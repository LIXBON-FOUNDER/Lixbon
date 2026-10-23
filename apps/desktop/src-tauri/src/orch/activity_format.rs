//! LXO-92 · formateador de Activity: un Event durable -> un `ActivityItem` para humanos.
//!
//! Función PURA de una fila del Event Log: no lee `State`, git, reloj ni SQL, y no escribe nada. El Core no
//! devuelve frases: devuelve una clave de mensaje estable (`activity.task.failed`) y unos argumentos
//! (`args`) con códigos, ids y contadores; cada cliente la traduce (`docs/VOCABULARIO.md` §1). Contrato,
//! tabla Event kind -> Activity y ejemplos: `docs/core/ACTIVITY.md`.
//!
//! # Garantías
//! * **Un evento, un item.** El cursor es el `seq` del evento y no hay compresión: nada se oculta.
//! * **Trazable.** Cada item lleva `seq`, `event_id`, `kind` y `v` del evento origen.
//! * **Ni rutas ni texto reinterpretados.** Proyecto, run, entidad y actor salen de las columnas del evento.
//! * **Lista cerrada de `args`.** Cada `kind` construye sus argumentos campo a campo; no se copia el
//!   payload. Los códigos cerrados se comparan contra su conjunto y las claves salen de constantes.
//! * **Nunca rompe la timeline.** Un `kind` desconocido, una `v` que este formateador no conoce o un payload
//!   ilegible producen el item `activity.unknown` (`fallback: true`) con el motivo, sin copiar el payload.

use serde_json::{json, Map, Value};

use crate::store::EventRow;

/// Versión del formateador. Sube si cambia el significado de una clave o de un argumento ya publicado.
pub(super) const PROJECTION_VERSION: u8 = 1;

/// ¿Sabe leer esta versión del contrato (`events.v`) de este `kind`? Todos la 1; `task.created` además la 2
/// (Task como intención, LXO-113), que tiene su propia clave de mensaje.
fn supports(kind: &str, v: i64) -> bool {
    v == 1 || (kind == "task.created" && v == 2)
}

/// Clave del item de respaldo.
pub(super) const UNKNOWN_KEY: &str = "activity.unknown";

/// Todos los `kind` que sabe formatear. Una prueba exige que cada `kind` de `event_kinds.rs` esté aquí.
pub(super) const KINDS: [&str; 49] = [
    "run.created",
    "run.closed",
    "run.removed",
    "task.created",
    "task.status_changed",
    "task.phase",
    "task.question",
    "task.reply",
    "task.removed",
    "task.review_requested",
    "task.updated",
    "task.discarded",
    "task.restored",
    "attempt.requested",
    "attempt.approved",
    "attempt.rejected",
    "attempt.started",
    "attempt.completed",
    "attempt.failed",
    "attempt.stopped",
    "provider_session.opened",
    "provider_session.bound",
    "provider_session.resumed",
    "provider_session.detached",
    "provider_session.closed",
    "thread.created",
    "thread.summarized",
    "worktree.created",
    "worktree.adopted",
    "worktree.attached",
    "worktree.missing",
    "worktree.found",
    "worktree.removed",
    "artifact.created",
    "core.agentic_cut",
    "decision.recorded",
    "effect.observed",
    "project.registered",
    "project.location_added",
    "project.archived",
    "project.restored",
    "project.relocated",
    "spawn.requested",
    "spawn.resolved",
    "environment.blocked",
    "environment.cleared",
    "attention.risk_acted",
    "attention.created",
    "attention.resolved",
];

