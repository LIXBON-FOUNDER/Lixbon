//! Catálogo de eventos del Core (slice E, etapa E1b): UNA estructura de payload por `kind`.
//!
//! Aquí viven los contratos (nombre, versión, clase) y los constructores de borradores. Es el único
//! sitio donde se implementa [`EventPayload`] y donde se construye un [`EventDraft`] de dominio: los
//! mutadores semánticos de `Tx` (`tx_ops.rs`) llaman a estas funciones, nadie más.
//!
//! # Reglas de los payloads
//! * Identificadores y hechos pequeños. **Nunca** cuerpos de mensaje, informes, diffs, `argv`, `env`
//!   ni credenciales. Los textos cortos que hacen legible el hecho (título de una tarea, nombre de una
//!   fase) se recortan con [`clip`]: un payload nunca se acerca a los 8 KiB.
//! * La clase es fija por `kind`. Quién lo provoca va en el actor; dónde ocurrió, en `channel`.
//!
//! # Kinds de este bloque (mutadores de `State`)
//! | kind | class | entidad |
//! |---|---|---|
//! | `run.created` · `run.closed` · `run.removed` | state | `run` |
//! | `task.created` · `task.status_changed` · `task.phase` · `task.question` · `task.reply` | state | `task` |
//! | `decision.recorded` (`review` · `merge` · `pr`) | decision | `task` |
//! | `task.removed` (`launch_failed`) | state | `task` |
//! | `effect.observed` (`git_merge` · `git_push_pr` · `git_worktree` · `git_worktree_removed` · `pty_process`) | effect | `task` |
//! | `project.registered` (`manual` · `auto` · `backfill` · `import`) | state | `project` |
//! | `spawn.requested` | state | `spawn_request` |
//! | `spawn.resolved` (`approved` · `rejected` · `launch_failed` · `timeout` · `coordinator_closed` · `cancelled_run_removed`) | decision | `spawn_request` |
//! | `task.review_requested` | state | `task` |
//! | `environment.blocked` · `environment.cleared` | state | `agent` |
//! | `project.location_added` · `project.archived` · `project.restored` · `project.relocated` | decision | `project` |
//!
//! # Kinds del Attempt (LXO-114, inertes hasta el corte; los emite `attempt_ops`)
//! | kind | class | entidad |
//! |---|---|---|
//! | `attempt.requested` · `attempt.started` · `attempt.completed` · `attempt.failed` · `attempt.stopped` | state | `attempt` |
//! | `attempt.approved` · `attempt.rejected` | decision | `attempt` |
//!
//! # Kinds de ProviderSession y Thread (LXO-115, inertes hasta el corte; los emite `session_ops`)
//! | kind | class | entidad |
//! |---|---|---|
//! | `provider_session.opened` · `bound` · `resumed` · `detached` · `closed` | state | `provider_session` |
//! | `thread.created` · `thread.summarized` | state | `thread` |
//!
//! # Kinds de Worktree y Artifact (LXO-116, inertes hasta el corte; los emite `worktree_ops`)
//! | kind | class | entidad |
//! |---|---|---|
//! | `worktree.created` · `adopted` · `attached` · `missing` · `found` · `removed` | state | `worktree` |
//! | `artifact.created` | state | `artifact` |
//!
//! # Kinds de la Task como intención (LXO-113, inertes hasta el corte; los emite `task_ops`)
//! | kind | class | entidad |
//! |---|---|---|
//! | `run.created` (v1, misma forma) · `task.created` **v2** · `task.updated` | state | `run` · `task` |
//! | `task.discarded` · `task.restored` | decision | `task` |
//! | `task.removed` (`unused`) | state | `task` |

use serde::Serialize;

use super::agents;
use super::events::{EntityKind, EventDraft, EventError, EventPayload};
use super::state::{Status, Task};
use crate::store::{AttemptRow, AttemptStatus, EventClass, Fingerprint, IntentField, ArtifactKind, ArtifactRow, Provenance, ProviderSessionRow, RemovalReason, Resolution, RunRow, SessionBinding, SessionStatus, TaskRow, ThreadRow, WorktreeRow};

/// Recorta a `max` caracteres (no bytes) y marca el recorte con «…».
pub(super) fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Máximo de ids de tareas que lleva `run.closed` (el total va aparte).
const MAX_LISTED: usize = 20;

// ---------------------------------------------------------------------------------------------
// run.*
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
pub(super) struct RunCreated {
    root_task: String,
}

impl EventPayload for RunCreated {
    const KIND: &'static str = "run.created";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// El objetivo (texto libre del usuario) se queda en `Run.objective`: el evento no lo copia.
pub(super) fn run_created(run: &str, root_task: &str) -> Result<EventDraft, EventError> {
    let p = RunCreated { root_task: root_task.into() };
    Ok(EventDraft::new(EntityKind::Run, run, &p)?.run(Some(run.into())).project_from_task(root_task))
}

#[derive(Serialize)]
pub(super) struct RunClosed {
    forced: bool,
    stopped: Vec<String>,
    stopped_total: usize,
}

impl EventPayload for RunClosed {
    const KIND: &'static str = "run.closed";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

pub(super) fn run_closed(run: &str, root_task: &str, forced: bool, stopped: &[String]) -> Result<EventDraft, EventError> {
    let p = RunClosed { forced, stopped: stopped.iter().take(MAX_LISTED).cloned().collect(), stopped_total: stopped.len() };
    Ok(EventDraft::new(EntityKind::Run, run, &p)?.run(Some(run.into())).project_from_task(root_task))
}

#[derive(Serialize)]
pub(super) struct RunRemoved {
    tasks: usize,
}

impl EventPayload for RunRemoved {
    const KIND: &'static str = "run.removed";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// `project_id` explícito: al finalizar, las tareas del run ya no existen en el candidato.
pub(super) fn run_removed(run: &str, project_id: Option<String>, tasks: usize) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Run, run, &RunRemoved { tasks })?.run(Some(run.into())).project(project_id))
}

// ---------------------------------------------------------------------------------------------
// task.*
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
pub(super) struct TaskCreated {
    parent: Option<String>,
    depth: u32,
    agent: String,
    role: Option<String>,
    model: Option<String>,
    title: String,
    external: bool,
}

impl EventPayload for TaskCreated {
    const KIND: &'static str = "task.created";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

pub(super) fn task_created(t: &Task) -> Result<EventDraft, EventError> {
    let p = TaskCreated {
        parent: t.parent.clone(),
        depth: t.depth,
        agent: t.agent.clone(),
        role: t.role.clone(),
        model: t.model.clone(),
        title: clip(&t.title, 120),
        external: t.external,
    };
    Ok(EventDraft::new(EntityKind::Task, t.id.as_str(), &p)?.run(Some(t.run.clone())).project_from_task(t.id.as_str()))
}

#[derive(Serialize)]
pub(super) struct TaskStatusChanged {
    from: Status,
    to: Status,
    /// Por qué cambió, cuando el mutador lo sabe (`question`, `answered`, `reopened`, `run_closed`,
    /// `orphaned`, `terminal_approval`, o el motivo máquina de un fallo por vigilancia).
    #[serde(skip_serializing_if = "Option::is_none")]
    cause: Option<String>,
}

impl EventPayload for TaskStatusChanged {
    const KIND: &'static str = "task.status_changed";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

pub(super) fn task_status_changed(task: &str, run: &str, from: Status, to: Status, cause: Option<String>) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Task, task, &TaskStatusChanged { from, to, cause })?.run(Some(run.into())).project_from_task(task))
}

