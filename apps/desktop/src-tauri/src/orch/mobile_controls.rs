//! LXO-167: exact Attempt controls, using the existing Queue and Stop Commands.
use super::adapter::{Capability, CapabilityState};
use super::policy::{Category, Level};
use super::provider_registry::{LiveRegistry, ProviderLookup};
use super::queue_commands::QueuePort;
use super::{attempt_stop_rpc, queue_rpc, Core};
use crate::store::{AttemptStatus, Owner};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    attempt_id: String,
    operation: Option<Operation>,
    request_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Operation {
    Queue { request_id: String, body: String, confirm: bool },
    Cancel { queue_id: String, confirm: bool },
    Stop { confirm: bool },
}
fn policy_reason(level: Level) -> Option<&'static str> {
    match level {
        Level::Allow | Level::Confirm => None,
        Level::Elevated => Some("policy_out_of_band_required"),
        Level::Deny => Some("policy_denied"),
    }
}
fn require(ok: bool) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err("policy_confirm_required: confirma el destino exacto".into())
    }
}

impl Core {
    pub(super) fn mobile_controls(&self, user_id: u64, session_id: u64, args: Value) -> Result<Value, String> {
        let input: Input = serde_json::from_value(args).map_err(|_| "invalid_request: control inválido")?;
        if input.attempt_id.is_empty() || input.attempt_id.len() > 200 {
            return Err("invalid_request: Attempt inválido".into());
        }
        let context = self.mobile_context(user_id, session_id)?;
        if input.request_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 128) {
            return Err("invalid_request: solicitud inválida".into());
        }
        let attempt = self.attempt_row_for_resume(&input.attempt_id)?.ok_or("attempt_missing: el Attempt ya no existe")?;
        let task_id = attempt.task_id.clone();
        let (current, project) = {
            let state = self.lock();
            (state.attempt_n.get(&task_id).copied().map(i64::from) == Some(attempt.n), state.tasks.get(&task_id).and_then(|t| t.project_id.clone()))
        };
        let queue_policy = super::policy::mobile_policy(self, Category::Queue, project.as_deref(), &attempt.id)?;
        let stop_policy = super::policy::mobile_policy(self, Category::Stop, project.as_deref(), &attempt.id)?;
        let human_owned = self.attempt_owner(&attempt.id).map_err(|_| "controls_unavailable: no se pudo comprobar la propiedad")?.owner == Owner::Human;
        let queue_capability = super::queue_runtime::TurnPort::for_enqueue(self).capability(&attempt).err().map(|error| super::queue_commands::capability_error(&error).code);
        let interrupt_available = matches!(LiveRegistry::lookup(&self.provider_registry, &attempt.provider),
            ProviderLookup::Found(entry) if matches!(entry.matrix.capabilities.get(&Capability::Interrupt), Some(CapabilityState::Available)));
        let common = if !current {
            Some("stale_attempt")
        } else if human_owned {
            Some("desktop_required")
        } else {
            None
        };
        let queue_reason = common.or(policy_reason(queue_policy)).or(if attempt.status != AttemptStatus::Running { Some("not_running") } else { queue_capability });
        let stop_reason = common.or(policy_reason(stop_policy)).or(if !matches!(attempt.status, AttemptStatus::Running | AttemptStatus::Waiting | AttemptStatus::AwaitingTerminalApproval) {
            Some("not_running")
        } else if !interrupt_available {
            Some("unsupported_capability")
        } else {
            None
        });