const TASK_STATUSES: [&str; 8] = [
    "starting",
    "running",
    "waiting",
    "awaiting_terminal_approval",
    "done",
    "failed",
    "stopped",
    "exited",
];
/// Por qué se detuvo un Attempt (`attempt.stopped`, `attempt.rejected`).
const STOP_CAUSES: [&str; 2] = ["cancelled", "run_closed"];
/// Motivo máquina de `attempt.failed`.
const ATTEMPT_FAILURES: [&str; 4] = ["launch_failed", "terminal_approval_timeout", "agent_idle_timeout", "agent_reported"];
/// Estados de los que se puede detener un Attempt ya aprobado (el pendiente es `attempt.rejected`).
const STOPPED_FROM: [&str; 4] = ["starting", "running", "waiting", "awaiting_terminal_approval"];
/// Cómo declaró el proveedor la referencia de una sesión (`provider_session.bound`).
const SESSION_BINDINGS: [&str; 2] = ["stream_json", "session_id"];
/// Estados desde los que se cierra una sesión (`provider_session.closed`).
const SESSION_CLOSED_FROM: [&str; 2] = ["open", "idle"];
/// Procedencia de un Worktree que ya existía (`worktree.adopted`).
const ADOPTED_PROVENANCE: [&str; 2] = ["adopted", "external"];
/// Por qué se quitó un Worktree (`worktree.removed`).
const WORKTREE_REMOVAL: [&str; 3] = ["integrated", "discarded", "gone"];
/// Tipos de Artifact (`artifact.created`).
const ARTIFACT_KINDS: [&str; 5] = ["report", "pull_request", "last_message", "commit", "file"];
/// Campos de la intención que puede nombrar `task.updated`.
const INTENT_FIELDS: [&str; 2] = ["title", "spec"];
const ENV_CODES: [&str; 3] = [
    "cli_missing",
    "cli_flags_unsupported",
    "windows_sandbox_elevated",
];
const ATTENTION_CATEGORIES: [&str; 7] = [
    "question",
    "approval",
    "review_ready",
    "conflict",
    "failed",
    "environment_blocked",
    "risk",
];
const ATTENTION_SEVERITIES: [&str; 4] = ["critical", "high", "medium", "low"];
const RESOLUTIONS: [&str; 3] = ["acted", "condition_cleared", "superseded"];

/// Énfasis visual opcional. No es la severidad de Attention: solo orienta cómo se pinta la línea.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Visual {
    Info,
    Success,
    Warning,
    Error,
}

impl Visual {
    fn as_str(self) -> &'static str {
        match self {
            Visual::Info => "info",
            Visual::Success => "success",
            Visual::Warning => "warning",
            Visual::Error => "error",
        }
    }
}

/// Por qué un item es de respaldo.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FallbackReason {
    UnknownKind,
    UnsupportedVersion,
    InvalidPayload,
}

impl FallbackReason {
    fn as_str(self) -> &'static str {
        match self {
            FallbackReason::UnknownKind => "unknown_kind",
            FallbackReason::UnsupportedVersion => "unsupported_version",
            FallbackReason::InvalidPayload => "invalid_payload",
        }
    }
}

struct Rendered {
    key: &'static str,
    visual: Visual,
    args: Map<String, Value>,
}

/// Construye el item. Un argumento cuyo nombre termina en `?` es opcional y se omite si falta; si falta uno
/// obligatorio el payload no cumple el contrato y el llamador cae al item de respaldo (`None`).
fn rendered(
    key: &'static str,
    visual: Visual,
    args: Vec<(&'static str, Option<Value>)>,
) -> Option<Rendered> {
    let mut out = Map::new();
    for (name, value) in args {
        match (name.strip_suffix('?'), value) {
            (_, Some(value)) => {
                out.insert(name.trim_end_matches('?').to_string(), value);
            }
            (Some(_), None) => {}
            (None, None) => return None,
        }
    }
    Some(Rendered {
        key,
        visual,
        args: out,
    })
}

// ---------------------------------------------------------------------------------------------
// Lectura tipada del payload: cada función devuelve `None` si el campo falta o no es del tipo esperado
// ---------------------------------------------------------------------------------------------

fn clean(s: &str, max: usize) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        return flat.to_string();
    }
    let mut out: String = flat.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Texto libre ya presente en el payload (título de una Task o solicitud, nombre de un Project, rama):
/// sin caracteres de control y recortado. Es lo único de `args` que no es un código, un id o un contador.
fn text(p: &Value, key: &str, max: usize) -> Option<Value> {
    p.get(key)?.as_str().map(|s| json!(clean(s, max)))
}

fn opt_text(p: &Value, key: &str, max: usize) -> Option<Value> {
    p.get(key)
        .filter(|v| !v.is_null())
        .and_then(|_| text(p, key, max))
}

fn valid_token(s: &str) -> bool {
    !s.is_empty()
        && s.chars().count() <= 80
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "._:/@+-".contains(c))
}

/// Código o nombre corto (`claude`, `agent_idle_timeout`, `claude-opus-4`): alfanumérico y `._:/@+-`.
fn token(p: &Value, key: &str) -> Option<Value> {
    p.get(key)?
        .as_str()
        .filter(|s| valid_token(s))
        .map(|s| json!(s))
}

