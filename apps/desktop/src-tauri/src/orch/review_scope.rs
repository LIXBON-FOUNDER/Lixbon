//! Review coverage is a human plan; reports never constitute acceptance.
use super::events::{Actor, MutationContext};
use super::state::State;
use super::{review, Core};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

const MAX_FILES: usize = 256;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Part {
    reviewer_id: String,
    files: Vec<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PlanInput {
    request_id: String,
    attempt_id: String,
    head_commit: String,
    reviewers: Vec<String>,
    assignments: Option<Vec<Part>>,
    confirm: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReportInput {
    request_id: String,
    attempt_id: String,
    scope_id: String,
    part: usize,
    head_commit: String,
    files: Vec<String>,
    summary: String,
}
fn hash(v: &Value) -> String {
    format!("{:x}", Sha256::digest(v.to_string().as_bytes()))
}
fn valid_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 200 && !s.chars().any(char::is_control)
}
fn detail(s: &str) -> Value {
    serde_json::from_str(s).unwrap_or(Value::Null)
}
fn actor(ctx: &MutationContext) -> Result<String, String> {
    if ctx.client_id.as_deref().is_none_or(str::is_empty) {
        return Err("review_scope_auth_required".into());
    }
    match &ctx.actor {
        Actor::PersonId(id) if ctx.is_person() => Ok(format!("person:{id}")),
        Actor::Agent(task) => Ok(task.clone()),
        _ => Err("review_scope_auth_required".into()),
    }
}
fn latest(st: &State, attempt: &str) -> Option<Value> {
    st.decisions
        .iter()
        .rev()
        .filter(|d| d.kind == "review_scope")
        .map(|d| detail(d.detail_json.as_deref().unwrap_or("null")))
        .find(|p| p["attempt_id"] == attempt)
}

/// Pure projection: old reports remain historical, never count against a new HEAD/plan.
pub(super) fn coverage(st: &State, attempt: &str, head: &str) -> Value {
    let Some(plan) = latest(st, attempt) else {
        return json!({"state":"not_requested","required":false});
    };
    let current = plan["head_commit"] == head;
    let mut owners: BTreeMap<String, usize> = BTreeMap::new();
    let mut covered = BTreeSet::new();
    let mut parts = vec![];
    for (index, p) in plan["parts"].as_array().into_iter().flatten().enumerate() {
        for file in p["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            *owners.entry(file.into()).or_default() += 1;
        }
        let report = st
            .decisions
            .iter()
            .rev()
            .filter(|d| d.kind == "review_scope_report")
            .map(|d| detail(d.detail_json.as_deref().unwrap_or("null")))
            .find(|r| {
                r["scope_id"] == plan["scope_id"]
                    && r["part"] == index
                    && r["head_commit"] == plan["head_commit"]
            });
        let reported = report
            .as_ref()
            .map(|r| r["files"].clone())
            .unwrap_or_else(|| json!([]));
        if current {
            for f in reported
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                covered.insert(f.to_string());
            }
        }
        parts.push(json!({"index":index,"reviewer_id":p["reviewer_id"],"files":p["files"],"reported_files":reported,
            "valid":current && report.is_some(),"provenance":"agent_reported","summary":report.as_ref().map(|r|r["summary"].clone())}));
    }
    let overlaps: Vec<_> = owners
        .iter()
        .filter(|(_, n)| **n > 1)
        .map(|(p, _)| p.clone())
        .collect();
    let files: Vec<_> = plan["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    let uncovered: Vec<_> = files
        .iter()
        .filter(|f| !current || owners.get(**f) != Some(&1) || !covered.contains(**f))
        .map(|f| f.to_string())
        .collect();
    let complete = current && uncovered.is_empty() && overlaps.is_empty();
    let mut out = json!({"state":if !current {"stale"} else if complete {"complete"} else {"incomplete"},"required":true,
        "scope_id":plan["scope_id"],"head_commit":plan["head_commit"],"parts":parts,"total_files":files.len(),
        "covered_files":files.len()-uncovered.len(),"uncovered_files":uncovered,"overlaps":overlaps});
    out["revision"] = json!(hash(&out));
    out
}

pub(super) fn ensure_acceptance(
    st: &State,
    task: &str,
    head: &str,
    reason: Option<&str>,
    expected_revision: Option<&str>,
) -> Result<(), String> {
    let n = st.attempt_n.get(task).copied().unwrap_or(0);
    let c = coverage(st, &format!("{task}-a{n}"), head);
    if reason.is_some()
        && (expected_revision.is_none() || expected_revision != c["revision"].as_str())
    {
        return Err(
            "review_coverage_changed: la cobertura cambió; revisa y confirma de nuevo".into(),
        );
    }
    if c["required"] == true
        && c["state"] != "complete"
        && reason.is_none_or(|s| s.trim().is_empty())
    {
        return Err("review_coverage_incomplete: completa las partes o acepta explícitamente los huecos con un motivo".into());
    }
    if reason.is_some_and(|s| s.trim().is_empty() || s.len() > 2000 || s.contains('\0')) {
        return Err("review_coverage_invalid_override".into());
    }
    Ok(())
}

fn target(
    core: &Core,
    ctx: &MutationContext,
    attempt: &str,
    head: &str,
) -> Result<(String, Vec<String>), String> {
    let row = core
        .attempt_row_for_resume(attempt)?
        .ok_or("review_scope_attempt_not_found")?;
    let (repo, current) = {
        let st = core.lock();
        let t = st
            .tasks
            .get(&row.task_id)
            .ok_or("review_scope_task_not_found")?;
        (
            t.repo.clone(),
            st.attempt_n.get(&row.task_id).copied() == Some(row.n as u32),
        )
    };
    if !current || !row.status.is_final() {
        return Err("review_scope_requires_current_final_attempt".into());
    }
    let (base, found, _) = review::live_range(&core.acting(ctx.clone()), &row.task_id)?;
    if head != found {
        return Err("head_moved: vuelve a repartir sobre la revisión actual".into());
    }
    if review::accepted_for(&core.lock(), &row.task_id, head) {
        return Err(
            "review_scope_already_accepted: rechaza la revisión antes de modificar su cobertura"
                .into(),
        );
    }
    let names = super::git::run(
        &repo,
        &["diff", "--no-renames", "--name-only", "-z", &base, head],
    )?;
    if !names.ok {
        return Err("review_scope_diff_unavailable".into());
    }
    let mut files: Vec<String> = names
        .stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    files.sort();
    if files.len() > MAX_FILES || files.iter().any(|p| p.len() > 1024) {
        return Err("review_scope_too_large".into());
    }
    Ok((row.task_id, files))
}

fn check_mutation_target(st: &State, task: &str, attempt: &str, head: &str) -> Result<(), String> {
    let t = st.tasks.get(task).ok_or("review_scope_task_not_found")?;
    if !t.status.is_final()
        || format!("{task}-a{}", st.attempt_n.get(task).copied().unwrap_or(0)) != attempt
    {
        return Err("review_scope_requires_current_final_attempt".into());
    }
    if review::accepted_for(st, task, head) {
        return Err("review_scope_already_accepted".into());
    }
    Ok(())
}

fn plan(core: &Core, ctx: &MutationContext, i: PlanInput) -> Result<Value, String> {
    let owner = super::fork_runtime::identity_scope(ctx)?;
    if !i.confirm
        || !valid_id(&i.request_id)
        || !(1..=8).contains(&i.reviewers.len())
        || i.reviewers.iter().any(|r| !valid_id(r))
        || i.reviewers.iter().collect::<BTreeSet<_>>().len() != i.reviewers.len()
    {
        return Err("review_scope_invalid_request".into());
    }
    let digest = hash(&serde_json::to_value(&i).map_err(|_| "review_scope_invalid_request")?);
    let key = hash(&json!([owner, i.request_id]));
    let id = format!("rs-{}", &key[..32]);
    let (task, files) = target(core, ctx, &i.attempt_id, &i.head_commit)?;
    let parts = match i.assignments {
        Some(parts) => parts,
        None => i
            .reviewers
            .iter()
            .enumerate()
            .map(|(n, r)| Part {
                reviewer_id: r.clone(),
                files: files
                    .iter()
                    .enumerate()
                    .filter(|(k, _)| k % i.reviewers.len() == n)
                    .map(|(_, p)| p.clone())
                    .collect(),
            })
            .collect(),
    };
    if parts.len() != i.reviewers.len()
        || parts.iter().enumerate().any(|(n, p)| {
            p.reviewer_id != i.reviewers[n]
                || p.files.iter().any(|f| !files.contains(f))
                || p.files.iter().collect::<BTreeSet<_>>().len() != p.files.len()
        })
    {
        return Err("review_scope_invalid_assignments".into());
    }
    let out = json!({"scope_id":id,"digest":digest,"attempt_id":i.attempt_id,"head_commit":i.head_commit,"files":files,"parts":parts});
    core.mutate_as(ctx, |tx| {
        check_mutation_target(tx, &task, &i.attempt_id, &i.head_commit)?;
        if let Some(old) = tx
            .decisions
            .iter()
            .filter(|d| d.kind == "review_scope")
            .map(|d| detail(d.detail_json.as_deref().unwrap_or("null")))
            .find(|p| p["scope_id"] == id)
        {
            if old["digest"] != digest {
                return Err("review_scope_request_conflict".into());
            }
            return Ok(old);
        }
        let t = tx.tasks.get(&task).ok_or("review_scope_task_not_found")?;
        if review::branch_head(
            &t.repo,
            t.branch.as_deref().ok_or("review_scope_no_branch")?,
        )
        .as_deref()
            != Some(i.head_commit.as_str())
        {
            return Err("head_moved".into());
        }
        if latest(tx, &i.attempt_id).is_some_and(|p| p["scope_id"] == id) {
            return Err("review_scope_conflict".into());
        }
        tx.record_decision(&task, "review_scope", "human", &out)?;
        Ok(out.clone())
    })
    .map_err(|e| e.to_string())
}

fn submit(core: &Core, ctx: &MutationContext, i: ReportInput) -> Result<Value, String> {
    let reviewer = actor(ctx)?;
    if !valid_id(&i.request_id)
        || i.summary.trim().is_empty()
        || i.summary.len() > 2000
        || i.files.len() > MAX_FILES
    {
        return Err("review_scope_invalid_report".into());
    }
    // Authorize the assigned reviewer before touching another Task's repository.
    {
        let st = core.lock();
        let p = latest(&st, &i.attempt_id).ok_or("review_scope_not_found")?;
        if p["scope_id"] != i.scope_id || p["head_commit"] != i.head_commit {
            return Err("review_scope_stale".into());
        }
        let part = p["parts"]
            .get(i.part)
            .ok_or("review_scope_part_not_found")?;
        if part["reviewer_id"] != reviewer {
            return Err("review_scope_wrong_reviewer".into());
        }
    }
    let (task, _) = target(core, ctx, &i.attempt_id, &i.head_commit)?;
    let digest = hash(&serde_json::to_value(&i).map_err(|_| "review_scope_invalid_report")?);
    let key = hash(&json!([reviewer, i.request_id]));
    core.mutate_as(ctx,|tx| {
        check_mutation_target(tx,&task,&i.attempt_id,&i.head_commit)?;
        let p=latest(tx,&i.attempt_id).ok_or("review_scope_not_found")?;
        if p["scope_id"]!=i.scope_id || p["head_commit"]!=i.head_commit {return Err("review_scope_stale".into());}
        let part=p["parts"].get(i.part).ok_or("review_scope_part_not_found")?;
        if part["reviewer_id"]!=reviewer {return Err("review_scope_wrong_reviewer".into());}
        if i.files.iter().any(|f|!part["files"].as_array().unwrap().contains(&json!(f))) || i.files.iter().collect::<BTreeSet<_>>().len()!=i.files.len() {return Err("review_scope_wrong_files".into());}
        let t=tx.tasks.get(&task).ok_or("review_scope_task_not_found")?;
        if review::branch_head(&t.repo,t.branch.as_deref().ok_or("review_scope_no_branch")?).as_deref()!=Some(i.head_commit.as_str()) {return Err("head_moved".into());}
        for old in tx.decisions.iter().filter(|d|d.kind=="review_scope_report").map(|d|detail(d.detail_json.as_deref().unwrap_or("null"))) {
            if old["key"]==key {if old["digest"]==digest {return Ok(old);} return Err("review_scope_request_conflict".into());}
        }
        let out=json!({"key":key,"digest":digest,"scope_id":i.scope_id,"attempt_id":i.attempt_id,"head_commit":i.head_commit,
            "part":i.part,"reviewer_id":reviewer,"files":i.files,"summary":super::adapter::redact(&i.summary)});
        let row_actor=match &ctx.actor {Actor::Agent(t)=>t.as_str(),_=>"human"};
        tx.record_decision(&task, "review_scope_report", row_actor, &out)?;
        Ok(out)
    }).map_err(|e|e.to_string())
}

pub(super) fn dispatch(
    core: &Arc<Core>,
    ctx: &MutationContext,
    cmd: &str,
    args: &Value,
) -> Option<Result<Value, String>> {
    match cmd {
        "review_scope" => Some(
            serde_json::from_value(args.clone())
                .map_err(|_| "review_scope_invalid_request".into())
                .and_then(|i| plan(core, ctx, i)),
        ),
        "review_scope_report" => Some(
            serde_json::from_value(args.clone())
                .map_err(|_| "review_scope_invalid_report".into())
                .and_then(|i| submit(core, ctx, i)),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::super::attempt_e2e_tests::{world, World};
    use super::super::compare_e2e_tests::{commit, git, task_of, worktree};
    use super::super::events::Channel;
    use super::*;
    use crate::store::{
        AuthenticatedClient, ClientClaims, ClientCredential, ClientPrincipal, ClientRegistration,
        ClientSurface, DeviceIdentity,
    };

    fn setup() -> (World, String, String, Vec<String>) {
        let w = world("claude", None);
        let attempt = w.finished("scope-source");
        let names: Vec<_> = (0..10).map(|n| format!("file{n}.txt")).collect();
        let files: Vec<_> = names.iter().map(|n| (n.as_str(), "review me\n")).collect();
        commit(&w.core, &attempt, &files);
        let head = git(&worktree(&w.core, &attempt), &["rev-parse", "HEAD"]);
        let reviewers = (0..3)
            .map(|n| task_of(&w.create("claude", &format!("scope-reviewer-{n}"))))
            .collect();
        (w, attempt, head, reviewers)
    }
    fn agent(w: &World, task: &str) -> AuthenticatedClient {
        let secret = format!("scope-agent-{task}-credential-at-least-32-bytes");
        let reg = ClientRegistration::new(
            ClientSurface::Cli,
            DeviceIdentity::new(format!("scope-install-{task}"), None).unwrap(),
        )
        .unwrap();
        let cred =
            ClientCredential::new(ClientPrincipal::Agent(task.into()), secret.clone()).unwrap();
        w.core
            .storage
            .with_store(|s| s.register_client(&reg, &cred, 100))
            .unwrap()
            .unwrap();
        w.core.authenticate_client(&secret).unwrap().unwrap()
    }
    fn make_plan(
        w: &World,
        a: &str,
        h: &str,
        reviewers: &[String],
        key: &str,
        assignments: Value,
    ) -> Value {
        w.desktop("review_scope",json!({"request_id":key,"attempt_id":a,"head_commit":h,"reviewers":reviewers,"assignments":assignments,"confirm":true})).unwrap()
    }
    fn pack(w: &World, a: &str) -> Value {
        w.desktop("attempt_proof_pack", json!({"attempt_id":a}))
            .unwrap()
    }
    fn accept(w: &World, a: &str, h: &str, reason: Option<&str>) -> Result<Value, String> {
        let mut v = json!({"attempt_id":a,"head_commit":h,"decision":"accepted","confirm":true});
        if let Some(r) = reason {
            v["coverage_override_reason"] = json!(r);
            v["coverage_override_digest"] = pack(w, a)["coverage"]["revision"].clone();
        }
        w.desktop("attempt_review", v)
    }
    fn report(
        w: &World,
        client: &AuthenticatedClient,
        plan: &Value,
        part: usize,
        key: &str,
        files: Value,
    ) -> Result<Value, String> {
        w.core.rpc_authenticated_via(client,&ClientClaims::default(),Channel::Lxo,"","review_scope_report",&json!({"request_id":key,
            "attempt_id":plan["attempt_id"],"scope_id":plan["scope_id"],"part":part,"head_commit":plan["head_commit"],"files":files,"summary":"Revisado con provider simulado"}))
    }
    #[test]
    fn three_reviewers_cover_ten_files_and_only_human_can_accept() {
        let (w, a, h, reviewers) = setup();
        let p = make_plan(&w, &a, &h, &reviewers, "scope-plan", Value::Null);
        assert_eq!(pack(&w, &a)["coverage"]["total_files"], 10);
        assert!(accept(&w, &a, &h, None)
            .unwrap_err()
            .contains("coverage_incomplete"));
        let desktop = w.core.desktop_client().unwrap().unwrap();
        let ctx = MutationContext::authenticated(&desktop, &ClientClaims::default(), Channel::Ui)
            .unwrap();
        assert!(review::review_task(
            &w.core.acting(ctx),
            &task_of(&a),
            "accepted",
            &h,
            None,
            true
        )
        .unwrap_err()
        .contains("coverage_incomplete"));
        for (n, r) in reviewers.iter().enumerate() {
            let c = agent(&w, r);
            assert!(w
                .core
                .rpc_authenticated_via(
                    &c,
                    &ClientClaims::default(),
                    Channel::Lxo,
                    "",
                    "attempt_review",
                    &json!({"attempt_id":a,"decision":"accepted","head_commit":h,"confirm":true})
                )
                .is_err());
            let out = report(
                &w,
                &c,
                &p,
                n,
                &format!("report-{n}"),
                p["parts"][n]["files"].clone(),
            )
            .unwrap();
            assert_eq!(out["reviewer_id"], r.as_str());
            report(
                &w,
                &c,
                &p,
                n,
                &format!("report-{n}"),
                p["parts"][n]["files"].clone(),
            )
            .unwrap();
        }
        let c = pack(&w, &a)["coverage"].clone();
        assert_eq!(c["state"], "complete");
        assert_eq!(c["covered_files"], 10);
        let restored = w.core.storage.load_from_tables().unwrap().unwrap();
        assert_eq!(coverage(&restored, &a, &h), c);
        assert_eq!(accept(&w, &a, &h, None).unwrap()["outcome"], "recorded");
        assert!(w.desktop("review_scope",json!({"request_id":"new-plan","attempt_id":a,"head_commit":h,"reviewers":reviewers,"assignments":null,"confirm":true})).is_err());
    }
    #[test]
    fn changed_coverage_rejects_an_old_override_even_with_the_same_head() {
        let (w, a, h, reviewers) = setup();
        let p = make_plan(&w, &a, &h, &reviewers, "coverage-version", Value::Null);
        let c = agent(&w, &reviewers[0]);
        report(
            &w,
            &c,
            &p,
            0,
            "first-coverage",
            p["parts"][0]["files"].clone(),
        )
        .unwrap();
        let old = pack(&w, &a)["coverage"]["revision"].clone();
        report(&w, &c, &p, 0, "withdraw-coverage", json!([])).unwrap();
        let attempt = json!({"attempt_id":a,"head_commit":h,"decision":"accepted","confirm":true,
            "coverage_override_reason":"Asumo los huecos que vi antes","coverage_override_digest":old});
        assert!(w
            .desktop("attempt_review", attempt)
            .unwrap_err()
            .contains("coverage_changed"));
        assert_eq!(
            accept(&w, &a, &h, Some("Revisé personalmente la cobertura nueva")).unwrap()["outcome"],
            "recorded"
        );
    }

    #[test]
    fn moved_head_invalidates_reports_and_requires_new_review() {
        let (w, a, h, reviewers) = setup();
        let p = make_plan(&w, &a, &h, &reviewers, "moving-plan", Value::Null);
        let c = agent(&w, &reviewers[0]);
        report(
            &w,
            &c,
            &p,
            0,
            "moving-report",
            p["parts"][0]["files"].clone(),
        )
        .unwrap();
        commit(&w.core, &a, &[("file0.txt", "moved\n")]);
        let new = git(&worktree(&w.core, &a), &["rev-parse", "HEAD"]);
        let cov = pack(&w, &a)["coverage"].clone();
        assert_eq!(cov["state"], "stale");
        assert_eq!(cov["covered_files"], 0);
        assert_eq!(cov["parts"][0]["valid"], false);
        assert!(report(
            &w,
            &c,
            &p,
            0,
            "moving-report-2",
            p["parts"][0]["files"].clone()
        )
        .unwrap_err()
        .contains("head_moved"));
        assert!(accept(&w, &a, &new, None)
            .unwrap_err()
            .contains("coverage_incomplete"));
    }
    #[test]
    fn overlap_and_gaps_require_explicit_human_override_with_audit() {
        let (w, a, h, reviewers) = setup();
        let parts = json!([{"reviewer_id":reviewers[0],"files":["file0.txt"]},{"reviewer_id":reviewers[1],"files":["file0.txt"]},{"reviewer_id":reviewers[2],"files":["file1.txt"]}]);
        make_plan(&w, &a, &h, &reviewers, "overlap-plan", parts);
        let cov = pack(&w, &a)["coverage"].clone();
        assert_eq!(cov["overlaps"], json!(["file0.txt"]));
        assert_eq!(cov["uncovered_files"].as_array().unwrap().len(), 10);
        assert!(accept(&w, &a, &h, None).is_err());
        assert_eq!(
            accept(
                &w,
                &a,
                &h,
                Some("Asumo personalmente los archivos pendientes")
            )
            .unwrap()["outcome"],
            "recorded"
        );
        let decisions = w.core.lock().decisions.clone();
        let last = decisions.last().unwrap();
        assert_eq!(
            detail(last.detail_json.as_deref().unwrap())["coverage_override_reason"],
            "Asumo personalmente los archivos pendientes"
        );
    }
    #[test]
    fn reports_bind_authenticated_reviewer_part_and_request_content() {
        let (w, a, h, reviewers) = setup();
        let p = make_plan(&w, &a, &h, &reviewers, "binding-plan", Value::Null);
        let c = agent(&w, &reviewers[0]);
        assert!(report(
            &w,
            &c,
            &p,
            1,
            "wrong-reviewer",
            p["parts"][1]["files"].clone()
        )
        .unwrap_err()
        .contains("wrong_reviewer"));
        assert!(report(&w, &c, &p, 0, "wrong-file", json!(["../other"]))
            .unwrap_err()
            .contains("wrong_files"));
        report(&w, &c, &p, 0, "same-key", p["parts"][0]["files"].clone()).unwrap();
        assert!(report(&w, &c, &p, 0, "same-key", json!([]))
            .unwrap_err()
            .contains("request_conflict"));
        let before = w.core.lock().decisions.len();
        let mut args = json!({"request_id":"spoof","attempt_id":a,"scope_id":p["scope_id"],"part":0,"head_commit":h,"files":[],"summary":"x"});
        args["reviewer_id"] = json!(reviewers[0]);
        assert!(w.desktop("review_scope_report", args).is_err());
        assert_eq!(w.core.lock().decisions.len(), before);
    }
}
