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
    objective: String,
}

impl EventPayload for RunCreated {
    const KIND: &'static str = "run.created";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

pub(super) fn run_created(run: &str, root_task: &str, objective: &str) -> Result<EventDraft, EventError> {
    let p = RunCreated { root_task: root_task.into(), objective: clip(objective, 120) };
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
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

impl EventPayload for TaskPhase {
    const KIND: &'static str = "task.phase";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

pub(super) fn task_phase(task: &str, run: &str, name: &str, done: bool, note: &str) -> Result<EventDraft, EventError> {
    let p = TaskPhase { name: clip(name, 80), done, note: Some(note).filter(|n| !n.trim().is_empty()).map(|n| clip(n, 200)) };
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
    answered_by: String,
}

impl EventPayload for TaskReply {
    const KIND: &'static str = "task.reply";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

/// La entidad es la tarea que PREGUNTÓ (el hilo de la pregunta); quien responde es el actor.
pub(super) fn task_reply(asker_task: &str, run: &str, question_id: u64, message_id: u64, answered_by: &str) -> Result<EventDraft, EventError> {
    let p = TaskReply { question_id, message_id, answered_by: answered_by.into() };
    Ok(EventDraft::new(EntityKind::Task, asker_task, &p)?.run(Some(run.into())).project_from_task(asker_task).correlated(format!("q{question_id}")))
}
