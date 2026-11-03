//! RPC `attempt_approve` / `attempt_reject`: la decisión de una Person sobre la aprobación inicial de un Attempt
//! (LXO-141, fase 2c-2).
//!
//! El cliente solo aporta el id del Attempt y si acepta o rechaza; nunca elige ni amplía el plazo, que es el durable que
//! fijó el servidor (migración 019). La decisión pasa por `Core::mutate` (`Tx::approve_attempt` / `Tx::reject_attempt`) y el
//! commit del runtime revalida el plazo y la evidencia canónica bajo la transacción: este módulo solo elige el camino
//! correcto para el usuario (repetir una decisión ya tomada, o expirar una vencida).
//!
//! # Resultados
//! | caso | resultado |
//! |---|---|
//! | decisión en plazo sobre un Attempt pendiente | `Approved` / `Rejected` |
//! | la misma decisión ya estaba tomada | `Replayed` (con `decision`), sin escribir |
//! | la contraria ya estaba tomada, o no está pendiente | error |
//! | el plazo ya venció | `Expired` (el Attempt queda detenido; aprobar tarde nunca aprueba) |
//!
//! **Aprobar no lanza nada**: el despacho es del despachador (`dispatch.rs`), que lee la cola de aprobados.

use serde::Deserialize;

use super::events::{Channel, MutationContext};
use super::Core;
use crate::store::{AttemptStatus, InitialApprovalDecision, InitialApprovalSnapshot};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApprovalResolution {
    Approved,
    Rejected,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum InitialApprovalResult {
    Approved,
    Rejected,
    Expired,
    ReplayedApproved,
    ReplayedRejected,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InitialApprovalInput {
    pub attempt_id: String,
}

/// Resuelve la decisión con el plazo durable que leyó el Core. El plazo es exclusivo: en el instante exacto ya venció.
pub(crate) fn resolve_initial_approval(approve: bool, decided_at_ms: i64, durable_deadline_ms: i64) -> ApprovalResolution {
    if decided_at_ms < 0 || durable_deadline_ms <= 0 || decided_at_ms >= durable_deadline_ms {
        ApprovalResolution::Expired
    } else if approve {
        ApprovalResolution::Approved
    } else {
        ApprovalResolution::Rejected
    }
}

/// `<task>-a<n>` con `n > 0` canónico (sin ceros a la izquierda), sin controles y de longitud acotada.
fn parse_attempt_id(id: &str) -> Result<(), String> {
    let invalid = || "Falta un id de Attempt válido".to_string();
    let (task, raw_n) = id.rsplit_once("-a").ok_or_else(invalid)?;
    raw_n.parse::<u32>().ok().filter(|n| *n > 0 && format!("{task}-a{n}") == id).ok_or_else(invalid)?;
    if task.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(())
}

/// Si el Attempt ya tiene una decisión canónica: repetirla es un replay; la contraria, un error.
fn resolved_result(snapshot: &InitialApprovalSnapshot, approve: bool) -> Result<Option<InitialApprovalResult>, String> {
    match snapshot.decision {
        Some(InitialApprovalDecision::Approved) if approve => Ok(Some(InitialApprovalResult::ReplayedApproved)),
        Some(InitialApprovalDecision::Approved) => Err("el Attempt ya fue aprobado".into()),
        Some(InitialApprovalDecision::Rejected) if !approve => Ok(Some(InitialApprovalResult::ReplayedRejected)),
        Some(InitialApprovalDecision::Rejected) => Err("el Attempt ya fue rechazado".into()),
        Some(InitialApprovalDecision::Expired) => Ok(Some(InitialApprovalResult::Expired)),
        Some(InitialApprovalDecision::RunClosed) => Err("el Run se cerró antes de resolver la aprobación".into()),
        None if snapshot.status == AttemptStatus::PendingApproval => Ok(None),
        None => Err("Attempt no pendiente de aprobación".into()),
    }
}

fn snapshot_of(core: &Core, attempt_id: &str) -> Result<InitialApprovalSnapshot, String> {
    core.initial_approval_snapshot(attempt_id)?.ok_or_else(|| format!("no existe el Attempt {attempt_id}"))
}

fn expire_due(core: &Core, attempt_id: &str) -> Result<bool, String> {
    core.mutate_as(&MutationContext::core(), |tx| tx.expire_pending_initial(attempt_id)).map_err(|e| e.to_string())
}

/// Resuelve una decisión inicial de una Person autenticada. El almacén es quien comprueba el plazo; este paso previo solo
/// elige el camino visible para el usuario.
pub(super) fn decide(core: &Core, context: &MutationContext, attempt_id: &str, approve: bool) -> Result<InitialApprovalResult, String> {
    if !context.is_person() || context.client_id.as_deref().is_none_or(str::is_empty) || context.channel == Channel::Core {
        return Err("resolver una aprobación inicial requiere una Person autenticada".into());
    }
    parse_attempt_id(attempt_id)?;

    let snapshot = snapshot_of(core, attempt_id)?;
    if let Some(result) = resolved_result(&snapshot, approve)? {
        return Ok(result);
    }

    let deadline = snapshot.deadline_ms.filter(|deadline| *deadline > 0).ok_or_else(|| "el Attempt pendiente no tiene un plazo durable".to_string())?;
    let now = i64::try_from(super::state::now_ms()).ok().filter(|now| *now > 0).ok_or_else(|| "el reloj del servidor no es válido".to_string())?;
    match resolve_initial_approval(approve, now, deadline) {
        ApprovalResolution::Expired => {
            if expire_due(core, attempt_id)? {
                return Ok(InitialApprovalResult::Expired);
            }
            // Otro hilo lo resolvió entre la lectura y la expiración.
            if let Some(result) = resolved_result(&snapshot_of(core, attempt_id)?, approve)? {
                return Ok(result);
            }
            Err("la aprobación venció, pero no se pudo confirmar su expiración".into())
        }
        ApprovalResolution::Approved | ApprovalResolution::Rejected => {
            let changed = core.mutate_as(context, |tx| if approve { tx.approve_attempt(attempt_id) } else { tx.reject_attempt(attempt_id) });
            match changed {
                Ok(()) => Ok(if approve { InitialApprovalResult::Approved } else { InitialApprovalResult::Rejected }),
                Err(error) => {
                    // Un reintento concurrente pudo confirmar esta misma decisión mientras esperaba el lock del estado.
                    // Solo se informa un replay si el evento canónico durable prueba ese desenlace exacto.
                    let current = snapshot_of(core, attempt_id)?;
                    if let Some(result) = resolved_result(&current, approve)? {
                        return Ok(result);
                    }
                    let now_after = i64::try_from(super::state::now_ms()).unwrap_or_default();
                    if current.status == AttemptStatus::PendingApproval
                        && current.deadline_ms.is_some_and(|deadline| now_after > 0 && now_after >= deadline)
                        && expire_due(core, attempt_id)?
                    {
                        return Ok(InitialApprovalResult::Expired);
                    }
                    Err(error.to_string())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn el_plazo_es_exclusivo_y_un_reloj_invalido_expira() {
        assert_eq!(resolve_initial_approval(true, 1_799_999, 1_800_000), ApprovalResolution::Approved);
        assert_eq!(resolve_initial_approval(false, 1_799_999, 1_800_000), ApprovalResolution::Rejected);
        assert_eq!(resolve_initial_approval(true, 1_800_000, 1_800_000), ApprovalResolution::Expired, "el plazo es exclusivo");
        assert_eq!(resolve_initial_approval(true, 1, 0), ApprovalResolution::Expired);
        assert_eq!(resolve_initial_approval(true, -1, 1_800_000), ApprovalResolution::Expired);
    }

    #[test]
    fn la_entrada_exige_un_unico_id_de_attempt_exacto() {
        let input: InitialApprovalInput = serde_json::from_value(json!({"attempt_id":"t7-a1"})).unwrap();
        assert_eq!(input.attempt_id, "t7-a1");
        assert!(serde_json::from_value::<InitialApprovalInput>(json!({"attempt_id":"t7-a1","deadline":1})).is_err(), "el cliente no aporta plazo");
        assert!(serde_json::from_value::<InitialApprovalInput>(json!({"task_id":"t7"})).is_err());
        assert!(parse_attempt_id("t7-a1").is_ok());
        assert!(parse_attempt_id("t7-a01").is_err());
        assert!(parse_attempt_id("t7-a0").is_err());
        assert!(parse_attempt_id("t7").is_err());
        assert!(parse_attempt_id("-a1").is_err());
        assert!(parse_attempt_id("t7\n-a1").is_err());
    }

    #[test]
    fn repetir_la_decision_tomada_es_un_replay_y_la_contraria_un_error() {
        let snap = |decision, status| InitialApprovalSnapshot { status, deadline_ms: Some(1), decision };
        let approved = snap(Some(InitialApprovalDecision::Approved), AttemptStatus::Starting);
        assert_eq!(resolved_result(&approved, true), Ok(Some(InitialApprovalResult::ReplayedApproved)));
        assert!(resolved_result(&approved, false).is_err());
        let rejected = snap(Some(InitialApprovalDecision::Rejected), AttemptStatus::Stopped);
        assert_eq!(resolved_result(&rejected, false), Ok(Some(InitialApprovalResult::ReplayedRejected)));
        assert!(resolved_result(&rejected, true).is_err());
        let expired = snap(Some(InitialApprovalDecision::Expired), AttemptStatus::Stopped);
        assert_eq!(resolved_result(&expired, true), Ok(Some(InitialApprovalResult::Expired)));
        assert_eq!(resolved_result(&expired, false), Ok(Some(InitialApprovalResult::Expired)));
        assert!(resolved_result(&snap(Some(InitialApprovalDecision::RunClosed), AttemptStatus::Stopped), true).is_err());
        assert_eq!(resolved_result(&snap(None, AttemptStatus::PendingApproval), true), Ok(None));
        assert!(resolved_result(&snap(None, AttemptStatus::Running), true).is_err(), "no pendiente");
    }
}
