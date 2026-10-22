//! Hechos de la Task como intención durable (LXO-113): el ÚNICO sitio que construye y finaliza los borradores de
//! sus eventos y el único que llama a los mutadores `*_recorded` de `store::tasks`. Contrato: `docs/core/TASKS.md`.
//!
//! # Por qué existe
//! La Task de intención no vive en `State`: sus filas son de SQLite (`007_tasks`). Igual que `project_ops` para
//! el registro de proyectos, este módulo hace de «`tx_ops` de la Task»:
//!
//! ```text
//! create_child(st, ctx, parent, …)
//!   1. autorizar (quién puede, sobre qué Task)      <- antes de abrir ninguna transacción
//!   2. Store::task_create_child_recorded(…, |fila|  <- BEGIN IMMEDIATE · id del contador · INSERT tasks
//!        event_kinds::task_intent_created(fila)       <- borrador tipado (único constructor)
//!        finalize_all(…)                              <- id UUID v7, hora, actor y canal, UNA vez
//!      )                                              <- INSERT events (+ Attention) · COMMIT: todo o nada
//! ```
//!
//! El closure es puro (sin E/S ni reloj): la hora se fija ANTES y es la misma para las filas y para los eventos.
//!
//! # Quién puede
//! | operación | persona | agente (su Task) | sistema |
//! |---|---|---|---|
//! | crear un Run con su raíz | sí | sí | sí |
//! | crear una hija | sí | solo bajo su propia Task o sus descendientes | sí |
//! | cambiar título o encargo | sí | solo de su Task o sus descendientes | no |
//! | descartar · restaurar · borrar | sí | no | no |
//!
//! Descartar, restaurar y borrar son decisiones sobre la intención: las toma una persona.
//!
//! **Inerte hasta el corte**: nada de esto está conectado al RPC todavía y el almacén rechaza escribir antes de
//! `meta.agentic_model` ([`StoreError::AgenticModelInactive`]).

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: lo conectará el runtime de Attempt

use super::event_kinds::{self, RemovalCause};
use super::events::{finalize_all, Actor, EventDraft, EventError, MutationContext};
use super::state::now_ms;
use crate::store::{ChangeOutcome, IntentChange, NewEvent, NewRun, NewTaskIntent, RunRow, Store, StoreError, StoreResult, TaskRemoval, TaskRow};

/// Finaliza los borradores con el contexto y la hora de la operación. Run y Project ya van explícitos.
fn finalize(drafts: Vec<Result<EventDraft, EventError>>, ctx: &MutationContext, at: i64) -> StoreResult<Vec<NewEvent>> {
    let drafts = drafts.into_iter().collect::<Result<Vec<_>, _>>().map_err(|e| StoreError::InvalidEvent(e.to_string()))?;
    finalize_all(drafts, ctx, at, &|_: &str| None).map_err(StoreError::InvalidEvent)
}

pub(super) fn finalize_single(draft: Result<EventDraft, EventError>, ctx: &MutationContext, at: i64) -> StoreResult<NewEvent> {
    finalize(vec![draft], ctx, at)?.pop().ok_or_else(|| StoreError::InvalidEvent("un borrador produce exactamente un evento".into()))
}

fn denied(what: &str, ctx: &MutationContext) -> StoreError {
    StoreError::TaskConflict(format!("{what}: no lo puede hacer {:?} por {:?}", ctx.actor, ctx.channel))
}

/// ¿`ancestor` es `id` o uno de sus antecesores? Recorre los padres en el almacén (el árbol no cambia: la 007
/// impide mover una Task).
pub(super) fn manages(st: &Store, ancestor: &str, id: &str) -> StoreResult<bool> {
    let mut cur = Some(id.to_string());
    while let Some(t) = cur {
        if t == ancestor {
            return Ok(true);
        }
        cur = st.task_row(&t)?.and_then(|row| row.parent_task_id);
    }
    Ok(false)
}

/// Una persona, o el agente de una Task que coordina `id` (su propia Task o un antecesor suyo).
fn require_person_or_manager(st: &Store, ctx: &MutationContext, id: &str, what: &str) -> StoreResult<()> {
    match &ctx.actor {
        Actor::Person | Actor::PersonId(_) if ctx.is_person() => Ok(()),
        Actor::Agent(own) if manages(st, own, id)? => Ok(()),
        _ => Err(denied(what, ctx)),
    }
}

fn require_person(ctx: &MutationContext, what: &str) -> StoreResult<()> {
    if ctx.is_person() {
        Ok(())
    } else {
        Err(denied(what, ctx))
    }
}

/// Nace un Run con su Task raíz: `run.created` + `task.created` (v2), en la transacción de las filas.
pub(super) fn create_run(st: &mut Store, ctx: &MutationContext, new: &NewRun) -> StoreResult<(RunRow, TaskRow)> {
    let at = now_ms() as i64;
    st.run_create_recorded(new, at, |run, root| {
        let project = root.project_id.as_deref().unwrap_or_default();
        finalize(vec![event_kinds::run_created_intent(run, project), event_kinds::task_intent_created(root)], ctx, at)
    })
}

/// Nace una hija de `parent`: `task.created` (v2). Un agente solo crea bajo su propia Task o sus descendientes.
pub(super) fn create_child(st: &mut Store, ctx: &MutationContext, parent: &str, new: &NewTaskIntent) -> StoreResult<TaskRow> {
    if let Actor::Agent(own) = &ctx.actor {
        if !manages(st, own, parent)? {
            return Err(denied(&format!("crear una hija de {parent}"), ctx));
        }
    }
    let at = now_ms() as i64;
    st.task_create_child_recorded(parent, new, at, |t| finalize_single(event_kinds::task_intent_created(t), ctx, at))
}

/// Cambia título o encargo: `task.updated` con los campos que cambiaron de verdad (nada si no cambió nada).
pub(super) fn update_intent(st: &mut Store, ctx: &MutationContext, id: &str, change: &IntentChange) -> StoreResult<ChangeOutcome> {
    require_person_or_manager(st, ctx, id, &format!("cambiar la intención de {id}"))?;
    let at = now_ms() as i64;
    st.task_update_intent_recorded(id, change, at, |t, changed| finalize_single(event_kinds::task_updated(t, changed), ctx, at))
}

/// Descarta (`task.discarded`) o restaura (`task.restored`) la intención. Solo una persona.
pub(super) fn set_discarded(st: &mut Store, ctx: &MutationContext, id: &str, discarded: bool) -> StoreResult<ChangeOutcome> {
    require_person(ctx, if discarded { "descartar una Task" } else { "restaurar una Task" })?;
    let at = now_ms() as i64;
    st.task_set_discarded_recorded(id, discarded, at, |t| {
        finalize_single(if discarded { event_kinds::task_discarded(t) } else { event_kinds::task_restored(t) }, ctx, at)
    })
}

/// Borra una Task con una política EXPLÍCITA: `task.removed { cause: unused }`. Solo una persona.
pub(super) fn remove(st: &mut Store, ctx: &MutationContext, id: &str, policy: TaskRemoval) -> StoreResult<ChangeOutcome> {
    require_person(ctx, "borrar una Task")?;
    let at = now_ms() as i64;
    let cause = match policy {
        TaskRemoval::IfUnused => RemovalCause::Unused,
    };
    st.task_remove_recorded(id, policy, |t| finalize_single(event_kinds::task_removed(&t.id, &t.run_id, t.project_id.clone(), cause), ctx, at))
}
