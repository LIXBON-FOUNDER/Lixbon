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

use serde::Serialize;

use super::events::{EntityKind, EventDraft, EventError, EventPayload};
use super::state::{Status, Task};
use crate::store::EventClass;

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

fn req_str(d: &serde_json::Value, key: &str) -> Result<String, String> {
    match d.get(key).and_then(|v| v.as_str()) {
        Some(s) if !s.trim().is_empty() => Ok(clip(s, 300)),
        _ => Err(format!("decision.recorded: falta `{key}` (texto no vacío) en el detalle")),
    }
}

fn opt_str(d: &serde_json::Value, key: &str) -> Result<Option<String>, String> {
    match d.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(clip(s, 300))),
        Some(_) => Err(format!("decision.recorded: `{key}` debe ser texto o null")),
    }
}

fn opt_bool(d: &serde_json::Value, key: &str) -> Result<Option<bool>, String> {
    match d.get(key) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(format!("decision.recorded: `{key}` debe ser booleano o null")),
    }
}

fn outcome_str<'a>(d: &'a serde_json::Value, key: &str, allowed: &[&str]) -> Result<&'a str, String> {
    match d.get(key).and_then(|v| v.as_str()) {
        Some(s) if allowed.contains(&s) => Ok(s),
        other => Err(format!("decision.recorded: `{key}` {other:?} fuera del contrato (admitidos: {})", allowed.join(", "))),
    }
}

impl DecisionRecorded {
    /// Valida y normaliza el `detail` de una fila `Decision` según su `kind`. `Ok(None)`: la excepción
    /// explícita [`DECISION_KINDS_WITHOUT_EVENT`] (fila sí, evento no). Cualquier otro `kind`, o un
    /// detalle que no cumple el contrato, es un error: la mutación completa se rechaza.
    pub(super) fn parse(kind: &str, detail: &serde_json::Value) -> Result<Option<DecisionRecorded>, String> {
        Ok(Some(match kind {
            "review" => {
                let outcome = match outcome_str(detail, "decision", &["accepted", "rejected"])? {
                    "accepted" => ReviewOutcome::Accepted,
                    _ => ReviewOutcome::Rejected,
                };
                DecisionRecorded::Review {
                    decision_id: 0,
                    outcome,
                    head_commit: req_str(detail, "head_commit")?,
                    base_commit: opt_str(detail, "base_commit")?,
                    base_source: opt_str(detail, "base_source")?,
                    has_comment: opt_str(detail, "comment")?.is_some_and(|c| !c.trim().is_empty()),
                }
            }
            "merge" => {
                let outcome = match outcome_str(detail, "outcome", &["merged", "conflict", "error", "target_moved"])? {
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
                    branch: req_str(detail, "branch")?,
                    squash: opt_bool(detail, "squash")?.ok_or("decision.recorded: falta `squash` (booleano) en el detalle")?,
                    base_commit: opt_str(detail, "base_commit")?,
                    result_commit: opt_str(detail, "result_commit")?,
                    conflict_count,
                    base_check: opt_str(detail, "base_check")?,
                    accepted_moved_target: opt_bool(detail, "accepted_moved_target")?,
                    expected_commit: opt_str(detail, "expected_commit")?,
                    found_commit: opt_str(detail, "found_commit")?,
                }
            }
            "pr" => {
                let outcome = match outcome_str(detail, "outcome", &["created", "already_exists", "error"])? {
                    "created" => PrOutcome::Created,
                    "already_exists" => PrOutcome::AlreadyExists,
                    _ => PrOutcome::Error,
                };
                DecisionRecorded::Pr { decision_id: 0, outcome, branch: req_str(detail, "branch")?, pr_url: opt_str(detail, "pr_url")? }
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
