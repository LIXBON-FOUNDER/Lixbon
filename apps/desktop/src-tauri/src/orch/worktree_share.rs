//! Compartir el worktree de otro Attempt (LXO-248): `attempt_share_worktree`. Diseño: `docs/core/WORKTREE_SHARED.md`.
//!
//! ```text
//! attempt_share_worktree { attempt_id, from_attempt_id, confirm: true }
//!   1. Person autenticada y confirmación explícita (compartir un worktree es un recurso que un borrado podría afectar)
//!   2. el Attempt destino existe, espera su aprobación (`pending_approval`) y todavía no trabaja en ningún worktree
//!   3. el Attempt origen existe y trabaja en uno
//!   4. el almacén lo enlaza en UNA transacción (`worktree.attached`) o dice por qué no
//! ```
//!
//! Lo decide la persona ANTES de aprobar. Aprobar es lo que ejecuta: el despachador (`worktree_provision::provision_worktree`) ve que el Attempt
//! ya trabaja en un worktree que no es de su Task y se adjunta sin crear nada.
//!
//! # Reglas (las impone el almacén y la migración 026, no este módulo)
//! * **Mismo Project.** Una Task sin Project no comparte.
//! * **En serie**: ningún otro Attempt vivo (no final) usa ya ese worktree. El Attempt destino, desde que se enlaza, lo ocupa: mientras espera
//!   su aprobación nadie más entra (ni la Task dueña con un seguimiento); si se rechaza o termina, se libera.
//! * **Quien comparte no es dueño**: el worktree sigue siendo de la Task que lo creó (`worktrees.task_id`). La Task que comparte no tiene
//!   `worktree`/`branch` propios en su estado, así que `resource_clean` / `resource_delete_worktree` de ella no tocan nada. La limpieza de la
//!   Task dueña se niega mientras otro Attempt vivo lo use (`shared_in_use`, `resource_actions.rs`).

use serde::Deserialize;
use serde_json::{json, Value};

use super::events::{Actor, MutationContext};
use super::mutation::Health;
use super::worktree_ops;
use super::Core;
use crate::store::{AttemptStatus, ChangeOutcome, StoreError, WorktreeState};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ShareInput {
    pub attempt_id: String,
    pub from_attempt_id: String,
    #[serde(default)]
    pub confirm: bool,
}

fn id_of(value: &str, what: &str) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() || v.chars().count() > 200 || v.chars().any(char::is_control) {
        return Err(format!("share_invalid: {what}: obligatorio, hasta 200 caracteres y sin caracteres de control"));
    }
    Ok(v.to_string())
}

