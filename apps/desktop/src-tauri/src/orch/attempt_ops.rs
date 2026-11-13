//! Hechos del Attempt (LXO-114): el ÚNICO sitio que construye y finaliza los borradores de sus eventos y el único
//! que llama a los mutadores `*_recorded` de `store::attempts`. Contrato: `docs/core/ATTEMPTS.md`.
//!
//! Igual que `task_ops` para la Task: las filas del Attempt son de SQLite (`008_attempts`), no de `State`, así que
//! este módulo hace de «`tx_ops` del Attempt».
//!
//! ```text
//! start(st, ctx, id)
//!   1. leer el Attempt y autorizar (quién puede, sobre qué Task)   <- antes de abrir ninguna transacción
//!   2. Store::attempt_transition_recorded(id, Start, |fila, de, task|  <- BEGIN IMMEDIATE · UPDATE attempts
//!        event_kinds::attempt_started(fila, task)                       <- borrador tipado (único constructor)
//!        finalize_single(…)                                             <- id UUID v7, hora, actor y canal, UNA vez
//!      )                                                                <- INSERT events (+ Attention) · COMMIT
//! ```
//!
//! El closure es puro (sin E/S ni reloj): la hora se fija ANTES y es la misma para la fila y para el evento.
//!
//! # Quién puede
//! | operación | persona | agente | sistema |
//! |---|---|---|---|
//! | crear (`attempt.requested`) | sí | el que coordina la Task (ella misma o un antecesor) | no |
//! | aprobar (`attempt.approved`) | sí | no | no |
//! | arrancar (`attempt.started`) | no | no | sí (el Core lanza el proceso) |
//! | terminar (`attempt.completed`) | no | el de ESA Task | sí (recogida de informes) |
//! | fallar (`attempt.failed`) | no | el de ESA Task | sí (vigilantes, lanzamiento fallido) |
//! | cancelar (`attempt.stopped` · `attempt.rejected` si estaba pendiente) | sí | el que la coordina | sí (cierre de Run, apagado) |
//! | esperar una respuesta · volver de una espera (`attempt.waiting` · `attempt.resumed`) | no | el de ESA Task | sí |
//! | esperar la aprobación en la terminal (`attempt.waiting`) | no | no | sí (el host la detecta) |
//! | salir (`attempt.exited`) · marcar integrado (`attempt.integrated`) | no | no | sí |//!
//! Aprobar o rechazar una ejecución es una decisión de una persona; el resto del ciclo lo conduce el Core o el agente.
//!
//! **Inerte hasta el corte**: nada de esto está conectado al RPC todavía y el almacén rechaza escribir antes de
//! `meta.agentic_model` ([`StoreError::AgenticModelInactive`]).

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: lo conectará el runtime de Attempt

use super::event_kinds::{self, DispatchClaimSource, FailureCode, StopCause};
/// Lo que el proveedor declaró de su uso en un turno (LXO-249). Las capas superiores lo reciben de aquí, no de `event_kinds`.
pub(super) use super::event_kinds::{ReportedLimit, ReportedUsage};
// Las capas superiores nombran la causa por aquí: el catálogo de eventos solo lo importan quienes construyen hechos.
pub(super) use super::event_kinds::DispatchAmbiguityCause;
pub(super) use super::event_kinds::PolicyDirection;
use super::events::{Actor, MutationContext};
use super::state::now_ms;
use super::task_ops::{finalize_single, manages};
use crate::store::{AttemptAction, AttemptRow, AttemptStatus, ChangeOutcome, ContinuationRow, NewAttempt, NewEvent, RetryRow, Store, StoreError, StoreResult, TaskRow};

use crate::store::{InstructionMode, InstructionOutcome, QueueConfirmation, QueueFailure, QueueItemRow};

fn denied(what: &str, ctx: &MutationContext) -> StoreError {
    StoreError::AttemptConflict(format!("{what}: no lo puede hacer {:?} por {:?}", ctx.actor, ctx.channel))
}

fn is_system(ctx: &MutationContext) -> bool {
    ctx.actor == Actor::System
}

