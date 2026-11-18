//! RPC `attempt_stop`: detiene un Attempt por su id durable exacto (CLI F5).
//!
//! Un stop en ejecución solo se confirma después de cancelar el control que está
//! registrado para ese mismo Attempt y de comprobar su estado durable final. Si el
//! Core no puede probar esa identidad o el proceso no termina, falla cerrado.

use serde::Deserialize;

use super::attempt_retry_rpc::attempt_number;
use super::events::{Channel, MutationContext};
use super::initial_approval_rpc::{self, InitialApprovalResult};
use super::state::Status;
use super::Core;
use crate::store::AttemptStatus;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StopInput {
    pub attempt_id: String,
    pub confirm: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum StopResult {
    Stopped,
    Replayed,
}

fn task_and_number(attempt_id: &str) -> Result<(String, u32), String> {
    if attempt_id.len() > 256 || attempt_id.chars().any(char::is_control) {
        return Err("attempt_stop_invalid_request: attempt_id no es válido".into());
    }
    let (task_id, _) = attempt_id
        .rsplit_once("-a")
        .ok_or_else(|| "attempt_stop_invalid_request: falta un id de Attempt exacto".to_string())?;
    let number = attempt_number(task_id, attempt_id)
        .map_err(|_| "attempt_stop_invalid_request: falta un id de Attempt exacto".to_string())?;
    Ok((task_id.to_string(), number))
}

fn require_confirmation(input: &StopInput) -> Result<(), String> {
    if input.confirm {
        Ok(())
    } else {
        Err("attempt_stop_confirm_required: repite con confirm: true para detener este Attempt".into())
    }
}

pub(super) fn stop(
    core: &Core,
    context: &MutationContext,
    input: &StopInput,
) -> Result<StopResult, String> {
    if !context.is_person()
        || context.client_id.as_deref().is_none_or(str::is_empty)
        || context.channel != Channel::Lxo
    {
        return Err("attempt_stop_auth_required: attempt_stop requiere una Person autenticada de CLI".into());
    }
    stop_confirmed(core, context, input)
}

/// Dedicated Mobile entry; it does not open the generic CLI RPC to Mobile.
pub(super) fn stop_mobile(core: &Core, context: &MutationContext, input: &StopInput) -> Result<StopResult, String> {
    if !context.is_authenticated_mobile_person() {
        return Err("attempt_stop_auth_required: falta una Person Mobile autenticada".into());
    }
    stop_confirmed(core, context, input)
}

fn stop_confirmed(core: &Core, context: &MutationContext, input: &StopInput) -> Result<StopResult, String> {
    require_confirmation(input)?;
    let (task_id, number) = task_and_number(&input.attempt_id)?;
    let attempt = core
        .attempt_row_for_resume(&input.attempt_id)?
        .ok_or_else(|| format!("attempt_stop_not_found: no existe el Attempt {}", input.attempt_id))?;
    if attempt.task_id != task_id || attempt.n != i64::from(number) {
        return Err("attempt_stop_invalid_request: el id no corresponde a la fila del Attempt".into());
    }

    match attempt.status {
        AttemptStatus::PendingApproval => {
            return match initial_approval_rpc::decide(core, context, &input.attempt_id, false)? {
                InitialApprovalResult::Rejected => Ok(StopResult::Stopped),
                InitialApprovalResult::ReplayedRejected => Ok(StopResult::Replayed),
                InitialApprovalResult::Expired => Err("attempt_stop_final: la aprobación ya expiró".into()),
                InitialApprovalResult::Approved
                | InitialApprovalResult::ReplayedApproved => Err(
                    "attempt_stop_conflict: el Attempt fue aprobado concurrentemente; vuelve a consultar su estado".into(),
                ),
            };
        }
        AttemptStatus::Starting => {
            // El dispatcher puede tener el claim o estar entre el claim y la
            // llamada del proveedor. Sin un control que permita serializar esos
            // dos efectos, cancelar aquí podría dar un falso éxito.
            return Err("attempt_stop_busy: el Attempt está arrancando; no se puede garantizar un stop exacto todavía".into());
        }
        AttemptStatus::Running | AttemptStatus::Waiting | AttemptStatus::AwaitingTerminalApproval => {}
        AttemptStatus::Stopped => return Ok(StopResult::Replayed),
        AttemptStatus::Done | AttemptStatus::Failed | AttemptStatus::Exited => {
            return Err("attempt_stop_final: el Attempt ya terminó".into());
        }
    }

    let current = {
        let state = core.lock();
        let n = state.attempt_n.get(&task_id).copied();
        let task = state.tasks.get(&task_id);
        n == Some(number)
            && task.is_some_and(|task| {
                matches!(task.status, Status::Running | Status::Waiting | Status::AwaitingTerminalApproval)
            })
    };
    if !current {
        return Err("attempt_stop_conflict: el Attempt ya no es la ejecución actual de su Task".into());
    }

    // Un Attempt en manos de una persona (LXO-170) no tiene ejecución que cancelar: el agente ya está interrumpido. Detenerlo es cerrarlo.
    let in_human_hands = core.attempt_owner(&input.attempt_id).is_ok_and(|o| o.owner == crate::store::Owner::Human);
    if in_human_hands {
        core.stop_human_owned(&task_id, &input.attempt_id);
    } else {
        core.cancel_adapter_attempt_run(&task_id, &input.attempt_id)
            .map_err(|error| format!("attempt_stop_unavailable: {error}"))?;
    }

    // La terminación del adapter no equivale a un stop confirmado. El pump debe
    // haber asentado el estado terminal exacto en SQLite antes de devolver.
    let final_attempt = core
        .attempt_row_for_resume(&input.attempt_id)?
        .ok_or_else(|| format!("attempt_stop_unavailable: desapareció el Attempt {}", input.attempt_id))?;
    if final_attempt.task_id != task_id || final_attempt.n != i64::from(number) {
        return Err("attempt_stop_unavailable: cambió la identidad durable del Attempt".into());
    }
    match final_attempt.status {
        AttemptStatus::Stopped => Ok(StopResult::Stopped),
        AttemptStatus::Done | AttemptStatus::Failed | AttemptStatus::Exited => {
            Err("attempt_stop_final: el Attempt terminó antes de que el stop se confirmara".into())
        }
        _ => Err("attempt_stop_unavailable: el proceso acabó pero el stop no quedó asentado".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn el_parser_exige_un_id_exacto_confirmacion_y_rechaza_opciones_extra() {
        assert!(serde_json::from_value::<StopInput>(json!({"attempt_id":"t1-a2","confirm":true})).is_ok());
        assert!(serde_json::from_value::<StopInput>(json!({"attempt_id":"t1-a2","confirm":true,"task_id":"t1"})).is_err());
        assert!(serde_json::from_value::<StopInput>(json!({"attempt_id":"t1-a2"})).is_err());
        let unconfirmed: StopInput = serde_json::from_value(json!({"attempt_id":"t1-a2","confirm":false})).unwrap();
        assert!(require_confirmation(&unconfirmed).is_err());
        assert_eq!(task_and_number("t1-a2"), Ok(("t1".into(), 2)));
        assert!(task_and_number("t1-a02").is_err());
        assert!(task_and_number("t1-a2\n").is_err());
    }
}