        if let Some(operation) = input.operation {
            return match operation {
                Operation::Queue { request_id, body, confirm } => {
                    require(confirm)?;
                    if request_id.is_empty() || request_id.len() > 128 {
                        return Err("invalid_request: solicitud inválida".into());
                    }
                    if body.trim().is_empty() || body.chars().count() > 4000 {
                        return Err("invalid_request: instrucción de 1 a 4000 caracteres".into());
                    }
                    if let Some(reason) = policy_reason(queue_policy) {
                        return Err(format!("{reason}: no se puede encolar ahora"));
                    }
                    let replay = self.queue_request_row(&attempt.id, &request_id)?.is_some();
                    if !replay {
                        if let Some(reason) = queue_reason {
                            return Err(format!("{reason}: no se puede encolar ahora"));
                        }
                    }
                    queue_rpc::enqueue(self, &context, &queue_rpc::QueueInput { attempt_id: attempt.id, request_id, body, confirm: true })
                }
                Operation::Cancel { queue_id, confirm } => {
                    require(confirm)?;
                    let item = self.queue_item_row(&queue_id)?.ok_or("stale_queue: el elemento ya no existe")?;
                    if item.attempt_id != attempt.id {
                        return Err("stale_queue: el elemento pertenece a otro Attempt".into());
                    }
                    let mut out = queue_rpc::cancel(self, &context, &queue_rpc::CancelInput { queue_id })?;
                    out["attempt_id"] = json!(attempt.id);
                    Ok(out)
                }
                Operation::Stop { confirm } => {
                    require(confirm)?;
                    if let Some(reason) = stop_reason {
                        return Err(format!("{reason}: no se puede detener ahora"));
                    }
                    let outcome = attempt_stop_rpc::stop_mobile(self, &context, &attempt_stop_rpc::StopInput { attempt_id: attempt.id.clone(), confirm: true })?;
                    Ok(json!({"attempt_id": attempt.id, "status": if outcome == attempt_stop_rpc::StopResult::Stopped { "Stopped" } else { "Replayed" }}))
                }
            };
        }
        let mut queue = queue_rpc::pending(self, &context, &queue_rpc::PendingInput { attempt_id: attempt.id.clone() })?;
        let pending_total = queue["items"].as_array().map_or(0, Vec::len);
        for field in ["items", "finished"] {
            if let Some(items) = queue[field].as_array_mut() {
                items.truncate(30);
                for item in items {
                    let body = item["body"].as_str().unwrap_or_default().to_owned();
                    item["body"] = json!(body.chars().take(200).collect::<String>());
                    item["body_truncated"] = json!(body.chars().count() > 200);
                    item["failure"] = if item["failure"].is_string() { item["failure"].clone() } else { item["failure"].get("code").cloned().unwrap_or(Value::Null) };
                }
            }
        }
        queue["pending_total"] = json!(pending_total);
        queue["mobile_truncated"] = json!(pending_total > 30);
        let request_status = if let Some(request_id) = input.request_id {
            if request_id.len() > 128 || request_id.is_empty() {
                return Err("invalid_request: solicitud inválida".into());
            }
            self.queue_request_row(&attempt.id, &request_id)?
                .map(|item| json!({"request_id": request_id, "queue_id": item.queue_id, "status": item.status}))
        } else {
            None
        };
        Ok(json!({"attempt_id": attempt.id, "task_id": task_id, "project_id": project, "provider": attempt.provider,
            "status": attempt.status, "queue": queue, "request_status": request_status,
            "queue_control": {"policy": queue_policy.as_str(), "allowed": queue_reason.is_none(), "reason": queue_reason},
            "stop_control": {"policy": stop_policy.as_str(), "allowed": stop_reason.is_none(), "reason": stop_reason}}))
    }
}

#[cfg(test)]
mod tests {
    use super::super::adapter::fake::Step;
    use super::super::adapter::AdapterError;
    use super::super::attempt_e2e_tests::{wait_until, world, World};
    use super::super::dispatch_tests::{event_count, row};
    use super::*;

    fn running(provider: &str) -> (World, String) {
        let w = world(provider, None);
        w.adapter.push_turn(vec![Step::Bind("mobile-session"), Step::Hold, Step::Complete(Some("hecho".into()))]);
        let id = w.create(provider, "mobile-controls");
        w.approve(&id);
        wait_until("Attempt activo", || row(&w.core, &id).0 == "running" && w.core.has_adapter_run(id.rsplit_once("-a").unwrap().0));
        (w, id)
    }
    fn read(w: &World, id: &str) -> Value {
        w.core.mobile_controls(7, 42, json!({"attempt_id":id})).unwrap()
    }
    fn op(w: &World, id: &str, operation: Value) -> Result<Value, String> {
        w.core.mobile_controls(7, 42, json!({"attempt_id":id,"operation":operation}))
    }
    fn queue(w: &World, id: &str, key: &str, body: &str) -> Result<Value, String> {
        op(w, id, json!({"kind":"queue","request_id":key,"body":body,"confirm":true}))
    }