#[derive(Serialize)]
pub(super) struct TaskPhase {
    name: String,
    done: bool,
}

impl EventPayload for TaskPhase {
    const KIND: &'static str = "task.phase";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// Solo el hecho estructural (`name`, `done`). La nota es texto libre y vive en el estado/mensaje de fase.
pub(super) fn task_phase(task: &str, run: &str, name: &str, done: bool) -> Result<EventDraft, EventError> {
    let p = TaskPhase { name: clip(name, 80), done };
    Ok(EventDraft::new(EntityKind::Task, task, &p)?.run(Some(run.into())).project_from_task(task))
}

#[derive(Serialize)]
pub(super) struct TaskQuestion {
    message_id: u64,
    to: String,
}

impl EventPayload for TaskQuestion {
    const KIND: &'static str = "task.question";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// El cuerpo de la pregunta se queda en `messages`: el evento solo la identifica.
pub(super) fn task_question(task: &str, run: &str, message_id: u64, to: &str) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Task, task, &TaskQuestion { message_id, to: to.into() })?
        .run(Some(run.into()))
        .project_from_task(task)
        .correlated(format!("q{message_id}")))
}

#[derive(Serialize)]
pub(super) struct TaskReply {
    question_id: u64,
    message_id: u64,
}

impl EventPayload for TaskReply {
    const KIND: &'static str = "task.reply";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// La entidad es la tarea que PREGUNTÓ (el hilo de la pregunta); quien responde es el actor.
/// Quien respondió es el ACTOR del evento (columnas), no un campo del payload.
pub(super) fn task_reply(asker_task: &str, run: &str, question_id: u64, message_id: u64) -> Result<EventDraft, EventError> {
    let p = TaskReply { question_id, message_id };
    Ok(EventDraft::new(EntityKind::Task, asker_task, &p)?.run(Some(run.into())).project_from_task(asker_task).correlated(format!("q{question_id}")))
}

// ---------------------------------------------------------------------------------------------
// decision.recorded
// ---------------------------------------------------------------------------------------------

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum ReviewOutcome {
    Accepted,
    Rejected,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum MergeOutcome {
    Merged,
    Conflict,
    Error,
    TargetMoved,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum PrOutcome {
    Created,
    AlreadyExists,
    Error,
}

/// Una decisión de una persona sobre una tarea. Contrato CERRADO por `decision_kind`. Nada de texto
/// libre ni de detalles del efecto externo: sin `comment`, `into`, mensajes de git, lista de archivos en
/// conflicto, `remote` ni el error textual (de eso se ocupará `effect.observed`).
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "decision_kind", rename_all = "snake_case")]
pub(super) enum DecisionRecorded {
    Review {
        decision_id: u64,
        outcome: ReviewOutcome,
        head_commit: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        base_commit: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        base_source: Option<String>,
        has_comment: bool,
    },
    Merge {
        decision_id: u64,
        outcome: MergeOutcome,
        branch: String,
        squash: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        base_commit: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result_commit: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        conflict_count: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        base_check: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        accepted_moved_target: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_commit: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        found_commit: Option<String>,
    },
    Pr {
        decision_id: u64,
        outcome: PrOutcome,
        branch: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pr_url: Option<String>,
    },
}

impl EventPayload for DecisionRecorded {
    const KIND: &'static str = "decision.recorded";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Decision;
}

const DEC: &str = "decision.recorded";

fn req_str(who: &str, d: &serde_json::Value, key: &str) -> Result<String, String> {
    match d.get(key).and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => Ok(clip(s, 300)),
        _ => Err(format!("{who}: falta `{key}` (texto no vacío) en el detalle")),
    }
}

fn opt_str(who: &str, d: &serde_json::Value, key: &str) -> Result<Option<String>, String> {
    match d.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(clip(s, 300))),
        Some(_) => Err(format!("{who}: `{key}` debe ser texto o null")),
    }
}

/// La URL del PR llega saneada: sin credenciales, query ni fragmento. Una URL que no se puede sanear se omite
/// (el hecho ya ocurrió y debe registrarse), pero un valor que no sea texto sigue siendo un error.
fn opt_pr_url(who: &str, d: &serde_json::Value) -> Result<Option<String>, String> {
    match d.get("pr_url") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(super::pr_url::sanitize_pr_url(s)),
        Some(_) => Err(format!("{who}: `pr_url` debe ser texto o null")),
    }
}

fn opt_bool(who: &str, d: &serde_json::Value, key: &str) -> Result<Option<bool>, String> {
    match d.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(format!("{who}: `{key}` debe ser booleano o null")),
    }
}

fn outcome_str<'a>(who: &str, d: &'a serde_json::Value, key: &str, allowed: &[&str]) -> Result<&'a str, String> {
    match d.get(key).and_then(|v| v.as_str()) {
        Some(s) if allowed.contains(&s) => Ok(s),
        other => Err(format!("{who}: `{key}` {other:?} fuera del contrato (admitidos: {})", allowed.join(", "))),
    }
}

