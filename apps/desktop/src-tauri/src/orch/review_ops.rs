//! Hechos de la revisión sobre un Attempt (LXO-118): el ÚNICO sitio que construye `review.completed` y
//! `review.invalidated` y el único que llama a los mutadores de `store::reviews`. Contrato: `docs/core/REVIEWS.md`.
//!
//! # Quién puede
//! | operación | persona | agente | sistema |
//! |---|---|---|---|
//! | revisar (aceptar o rechazar) | sí | no | no |
//! | invalidar por HEAD movido | sí | no | sí (quien observa la rama) |
//!
//! Revisar es una decisión de una persona, como hoy (`review.rs`, `HUMAN_DECISION_CMDS`).
//!
//! **Inerte hasta el corte**: sin conexión al RPC; el almacén rechaza escribir antes de `meta.agentic_model`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: lo conectará el runtime (F4)

use super::event_kinds;
use super::events::{Actor, MutationContext};
use super::state::now_ms;
use super::task_ops::finalize_single;
use crate::store::{ChangeOutcome, NewReview, ReviewRow, Store, StoreError, StoreResult};

fn require(ok: bool, what: &str, ctx: &MutationContext) -> StoreResult<()> {
    if ok {
        Ok(())
    } else {
        Err(StoreError::ReviewConflict(format!("{what}: no lo puede hacer {:?} por {:?}", ctx.actor, ctx.channel)))
    }
}

/// La persona acepta o rechaza el Attempt sobre `head_commit`: `review.completed`.
pub(super) fn review(st: &mut Store, ctx: &MutationContext, attempt_id: &str, new: &NewReview) -> StoreResult<ReviewRow> {
    require(ctx.is_person(), &format!("revisar {attempt_id}"), ctx)?;
    let at = now_ms() as i64;
    let has_comment = new.comment.as_deref().is_some_and(|c| !c.trim().is_empty());
    st.review_record_recorded(attempt_id, new, at, |r, prev, a, t| finalize_single(event_kinds::review_completed(r, prev, a, t, has_comment), ctx, at))
}

/// La rama del Attempt está en `observed_head`: si no es el HEAD revisado, la aceptación deja de valer
/// (`review.invalidated`).
pub(super) fn invalidate(st: &mut Store, ctx: &MutationContext, attempt_id: &str, observed_head: &str) -> StoreResult<ChangeOutcome> {
    require(ctx.actor == Actor::System || ctx.is_person(), &format!("invalidar la revisión de {attempt_id}"), ctx)?;
    let at = now_ms() as i64;
    st.review_invalidate_recorded(attempt_id, observed_head, at, |r, a, t| finalize_single(event_kinds::review_invalidated(r, a, t), ctx, at))
}