/// `attempt_share_worktree`. Solo una Person de Desktop (`HumanDecision`).
pub(super) fn share(core: &Core, context: &MutationContext, input: &ShareInput) -> Result<Value, String> {
    if !context.is_person() || context.client_id.as_deref().is_none_or(str::is_empty) || !matches!(context.actor, Actor::PersonId(_)) {
        return Err("compartir un worktree requiere una Person autenticada".into());
    }
    if !input.confirm {
        return Err("share_confirm_required: compartir un worktree exige confirmación explícita de la persona (confirm: true)".into());
    }
    let attempt_id = id_of(&input.attempt_id, "attempt_id")?;
    let from_id = id_of(&input.from_attempt_id, "from_attempt_id")?;
    if attempt_id == from_id {
        return Err("share_invalid: un Attempt no comparte el worktree consigo mismo".into());
    }
    if let Health::DegradedReadOnly(why) = core.health() {
        return Err(format!("share_degraded: el Core está en solo lectura ({why}): no puede registrar el enlace"));
    }

    core.worktree_store(|st| {
            let target = st.attempt_row(&attempt_id).map_err(|e| format!("share_failed: {e}"))?.ok_or_else(|| format!("share_not_found: no existe el Attempt {attempt_id}"))?;
            let source = st.attempt_row(&from_id).map_err(|e| format!("share_failed: {e}"))?.ok_or_else(|| format!("share_not_found: no existe el Attempt {from_id}"))?;
            let Some(worktree_id) = source.worktree_id.clone() else {
                return Err(format!("share_source_without_worktree: el Attempt {from_id} no trabaja en ningún worktree"));
            };
            // Repetir lo ya hecho no cambia nada.
            if target.worktree_id.as_deref() == Some(worktree_id.as_str()) {
                return Ok(answer("AlreadyShared", &attempt_id, &worktree_id, &owner_of(st, &worktree_id)?));
            }
            if target.status != AttemptStatus::PendingApproval {
                return Err(format!("share_not_pending: el Attempt {attempt_id} ya no espera su aprobación: el worktree se elige antes de aprobar"));
            }
            if let Some(own) = &target.worktree_id {
                return Err(format!("share_already_has_worktree: el Attempt {attempt_id} ya trabaja en {own}"));
            }
            let worktree = st.worktree_row(&worktree_id).map_err(|e| format!("share_failed: {e}"))?.ok_or_else(|| format!("share_not_found: no existe el worktree {worktree_id}"))?;
            if worktree.state != WorktreeState::Active {
                return Err(format!("share_not_active: el worktree {worktree_id} no está activo ({})", worktree.state.as_str()));
            }
            match worktree_ops::attach(st, &MutationContext::core(), &worktree_id, &attempt_id) {
                Ok(outcome) => Ok(answer(if outcome == ChangeOutcome::Unchanged { "AlreadyShared" } else { "Shared" }, &attempt_id, &worktree_id, &worktree.task_id)),
                Err(StoreError::WorktreeConflict(why)) => Err(format!("share_conflict: {why}")),
                Err(other) => Err(format!("share_failed: {other}")),
            }
        })
        .unwrap_or_else(|| Err("share_failed: el almacén del Core no está abierto".into()))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CandidatesInput {
    pub attempt_id: String,
}

/// `attempt_share_candidates { attempt_id }`: los worktrees que ese Attempt podría compartir, del MISMO Project y activos, cada uno con el Attempt que se
/// pasa a `attempt_share_worktree` (`from_attempt_id`: el que lo creó) y `busy_by` si otro Attempt vivo lo usa ahora (en serie: no se puede compartir
/// todavía, y la interfaz lo muestra deshabilitado con su motivo). Una lectura: no cambia nada. Solo una Person de Desktop.
pub(super) fn candidates(core: &Core, context: &MutationContext, input: &CandidatesInput) -> Result<Value, String> {
    if !context.is_person() || context.client_id.as_deref().is_none_or(str::is_empty) || !matches!(context.actor, Actor::PersonId(_)) {
        return Err("ver los worktrees que se pueden compartir requiere una Person autenticada".into());
    }
    let attempt_id = id_of(&input.attempt_id, "attempt_id")?;
    core.worktree_store(|st| {
        let target = st.attempt_row(&attempt_id).map_err(|e| format!("share_failed: {e}"))?.ok_or_else(|| format!("share_not_found: no existe el Attempt {attempt_id}"))?;
        let Some(project) = st.task_row(&target.task_id).map_err(|e| format!("share_failed: {e}"))?.and_then(|t| t.project_id) else {
            return Ok(json!({ "attempt_id": target.id, "candidates": [] }));
        };
        let mut out = Vec::new();
        for w in st.worktrees_of_project(&project).map_err(|e| format!("share_failed: {e}"))? {
            // Los de su propia Task no se «comparten» (un seguimiento ya trabaja en el de la Task) y solo los activos con carpeta.
            if w.task_id == target.task_id || w.state != WorktreeState::Active || w.path.is_none() {
                continue;
            }
            let users = st.attempts_of_worktree(&w.id).map_err(|e| format!("share_failed: {e}"))?;
            let busy_by = users.iter().find(|a| a.id != target.id && !a.status.is_final()).map(|a| a.id.clone());
            let title = st.task_row(&w.task_id).map_err(|e| format!("share_failed: {e}"))?.map(|t| t.title).unwrap_or_default();
            out.push(json!({
                "from_attempt_id": w.attempt_id, "worktree_id": w.id, "owner_task_id": w.task_id, "owner_task_title": title,
                "branch": w.branch, "path": w.path, "busy_by": busy_by,
            }));
        }
        Ok(json!({ "attempt_id": target.id, "candidates": out }))
    })
    .unwrap_or_else(|| Err("share_failed: el almacén del Core no está abierto".into()))
}

/// Un Attempt que COMPARTE el worktree de otra Task no se revisa ni se integra desde sí mismo: su Task no tiene rama propia (no es dueño; si la tuviera,
/// su limpieza borraría la carpeta del dueño). El trabajo vive en la rama del dueño, así que se revisa e integra desde el Attempt dueño, que ya incluye
/// lo que quien compartió hizo en esa carpeta. Sin esto el error sería «no tiene rama propia (se lanzó sin worktree)», que no es verdad.
pub(super) fn ensure_not_a_sharer(core: &Core, args: &Value) -> Result<(), String> {
    let Some(attempt_id) = args.get("attempt_id").and_then(Value::as_str) else { return Ok(()) };
    let owner = core
        .worktree_store(|st| -> Option<(String, String)> {
            let attempt = st.attempt_row(attempt_id).ok()??;
            let worktree = st.worktree_row(attempt.worktree_id.as_deref()?).ok()??;
            (worktree.task_id != attempt.task_id).then_some((worktree.task_id, worktree.attempt_id))
        })
        .flatten();
    match owner {
        Some((task, owner_attempt)) => Err(format!(
            "share_not_reviewable: el Attempt {attempt_id} comparte el worktree de la Task {task}, que es de su dueño: se revisa y se integra desde el Attempt {owner_attempt}, que ya incluye lo que se hizo en esa carpeta"
        )),
        None => Ok(()),
    }
}

fn owner_of(st: &crate::store::Store, worktree_id: &str) -> Result<String, String> {
    Ok(st.worktree_row(worktree_id).map_err(|e| format!("share_failed: {e}"))?.map(|w| w.task_id).unwrap_or_default())
}

fn answer(status: &str, attempt_id: &str, worktree_id: &str, owner_task_id: &str) -> Value {
    json!({ "status": status, "attempt_id": attempt_id, "worktree_id": worktree_id, "owner_task_id": owner_task_id })
}