impl DecisionRecorded {
    /// Valida y normaliza el `detail` de una fila `Decision` según su `kind`. Un `kind` fuera del contrato, o un
    /// detalle que no cumple, es un error: la mutación completa se rechaza. `spawn` NO es de este evento: su
    /// única vía es `Tx::record_spawn_resolution` (`spawn.resolved`).
    pub(super) fn parse(kind: &str, detail: &serde_json::Value) -> Result<DecisionRecorded, String> {
        Ok(match kind {
            "review" => {
                let outcome = match outcome_str(DEC, detail, "decision", &["accepted", "rejected"])? {
                    "accepted" => ReviewOutcome::Accepted,
                    _ => ReviewOutcome::Rejected,
                };
                DecisionRecorded::Review {
                    decision_id: 0,
                    outcome,
                    head_commit: req_str(DEC, detail, "head_commit")?,
                    base_commit: opt_str(DEC, detail, "base_commit")?,
                    base_source: opt_str(DEC, detail, "base_source")?,
                    has_comment: opt_str(DEC, detail, "comment")?.is_some_and(|c| !c.trim().is_empty()),
                }
            }
            "merge" => {
                let outcome = match outcome_str(DEC, detail, "outcome", &["merged", "conflict", "error", "target_moved"])? {
                    "merged" => MergeOutcome::Merged,
                    "conflict" => MergeOutcome::Conflict,
                    "error" => MergeOutcome::Error,
                    _ => MergeOutcome::TargetMoved,
                };
                let conflict_count = match detail.get("conflicts") {
                    None | Some(serde_json::Value::Null) => None,
                    Some(serde_json::Value::Array(a)) => Some(a.len() as u64),
                    Some(_) => return Err("decision.recorded: `conflicts` debe ser una lista o null".into()),
                };
                DecisionRecorded::Merge {
                    decision_id: 0,
                    outcome,
                    branch: req_str(DEC, detail, "branch")?,
                    squash: opt_bool(DEC, detail, "squash")?.ok_or("decision.recorded: falta `squash` (booleano) en el detalle")?,
                    base_commit: opt_str(DEC, detail, "base_commit")?,
                    result_commit: opt_str(DEC, detail, "result_commit")?,
                    conflict_count,
                    base_check: opt_str(DEC, detail, "base_check")?,
                    accepted_moved_target: opt_bool(DEC, detail, "accepted_moved_target")?,
                    expected_commit: opt_str(DEC, detail, "expected_commit")?,
                    found_commit: opt_str(DEC, detail, "found_commit")?,
                }
            }
            "pr" => {
                let outcome = match outcome_str(DEC, detail, "outcome", &["created", "already_exists", "error"])? {
                    "created" => PrOutcome::Created,
                    "already_exists" => PrOutcome::AlreadyExists,
                    _ => PrOutcome::Error,
                };
                DecisionRecorded::Pr { decision_id: 0, outcome, branch: req_str(DEC, detail, "branch")?, pr_url: opt_pr_url(DEC, detail)? }
            }
            "spawn" => return Err("decision.recorded: `spawn` solo se registra con Tx::record_spawn_resolution (spawn.resolved)".into()),
            other => return Err(format!("decision.recorded: decision_kind {other:?} fuera del contrato (review, merge, pr)")),
        })
    }

    /// Completa el id que acaba de asignar `State::record_decision`.
    pub(super) fn with_id(mut self, id: u64) -> DecisionRecorded {
        match &mut self {
            DecisionRecorded::Review { decision_id, .. } | DecisionRecorded::Merge { decision_id, .. } | DecisionRecorded::Pr { decision_id, .. } => {
                *decision_id = id
            }
        }
        self
    }
}

/// La entidad es la tarea sobre la que se decide (`Decision.id` se reutiliza tras `remove_run`: no
/// puede ser identidad de entidad). Sin `idem_key`: revisar dos veces la misma rama es legítimo.
pub(super) fn decision_recorded(task: &str, run: &str, payload: &DecisionRecorded) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Task, task, payload)?.run(Some(run.to_string()).filter(|r| !r.is_empty())).project_from_task(task))
}

// ---------------------------------------------------------------------------------------------
// effect.observed
// ---------------------------------------------------------------------------------------------

const EFF: &str = "effect.observed";

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum MergeResult {
    Merged,
    Conflict,
    Error,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum PrResult {
    Created,
    AlreadyExists,
    Error,
}

/// Un efecto externo que YA ocurrió y que el Core observó. Contrato CERRADO por `effect_kind`. El
/// `effect_id` es la identidad de la ocurrencia: va en el payload, en `correlation_id` y en `idem_key`
/// (tres usos del mismo identificador: contenido, relación y unicidad). Nunca rutas locales, `env`,
/// `argv`, mensajes de error ni credenciales.
#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "effect_kind", rename_all = "snake_case")]
pub(super) enum EffectObserved {
    GitMerge {
        effect_id: String,
        operation: &'static str,
        result: MergeResult,
        branch: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        base_commit: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        result_commit: Option<String>,
    },
    GitPushPr {
        effect_id: String,
        operation: &'static str,
        result: PrResult,
        branch: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        pr_url: Option<String>,
    },
    GitWorktree {
        effect_id: String,
        operation: &'static str,
        branch: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        base: Option<String>,
    },
    GitWorktreeRemoved {
        effect_id: String,
        operation: &'static str,
        worktree_removed: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
        branch_deleted: bool,
    },
    PtyProcess {
        effect_id: String,
        operation: &'static str,
        launched: bool,
    },
}

impl EventPayload for EffectObserved {
    const KIND: &'static str = "effect.observed";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Effect;
}

/// Valida `operation` contra los valores conocidos del `effect_kind` (no es un texto libre).
fn operation_of(kind: &str, operation: &str, allowed: &[&'static str]) -> Result<&'static str, String> {
    allowed
        .iter()
        .copied()
        .find(|a| *a == operation)
        .ok_or_else(|| format!("{EFF}: operation {operation:?} fuera del contrato de {kind} (admitidas: {})", allowed.join(", ")))
}

impl EffectObserved {
    /// Valida y normaliza lo observado por un `Effect`. Un `kind` desconocido (también `spawn_outcome`, que ya no
    /// es un efecto: aprobar, rechazar o vencer un lanzamiento es una decisión) o un detalle fuera de contrato
    /// es un error.
    pub(super) fn parse(effect_id: &str, operation: &str, kind: &str, observed: &serde_json::Value) -> Result<EffectObserved, String> {
        let id = effect_id.to_string();
        Ok(match kind {
            "git_merge" => {
                let result = match outcome_str(EFF, observed, "outcome", &["merged", "conflict", "error"])? {
                    "merged" => MergeResult::Merged,
                    "conflict" => MergeResult::Conflict,
                    _ => MergeResult::Error,
                };
                EffectObserved::GitMerge {
                    effect_id: id,
                    operation: operation_of(kind, operation, &["integrate"])?,
                    result,
                    branch: req_str(EFF, observed, "branch")?,
                    base_commit: opt_str(EFF, observed, "base_commit")?,
                    result_commit: opt_str(EFF, observed, "result_commit")?,
                }
            }
            "git_push_pr" => {
                let result = match outcome_str(EFF, observed, "outcome", &["created", "already_exists", "error"])? {
                    "created" => PrResult::Created,
                    "already_exists" => PrResult::AlreadyExists,
                    _ => PrResult::Error,
                };
                EffectObserved::GitPushPr {
                    effect_id: id,
                    operation: operation_of(kind, operation, &["publish_pr"])?,
                    result,
                    branch: req_str(EFF, observed, "branch")?,
                    pr_url: opt_pr_url(EFF, observed)?,
                }
            }
            "git_worktree" => EffectObserved::GitWorktree {
                effect_id: id,
                operation: operation_of(kind, operation, &["spawn"])?,
                branch: req_str(EFF, observed, "branch")?,
                base: opt_str(EFF, observed, "base")?,
            },
            "git_worktree_removed" => {
                let operation = operation_of(kind, operation, &["release", "close_idle_runs", "spawn_cleanup"])?;
                let worktree_removed = opt_bool(EFF, observed, "worktree_removed")?.ok_or("effect.observed: falta `worktree_removed` (booleano)")?;
                let branch = opt_str(EFF, observed, "branch")?;
                let branch_deleted = opt_bool(EFF, observed, "branch_deleted")?.ok_or("effect.observed: falta `branch_deleted` (booleano)")?;
                // Un efecto observado exige que ALGO se borrara de verdad: un call site futuro no puede inventar
                // un cleanup que no ocurrió.
                if !worktree_removed && !branch_deleted {
                    return Err("effect.observed: git_worktree_removed exige worktree_removed o branch_deleted (no ocurrió ningún borrado)".into());
                }
                if branch_deleted && branch.as_deref().is_none_or(|b| b.trim().is_empty()) {
                    return Err("effect.observed: branch_deleted exige `branch` presente y no vacía".into());
                }
                EffectObserved::GitWorktreeRemoved { effect_id: id, operation, worktree_removed, branch, branch_deleted }
            }
            "pty_process" => {
                // `launched = false` no es un efecto observado: un lanzamiento que no arrancó no se registra.
                if opt_bool(EFF, observed, "launched")? != Some(true) {
                    return Err("effect.observed: pty_process exige launched = true (un proceso que no arrancó no es un efecto observado)".into());
                }
                EffectObserved::PtyProcess { effect_id: id, operation: operation_of(kind, operation, &["spawn"])?, launched: true }
            }
            other => return Err(format!("{EFF}: effect_kind {other:?} fuera del contrato (git_merge, git_push_pr, git_worktree, git_worktree_removed, pty_process)")),
        })
    }
}

/// Entidad: la tarea del efecto. `effect_id` = `correlation_id` = `idem_key` (y también va en el payload).
/// `run` y `project` son los de la tarea EN EL MOMENTO de observar el efecto y van explícitos: el cierre
/// que registra el efecto puede retirar la tarea (cleanup), y entonces `project_from_task` ya no la
/// encontraría al finalizar. Sin git ni registro de proyectos.
pub(super) fn effect_observed(task: &str, run: &str, project: Option<String>, payload: &EffectObserved, effect_id: &str) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Task, task, payload)?
        .run(Some(run.to_string()).filter(|r| !r.is_empty()))
        .project(project)
        .correlated(effect_id)
        .idempotent(effect_id))
}

