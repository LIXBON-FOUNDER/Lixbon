//! LXO-166: private Mobile review over an exact, readable revision.
use serde::Deserialize;
use serde_json::{json, Value};

use super::policy::{Category, Level};
use super::{proof_pack, review, Caller, Core};
use crate::store::{AttentionCategory, AttentionStatus, TargetKind};

const DIFF_BYTES: usize = 32 * 1024;
const MAX_FILES: usize = 30;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    attention_id: String,
    attempt_id: String,
    decision: Option<Decision>,
    #[serde(default)]
    open_desktop: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::compare_e2e_tests::{commit, event_total, task_of, worktree};
    use super::super::proof_pack_e2e_tests::done_with_work;
    use super::super::attempt_e2e_tests::World;
    use crate::store::{AttentionTarget, NewAttention, Raised, Severity};

    fn ready() -> (World, String, String) {
        let (w, attempt) = done_with_work("Pruebas declaradas por el agente");
        let attention = w.core.storage.with_store(|s| s.attention_raise(&NewAttention {
            category: AttentionCategory::ReviewReady, severity: Severity::Medium,
            target: AttentionTarget::new(TargetKind::Task, &task_of(&attempt)).unwrap(),
            project_id: Some(w.project.clone()), run_id: None, subject: None, source_event_id: None,
            correlation_id: None, facts: "{}".into(), at: 123,
        })).unwrap().unwrap();
        let id = match attention { Raised::Created(row) | Raised::Existing(row) => row.id };
        (w, attempt, id)
    }
    fn read(w: &World, attempt: &str, attention: &str) -> Value {
        w.core.mobile_review(7, 42, json!({"attention_id":attention,"attempt_id":attempt})).unwrap()
    }
    fn decide(w: &World, attempt: &str, attention: &str, head: &str, verdict: &str) -> Result<Value, String> {
        w.core.mobile_review(7, 42, json!({"attention_id":attention,"attempt_id":attempt,
            "decision":{"review_id":attention,"head_commit":head,"verdict":verdict,"confirm":true}}))
    }
    #[test]
    fn mobile_review_decide_el_head_visto_y_resuelve_attention_sin_integrar() {
        for verdict in ["accepted", "rejected"] {
            let (w, attempt, attention) = ready();
            let pack = read(&w, &attempt, &attention);
            assert_eq!(pack["can_decide"], true, "{pack:#}");
            assert_eq!(pack["proof"]["tests"]["provenance"], "unknown");
            assert_eq!(pack["proof"]["summary"]["provenance"], "agent_reported");
            let head = pack["proof"]["decision"]["head_commit"].as_str().unwrap();
            assert_eq!(decide(&w, &attempt, &attention, head, verdict).unwrap()["outcome"], "recorded");
            assert!(worktree(&w.core, &attempt).exists());
            assert!(read_resolved(&w, &attempt, &attention).contains("stale_review"));
            assert_eq!(w.desktop("attempt_proof_pack", json!({"attempt_id":attempt})).unwrap()["acceptance"]["state"], verdict);
        }
    }
    fn read_resolved(w: &World, attempt: &str, attention: &str) -> String {
        w.core.mobile_review(7, 42, json!({"attention_id":attention,"attempt_id":attempt})).unwrap_err()
    }
    #[test]
    fn mobile_review_head_moved_no_registra_decision_y_diff_grande_exige_desktop() {
        let (w, attempt, attention) = ready();
        let old = read(&w, &attempt, &attention)["proof"]["decision"]["head_commit"].as_str().unwrap().to_owned();
        commit(&w.core, &attempt, &[("nuevo.txt", "nuevo\n")]);
        let before = event_total(&w.core);
        assert!(decide(&w, &attempt, &attention, &old, "accepted").unwrap_err().contains("head_moved"));
        assert_eq!(event_total(&w.core), before);
        commit(&w.core, &attempt, &[("grande.txt", &"x\n".repeat(DIFF_BYTES))]);
        let pack = read(&w, &attempt, &attention);
        assert_eq!(pack["blocked_reason"], "desktop_required");
        assert_eq!(pack["diff"]["files"], json!([]));
        assert_eq!(pack["can_decide"], false);
        let opened = w.core.mobile_review(7, 42, json!({"attention_id":attention,"attempt_id":attempt,"open_desktop":true})).unwrap();
        assert_eq!(opened["selection"]["attemptId"], attempt);
    }
    #[test]
    fn mobile_review_identidad_policy_y_destino_se_revalidan() {
        let (w, attempt, attention) = ready();
        let target = json!({"attention_id":attention,"attempt_id":attempt});
        assert!(w.core.mobile_review(0, 42, target.clone()).is_err());
        let mut spoofed = target.clone(); spoofed["scope"] = json!("desktop");
        assert!(w.core.mobile_review(7,42,spoofed).is_err());
        let head = read(&w, &attempt, &attention)["proof"]["decision"]["head_commit"].as_str().unwrap().to_owned();
        let client = w.core.mobile_identities.lock().unwrap().get(&(7,42)).unwrap().clone();
        assert!(w.core.rpc_authenticated_via(&client, &crate::store::ClientClaims::default(), super::super::events::Channel::Mobile,
            "", "attempt_review", &json!({"attempt_id":attempt,"decision":"accepted","head_commit":head,"confirm":true})).is_err());
        for cmd in ["review", "integrate", "pr"] {
            assert!(w.core.rpc_authenticated_via(&client, &crate::store::ClientClaims::default(), super::super::events::Channel::Mobile,
                "", cmd, &json!({"task_id":task_of(&attempt),"confirm":true})).is_err());
        }
        let revision = w.desktop("policy_effective", json!({})).unwrap()["revision"].as_i64().unwrap();
        w.desktop("policy_set", json!({"scope":{"kind":"global"},"category":"review","level":"elevated","expected_revision":revision})).unwrap();
        assert_eq!(read(&w, &attempt, &attention)["can_decide"], false);
        assert!(decide(&w,&attempt,&attention,&head,"accepted").unwrap_err().contains("policy_out_of_band_required"));
    }
    #[test]
    fn mobile_review_binarios_no_se_presentan_como_diff_revisable() {
        let (w, attempt, attention) = ready();
        commit(&w.core, &attempt, &[("binary.dat", "\0binary\0")]);
        let pack = read(&w, &attempt, &attention);
        assert_eq!(pack["can_decide"], false);
        assert_eq!(pack["blocked_reason"], "desktop_required");
        let head = pack["proof"]["decision"]["head_commit"].as_str().unwrap();
        assert!(decide(&w,&attempt,&attention,head,"accepted").unwrap_err().contains("desktop_required"));
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    review_id: String,
    head_commit: String,
    verdict: String,
    confirm: bool,
}