    #[test]
    fn mobile_controls_queue_replay_cancel_y_stop_durables() {
        let (w, id) = running("claude");
        assert_eq!(read(&w, &id)["queue_control"]["allowed"], true);
        let first = queue(&w, &id, "q1", "sigue").unwrap();
        assert_eq!(first["status"], "Queued");
        assert_eq!(queue(&w, &id, "q1", "sigue").unwrap()["queue_id"], first["queue_id"]);
        assert_eq!(queue(&w, &id, "q1", "sigue").unwrap()["status"], "Replayed");
        assert!(queue(&w, &id, "q1", "otro").unwrap_err().contains("request_conflict"));
        assert_eq!(event_count(&w.core, &id, "attempt.queued"), 1);
        let known = w.core.mobile_controls(7, 42, json!({"attempt_id":id,"request_id":"q1"})).unwrap();
        assert_eq!(known["request_status"]["queue_id"], first["queue_id"]);
        let cancel = json!({"kind":"cancel","queue_id":first["queue_id"],"confirm":true});
        assert_eq!(op(&w, &id, cancel.clone()).unwrap()["status"], "Cancelled");
        assert_eq!(op(&w, &id, cancel).unwrap()["status"], "AlreadyCancelled");
        assert_eq!(op(&w, &id, json!({"kind":"stop","confirm":true})).unwrap()["status"], "Stopped");
        assert_eq!(row(&w.core, &id).0, "stopped");
        assert_eq!(read(&w, &id)["stop_control"]["allowed"], false);
        assert_eq!(queue(&w, &id, "q1", "sigue").unwrap()["status"], "Replayed");
    }
    #[test]
    fn mobile_controls_fallo_de_entrega_no_es_entregado_y_no_se_duplica() {
        let (w, id) = running("claude");
        queue(&w, &id, "q1", "no llegará").unwrap();
        w.adapter.fail_resume_with(Some(AdapterError::provider("PRIVATE_ERROR")));
        w.adapter.release_hold();
        w.settled(&id, "done");
        let view = read(&w, &id);
        assert_eq!(view["queue"]["finished"][0]["status"], "failed");
        assert_eq!(view["queue"]["finished"][0]["failure"], "adapter_error");
        assert!(!view.to_string().contains("PRIVATE_ERROR"));
        assert_eq!(queue(&w, &id, "q1", "no llegará").unwrap()["status"], "Replayed");
        assert_eq!(event_count(&w.core, &id, "attempt.queue_delivered"), 0);
    }
    #[test]
    fn mobile_controls_policy_identidad_confirmacion_y_destino_fallan_cerrado() {
        let (w, id) = running("claude");
        assert!(w.core.mobile_controls(0, 42, json!({"attempt_id":id})).is_err());
        assert!(op(&w, &id, json!({"kind":"stop","confirm":false})).is_err());
        let other = w.create("claude", "other-mobile-task");
        let first = queue(&w, &id, "q1", "original").unwrap();
        assert!(op(&w, &other, json!({"kind":"cancel","queue_id":first["queue_id"],"confirm":true})).unwrap_err().contains("stale_queue"));
        assert_eq!(read(&w, &id)["queue"]["items"].as_array().unwrap().len(), 1);
        for category in ["queue", "stop"] {
            let rev = w.desktop("policy_effective", json!({})).unwrap()["revision"].clone();
            w.desktop("policy_set", json!({"scope":{"kind":"global"},"category":category,"level":"elevated","expected_revision":rev})).unwrap();
        }
        assert!(queue(&w, &id, "q2", "bloqueado").unwrap_err().contains("policy_out_of_band_required"));
        assert!(op(&w, &id, json!({"kind":"stop","confirm":true})).unwrap_err().contains("policy_out_of_band_required"));
        // Withdrawal is still permitted, as in the existing Core Queue Command.
        assert_eq!(op(&w, &id, json!({"kind":"cancel","queue_id":first["queue_id"],"confirm":true})).unwrap()["status"], "Cancelled");
        w.adapter.release_hold();
        w.settled(&id, "done");
    }
    #[test]
    fn mobile_controls_sin_resume_y_stop_sin_control_no_inventan_exito() {
        let (w, id) = running("codex");
        assert_eq!(read(&w, &id)["queue_control"]["allowed"], false);
        assert!(queue(&w, &id, "q1", "bloqueado").is_err());
        assert_eq!(event_count(&w.core, &id, "attempt.queued"), 0);
        w.core.adapter_runs_lock().remove(id.rsplit_once("-a").unwrap().0);
        assert!(op(&w, &id, json!({"kind":"stop","confirm":true})).unwrap_err().contains("attempt_stop_unavailable"));
        assert_eq!(row(&w.core, &id).0, "running");
        w.adapter.release_hold();
        w.settled(&id, "done");
    }
}