// ---------------------------------------------------------------------------------------------
// task.removed
// ---------------------------------------------------------------------------------------------

/// Por qué se retiró una Task. Cerrado: el cleanup de un lanzamiento fallido (legacy) o el borrado explícito de
/// una Task del modelo de intención que no se llegó a usar (`TaskRemoval::IfUnused`, LXO-113).
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum RemovalCause {
    LaunchFailed,
    #[cfg_attr(not(test), allow(dead_code))]
    Unused,
}

#[derive(Serialize)]
pub(super) struct TaskRemoved {
    cause: RemovalCause,
}

impl EventPayload for TaskRemoved {
    const KIND: &'static str = "task.removed";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// «La Task existió y después fue retirada»: un hecho distinto de que la solicitud de spawn terminara en
/// `launch_failed` (eso será `spawn.resolved`). La Task YA NO existe cuando se finaliza el borrador, así que
/// `run` y `project` los captura el mutador ANTES de borrar y van explícitos (nunca `project_from_task`).
pub(super) fn task_removed(task: &str, run: &str, project: Option<String>, cause: RemovalCause) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Task, task, &TaskRemoved { cause })?.run(Some(run.to_string()).filter(|r| !r.is_empty())).project(project))
}

// ---------------------------------------------------------------------------------------------
// Task como intención (LXO-113): run.created · task.created v2 · task.updated · task.discarded · task.restored
// ---------------------------------------------------------------------------------------------
//
// Los emite `task_ops` sobre las filas de `store::tasks` (inertes hasta el corte Task/Attempt). Run y Project van
// EXPLÍCITOS, leídos de la fila confirmada: no hay `State` del que sacarlos. Nunca el encargo (`spec`), rutas,
// proceso, worktree ni sesión: la intención no tiene ejecución.

/// `run.created` (v1: misma forma que el legacy) de un Run nacido en el modelo de intención.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn run_created_intent(run: &RunRow, project_id: &str) -> Result<EventDraft, EventError> {
    let p = RunCreated { root_task: run.root_task_id.clone() };
    Ok(EventDraft::new(EntityKind::Run, run.id.as_str(), &p)?.run(Some(run.id.clone())).project(Some(project_id.into())))
}

/// `task.created` **v2**: solo la intención. La v1 (legacy) mezclaba datos de la ejecución (`agent`, `role`,
/// `model`, `external`), que tras el corte son del Attempt.
#[derive(Serialize)]
pub(super) struct TaskIntentCreated {
    parent: Option<String>,
    depth: i64,
    title: String,
}

impl EventPayload for TaskIntentCreated {
    const KIND: &'static str = "task.created";
    const VERSION: i64 = 2;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
fn task_draft<P: EventPayload>(t: &TaskRow, p: &P) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Task, t.id.as_str(), p)?.run(Some(t.run_id.clone())).project(t.project_id.clone()))
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn task_intent_created(t: &TaskRow) -> Result<EventDraft, EventError> {
    task_draft(t, &TaskIntentCreated { parent: t.parent_task_id.clone(), depth: t.depth, title: clip(&t.title, 120) })
}

/// Qué cambió de la intención. `title` solo si cambió (recortado); el encargo nunca viaja.
#[derive(Serialize)]
pub(super) struct TaskUpdated {
    changed: Vec<IntentField>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

impl EventPayload for TaskUpdated {
    const KIND: &'static str = "task.updated";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn task_updated(t: &TaskRow, changed: &[IntentField]) -> Result<EventDraft, EventError> {
    let title = changed.contains(&IntentField::Title).then(|| clip(&t.title, 120));
    task_draft(t, &TaskUpdated { changed: changed.to_vec(), title })
}

/// La persona descarta la intención (no se borra nada). Sin payload: el hecho es la decisión.
#[derive(Serialize)]
pub(super) struct TaskDiscarded {}

impl EventPayload for TaskDiscarded {
    const KIND: &'static str = "task.discarded";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Decision;
}

#[derive(Serialize)]
pub(super) struct TaskRestored {}

impl EventPayload for TaskRestored {
    const KIND: &'static str = "task.restored";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Decision;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn task_discarded(t: &TaskRow) -> Result<EventDraft, EventError> {
    task_draft(t, &TaskDiscarded {})
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn task_restored(t: &TaskRow) -> Result<EventDraft, EventError> {
    task_draft(t, &TaskRestored {})
}

// ---------------------------------------------------------------------------------------------
// Attempt (LXO-114): attempt.requested · approved · rejected · started · completed · failed · stopped
// ---------------------------------------------------------------------------------------------
//
// Los emite `attempt_ops` sobre las filas de `store::attempts` (inertes hasta el corte). El Attempt es la entidad
// del hecho (`entity_id = <task>-a<n>`); Run y Project salen de su Task y van EXPLÍCITOS. Todos llevan la Task y el
// número. Nunca el resumen, el informe, rutas, argv, proceso, worktree ni sesión: solo códigos e ids.
// `attempt.waiting` está reservado en el contrato y lo emitirá el runtime (F4) cuando entre en las esperas.

/// Por qué se detuvo un Attempt (o se rechazó su aprobación). Cerrado: quién lo pidió va en el actor.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum StopCause {
    /// Alguien pidió detenerlo (persona, coordinador o el propio Core).
    Cancelled,
    /// Se cerró el Run al que pertenece.
    RunClosed,
}

/// Motivo máquina del fallo de un Attempt. Cerrado: nunca texto libre.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum FailureCode {
    /// El proceso no llegó a arrancar.
    LaunchFailed,
    /// Nadie aprobó en la terminal a tiempo (`approval_deadline`).
    TerminalApprovalTimeout,
    /// El agente dejó de dar señales.
    AgentIdleTimeout,
    /// El propio agente cerró diciendo que falló (`lxo done --failed`).
    AgentReported,
}