fn blocked_policy(level: Level) -> Option<&'static str> {
    match level {
        Level::Allow | Level::Confirm => None,
        Level::Elevated => Some("policy_out_of_band_required"),
        Level::Deny => Some("policy_denied"),
    }
}

impl Core {
    pub(super) fn mobile_review(&self, user_id: u64, session_id: u64, args: Value) -> Result<Value, String> {
        let input: Input = serde_json::from_value(args).map_err(|_| "invalid_request: revisión inválida")?;
        if input.attention_id.is_empty() || input.attention_id.len() > 200 || input.attempt_id.is_empty() || input.attempt_id.len() > 200 {
            return Err("invalid_request: destino inválido".into());
        }
        let context = self.mobile_context(user_id, session_id)?;
        let attention = self.storage.attention_get_scoped(&input.attention_id, None)
            .and_then(Result::ok).flatten().ok_or("stale_review: la revisión ya no existe")?;
        let pack = proof_pack::proof_pack(self, &Caller::User, Some(&context), &proof_pack::ProofPackInput { attempt_id: input.attempt_id.clone() })?;
        let task_id = pack["task_id"].as_str().ok_or("invalid_response: Task ausente")?.to_string();
        if attention.category != AttentionCategory::ReviewReady || attention.status != AttentionStatus::Active
            || !matches!((attention.target.kind, attention.target.id.as_str()), (TargetKind::Task, id) if id == task_id)
                && !matches!((attention.target.kind, attention.target.id.as_str()), (TargetKind::Attempt, id) if id == input.attempt_id)
        {
            return Err("stale_review: el destino de la revisión cambió".into());
        }
        if input.open_desktop {
            if input.decision.is_some() { return Err("invalid_request: operaciones incompatibles".into()); }
            return Ok(json!({"outcome": "desktop_requested", "selection": {"projectId": attention.project_id, "taskId": task_id, "attemptId": input.attempt_id}}));
        }
        let level = super::policy::mobile_policy(self, Category::Review, attention.project_id.as_deref(), &input.attempt_id)?;
        let shared = super::worktree_share::ensure_not_a_sharer(self, &json!({"attempt_id": input.attempt_id})).is_err();
        let head = pack["decision"]["head_commit"].as_str().map(str::to_owned);
        let small = pack["changes"]["total_files"].as_u64().is_some_and(|count| count <= MAX_FILES as u64);
        let objective_complete = pack["objective"]["value"]["objective"].as_str().is_none_or(|text| text.chars().count() <= 2000);
        let diff = if head.is_some() && small && objective_complete && !shared {
            review::task_diff(&self.acting(context.clone()), &task_id, DIFF_BYTES).ok()
        } else { None };
        let readable = diff.as_ref().is_some_and(|d| d["head_commit"].as_str() == head.as_deref()
            && d["truncated"] == false && d["files"].as_array().is_some_and(|files| files.len() <= MAX_FILES
                && files.iter().all(|f| f["patch"].is_string() && f["additions"].is_u64() && f["deletions"].is_u64())));
        let reason = blocked_policy(level).or_else(|| if pack["decision"]["can_decide"] != true { Some("review_unavailable") }
            else if pack["coverage"]["required"] == true && pack["coverage"]["state"] != "complete" { Some("desktop_required") }
            else if !readable { Some("desktop_required") } else { None });
        if let Some(decision) = input.decision {
            if decision.review_id != input.attention_id { return Err("stale_review: la solicitud de revisión cambió".into()); }
            if !decision.confirm { return Err("policy_confirm_required: confirma la revisión".into()); }
            if !matches!(decision.verdict.as_str(), "accepted" | "rejected") { return Err("invalid_request: decisión inválida".into()); }
            if head.as_deref() != Some(decision.head_commit.as_str()) { return Err("head_moved: vuelve a revisar la revisión actual".into()); }
            if let Some(reason) = reason { return Err(format!("{reason}: revisa este trabajo en Desktop")); }
            let out = proof_pack::review_attempt(self, &context, &proof_pack::ReviewInput {
                attempt_id: input.attempt_id, decision: decision.verdict, head_commit: decision.head_commit, comment: None, confirm: true, coverage_override_reason: None,
            })?;
            // Only the bounded acknowledgement leaves the host; no comment or paths.
            return Ok(json!({"attempt_id": out["attempt_id"], "outcome": out["outcome"], "head_commit": out["head_commit"], "decision": out["decision"]}));
        }
        let mut pack = pack;
        if let Some(text) = pack["objective"]["value"]["objective"].as_str().map(str::to_owned) {
            pack["objective"]["value"]["objective"] = json!(text.chars().take(2000).collect::<String>());
            pack["objective"]["mobile_truncated"] = json!(!objective_complete);
        }
        if let Some(files) = pack["changes"]["list"].as_array_mut() { files.truncate(MAX_FILES); }
        pack["changes"]["mobile_truncated"] = json!(!small);
        // Artifact locators can contain tokens or local paths. Show recorded metadata only.
        if let Some(items) = pack["artifacts"]["items"].as_array_mut() {
            items.truncate(30);
            for item in items {
                if let Some(map) = item.as_object_mut() { map.remove("uri"); }
            }
        }
        let desktop_link = attention.project_id.as_ref().and_then(|project_id| super::deep_link_read::generate(
            self, &Caller::User, Some(&context),
            &json!({"project_id": project_id, "task_id": task_id, "attempt_id": input.attempt_id, "view": "diff", "revision": head}),
        ).ok()).and_then(|link| link["canonical"].as_str().map(str::to_owned));
        let files = if readable { diff.as_ref().map(|d| d["files"].clone()).unwrap_or_else(|| json!([])) } else { json!([]) };
        Ok(json!({"attempt_id": input.attempt_id, "review_id": input.attention_id, "project_id": attention.project_id,
            "task_id": task_id, "policy": level.as_str(), "can_decide": reason.is_none(), "blocked_reason": reason,
            "proof": pack, "diff": {"files": files, "readable": readable, "limit_bytes": DIFF_BYTES}, "desktop_link": desktop_link}))
    }
}