/// Una persona, o el agente que coordina `task` (ella misma o un antecesor).
pub(super) fn person_or_manager(st: &Store, ctx: &MutationContext, task: &str) -> StoreResult<bool> {
    Ok(match &ctx.actor {
        Actor::Person | Actor::PersonId(_) => ctx.is_person(),
        Actor::Agent(own) => manages(st, own, task)?,
        Actor::System => false,
    })
}

/// El agente de ESA Task (no el que la coordina).
fn own_agent(ctx: &MutationContext, task: &str) -> bool {
    matches!(&ctx.actor, Actor::Agent(own) if own == task)
}

/// Pide una ejecución de `task_id`: `attempt.requested`. Nace `pending_approval` si `new.requires_approval`.
pub(super) fn create(st: &mut Store, ctx: &MutationContext, task_id: &str, new: &NewAttempt) -> StoreResult<AttemptRow> {
    if !person_or_manager(st, ctx, task_id)? {
        return Err(denied(&format!("pedir una ejecución de {task_id}"), ctx));
    }
    let at = now_ms() as i64;
    st.attempt_create_recorded(task_id, new, at, |a, t| finalize_single(event_kinds::attempt_requested(a, t), ctx, at))
}

/// No se puede probar si el proveedor llegó a lanzarse (LXO-246): `attempt.dispatch_ambiguous`. Solo el Core. `from` es el claim
/// que tenía el Attempt (`reserved` o `started`; cualquier otro no admite ambigüedad).
pub(super) fn dispatch_ambiguous_fact(a: &AttemptRow, t: &TaskRow, from: &str, cause: DispatchAmbiguityCause, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    let source = DispatchClaimSource::parse(from).ok_or_else(|| StoreError::AttemptConflict(format!("un claim {from} no admite ambigüedad de despacho")))?;
    finalize_single(event_kinds::attempt_dispatch_ambiguous(a, t, source, cause), ctx, at)
}

/// Los hechos de una continuidad (LXO-134), construidos aquí para que `continuity` no importe el catálogo de eventos. Los
/// tres se confirman en la transacción del almacén con la hora de quien llama.
pub(super) fn requested_fact(a: &AttemptRow, t: &TaskRow, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_requested(a, t), ctx, at)
}

pub(super) fn continued_fact(a: &AttemptRow, c: &ContinuationRow, t: &TaskRow, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_continued(a, c, t), ctx, at)
}

pub(super) fn retried_fact(a: &AttemptRow, r: &RetryRow, t: &TaskRow, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_retried(a, r, t), ctx, at)
}

/// El hecho de un cambio de policy (LXO-209). Vive aquí, con los demás hechos, para que `policy.rs` no importe el catálogo de eventos.
#[allow(clippy::too_many_arguments)]
pub(super) fn policy_changed_fact(scope: &str, scope_id: Option<&str>, project_id: Option<&str>, category: &str, from: Option<&str>, to: Option<&str>, direction: PolicyDirection, revision: i64, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::policy_changed(scope, scope_id, project_id, category, from, to, direction, revision), ctx, at)
}

/// Los hechos de la Pending Queue (LXO-143), construidos aquí para que `queue_commands` no importe el catálogo de eventos.
/// Cada uno se confirma en la transacción del almacén (`store::queue`) con la hora de quien llama.
pub(super) fn queued_fact(a: &AttemptRow, t: &TaskRow, item: &QueueItemRow, position: i64, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_queued(a, t, item, position), ctx, at)
}

pub(super) fn queue_delivered_fact(a: &AttemptRow, t: &TaskRow, item: &QueueItemRow, confirmed_by: QueueConfirmation, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_queue_delivered(a, t, item, confirmed_by), ctx, at)
}

pub(super) fn queue_cancelled_fact(a: &AttemptRow, t: &TaskRow, item: &QueueItemRow, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_queue_cancelled(a, t, item), ctx, at)
}

pub(super) fn queue_failed_fact(a: &AttemptRow, t: &TaskRow, item: &QueueItemRow, reason: QueueFailure, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_queue_failed(a, t, item, reason), ctx, at)
}