impl FailureCode {
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn code(self) -> &'static str {
        match self {
            FailureCode::LaunchFailed => "launch_failed",
            FailureCode::TerminalApprovalTimeout => "terminal_approval_timeout",
            FailureCode::AgentIdleTimeout => "agent_idle_timeout",
            FailureCode::AgentReported => "agent_reported",
        }
    }
}

#[cfg_attr(not(test), allow(dead_code))]
fn attempt_draft<P: EventPayload>(a: &AttemptRow, t: &TaskRow, p: &P) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Attempt, a.id.as_str(), p)?.run(Some(t.run_id.clone())).project(t.project_id.clone()))
}

#[derive(Serialize)]
pub(super) struct AttemptRequested {
    task: String,
    n: i64,
    provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile: Option<String>,
    external: bool,
    /// Nace `pending_approval`: espera a una persona.
    approval_required: bool,
}

impl EventPayload for AttemptRequested {
    const KIND: &'static str = "attempt.requested";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn attempt_requested(a: &AttemptRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    let p = AttemptRequested {
        task: a.task_id.clone(),
        n: a.n,
        provider: clip(&a.provider, 80),
        model: a.model.as_deref().map(|v| clip(v, 80)),
        effort: a.effort.as_deref().map(|v| clip(v, 80)),
        role: a.role.as_deref().map(|v| clip(v, 80)),
        profile: a.profile.as_deref().map(|v| clip(v, 80)),
        external: a.external,
        approval_required: a.status == AttemptStatus::PendingApproval,
    };
    attempt_draft(a, t, &p)
}

macro_rules! attempt_ref_payload {
    ($name:ident, $kind:literal, $class:expr) => {
        #[derive(Serialize)]
        pub(super) struct $name {
            task: String,
            n: i64,
        }

        impl EventPayload for $name {
            const KIND: &'static str = $kind;
            const VERSION: i64 = 1;
            const CLASS: EventClass = $class;
        }
    };
}

attempt_ref_payload!(AttemptApproved, "attempt.approved", EventClass::Decision);
attempt_ref_payload!(AttemptStarted, "attempt.started", EventClass::State);

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn attempt_approved(a: &AttemptRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    attempt_draft(a, t, &AttemptApproved { task: a.task_id.clone(), n: a.n })
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn attempt_started(a: &AttemptRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    attempt_draft(a, t, &AttemptStarted { task: a.task_id.clone(), n: a.n })
}

/// La aprobación se rechazó (o dejó de tener sentido): el Attempt pasó de `pending_approval` a `stopped`.
#[derive(Serialize)]
pub(super) struct AttemptRejected {
    task: String,
    n: i64,
    cause: StopCause,
}

impl EventPayload for AttemptRejected {
    const KIND: &'static str = "attempt.rejected";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Decision;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn attempt_rejected(a: &AttemptRow, t: &TaskRow, cause: StopCause) -> Result<EventDraft, EventError> {
    attempt_draft(a, t, &AttemptRejected { task: a.task_id.clone(), n: a.n, cause })
}

/// El resumen NO viaja: solo si lo había.
#[derive(Serialize)]
pub(super) struct AttemptCompleted {
    task: String,
    n: i64,
    has_summary: bool,
}

impl EventPayload for AttemptCompleted {
    const KIND: &'static str = "attempt.completed";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn attempt_completed(a: &AttemptRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    attempt_draft(a, t, &AttemptCompleted { task: a.task_id.clone(), n: a.n, has_summary: !a.summary.is_empty() })
}

#[derive(Serialize)]
pub(super) struct AttemptFailed {
    task: String,
    n: i64,
    reason: FailureCode,
    has_summary: bool,
}

impl EventPayload for AttemptFailed {
    const KIND: &'static str = "attempt.failed";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn attempt_failed(a: &AttemptRow, t: &TaskRow, reason: FailureCode) -> Result<EventDraft, EventError> {
    attempt_draft(a, t, &AttemptFailed { task: a.task_id.clone(), n: a.n, reason, has_summary: !a.summary.is_empty() })
}

/// `from` es el estado del que venía (`starting`, `running`, `waiting`…); nunca `pending_approval` (eso es `rejected`).
#[derive(Serialize)]
pub(super) struct AttemptStopped {
    task: String,
    n: i64,
    from: AttemptStatus,
    cause: StopCause,
}

impl EventPayload for AttemptStopped {
    const KIND: &'static str = "attempt.stopped";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn attempt_stopped(a: &AttemptRow, t: &TaskRow, from: AttemptStatus, cause: StopCause) -> Result<EventDraft, EventError> {
    attempt_draft(a, t, &AttemptStopped { task: a.task_id.clone(), n: a.n, from, cause })
}

// ---------------------------------------------------------------------------------------------
// ProviderSession y Thread (LXO-115)
// ---------------------------------------------------------------------------------------------
//
// Los emite `session_ops` (inertes hasta el corte). Run y Project, los de la Task dueña. NUNCA la referencia del
// proveedor (`external_ref`), el resumen del Thread ni cuerpos de mensaje: solo ids, códigos y si hay o no.

#[cfg_attr(not(test), allow(dead_code))]
fn session_draft<P: EventPayload>(s: &ProviderSessionRow, t: &TaskRow, p: &P) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::ProviderSession, s.id.as_str(), p)?.run(Some(t.run_id.clone())).project(t.project_id.clone()))
}

#[derive(Serialize)]
pub(super) struct ProviderSessionOpened {
    task: String,
    attempt: String,
    n: i64,
    provider: String,
    resumable: bool,
    /// La referencia ya llegó con la apertura.
    bound: bool,
}

impl EventPayload for ProviderSessionOpened {
    const KIND: &'static str = "provider_session.opened";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn provider_session_opened(s: &ProviderSessionRow, a: &AttemptRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    let p = ProviderSessionOpened { task: s.task_id.clone(), attempt: a.id.clone(), n: a.n, provider: clip(&s.provider, 80), resumable: s.resumable, bound: s.external_ref.is_some() };
    session_draft(s, t, &p)
}

