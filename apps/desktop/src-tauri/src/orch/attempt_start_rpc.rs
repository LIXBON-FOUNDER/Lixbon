//! RPC `attempt_start`: pide el primer Attempt de una Task ya existente (CLI F5).
//!
//! La CLI solo aporta la selección de ejecución. La Task, su Project, su Run y el
//! encargo se reconstruyen desde el Core; el Worktree `new` lo crea el launcher.
//! La solicitud nace `pending_approval` y no despierta al despachador: solo una
//! aprobación posterior de Desktop puede llevarla a `starting`.

use serde::Deserialize;

use super::agents::Profile;
use super::events::{Channel, MutationContext};
use super::state::Status;
use super::tx_ops::InitialAttemptSelection;
use super::Core;
use crate::store::{AttemptStatus, TaskIntent, TaskOrigin};

const MAX_ID: usize = 256;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StartInput {
    pub task_id: String,
    pub provider: String,
    pub profile: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum StartResult {
    Requested(String),
    Replayed(String, AttemptStatus),
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_ID && !value.chars().any(char::is_control)
}

fn valid_provider(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn clean_optional(name: &str, value: &Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else { return Ok(None) };
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 128 || value.chars().any(char::is_control) {
        return Err(format!("attempt_start_invalid_request: {name} no es válido"));
    }
    Ok(Some(value.to_string()))
}

fn capability_error(error: String) -> String {
    let prefix = if error.starts_with("provider_environment_blocked:") {
        "attempt_start_environment_blocked"
    } else if error.starts_with("provider_start_unsupported:") || error.starts_with("provider_unknown:") {
        "attempt_start_unsupported"
    } else if error.starts_with("provider_probing:") || error.starts_with("provider_start_unavailable:") {
        "attempt_start_capability_unavailable"
    } else {
        "attempt_start_unavailable"
    };
    format!("{prefix}: {error}")
}

fn selection(input: &StartInput) -> Result<InitialAttemptSelection, String> {
    if !valid_id(&input.task_id) || !valid_provider(&input.provider) {
        return Err("attempt_start_invalid_request: task_id o provider no es válido".into());
    }
    let profile = Profile::parse(&input.profile)
        .filter(|profile| profile.disabled_reason().is_none())
        .ok_or_else(|| "attempt_start_invalid_request: profile no es un perfil habilitado".to_string())?;
    Ok(InitialAttemptSelection {
        provider: input.provider.clone(),
        model: clean_optional("model", &input.model)?,
        effort: clean_optional("effort", &input.effort)?,
        profile: profile.id().to_string(),
    })
}

fn same_selection(
    attempt: &crate::store::AttemptRow,
    selection: &InitialAttemptSelection,
) -> bool {
    attempt.origin == TaskOrigin::Core
        && !attempt.external
        && attempt.provider == selection.provider
        && attempt.model == selection.model
        && attempt.effort == selection.effort
        && attempt.profile.as_deref() == Some(selection.profile.as_str())
}

/// Valida la identidad, el estado y la policy de inicio antes de escribir nada.
/// `attempt.requested` es idempotente por Task: repetir la misma selección de su
/// Attempt inicial devuelve ese id; una selección distinta nunca lo reemplaza.
pub(super) fn start(
    core: &Core,
    context: &MutationContext,
    input: &StartInput,
) -> Result<StartResult, String> {
    if !context.is_person()
        || context.client_id.as_deref().is_none_or(str::is_empty)
        || context.channel != Channel::Lxo
    {
        return Err("attempt_start_auth_required: attempt_start requiere una Person autenticada de CLI".into());
    }
    if !core.attempt_model() {
        return Err("attempt_start_unavailable: el modelo Task/Attempt no está activo".into());
    }
    if core.launcher().is_none() {
        return Err("attempt_start_unavailable: el lifecycle de lanzamiento no está disponible".into());
    }
    let selection = selection(input)?;

    let (task_status, task_project, attempt_n) = {
        let state = core.lock();
        let task = state
            .tasks
            .get(&input.task_id)
            .ok_or_else(|| format!("attempt_start_not_found: no existe la Task {}", input.task_id))?;
        if state.runs.get(&task.run).is_none_or(|run| run.closed) {
            return Err("attempt_start_final: el Run de la Task está cerrado".into());
        }
        (task.status, task.project_id.clone(), state.attempt_n.get(&input.task_id).copied())
    };

    let project_id = task_project
        .filter(|project| !project.trim().is_empty())
        .ok_or_else(|| "attempt_start_unavailable: la Task no tiene Project desde el que lanzar".to_string())?;

    // La proyección en memoria no sustituye la intención durable: un Task legacy o
    // descartado no se convierte en ejecutable por el mero hecho de conocer su id.
    let durable_task = core
        .task_row_for_start(&input.task_id)
        .map_err(|error| format!("attempt_start_unavailable: no se pudo leer la Task: {error}"))?
        .ok_or_else(|| format!("attempt_start_not_found: no existe la Task {}", input.task_id))?;
    if durable_task.origin != TaskOrigin::Core || durable_task.intent != TaskIntent::Open {
        return Err("attempt_start_final: solo se puede iniciar una Task Core abierta".into());
    }
    if durable_task.project_id.as_deref() != Some(project_id.as_str()) {
        return Err("attempt_start_unavailable: el Project de la Task no coincide con el registro durable".into());
    }
    if durable_task.spec.trim().is_empty() {
        return Err("attempt_start_invalid_request: la Task no tiene un encargo que lanzar".into());
    }

    if let Some(n) = attempt_n {
        if n == 1 {
            let id = format!("{}-a1", input.task_id);
            let previous = core
                .attempt_row_for_resume(&id)?
                .ok_or_else(|| format!("attempt_start_unavailable: falta la fila durable de {id}"))?;
            if same_selection(&previous, &selection) {
                return Ok(StartResult::Replayed(id, previous.status));
            }
            return Err("attempt_start_conflict: la Task ya tiene un Attempt inicial con otra selección".into());
        }
        return Err("attempt_start_final: la Task ya tiene un Attempt; usa retry o resume con su id explícito".into());
    }
    if task_status != Status::NotStarted {
        return Err("attempt_start_final: la Task ya no está sin iniciar".into());
    }

    core.project_launch_location(&project_id)
        .map_err(|error| format!("attempt_start_unavailable: {error}"))?;
    core.provider_start_preflight(&selection.provider)
        .map_err(capability_error)?;

    let task_id = input.task_id.clone();
    let requested = selection.clone();
    match core.mutate_as(context, |tx| tx.request_initial_attempt_for_task(&task_id, &requested)) {
        Ok(()) => Ok(StartResult::Requested(format!("{}-a1", input.task_id))),
        Err(error) => {
            // Otra llamada pudo ganar la carrera. Solo el mismo Attempt 1 y la
            // misma selección pueden convertir ese conflicto en un replay.
            let id = format!("{}-a1", input.task_id);
            let current = core.attempt_row_for_resume(&id)?;
            if let Some(attempt) = current.filter(|attempt| same_selection(attempt, &selection)) {
                Ok(StartResult::Replayed(id, attempt.status))
            } else {
                Err(format!("attempt_start_conflict: {error}"))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn el_parser_rechaza_opciones_de_host_worktree_y_campos_inesperados() {
        let valid = json!({"task_id":"task-1","provider":"claude","profile":"explorar","model":"sonnet"});
        assert!(serde_json::from_value::<StartInput>(valid).is_ok());
        for extra in ["host", "background", "worktree_strategy", "request_id", "external"] {
            let mut input = json!({"task_id":"task-1","provider":"claude","profile":"explorar"});
            input[extra] = json!("local");
            assert!(serde_json::from_value::<StartInput>(input).is_err(), "{extra} no forma parte del RPC");
        }
    }

    #[test]
    fn la_seleccion_requiere_provider_y_perfil_habilitados_y_limpia_opcionales() {
        let input: StartInput = serde_json::from_value(json!({
            "task_id":"task-1","provider":"claude","profile":"Explorar","model":" sonnet "
        })).unwrap();
        let got = selection(&input).unwrap();
        assert_eq!(got.provider, "claude");
        assert_eq!(got.profile, "explorar");
        assert_eq!(got.model.as_deref(), Some("sonnet"));
        assert!(selection(&StartInput {
            task_id: "task-1".into(), provider: "Claude".into(), profile: "explorar".into(),
            model: None, effort: None,
        }).is_err());
        assert!(selection(&StartInput {
            task_id: "task-1".into(), provider: "claude".into(), profile: "autonomia_amplia".into(),
            model: None, effort: None,
        }).is_err());
    }
}