/// Los hechos de Steer y Stop & Send (LXO-144): una petición aceptada y su resultado, unidos por `request_id`.
pub(super) fn instruction_requested_fact(a: &AttemptRow, t: &TaskRow, request_id: &str, mode: InstructionMode, chars: i64, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_instruction_requested(a, t, request_id, mode, chars), ctx, at)
}

/// El hecho `attempt.request_answered` (LXO-247): qué se respondió a una petición del proveedor (solo `allow`/`deny` en un permiso).
pub(super) fn request_answered_fact(a: &AttemptRow, t: &TaskRow, request_id: &str, kind: &'static str, decision: Option<&'static str>, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_request_answered(a, t, request_id, kind, decision), ctx, at)
}

/// El hecho `attempt.usage_reported` (LXO-249): el uso que el proveedor declaró en un turno.
pub(super) fn usage_reported_fact(a: &AttemptRow, t: &TaskRow, usage: &event_kinds::ReportedUsage, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_usage_reported(a, t, usage), ctx, at)
}

pub(super) fn instruction_result_fact(a: &AttemptRow, t: &TaskRow, request_id: &str, mode: InstructionMode, outcome: InstructionOutcome, reason: Option<QueueFailure>, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::attempt_instruction_result(a, t, request_id, mode, outcome, reason), ctx, at)
}

/// El lanzamiento de un Attempt que continúa falló por culpa del proveedor: `attempt.failed(launch_failed)`. Solo el Core.
pub(super) fn fail_launch(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    fail(st, ctx, id, FailureCode::LaunchFailed, "")
}

/// Nada llegó a ejecutarse (capability ausente, entorno bloqueado, cancelación): `attempt.stopped`, nunca `failed`.
pub(super) fn stop_unlaunched(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    cancel(st, ctx, id, StopCause::Cancelled)
}

/// Lee el Attempt para autorizar sobre su Task. `None`: no existe (el almacén devolverá `Missing`).
fn task_of(st: &Store, id: &str) -> StoreResult<Option<String>> {
    Ok(st.attempt_row(id)?.map(|a| a.task_id))
}

/// Aprueba la ejecución pendiente: `attempt.approved`. Solo una persona.
pub(super) fn approve(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    if !ctx.is_person() {
        return Err(denied(&format!("aprobar {id}"), ctx));
    }
    let at = now_ms() as i64;
    st.attempt_transition_recorded(id, &AttemptAction::Approve, at, |a, _, t| finalize_single(event_kinds::attempt_approved(a, t), ctx, at))
}

/// El proceso arrancó: `attempt.started`. Solo el Core.
pub(super) fn start(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    if !is_system(ctx) {
        return Err(denied(&format!("arrancar {id}"), ctx));
    }
    let at = now_ms() as i64;
    st.attempt_transition_recorded(id, &AttemptAction::Start, at, |a, _, t| finalize_single(event_kinds::attempt_started(a, t), ctx, at))
}

/// Termina bien: `attempt.completed`. El agente de ESA Task o el Core. El resumen NO viaja en el evento.
pub(super) fn finish(st: &mut Store, ctx: &MutationContext, id: &str, summary: &str) -> StoreResult<ChangeOutcome> {
    let Some(task) = task_of(st, id)? else { return Ok(ChangeOutcome::Missing) };
    if !(is_system(ctx) || own_agent(ctx, &task)) {
        return Err(denied(&format!("terminar {id}"), ctx));
    }
    let at = now_ms() as i64;
    st.attempt_transition_recorded(id, &AttemptAction::Finish { summary: summary.into() }, at, |a, _, t| finalize_single(event_kinds::attempt_completed(a, t), ctx, at))
}