#[derive(Serialize)]
pub(super) struct ProviderSessionBound {
    task: String,
    binding: SessionBinding,
}

impl EventPayload for ProviderSessionBound {
    const KIND: &'static str = "provider_session.bound";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn provider_session_bound(s: &ProviderSessionRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    let binding = s.binding.ok_or_else(|| EventError::Serialize("provider_session.bound: la sesión no tiene vínculo".into()))?;
    session_draft(s, t, &ProviderSessionBound { task: s.task_id.clone(), binding })
}

#[derive(Serialize)]
pub(super) struct ProviderSessionResumed {
    task: String,
    attempt: String,
    n: i64,
}

impl EventPayload for ProviderSessionResumed {
    const KIND: &'static str = "provider_session.resumed";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn provider_session_resumed(s: &ProviderSessionRow, a: &AttemptRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    session_draft(s, t, &ProviderSessionResumed { task: s.task_id.clone(), attempt: a.id.clone(), n: a.n })
}

#[derive(Serialize)]
pub(super) struct ProviderSessionDetached {
    task: String,
}

impl EventPayload for ProviderSessionDetached {
    const KIND: &'static str = "provider_session.detached";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn provider_session_detached(s: &ProviderSessionRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    session_draft(s, t, &ProviderSessionDetached { task: s.task_id.clone() })
}

#[derive(Serialize)]
pub(super) struct ProviderSessionClosed {
    task: String,
    from: SessionStatus,
}

impl EventPayload for ProviderSessionClosed {
    const KIND: &'static str = "provider_session.closed";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn provider_session_closed(s: &ProviderSessionRow, from: SessionStatus, t: &TaskRow) -> Result<EventDraft, EventError> {
    session_draft(s, t, &ProviderSessionClosed { task: s.task_id.clone(), from })
}

#[cfg_attr(not(test), allow(dead_code))]
fn thread_draft<P: EventPayload>(th: &ThreadRow, t: &TaskRow, p: &P) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Thread, th.id.as_str(), p)?.run(Some(t.run_id.clone())).project(t.project_id.clone()))
}

#[derive(Serialize)]
pub(super) struct ThreadCreated {
    task: String,
}

impl EventPayload for ThreadCreated {
    const KIND: &'static str = "thread.created";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn thread_created(th: &ThreadRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    thread_draft(th, t, &ThreadCreated { task: th.task_id.clone() })
}

/// El resumen NO viaja: solo si lo hay.
#[derive(Serialize)]
pub(super) struct ThreadSummarized {
    task: String,
    has_summary: bool,
}

impl EventPayload for ThreadSummarized {
    const KIND: &'static str = "thread.summarized";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn thread_summarized(th: &ThreadRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    thread_draft(th, t, &ThreadSummarized { task: th.task_id.clone(), has_summary: th.summary.is_some() })
}

// ---------------------------------------------------------------------------------------------
// Worktree y Artifact (LXO-116)
// ---------------------------------------------------------------------------------------------
//
// Los emite `worktree_ops` (inertes hasta el corte). Run y Project, los de la Task dueña. NUNCA rutas (ni la carpeta, ni
// el repo, ni el localizador del Artifact): la rama, que ya viaja en los efectos de git, y códigos.

#[cfg_attr(not(test), allow(dead_code))]
fn worktree_draft<P: EventPayload>(w: &WorktreeRow, t: &TaskRow, p: &P) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Worktree, w.id.as_str(), p)?.run(Some(t.run_id.clone())).project(t.project_id.clone()))
}

#[derive(Serialize)]
pub(super) struct WorktreeCreated {
    task: String,
    attempt: String,
    n: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
}

