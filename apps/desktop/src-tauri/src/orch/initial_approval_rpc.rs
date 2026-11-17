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
use serde_json::{json, Value};

use super::events::{Channel, MutationContext};
use super::Core;
use crate::store::{AttemptRow, AttemptStatus, AttentionCategory, AttentionStatus, InitialApprovalDecision, InitialApprovalSnapshot, TargetKind};

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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MobileApprovalInput {
    attention_id: String,
    attempt_id: String,
    decision: Option<MobileDecision>,
    #[serde(default)]
    confirm: bool,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MobileDecision {
    Approve,
    Reject,
}

fn launch_blocked(attempt: &AttemptRow) -> Option<&'static str> {
    if !crate::store::mobile_launch_shape(attempt) {
        return Some("launch_scope_unsupported");
    }
    if cfg!(windows) && attempt.provider == "codex"
        && !super::agents::sandbox_proves_not_elevated(
            super::agents::codex_config_text().as_deref().and_then(super::agents::codex_windows_sandbox).as_deref()
        )
    {
        return Some("sandbox_requires_desktop");
    }
    None
}

pub(super) fn guard_mobile_launch(core: &Core, attempt: &AttemptRow, project: Option<&str>) -> Result<(), String> {
    use super::policy::{Category, Level};
    if let Some(reason) = launch_blocked(attempt) {
        return Err(format!("{reason}: el lanzamiento requiere Desktop"));
    }
    match super::policy::mobile_policy(core, Category::Start, project, &attempt.id)? {
        Level::Allow | Level::Confirm => Ok(()),
        Level::Elevated => Err("policy_out_of_band_required: el lanzamiento requiere Desktop".into()),
        Level::Deny => Err("policy_denied: la policy deniega el lanzamiento desde Mobile".into()),
    }
}