/// Falla: `attempt.failed` con un motivo cerrado. El agente de ESA Task o el Core.
pub(super) fn fail(st: &mut Store, ctx: &MutationContext, id: &str, reason: FailureCode, summary: &str) -> StoreResult<ChangeOutcome> {
    let Some(task) = task_of(st, id)? else { return Ok(ChangeOutcome::Missing) };
    if !(is_system(ctx) || own_agent(ctx, &task)) {
        return Err(denied(&format!("dar por fallido {id}"), ctx));
    }
    let at = now_ms() as i64;
    let action = AttemptAction::Fail { reason: reason.code().into(), summary: summary.into() };
    st.attempt_transition_recorded(id, &action, at, |a, _, t| finalize_single(event_kinds::attempt_failed(a, t, reason), ctx, at))
}

/// Espera una respuesta (`lxo ask`): `attempt.waiting`. El agente de ESA Task o el Core.
pub(super) fn wait(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    let Some(task) = task_of(st, id)? else { return Ok(ChangeOutcome::Missing) };
    if !(is_system(ctx) || own_agent(ctx, &task)) {
        return Err(denied(&format!("dejar en espera {id}"), ctx));
    }
    let at = now_ms() as i64;
    st.attempt_transition_recorded(id, &AttemptAction::Wait, at, |a, from, t| finalize_single(event_kinds::attempt_waiting(a, t, from), ctx, at))
}

/// Espera que una persona apruebe en la terminal: `attempt.waiting`. Solo el Core (el host lo detecta).
pub(super) fn await_terminal(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    if !is_system(ctx) {
        return Err(denied(&format!("esperar la aprobación de {id}"), ctx));
    }
    let at = now_ms() as i64;
    st.attempt_transition_recorded(id, &AttemptAction::AwaitTerminal, at, |a, from, t| finalize_single(event_kinds::attempt_waiting(a, t, from), ctx, at))
}

/// Vuelve a `running` tras una espera: `attempt.resumed`. El agente de ESA Task o el Core.
pub(super) fn resume(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    let Some(task) = task_of(st, id)? else { return Ok(ChangeOutcome::Missing) };
    if !(is_system(ctx) || own_agent(ctx, &task)) {
        return Err(denied(&format!("reanudar {id}"), ctx));
    }
    let at = now_ms() as i64;
    st.attempt_transition_recorded(id, &AttemptAction::Resume, at, |a, from, t| finalize_single(event_kinds::attempt_resumed(a, t, from), ctx, at))
}

/// El proceso terminó sin cerrar el Attempt: `attempt.exited`. Solo el Core.
pub(super) fn exit(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    if !is_system(ctx) {
        return Err(denied(&format!("dar por salido {id}"), ctx));
    }
    let at = now_ms() as i64;
    st.attempt_transition_recorded(id, &AttemptAction::Exit, at, |a, from, t| finalize_single(event_kinds::attempt_exited(a, t, from), ctx, at))
}

/// Su trabajo quedó integrado: `attempt.integrated`. Solo el Core, tras el efecto de integración.
pub(super) fn integrate(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    if !is_system(ctx) {
        return Err(denied(&format!("marcar integrado {id}"), ctx));
    }
    let at = now_ms() as i64;
    st.attempt_integrate_recorded(id, at, |a, t| finalize_single(event_kinds::attempt_integrated(a, t), ctx, at))
}

/// Cancela: `attempt.stopped` (o `attempt.rejected` si todavía esperaba aprobación). Una persona, el que coordina la
/// Task o el Core. Un Attempt final no se cancela: el almacén lo rechaza.
pub(super) fn cancel(st: &mut Store, ctx: &MutationContext, id: &str, cause: StopCause) -> StoreResult<ChangeOutcome> {
    let Some(task) = task_of(st, id)? else { return Ok(ChangeOutcome::Missing) };
    if !(is_system(ctx) || person_or_manager(st, ctx, &task)?) {
        return Err(denied(&format!("cancelar {id}"), ctx));
    }
    let at = now_ms() as i64;
    st.attempt_transition_recorded(id, &AttemptAction::Cancel, at, |a, from, t| {
        let draft = if from == AttemptStatus::PendingApproval { event_kinds::attempt_rejected(a, t, cause) } else { event_kinds::attempt_stopped(a, t, from, cause) };
        finalize_single(draft, ctx, at)
    })
}
