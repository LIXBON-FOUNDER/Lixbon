//! Hechos de Worktree y Artifact (LXO-116): el ÚNICO sitio que construye sus eventos y el único que llama a los
//! mutadores `*_recorded` de `store::worktrees`. Contrato: `docs/core/WORKTREES_ARTIFACTS.md`.
//!
//! Mismo esquema que `attempt_ops`: autorizar antes de abrir la transacción, hora fijada una vez, closure puro.
//!
//! # Quién puede
//! | operación | persona | agente | sistema |
//! |---|---|---|---|
//! | registrar uno creado por Lixbon | no | no | sí |
//! | registrar uno adoptado o externo | sí | no | sí |
//! | enlazar un seguimiento · marcarlo ausente o encontrado | no | no | sí |
//! | quitar por `integrated` | no | no | sí (tras integrar) |
//! | quitar por `discarded` | sí (es la confirmación) | no | no |
//! | quitar por `gone` | sí | no | sí |
//! | dejar un Artifact | no | el de ESA Task | sí |
//!
//! **Inerte hasta el corte**: sin conexión al RPC; el almacén rechaza escribir antes de `meta.agentic_model`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: lo conectará el runtime (F4)

use super::event_kinds;
use super::events::{Actor, MutationContext};
use super::state::now_ms;
use super::task_ops::finalize_single;
use crate::store::{ArtifactRow, ChangeOutcome, NewArtifact, NewWorktree, Provenance, RemovalReason, Store, StoreError, StoreResult, WorktreeRow, WorktreeStep};

fn require(ok: bool, what: &str, ctx: &MutationContext) -> StoreResult<()> {
    if ok {
        Ok(())
    } else {
        Err(StoreError::WorktreeConflict(format!("{what}: no lo puede hacer {:?} por {:?}", ctx.actor, ctx.channel)))
    }
}

fn system(ctx: &MutationContext) -> bool {
    ctx.actor == Actor::System
}

/// El Attempt registra su Worktree: `worktree.created` (lo creó Lixbon) o `worktree.adopted` (ya existía).
pub(super) fn register(st: &mut Store, ctx: &MutationContext, attempt_id: &str, new: &NewWorktree) -> StoreResult<WorktreeRow> {
    let ok = system(ctx) || (new.provenance != Provenance::Created && ctx.is_person());
    require(ok, &format!("registrar el Worktree de {attempt_id}"), ctx)?;
    let at = now_ms() as i64;
    st.worktree_register_recorded(attempt_id, new, at, |w, a, t| finalize_single(event_kinds::worktree_registered(w, a, t), ctx, at))
}

/// Un seguimiento trabaja en el mismo Worktree: `worktree.attached`.
pub(super) fn attach(st: &mut Store, ctx: &MutationContext, id: &str, attempt_id: &str) -> StoreResult<ChangeOutcome> {
    require(system(ctx), &format!("enlazar {attempt_id} a {id}"), ctx)?;
    let at = now_ms() as i64;
    st.worktree_attach_recorded(id, attempt_id, at, |w, a, t| finalize_single(event_kinds::worktree_attached(w, a, t), ctx, at))
}

/// La carpeta no está en disco: `worktree.missing`.
pub(super) fn lost(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    require(system(ctx), &format!("marcar ausente {id}"), ctx)?;
    let at = now_ms() as i64;
    st.worktree_transition_recorded(id, WorktreeStep::Lost, at, |w, _, t| finalize_single(event_kinds::worktree_missing(w, t), ctx, at))
}

/// Volvió a estar: `worktree.found`.
pub(super) fn found(st: &mut Store, ctx: &MutationContext, id: &str) -> StoreResult<ChangeOutcome> {
    require(system(ctx), &format!("marcar encontrado {id}"), ctx)?;
    let at = now_ms() as i64;
    st.worktree_transition_recorded(id, WorktreeStep::Found, at, |w, _, t| finalize_single(event_kinds::worktree_found(w, t), ctx, at))
}

/// Quitar (final): `worktree.removed`. Descartar trabajo lo confirma una persona; tras integrar lo hace el Core.
pub(super) fn remove(st: &mut Store, ctx: &MutationContext, id: &str, reason: RemovalReason, branch_kept: bool) -> StoreResult<ChangeOutcome> {
    let ok = match reason {
        RemovalReason::Integrated => system(ctx),
        RemovalReason::Discarded => ctx.is_person(),
        RemovalReason::Gone => system(ctx) || ctx.is_person(),
    };
    require(ok, &format!("quitar {id} ({})", reason.as_str()), ctx)?;
    let at = now_ms() as i64;
    st.worktree_transition_recorded(id, WorktreeStep::Remove { reason, branch_kept }, at, |w, _, t| finalize_single(event_kinds::worktree_removed(w, t), ctx, at))
}

/// El Attempt deja un Artifact: `artifact.created` (sin el localizador). El Core o el agente de ESA Task.
pub(super) fn artifact(st: &mut Store, ctx: &MutationContext, attempt_id: &str, new: &NewArtifact) -> StoreResult<ArtifactRow> {
    let task = st.attempt_row(attempt_id)?.map(|a| a.task_id);
    let own = matches!((&ctx.actor, &task), (Actor::Agent(own), Some(t)) if own == t);
    require(system(ctx) || own, &format!("dejar un Artifact de {attempt_id}"), ctx)?;
    let at = now_ms() as i64;
    st.artifact_create_recorded(attempt_id, new, at, |x, a, t| finalize_single(event_kinds::artifact_created(x, a, t), ctx, at))
}
