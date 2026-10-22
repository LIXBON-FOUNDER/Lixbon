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
//!
//! Aprobar o rechazar una ejecución es una decisión de una persona; el resto del ciclo lo conduce el Core o el agente.
//!
//! **Inerte hasta el corte**: nada de esto está conectado al RPC todavía y el almacén rechaza escribir antes de
//! `meta.agentic_model` ([`StoreError::AgenticModelInactive`]).

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: lo conectará el runtime de Attempt

use super::event_kinds::{self, FailureCode, StopCause};
use super::events::{Actor, MutationContext};
use super::state::now_ms;
use super::task_ops::{finalize_single, manages};
use crate::store::{AttemptAction, AttemptRow, AttemptStatus, ChangeOutcome, NewAttempt, Store, StoreError, StoreResult};

fn denied(what: &str, ctx: &MutationContext) -> StoreError {
    StoreError::AttemptConflict(format!("{what}: no lo puede hacer {:?} por {:?}", ctx.actor, ctx.channel))
}

fn is_system(ctx: &MutationContext) -> bool {
    ctx.actor == Actor::System
}

/// Una persona, o el agente que coordina `task` (ella misma o un antecesor).
fn person_or_manager(st: &Store, ctx: &MutationContext, task: &str) -> StoreResult<bool> {
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