impl Core {
    pub(super) fn mobile_launch_approval(&self, user_id: u64, session_id: u64, args: Value) -> Result<Value, String> {
        use super::policy::Category;
        let input: MobileApprovalInput = serde_json::from_value(args).map_err(|_| "invalid_request: aprobación inválida")?;
        parse_attempt_id(&input.attempt_id).map_err(|_| "invalid_request: Attempt inválido")?;
        if input.attention_id.is_empty() || input.attention_id.len() > 200 || user_id == 0 || session_id == 0 {
            return Err("invalid_request: destino inválido".into());
        }
        let attention = self.storage.attention_get_scoped(&input.attention_id, None)
            .and_then(Result::ok).flatten().ok_or("stale_approval: la aprobación ya no está activa")?;
        if attention.category != AttentionCategory::Approval || attention.target.kind != TargetKind::Attempt
            || attention.target.id != input.attempt_id || attention.subject.as_deref() != Some(super::attention_rules::LAUNCH)
        {
            return Err("unsupported_approval: la solicitud requiere Desktop".into());
        }
        let snapshot = snapshot_of(self, &input.attempt_id).map_err(|_| "stale_approval: el Attempt ya no existe")?;
        let attempt = self.attempt_for_answer(&input.attempt_id).map_err(|_| "stale_approval: el Attempt ya no existe")?;
        let expired = snapshot.decision == Some(InitialApprovalDecision::Expired)
            || (snapshot.status == AttemptStatus::PendingApproval && snapshot.deadline_ms.is_some_and(|ms| ms <= super::state::now_ms() as i64));
        let status = if expired { "expired" } else if snapshot.decision.is_some() { "resolved" }
            else if snapshot.status == AttemptStatus::PendingApproval && attention.status == AttentionStatus::Active && snapshot.deadline_ms.is_some() { "pending" }
            else { "stale" };
        if let Some(decision) = input.decision {
            match status {
                "expired" => return Err("approval_expired: el plazo de la aprobación venció".into()),
                "resolved" => return Err("already_resolved: la aprobación ya se resolvió".into()),
                "pending" => {}
                _ => return Err("stale_approval: la aprobación dejó de estar activa".into()),
            }
            if !input.confirm {
                return Err("policy_confirm_required: confirma la decisión".into());
            }
            guard_mobile_launch(self, &attempt, attention.project_id.as_deref())?;
            let ctx = self.mobile_context(user_id, session_id)?;
            let result = decide(self, &ctx, &input.attempt_id, matches!(decision, MobileDecision::Approve));
            let outcome = match result {
                Ok(InitialApprovalResult::Approved) => "approved",
                Ok(InitialApprovalResult::Rejected) => "rejected",
                Ok(InitialApprovalResult::Expired) => return Err("approval_expired: el plazo venció".into()),
                Ok(_) => return Err("already_resolved: la aprobación ya se resolvió".into()),
                Err(_) if snapshot_of(self, &input.attempt_id).is_ok_and(|latest| latest.decision.is_some()) =>
                    return Err("already_resolved: la aprobación ya se resolvió".into()),
                Err(_) => return Err("stale_approval: cambió la aprobación".into()),
            };
            return Ok(json!({"outcome": outcome, "attempt_id": input.attempt_id}));
        }
        let policy = super::policy::mobile_policy(self, Category::Start, attention.project_id.as_deref(), &attempt.id)?;
        let blocked_reason = launch_blocked(&attempt);
        Ok(json!({
            "status": status, "deadline_ms": snapshot.deadline_ms, "attempt_id": attempt.id, "task_id": attempt.task_id,
            "project_id": attention.project_id, "provider": attempt.provider, "profile": attempt.profile,
            "worktree_strategy": if attempt.worktree_id.is_some() { "attached" } else if attempt.provider_session_id.is_some() { "resume" } else { "new" },
            "policy": policy.as_str(), "blocked_reason": blocked_reason,
            "can_decide": status == "pending" && blocked_reason.is_none() && matches!(policy, super::policy::Level::Allow | super::policy::Level::Confirm)
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mobile_decide_el_lanzamiento_vigente_con_contexto_autenticado() {
        use super::super::attempt_e2e_tests::world;
        use super::super::dispatch_tests::row;

        let w = world("claude", None);
        for (decision, outcome) in [("approve", "approved"), ("reject", "rejected")] {
            let attempt = w.create("claude", decision);
            let items = w.desktop("attention_list", json!({"category":"approval","target_kind":"attempt","target_id":attempt})).unwrap();
            let item = &items["items"][0];
            assert_eq!(item["launch_approval"], true);
            let target = json!({"attention_id":item["id"],"attempt_id":attempt});
            let data = w.core.mobile_launch_approval(7, 42, target.clone()).unwrap();
            assert_eq!(data["policy"], "confirm");
            assert_eq!(data["can_decide"], true);
            assert_eq!(data["worktree_strategy"], "new");
            assert_eq!(data["provider"], "claude");
            let mut args = target;
            args["decision"] = json!(decision);
            assert!(w.core.mobile_launch_approval(7, 42, args.clone()).unwrap_err().contains("policy_confirm_required"));
            args["confirm"] = json!(true);
            assert!(w.core.mobile_launch_approval(0, 42, args.clone()).is_err());
            assert_eq!(w.core.mobile_launch_approval(7, 42, args.clone()).unwrap()["outcome"], outcome);
            assert!(w.core.mobile_launch_approval(7, 42, args).unwrap_err().contains("already_resolved"));
            if decision == "approve" {
                w.core.wake_dispatcher();
                w.settled(&attempt, "done");
            } else {
                assert_eq!(row(&w.core, &attempt).0, "stopped");
            }
        }
    }

    #[test]
    fn mobile_no_decide_fuera_de_banda_o_despues_del_plazo() {
        use super::super::attempt_e2e_tests::world;
        use super::super::initial_approval_tests::e2e::make_deadline_due;
        let w = world("claude", None);
        let attempt = w.create("claude", "blocked-mobile");
        let items = w.desktop("attention_list", json!({"category":"approval","target_kind":"attempt","target_id":attempt})).unwrap();
        let mut args = json!({"attention_id":items["items"][0]["id"],"attempt_id":attempt});
        let revision = w.desktop("policy_effective", json!({})).unwrap()["revision"].clone();
        w.desktop("policy_set", json!({"scope":{"kind":"global"},"category":"start","level":"elevated","expected_revision":revision})).unwrap();
        assert_eq!(w.core.mobile_launch_approval(7, 42, args.clone()).unwrap()["can_decide"], false);
        args["decision"] = json!("approve");
        args["confirm"] = json!(true);
        assert!(w.core.mobile_launch_approval(7, 42, args.clone()).unwrap_err().contains("policy_out_of_band_required"));
        make_deadline_due(&w.core, &attempt);
        assert!(w.core.mobile_launch_approval(7, 42, args).unwrap_err().contains("approval_expired"));
    }

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