fn opt_token(p: &Value, key: &str) -> Option<Value> {
    p.get(key)
        .filter(|v| !v.is_null())
        .and_then(|_| token(p, key))
}

/// Identificador de una entidad (task, run, solicitud, efecto): 1 a 200 caracteres sin control.
fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.chars().count() <= 200 && !s.chars().any(char::is_control)
}

fn id(p: &Value, key: &str) -> Option<Value> {
    p.get(key)?
        .as_str()
        .filter(|s| valid_id(s))
        .map(|s| json!(s))
}

fn number(p: &Value, key: &str) -> Option<Value> {
    p.get(key)?.as_u64().map(|n| json!(n))
}

fn opt_number(p: &Value, key: &str) -> Option<Value> {
    p.get(key)
        .filter(|v| !v.is_null())
        .and_then(|_| number(p, key))
}

fn flag(p: &Value, key: &str) -> Option<Value> {
    p.get(key)?.as_bool().map(|b| json!(b))
}

/// ¿Hay un campo presente y no vacío? Para decir «hay enlace» sin copiarlo.
fn present(p: &Value, key: &str) -> Value {
    json!(p
        .get(key)
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty()))
}

/// Un código cerrado: devuelve el elemento del conjunto, nunca el texto del payload.
fn one_of(p: &Value, key: &str, allowed: &[&'static str]) -> Option<&'static str> {
    let got = p.get(key)?.as_str()?;
    allowed.iter().copied().find(|a| *a == got)
}

fn closed(p: &Value, key: &str, allowed: &[&'static str]) -> Option<Value> {
    one_of(p, key, allowed).map(|a| json!(a))
}

// ---------------------------------------------------------------------------------------------
// Tabla Event kind -> Activity
// ---------------------------------------------------------------------------------------------

fn render(e: &EventRow, p: &Value) -> Option<Rendered> {
    match e.kind.as_str() {
        "run.created" => rendered(
            "activity.run.created",
            Visual::Info,
            vec![("root_task", id(p, "root_task"))],
        ),
        "run.closed" => {
            let forced = p.get("forced")?.as_bool()?;
            rendered(
                "activity.run.closed",
                if forced {
                    Visual::Warning
                } else {
                    Visual::Info
                },
                vec![
                    ("forced", flag(p, "forced")),
                    ("stopped_total", number(p, "stopped_total")),
                ],
            )
        }
        "run.removed" => rendered(
            "activity.run.removed",
            Visual::Info,
            vec![("tasks", number(p, "tasks"))],
        ),

        "task.created" if e.v == 2 => rendered(
            "activity.task.intent_created",
            Visual::Info,
            vec![
                ("title", text(p, "title", 120)),
                (
                    "parent?",
                    p.get("parent")
                        .filter(|v| !v.is_null())
                        .and_then(|_| id(p, "parent")),
                ),
                ("depth", number(p, "depth")),
            ],
        ),
        "task.created" => rendered(
            "activity.task.created",
            Visual::Info,
            vec![
                ("title", text(p, "title", 120)),
                ("agent", token(p, "agent")),
                ("role?", opt_token(p, "role")),
                ("model?", opt_token(p, "model")),
                (
                    "parent?",
                    p.get("parent")
                        .filter(|v| !v.is_null())
                        .and_then(|_| id(p, "parent")),
                ),
                ("depth", number(p, "depth")),
                ("external", flag(p, "external")),
            ],
        ),
        "task.status_changed" => {
            let from = one_of(p, "from", &TASK_STATUSES)?;
            let to = one_of(p, "to", &TASK_STATUSES)?;
            let (key, visual) = match to {
                "starting" => ("activity.task.starting", Visual::Info),
                "running" => ("activity.task.running", Visual::Info),
                "waiting" => ("activity.task.waiting", Visual::Info),
                "awaiting_terminal_approval" => {
                    ("activity.task.awaiting_terminal_approval", Visual::Warning)
                }
                "done" => ("activity.task.done", Visual::Success),
                "failed" => ("activity.task.failed", Visual::Error),
                "stopped" => ("activity.task.stopped", Visual::Warning),
                _ => ("activity.task.exited", Visual::Error),
            };
            rendered(
                key,
                visual,
                vec![
                    ("from", Some(json!(from))),
                    ("to", Some(json!(to))),
                    ("cause?", opt_token(p, "cause")),
                ],
            )
        }
        // El nombre de la fase es texto libre del agente y no se expone: la línea dice solo que hubo una fase.
        "task.phase" => {
            let done = p.get("done")?.as_bool()?;
            rendered(
                if done {
                    "activity.task.phase_done"
                } else {
                    "activity.task.phase_started"
                },
                Visual::Info,
                vec![],
            )
        }
        "task.question" => rendered(
            "activity.task.question",
            Visual::Warning,
            vec![("message_id", number(p, "message_id")), ("to", id(p, "to"))],
        ),
        "task.reply" => rendered(
            "activity.task.reply",
            Visual::Info,
            vec![
                ("question_id", number(p, "question_id")),
                ("message_id", number(p, "message_id")),
            ],
        ),
        "task.removed" => rendered(
            "activity.task.removed",
            Visual::Warning,
            vec![("cause", closed(p, "cause", &["launch_failed", "unused"]))],
        ),
        "task.updated" => {
            let changed = p
                .get("changed")?
                .as_array()?
                .iter()
                .map(|v| v.as_str().filter(|s| INTENT_FIELDS.contains(s)).map(|s| json!(s)))
                .collect::<Option<Vec<Value>>>()?;
            if changed.is_empty() {
                return None;
            }
            rendered(
                "activity.task.updated",
                Visual::Info,
                vec![("changed", Some(json!(changed))), ("title?", opt_text(p, "title", 120))],
            )
        }
        "task.discarded" => rendered("activity.task.discarded", Visual::Warning, vec![]),
        "task.restored" => rendered("activity.task.restored", Visual::Info, vec![]),

        "attempt.requested" => rendered(
            "activity.attempt.requested",
            Visual::Info,
            vec![
                ("task", id(p, "task")),
                ("n", number(p, "n")),
                ("provider", token(p, "provider")),
                ("model?", opt_token(p, "model")),
                ("effort?", opt_token(p, "effort")),
                ("role?", opt_token(p, "role")),
                ("profile?", opt_token(p, "profile")),
                ("external", flag(p, "external")),
                ("approval_required", flag(p, "approval_required")),
            ],
        ),
        "attempt.approved" => rendered("activity.attempt.approved", Visual::Success, vec![("task", id(p, "task")), ("n", number(p, "n"))]),
        "attempt.started" => rendered("activity.attempt.started", Visual::Info, vec![("task", id(p, "task")), ("n", number(p, "n"))]),
        "attempt.rejected" => rendered(
            "activity.attempt.rejected",
            Visual::Warning,
            vec![("task", id(p, "task")), ("n", number(p, "n")), ("cause", closed(p, "cause", &STOP_CAUSES))],
        ),
        "attempt.completed" => rendered(
            "activity.attempt.completed",
            Visual::Success,
            vec![("task", id(p, "task")), ("n", number(p, "n")), ("has_summary", flag(p, "has_summary"))],
        ),
        "attempt.failed" => rendered(
            "activity.attempt.failed",
            Visual::Error,
            vec![
                ("task", id(p, "task")),
                ("n", number(p, "n")),
                ("reason", closed(p, "reason", &ATTEMPT_FAILURES)),
                ("has_summary", flag(p, "has_summary")),
            ],
        ),
        "attempt.stopped" => rendered(
            "activity.attempt.stopped",
            Visual::Warning,
            vec![
                ("task", id(p, "task")),
                ("n", number(p, "n")),
                ("from", closed(p, "from", &STOPPED_FROM)),
                ("cause", closed(p, "cause", &STOP_CAUSES)),
            ],
        ),
        "provider_session.opened" => rendered(
            "activity.provider_session.opened",
            Visual::Info,
            vec![
                ("task", id(p, "task")),
                ("n", number(p, "n")),
                ("provider", token(p, "provider")),
                ("resumable", flag(p, "resumable")),
                ("bound", flag(p, "bound")),
            ],
        ),
        "provider_session.bound" => rendered(
            "activity.provider_session.bound",
            Visual::Info,
            vec![("task", id(p, "task")), ("binding", closed(p, "binding", &SESSION_BINDINGS))],
        ),
        "provider_session.resumed" => rendered("activity.provider_session.resumed", Visual::Info, vec![("task", id(p, "task")), ("n", number(p, "n"))]),
        "provider_session.detached" => rendered("activity.provider_session.detached", Visual::Info, vec![("task", id(p, "task"))]),
        "provider_session.closed" => rendered(
            "activity.provider_session.closed",
            Visual::Info,
            vec![("task", id(p, "task")), ("from", closed(p, "from", &SESSION_CLOSED_FROM))],
        ),
        "thread.created" => rendered("activity.thread.created", Visual::Info, vec![("task", id(p, "task"))]),
        "thread.summarized" => rendered("activity.thread.summarized", Visual::Info, vec![("task", id(p, "task")), ("has_summary", flag(p, "has_summary"))]),
        "worktree.created" => rendered(
            "activity.worktree.created",
            Visual::Info,
            vec![("task", id(p, "task")), ("n", number(p, "n")), ("branch?", text(p, "branch", 300))],
        ),
        "worktree.adopted" => rendered(
            "activity.worktree.adopted",
            Visual::Info,
            vec![("task", id(p, "task")), ("n", number(p, "n")), ("provenance", closed(p, "provenance", &ADOPTED_PROVENANCE)), ("branch?", text(p, "branch", 300))],
        ),
        "worktree.attached" => rendered("activity.worktree.attached", Visual::Info, vec![("task", id(p, "task")), ("n", number(p, "n"))]),
        "worktree.missing" => rendered("activity.worktree.missing", Visual::Warning, vec![("task", id(p, "task"))]),
        "worktree.found" => rendered("activity.worktree.found", Visual::Info, vec![("task", id(p, "task"))]),
        "worktree.removed" => rendered(
            "activity.worktree.removed",
            Visual::Info,
            vec![("task", id(p, "task")), ("reason", closed(p, "reason", &WORKTREE_REMOVAL)), ("branch_kept", flag(p, "branch_kept"))],
        ),
        "artifact.created" => rendered(
            "activity.artifact.created",
            Visual::Info,
            vec![("task", id(p, "task")), ("n", number(p, "n")), ("kind", closed(p, "kind", &ARTIFACT_KINDS)), ("verifiable", flag(p, "verifiable"))],
        ),
        "core.agentic_cut" => rendered(
            "activity.core.agentic_cut",
            Visual::Info,
            vec![("tasks", p.get("counts").and_then(|c| number(c, "tasks"))), ("attempts", p.get("counts").and_then(|c| number(c, "attempts")))],
        ),
        "task.review_requested" => rendered(
            "activity.task.review_requested",
            Visual::Info,
            vec![("branch", text(p, "branch", 300))],
        ),

        "decision.recorded" => render_decision(p),
        "effect.observed" => render_effect(p),

        "project.registered" => rendered(
            "activity.project.registered",
            Visual::Info,
            vec![
                ("name", text(p, "name", 120)),
                (
                    "origin",
                    closed(p, "origin", &["manual", "auto", "backfill", "import"]),
                ),
                ("has_remote", flag(p, "has_remote")),
            ],
        ),
        "project.location_added" => rendered(
            "activity.project.location_added",
            Visual::Info,
            vec![
                ("primary", flag(p, "primary")),
                ("fingerprint_adopted", flag(p, "fingerprint_adopted")),
            ],
        ),
        "project.archived" => rendered("activity.project.archived", Visual::Info, vec![]),
        "project.restored" => rendered("activity.project.restored", Visual::Info, vec![]),
        "project.relocated" => rendered(
            "activity.project.relocated",
            Visual::Info,
            vec![
                ("fingerprint_adopted", flag(p, "fingerprint_adopted")),
                ("confirmed_mismatch", flag(p, "confirmed_mismatch")),
            ],
        ),

        "spawn.requested" => {
            let policy = one_of(p, "policy_status", &["ok", "blocked", "unverified"])?;
            rendered(
                "activity.spawn.requested",
                if policy == "blocked" {
                    Visual::Warning
                } else {
                    Visual::Info
                },
                vec![
                    ("parent_task", id(p, "parent_task")),
                    ("title", text(p, "title", 120)),
                    ("provider", token(p, "provider")),
                    ("profile", token(p, "profile")),
                    ("role?", opt_token(p, "role")),
                    ("model?", opt_token(p, "model")),
                    ("effort?", opt_token(p, "effort")),
                    ("shared", flag(p, "shared")),
                    ("policy_status", Some(json!(policy))),
                ],
            )
        }
        "spawn.resolved" => {
            let (key, visual) = match one_of(
                p,
                "outcome",
                &[
                    "approved",
                    "rejected",
                    "launch_failed",
                    "timeout",
                    "coordinator_closed",
                    "cancelled_run_removed",
                ],
            )? {
                "approved" => ("activity.spawn.approved", Visual::Success),
                "rejected" => ("activity.spawn.rejected", Visual::Warning),
                "launch_failed" => ("activity.spawn.launch_failed", Visual::Error),
                "timeout" => ("activity.spawn.timeout", Visual::Warning),
                "coordinator_closed" => ("activity.spawn.coordinator_closed", Visual::Info),
                _ => ("activity.spawn.cancelled_run_removed", Visual::Info),
            };
            rendered(
                key,
                visual,
                vec![
                    ("task?", opt_token_id(p, "task")),
                    ("has_reason", flag(p, "has_reason")),
                ],
            )
        }

        // El proveedor es la entidad del evento (columna), no un campo del payload.
        "environment.blocked" => rendered(
            "activity.environment.blocked",
            Visual::Warning,
            vec![
                ("provider", valid_entity(e)),
                ("profile", token(p, "profile")),
                ("code", closed(p, "code", &ENV_CODES)),
            ],
        ),
        "environment.cleared" => rendered(
            "activity.environment.cleared",
            Visual::Success,
            vec![
                ("provider", valid_entity(e)),
                ("profile", token(p, "profile")),
                ("code", closed(p, "code", &ENV_CODES)),
            ],
        ),

        "attention.risk_acted" => rendered(
            "activity.attention.risk_acted",
            Visual::Info,
            vec![("resolution", closed(p, "resolution", &RESOLUTIONS))],
        ),
        "attention.created" => rendered(
            "activity.attention.created",
            Visual::Info,
            vec![
                ("category", closed(p, "category", &ATTENTION_CATEGORIES)),
                ("severity", closed(p, "severity", &ATTENTION_SEVERITIES)),
                ("occurrence", number(p, "occurrence")),
                ("target_kind", token(p, "target_kind")),
                ("target_id", id(p, "target_id")),
            ],
        ),
        "attention.resolved" => rendered(
            "activity.attention.resolved",
            Visual::Info,
            vec![("resolution", closed(p, "resolution", &RESOLUTIONS))],
        ),
        _ => None,
    }
}

fn opt_token_id(p: &Value, key: &str) -> Option<Value> {
    p.get(key).filter(|v| !v.is_null()).and_then(|_| id(p, key))
}

fn valid_entity(e: &EventRow) -> Option<Value> {
    valid_token(&e.entity_id).then(|| json!(e.entity_id))
}

fn render_decision(p: &Value) -> Option<Rendered> {
    match p.get("decision_kind")?.as_str()? {
        "review" => {
            let (key, visual) = match one_of(p, "outcome", &["accepted", "rejected"])? {
                "accepted" => ("activity.decision.review.accepted", Visual::Success),
                _ => ("activity.decision.review.rejected", Visual::Warning),
            };
            rendered(
                key,
                visual,
                vec![
                    ("decision_id", number(p, "decision_id")),
                    ("has_comment", flag(p, "has_comment")),
                ],
            )
        }
        "merge" => {
            let (key, visual) = match one_of(
                p,
                "outcome",
                &["merged", "conflict", "error", "target_moved"],
            )? {
                "merged" => ("activity.decision.merge.merged", Visual::Success),
                "conflict" => ("activity.decision.merge.conflict", Visual::Error),
                "error" => ("activity.decision.merge.error", Visual::Error),
                _ => ("activity.decision.merge.target_moved", Visual::Warning),
            };
            rendered(
                key,
                visual,
                vec![
                    ("decision_id", number(p, "decision_id")),
                    ("branch", text(p, "branch", 300)),
                    ("squash", flag(p, "squash")),
                    ("conflict_count?", opt_number(p, "conflict_count")),
                ],
            )
        }
        "pr" => {
            let (key, visual) = match one_of(p, "outcome", &["created", "already_exists", "error"])?
            {
                "created" => ("activity.decision.pr.created", Visual::Success),
                "already_exists" => ("activity.decision.pr.already_exists", Visual::Info),
                _ => ("activity.decision.pr.error", Visual::Error),
            };
            rendered(
                key,
                visual,
                vec![
                    ("decision_id", number(p, "decision_id")),
                    ("branch", text(p, "branch", 300)),
                    ("has_pr_url", Some(present(p, "pr_url"))),
                ],
            )
        }
        _ => None,
    }
}

fn render_effect(p: &Value) -> Option<Rendered> {
    match p.get("effect_kind")?.as_str()? {
        "git_merge" => {
            let (key, visual) = match one_of(p, "result", &["merged", "conflict", "error"])? {
                "merged" => ("activity.effect.git_merge.merged", Visual::Success),
                "conflict" => ("activity.effect.git_merge.conflict", Visual::Error),
                _ => ("activity.effect.git_merge.error", Visual::Error),
            };
            rendered(
                key,
                visual,
                vec![
                    ("effect_id", id(p, "effect_id")),
                    ("branch", text(p, "branch", 300)),
                ],
            )
        }
        "git_push_pr" => {
            let (key, visual) = match one_of(p, "result", &["created", "already_exists", "error"])?
            {
                "created" => ("activity.effect.git_push_pr.created", Visual::Success),
                "already_exists" => ("activity.effect.git_push_pr.already_exists", Visual::Info),
                _ => ("activity.effect.git_push_pr.error", Visual::Error),
            };
            rendered(
                key,
                visual,
                vec![
                    ("effect_id", id(p, "effect_id")),
                    ("branch", text(p, "branch", 300)),
                    ("has_pr_url", Some(present(p, "pr_url"))),
                ],
            )
        }
        "git_worktree" => rendered(
            "activity.effect.git_worktree.created",
            Visual::Info,
            vec![
                ("effect_id", id(p, "effect_id")),
                ("branch", text(p, "branch", 300)),
                ("base?", opt_text(p, "base", 300)),
            ],
        ),
        "git_worktree_removed" => rendered(
            "activity.effect.git_worktree.removed",
            Visual::Info,
            vec![
                ("effect_id", id(p, "effect_id")),
                ("worktree_removed", flag(p, "worktree_removed")),
                ("branch?", opt_text(p, "branch", 300)),
                ("branch_deleted", flag(p, "branch_deleted")),
            ],
        ),
        "pty_process" => {
            let launched = p.get("launched")?.as_bool()?;
            rendered(
                if launched {
                    "activity.effect.process.launched"
                } else {
                    "activity.effect.process.not_launched"
                },
                if launched {
                    Visual::Info
                } else {
                    Visual::Warning
                },
                vec![("effect_id", id(p, "effect_id"))],
            )
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------------
// El item
// ---------------------------------------------------------------------------------------------

/// El item de Activity de un evento. Nunca falla: lo que no se entiende pasa a `activity.unknown`.
pub(super) fn item(e: &EventRow) -> Value {
    let known = KINDS.contains(&e.kind.as_str());
    let outcome = if !known {
        Err(FallbackReason::UnknownKind)
    } else if !supports(&e.kind, e.v) {
        Err(FallbackReason::UnsupportedVersion)
    } else {
        serde_json::from_str::<Value>(&e.payload)
            .ok()
            .and_then(|p| render(e, &p))
            .ok_or(FallbackReason::InvalidPayload)
    };
    let (key, visual, args, fallback) = match outcome {
        Ok(r) => (r.key, r.visual, r.args, false),
        Err(reason) => {
            let mut args = Map::new();
            args.insert("reason".into(), json!(reason.as_str()));
            args.insert("kind".into(), json!(clean(&e.kind, 64)));
            args.insert("event_version".into(), json!(e.v));
            (UNKNOWN_KEY, Visual::Info, args, true)
        }
    };
    json!({
        "seq": e.seq,
        "event_id": e.id,
        "ts": e.at,
        "kind": e.kind,
        "v": e.v,
        "class": e.class.as_str(),
        "message_key": key,
        "args": Value::Object(args),
        "visual": visual.as_str(),
        "fallback": fallback,
        "target": { "kind": e.entity_kind, "id": e.entity_id },
        "project_id": e.project_id,
        "run_id": e.run_id,
        "actor": { "kind": e.actor_kind.as_str(), "id": e.actor_id },
        "provenance": { "channel": e.channel, "client_id": e.client_id },
        "correlation_id": e.correlation_id,
    })
}
