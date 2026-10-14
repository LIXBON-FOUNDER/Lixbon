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
//! | `project.location_added` · `project.archived` · `project.restored` · `project.relocated` | decision | `project` |

use serde::Serialize;

use super::events::{EntityKind, EventDraft, EventError, EventPayload};
use super::state::{Status, Task};
use crate::store::{EventClass, Fingerprint};

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

/// `Decision.kind` que conservan su fila legacy pero NO emiten `decision.recorded`. Excepción única y
/// explícita: `spawn` lo representará `spawn.resolved` (bloque de lanzamientos pendientes); emitirlo
/// aquí lo duplicaría. Un `kind` que no esté ni en el contrato ni en esta lista rechaza la mutación.
pub(super) const DECISION_KINDS_WITHOUT_EVENT: [&str; 1] = ["spawn"];

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
    /// Valida y normaliza el `detail` de una fila `Decision` según su `kind`. `Ok(None)`: la excepción
    /// explícita [`DECISION_KINDS_WITHOUT_EVENT`] (fila sí, evento no). Cualquier otro `kind`, o un
    /// detalle que no cumple el contrato, es un error: la mutación completa se rechaza.
    pub(super) fn parse(kind: &str, detail: &serde_json::Value) -> Result<Option<DecisionRecorded>, String> {
        Ok(Some(match kind {
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
                DecisionRecorded::Pr { decision_id: 0, outcome, branch: req_str(DEC, detail, "branch")?, pr_url: opt_str(DEC, detail, "pr_url")? }
            }
            k if DECISION_KINDS_WITHOUT_EVENT.contains(&k) => return Ok(None),
            other => return Err(format!("decision.recorded: decision_kind {other:?} fuera del contrato (review, merge, pr)")),
        }))
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

/// `Effect.kind` que solo viajan al diario de recuperación y NO emiten `effect.observed`. Excepción
/// temporal y explícita: `spawn_outcome` no es un efecto externo sino el marcador del registro de la
/// decisión `spawn`, cuyo hecho es `spawn.resolved` (bloque de lanzamientos pendientes).
pub(super) const EFFECT_KINDS_WITHOUT_EVENT: [&str; 1] = ["spawn_outcome"];

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
    /// Valida y normaliza lo observado por un `Effect`. `Ok(None)`: la excepción explícita
    /// [`EFFECT_KINDS_WITHOUT_EVENT`]. Un `kind` desconocido o un detalle fuera de contrato es un error.
    pub(super) fn parse(effect_id: &str, operation: &str, kind: &str, observed: &serde_json::Value) -> Result<Option<EffectObserved>, String> {
        let id = effect_id.to_string();
        Ok(Some(match kind {
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
                    pr_url: opt_str(EFF, observed, "pr_url")?,
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
            k if EFFECT_KINDS_WITHOUT_EVENT.contains(&k) => return Ok(None),
            other => return Err(format!("{EFF}: effect_kind {other:?} fuera del contrato (git_merge, git_push_pr, git_worktree, git_worktree_removed, pty_process)")),
        }))
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

/// Por qué se retiró una Task. Cerrado: hoy solo el cleanup de un lanzamiento fallido.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum RemovalCause {
    LaunchFailed,
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