impl EventPayload for WorktreeCreated {
    const KIND: &'static str = "worktree.created";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// Un Worktree que ya existía: lo gestiona Lixbon (`adopted`) o solo lo usa (`external`).
#[derive(Serialize)]
pub(super) struct WorktreeAdopted {
    task: String,
    attempt: String,
    n: i64,
    provenance: Provenance,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
}

impl EventPayload for WorktreeAdopted {
    const KIND: &'static str = "worktree.adopted";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// `worktree.created` si lo creó Lixbon; `worktree.adopted` si ya existía.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn worktree_registered(w: &WorktreeRow, a: &AttemptRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    let branch = w.branch.as_deref().map(|b| clip(b, 255));
    match w.provenance {
        Provenance::Created => worktree_draft(w, t, &WorktreeCreated { task: w.task_id.clone(), attempt: a.id.clone(), n: a.n, branch }),
        p => worktree_draft(w, t, &WorktreeAdopted { task: w.task_id.clone(), attempt: a.id.clone(), n: a.n, provenance: p, branch }),
    }
}

#[derive(Serialize)]
pub(super) struct WorktreeAttached {
    task: String,
    attempt: String,
    n: i64,
}

impl EventPayload for WorktreeAttached {
    const KIND: &'static str = "worktree.attached";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn worktree_attached(w: &WorktreeRow, a: &AttemptRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    worktree_draft(w, t, &WorktreeAttached { task: w.task_id.clone(), attempt: a.id.clone(), n: a.n })
}

#[derive(Serialize)]
pub(super) struct WorktreeMissing {
    task: String,
}

impl EventPayload for WorktreeMissing {
    const KIND: &'static str = "worktree.missing";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn worktree_missing(w: &WorktreeRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    worktree_draft(w, t, &WorktreeMissing { task: w.task_id.clone() })
}

#[derive(Serialize)]
pub(super) struct WorktreeFound {
    task: String,
}

impl EventPayload for WorktreeFound {
    const KIND: &'static str = "worktree.found";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn worktree_found(w: &WorktreeRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    worktree_draft(w, t, &WorktreeFound { task: w.task_id.clone() })
}

#[derive(Serialize)]
pub(super) struct WorktreeRemoved {
    task: String,
    reason: RemovalReason,
    branch_kept: bool,
}

impl EventPayload for WorktreeRemoved {
    const KIND: &'static str = "worktree.removed";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn worktree_removed(w: &WorktreeRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    let reason = w.removed_reason.ok_or_else(|| EventError::Serialize("worktree.removed: el Worktree no tiene motivo".into()))?;
    worktree_draft(w, t, &WorktreeRemoved { task: w.task_id.clone(), reason, branch_kept: w.branch_kept })
}

/// El localizador NO viaja: solo el tipo y si trae hash para verificarlo.
#[derive(Serialize)]
pub(super) struct ArtifactCreated {
    task: String,
    attempt: String,
    n: i64,
    kind: ArtifactKind,
    verifiable: bool,
}

impl EventPayload for ArtifactCreated {
    const KIND: &'static str = "artifact.created";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[cfg_attr(not(test), allow(dead_code))]
pub(super) fn artifact_created(x: &ArtifactRow, a: &AttemptRow, t: &TaskRow) -> Result<EventDraft, EventError> {
    let p = ArtifactCreated { task: a.task_id.clone(), attempt: a.id.clone(), n: a.n, kind: x.kind, verifiable: x.sha256.is_some() };
    Ok(EventDraft::new(EntityKind::Artifact, x.id.as_str(), &p)?.run(Some(t.run_id.clone())).project(t.project_id.clone()))
}

// ---------------------------------------------------------------------------------------------
// project.registered
// ---------------------------------------------------------------------------------------------

/// Cómo llegó un Project al registro. Cerrado: es el único dato de PROCEDENCIA del hecho (quién lo
/// provocó va en el actor y por dónde llegó en el canal).
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum ProjectOrigin {
    /// La persona registró el repositorio (`project_add`).
    Manual,
    /// Se descubrió al lanzar un run (`run_create`), sin preguntar: era inequívocamente nuevo.
    Auto,
    /// El relleno de `project_id` de las tareas anteriores a D.
    Backfill,
    /// La importación de las carpetas recientes de la interfaz.
    Import,
}

/// El Project NACIÓ. Este hecho solo existe cuando la fila `projects` se insertó de verdad: encontrar un
/// proyecto ya registrado, una ambigüedad o un `join` NO lo emiten. Sin ruta, `display_path`, remoto,
/// commits ni huella: la identidad física del repositorio vive en el registro, no en el log.
#[derive(Serialize)]
pub(super) struct ProjectRegistered {
    origin: ProjectOrigin,
    name: String,
    has_remote: bool,
    root_commit_count: usize,
}

impl EventPayload for ProjectRegistered {
    const KIND: &'static str = "project.registered";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// Entidad: el proyecto. `run_id` NULL (no pertenece a ningún run). `idem_key = project_id`: un proyecto
/// nace una sola vez y su evento no se duplica. El `project_id` se pre-genera FUERA de la transacción y es
/// el mismo de la fila: el borrador lo lleva explícito (nunca `project_from_task`).
pub(super) fn project_registered(project_id: &str, name: &str, fingerprint: &Fingerprint, origin: ProjectOrigin) -> Result<EventDraft, EventError> {
    let p = ProjectRegistered { origin, name: clip(name, 120), has_remote: !fingerprint.remotes.is_empty(), root_commit_count: fingerprint.root_commits.len() };
    Ok(EventDraft::new(EntityKind::Project, project_id, &p)?.project(Some(project_id.to_string())).run(None).idempotent(project_id))
}

// ---------------------------------------------------------------------------------------------
// project.location_added · project.archived · project.restored · project.relocated
// ---------------------------------------------------------------------------------------------
//
// Decisiones de gestión de una PERSONA sobre un Project que ya existe. Todas: clase `decision`, entidad
// `project`, `run_id` NULL, sin `idem_key` (archivar, restaurar y volver a archivar es legítimo), actor Person
// y canal Ui (lo valida `project_ops::Management`). Nunca rutas, remotos, huellas ni commits.

/// Se añadió una ubicación a un proyecto que ya existía (`join`).
#[derive(Serialize)]
pub(super) struct ProjectLocationAdded {
    /// ¿La ubicación nueva quedó como la principal? Es lo que se ESCRIBIÓ, no una intención.
    primary: bool,
    /// ¿Cambió de verdad la huella guardada (se adoptaron los remotos del repositorio nuevo)?
    fingerprint_adopted: bool,
}

impl EventPayload for ProjectLocationAdded {
    const KIND: &'static str = "project.location_added";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Decision;
}

pub(super) fn project_location_added(project_id: &str, primary: bool, fingerprint_adopted: bool) -> Result<EventDraft, EventError> {
    let p = ProjectLocationAdded { primary, fingerprint_adopted };
    Ok(EventDraft::new(EntityKind::Project, project_id, &p)?.project(Some(project_id.to_string())).run(None))
}

// ---------------------------------------------------------------------------------------------
// attention.risk_acted
// ---------------------------------------------------------------------------------------------

/// Decisión humana de cerrar un riesgo explícito. Sin facts ni credenciales; el id también deduplica reintentos.
#[derive(Serialize)]
pub(super) struct AttentionRiskActed {
    resolution: Resolution,
}

impl EventPayload for AttentionRiskActed {
    const KIND: &'static str = "attention.risk_acted";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Decision;
}

pub(super) fn attention_risk_acted(attention_id: &str, project_id: Option<String>, run_id: Option<String>) -> Result<EventDraft, EventError> {
    let payload = AttentionRiskActed { resolution: Resolution::Acted };
    Ok(EventDraft::new(EntityKind::Attention, attention_id, &payload)?
        .project(project_id)
        .run(run_id)
        .correlated(attention_id)
        .idempotent(attention_id))
}

/// El proyecto pasó de activo a archivado. El estado anterior y el nuevo los dice el `kind`.
#[derive(Serialize)]
pub(super) struct ProjectArchived {}

impl EventPayload for ProjectArchived {
    const KIND: &'static str = "project.archived";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Decision;
}

pub(super) fn project_archived(project_id: &str) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Project, project_id, &ProjectArchived {})?.project(Some(project_id.to_string())).run(None))
}

/// El proyecto pasó de archivado a activo.
#[derive(Serialize)]
pub(super) struct ProjectRestored {}

impl EventPayload for ProjectRestored {
    const KIND: &'static str = "project.restored";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Decision;
}

pub(super) fn project_restored(project_id: &str) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Project, project_id, &ProjectRestored {})?.project(Some(project_id.to_string())).run(None))
}

/// La persona indicó dónde está ahora el proyecto (`project_locate`): la nueva ubicación pasa a ser la principal.
#[derive(Serialize)]
pub(super) struct ProjectRelocated {
    /// ¿Cambió de verdad la huella guardada (el proyecto no tenía commits raíz y adoptó los del repositorio)?
    fingerprint_adopted: bool,
    /// `true` SOLO cuando la persona usó `confirm` para aceptar un repositorio cuyos commits raíz no coincidían.
    confirmed_mismatch: bool,
}

impl EventPayload for ProjectRelocated {
    const KIND: &'static str = "project.relocated";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Decision;
}

pub(super) fn project_relocated(project_id: &str, fingerprint_adopted: bool, confirmed_mismatch: bool) -> Result<EventDraft, EventError> {
    let p = ProjectRelocated { fingerprint_adopted, confirmed_mismatch };
    Ok(EventDraft::new(EntityKind::Project, project_id, &p)?.project(Some(project_id.to_string())).run(None))
}

// ---------------------------------------------------------------------------------------------
// spawn.requested · spawn.resolved
// ---------------------------------------------------------------------------------------------
//
// Una solicitud de lanzamiento (`lxo spawn`) y su resolución. La entidad es la solicitud
// (`spawn_request` / `pending_id`); `correlation_id` e `idem_key` son el `pending_id`, así que hay como mucho
// UNA solicitud y UNA resolución por `pending_id`. Nunca `spec`, `spec_summary`, `argv`, `cwd`, `env`,
// `integrate_into`, rutas, `policy.reason`, avisos ni credenciales.

