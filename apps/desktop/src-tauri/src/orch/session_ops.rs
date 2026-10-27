//! Hechos de ProviderSession y Thread (LXO-115): el ÚNICO sitio que construye sus eventos y el único que llama a los
//! mutadores `*_recorded` de `store::sessions`. Contrato: `docs/core/SESIONES_THREADS.md`.
//!
//! Mismo esquema que `attempt_ops`: autorizar antes de abrir la transacción, hora fijada una vez, closure puro.
//!
//! # Quién puede
//! | operación | persona | agente | sistema |
//! |---|---|---|---|
//! | abrir · fijar la referencia · reanudar · dejar en espera | no | no | sí (el Core lanza el proceso y lee al proveedor) |
//! | cerrar | sí | no | sí |
//! | abrir el Thread · fijar su resumen | no | no | sí |
//!
//! Un agente nunca declara su propia sesión: la referencia la lee el Core del proveedor, no la dice el agente.
//!
//! **Inerte hasta el corte**: sin conexión al RPC; el almacén rechaza escribir antes de `meta.agentic_model`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: lo conectará el runtime (F4)

use super::event_kinds;
use super::events::{Actor, MutationContext};
use super::state::now_ms;
use super::task_ops::finalize_single;
use crate::store::{AttemptRow, ChangeOutcome, NewEvent, NewProviderSession, ProviderSessionRow, SessionBinding, SessionStatus, SessionStep, Store, StoreError, StoreResult, TaskRow, ThreadRow};

fn require(ok: bool, what: &str, ctx: &MutationContext) -> StoreResult<()> {
    if ok {
        Ok(())
    } else {
        Err(StoreError::SessionConflict(format!("{what}: no lo puede hacer {:?} por {:?}", ctx.actor, ctx.channel)))
    }
}

fn system(ctx: &MutationContext) -> bool {
    ctx.actor == Actor::System
}

/// El Attempt abre su sesión: `provider_session.opened`.
pub(super) fn open(st: &mut Store, ctx: &MutationContext, attempt_id: &str, new: &NewProviderSession) -> StoreResult<ProviderSessionRow> {
    require(system(ctx), &format!("abrir la sesión de {attempt_id}"), ctx)?;
    let at = now_ms() as i64;
    st.provider_session_open_recorded(attempt_id, new, at, |s, a, t| finalize_single(event_kinds::provider_session_opened(s, a, t), ctx, at))
}

/// El proveedor entregó la referencia: `provider_session.bound` (sin la referencia).
pub(super) fn bind(st: &mut Store, ctx: &MutationContext, id: &str, external_ref: &str, binding: SessionBinding) -> StoreResult<ChangeOutcome> {
    require(system(ctx), &format!("fijar la referencia de {id}"), ctx)?;
    let at = now_ms() as i64;
    st.provider_session_bind_recorded(id, external_ref, binding, at, |s, t| finalize_single(event_kinds::provider_session_bound(s, t), ctx, at))
}

/// Un seguimiento reanuda la sesión: `provider_session.resumed`.
pub(super) fn resume(st: &mut Store, ctx: &MutationContext, id: &str, attempt_id: &str) -> StoreResult<ChangeOutcome> {
    require(system(ctx), &format!("reanudar {id}"), ctx)?;
    let at = now_ms() as i64;
    st.provider_session_resume_recorded(id, attempt_id, at, |s, a, t| finalize_single(event_kinds::provider_session_resumed(s, a, t), ctx, at))
}

/// El hecho de que un seguimiento reanudó la sesión, para la transacción de la continuidad (LXO-134).
pub(super) fn resumed_fact(s: &ProviderSessionRow, a: &AttemptRow, t: &TaskRow, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize_single(event_kinds::provider_session_resumed(s, a, t), ctx, at)
}

/// Queda en espera de un seguimiento: `provider_session.detached`.
pub(super) fn detach(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    require(system(ctx), &format!("dejar en espera {id}"), ctx)?;
    let at = now_ms() as i64;
    st.provider_session_transition_recorded(id, SessionStep::Detach, at, |s, _, t| finalize_single(event_kinds::provider_session_detached(s, t), ctx, at))
}

/// Cierra la sesión (final): `provider_session.closed`. El Core o una persona.
pub(super) fn close(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    require(system(ctx) || ctx.is_person(), &format!("cerrar {id}"), ctx)?;
    let at = now_ms() as i64;
    st.provider_session_transition_recorded(id, SessionStep::Close, at, |s, from: SessionStatus, t| finalize_single(event_kinds::provider_session_closed(s, from, t), ctx, at))
}

/// Nace el Thread de la Task: `thread.created`.
pub(super) fn open_thread(st: &mut Store, ctx: &MutationContext, task_id: &str) -> StoreResult<ThreadRow> {
    require(system(ctx), &format!("abrir el Thread de {task_id}"), ctx)?;
    let at = now_ms() as i64;
    st.thread_open_recorded(task_id, at, |th, t| finalize_single(event_kinds::thread_created(th, t), ctx, at))
}

/// Fija o borra el resumen del Thread: `thread.summarized` (sin el resumen).
pub(super) fn summarize(st: &mut Store, ctx: &MutationContext, id: &str, summary: Option<&str>) -> StoreResult<ChangeOutcome> {
    require(system(ctx), &format!("resumir {id}"), ctx)?;
    let at = now_ms() as i64;
    st.thread_summary_set_recorded(id, summary, at, |th, t| finalize_single(event_kinds::thread_summarized(th, t), ctx, at))
}