/// Una solicitud de lanzamiento persistida ANTES de existir como pendiente en memoria.
#[derive(Serialize)]
pub(super) struct SpawnRequested {
    parent_task: String,
    provider: String,
    profile: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    title: String,
    shared: bool,
    policy_status: agents::Status,
    expires_at: u64,
}

impl EventPayload for SpawnRequested {
    const KIND: &'static str = "spawn.requested";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// Lo que describe la solicitud (todo validado al pedirla; nada del encargo ni de la política efectiva).
pub(super) struct SpawnRequestFacts<'a> {
    pub pending_id: &'a str,
    pub parent_task: &'a str,
    pub run: &'a str,
    pub provider: &'a str,
    pub profile: &'a str,
    pub role: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub title: &'a str,
    pub shared: bool,
    pub policy_status: agents::Status,
    pub expires_at: u64,
}

/// `project_id` de la tarea padre: se resuelve al finalizar contra el estado confirmado (`project_from_task`).
pub(super) fn spawn_requested(f: &SpawnRequestFacts<'_>) -> Result<EventDraft, EventError> {
    let p = SpawnRequested {
        parent_task: f.parent_task.into(),
        provider: f.provider.into(),
        profile: f.profile.into(),
        role: f.role.map(Into::into),
        model: f.model.map(Into::into),
        effort: f.effort.map(Into::into),
        title: clip(f.title, 120),
        shared: f.shared,
        policy_status: f.policy_status,
        expires_at: f.expires_at,
    };
    Ok(EventDraft::new(EntityKind::SpawnRequest, f.pending_id, &p)?
        .run(Some(f.run.to_string()).filter(|r| !r.is_empty()))
        .project_from_task(f.parent_task)
        .correlated(f.pending_id)
        .idempotent(f.pending_id))
}

/// Cómo terminó una solicitud. Cerrado. `expired` NO es un resultado del Event Log: es solo el estado/API
/// compatible de `spawn_status`. La reconciliación de solicitudes tras reiniciar tiene seguimiento separado.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(super) enum SpawnOutcome {
    Approved,
    Rejected,
    LaunchFailed,
    Timeout,
    CoordinatorClosed,
    CancelledRunRemoved,
}

impl SpawnOutcome {
    /// ¿La toma una persona desde la interfaz (`person/ui`) o el propio Core (`system/core`)?
    pub(super) fn decided_by_person(self) -> bool {
        !matches!(self, SpawnOutcome::Timeout | SpawnOutcome::CoordinatorClosed)
    }
}

#[derive(Serialize)]
pub(super) struct SpawnResolved {
    outcome: SpawnOutcome,
    /// SOLO cuando realmente existe una hija.
    #[serde(skip_serializing_if = "Option::is_none")]
    task: Option<String>,
    /// ¿Hay un motivo (la razón del rechazo, el error del lanzamiento)? El texto nunca viaja en el evento.
    has_reason: bool,
}

impl EventPayload for SpawnResolved {
    const KIND: &'static str = "spawn.resolved";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::Decision;
}

/// `run` y `project` van explícitos: al finalizar, la tarea padre puede haber desaparecido con el run.
pub(super) fn spawn_resolved(pending_id: &str, run: &str, project: Option<String>, outcome: SpawnOutcome, task: Option<&str>, has_reason: bool) -> Result<EventDraft, EventError> {
    let p = SpawnResolved { outcome, task: task.map(Into::into), has_reason };
    Ok(EventDraft::new(EntityKind::SpawnRequest, pending_id, &p)?
        .run(Some(run.to_string()).filter(|r| !r.is_empty()))
        .project(project)
        .correlated(pending_id)
        .idempotent(pending_id))
}

// ---------------------------------------------------------------------------------------------
// task.review_requested
// ---------------------------------------------------------------------------------------------
//
// «Esta hija entregó con éxito y su resultado espera la revisión de la persona.» Lo emite UN sitio —`Tx::done`— en la
// transición `→ done` de una Task con padre y rama propia. Es la señal fuente de `review_ready` (LXO-88): la
// proyección no lo deduce de la rama, del estado ni de la ausencia de una decisión. No hay `idem_key`: cada entrega
// (también tras reabrir la tarea) es otro hecho. Sin informe, resumen, ficheros ni rutas.

#[derive(Serialize)]
pub(super) struct TaskReviewRequested {
    branch: String,
}

impl EventPayload for TaskReviewRequested {
    const KIND: &'static str = "task.review_requested";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

pub(super) fn task_review_requested(task: &str, run: &str, branch: &str) -> Result<EventDraft, EventError> {
    let p = TaskReviewRequested { branch: clip(branch, 300) };
    Ok(EventDraft::new(EntityKind::Task, task, &p)?.run(Some(run.to_string()).filter(|r| !r.is_empty())).project_from_task(task))
}

// ---------------------------------------------------------------------------------------------
// environment.blocked · environment.cleared
// ---------------------------------------------------------------------------------------------
//
// El host comprobó (policy, antes de lanzar) que el ENTORNO o el proveedor impide trabajar con `provider` en el perfil
// `profile` (`code` cerrado y TIPADO: `agents::EnvBlock`), y más tarde que dejó de impedirlo. Es una condición del proveedor, no de una
// Task ni de un intento: no cambia el estado de ninguna Task (en particular, no es un fallo). Lo emiten solo
// `Tx::environment_blocked` / `Tx::environment_verified`, y únicamente cuando el conjunto de causas vigentes CAMBIA (el mapa
// `State.env_blocks` hace de memoria durable), así que no hay un evento por cada comprobación. Una causa nueva no
// reemplaza a las activas: se suma, y `cleared` se emite solo con prueba positiva de ESA causa. Actor `system`, canal `core`.

#[derive(Serialize)]
pub(super) struct EnvironmentBlocked {
    profile: String,
    code: agents::EnvBlock,
}

impl EventPayload for EnvironmentBlocked {
    const KIND: &'static str = "environment.blocked";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[derive(Serialize)]
pub(super) struct EnvironmentCleared {
    profile: String,
    code: agents::EnvBlock,
}

impl EventPayload for EnvironmentCleared {
    const KIND: &'static str = "environment.cleared";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

pub(super) fn environment_blocked(provider: &str, profile: &str, code: agents::EnvBlock) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Agent, provider, &EnvironmentBlocked { profile: profile.into(), code })?.run(None).project(None))
}

pub(super) fn environment_cleared(provider: &str, profile: &str, code: agents::EnvBlock) -> Result<EventDraft, EventError> {
    Ok(EventDraft::new(EntityKind::Agent, provider, &EnvironmentCleared { profile: profile.into(), code })?.run(None).project(None))
}
