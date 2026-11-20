//! Bounded read-only consultations (LXO-236). Never uses Fork or its approvals.
use super::adapter::{AdapterEvent, CancelToken, Capability, Gated, RunOutcome, StartRequest};
use super::events::MutationContext;
use super::provider_registry::{AdapterLookup, LiveRegistry};
use super::Core;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

static REQUEST_LOCK: Mutex<()> = Mutex::new(());
static ACTIVE: AtomicUsize = AtomicUsize::new(0);
struct Active;
impl Drop for Active {
    fn drop(&mut self) {
        ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Candidate {
    provider: String,
    model: Option<String>,
    effort: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Input {
    request_id: String,
    source_attempt_id: String,
    question: String,
    candidates: Vec<Candidate>,
    max_candidates: usize,
    max_cost_microusd: u64,
    timeout_ms: u64,
    confirm: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Evidence {
    path: String,
    line: usize,
    quote: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Point {
    statement: String,
    evidence: Vec<Evidence>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Report {
    answer: String,
    confidence: f64,
    disagreements: Vec<String>,
    points: Vec<Point>,
}

fn digest(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn bad() -> String {
    "panel_invalid_request: pregunta, candidatos o presupuesto inválidos".into()
}
fn text(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.len() <= max && !s.contains('\0')
}

fn validate(i: &Input) -> Result<(), String> {
    if !text(&i.request_id, 64)
        || !i
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        || !text(&i.question, 8000)
        || !(2..=4).contains(&i.candidates.len())
        || !(2..=4).contains(&i.max_candidates)
        || i.candidates.len() > i.max_candidates
        || !(100..=100_000_000).contains(&i.max_cost_microusd)
        || !(100..=120_000).contains(&i.timeout_ms)
    {
        return Err(bad());
    }
    let mut unique = BTreeSet::new();
    for c in &i.candidates {
        if !text(&c.provider, 64)
            || !c
                .provider
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || !unique.insert((&c.provider, &c.model, &c.effort))
        {
            return Err(bad());
        }
        for v in [&c.model, &c.effort].into_iter().flatten() {
            super::agents::safe_token(v).map_err(|_| bad())?;
        }
    }
    if !i.confirm {
        return Err(
            "panel_confirmation_required: confirma el panel completo y su presupuesto".into(),
        );
    }
    Ok(())
}

fn read(core: &Core, context: &MutationContext, id: &str) -> Result<Value, String> {
    let owner = super::fork_runtime::identity_scope(context)?;
    let rows = core.panel_events(&id)?;
    let req = rows
        .iter()
        .find(|(k, _)| k == "panel.requested")
        .ok_or("panel_not_found")?;
    let req: Value = serde_json::from_str(&req.1).map_err(|_| "panel_corrupt")?;
    if req["owner"] != owner {
        return Err("panel_not_found".into());
    }
    for (kind, payload) in rows.iter().rev() {
        if kind == "panel.completed" {
            let mut result: Value = serde_json::from_str(payload).map_err(|_| "panel_corrupt")?;
            result["panelists"] = json!(rows
                .iter()
                .filter(|(k, _)| k == "panel.panelist_recorded")
                .filter_map(|(_, p)| serde_json::from_str::<Value>(p)
                    .ok()
                    .map(|p| p["result"].clone()))
                .collect::<Vec<_>>());
            return Ok(result);
        }
    }
    // A crashed/restarted host never automatically resubmits a paid request.
    Ok(json!({"panel_id": id, "status": "requested", "digest": req["digest"], "replay": true}))
}

fn verified(repo: &str, head: &str, e: &Evidence) -> bool {
    if e.line == 0
        || e.line > 1_000_000
        || !text(&e.path, 256)
        || !text(&e.quote, 256)
        || e.path.starts_with('/')
        || e.path.contains('\\')
        || e.path.contains(':')
        || e.path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
    {
        return false;
    }
    // Read immutable blobs, never follow an on-disk symlink supplied by a model.
    let spec = format!("{head}:{}", e.path);
    let size = super::git::run(repo, &["cat-file", "-s", &spec])
        .ok()
        .filter(|o| o.ok)
        .and_then(|o| o.stdout.trim().parse::<usize>().ok());
    if !size.is_some_and(|n| n <= 256 * 1024) {
        return false;
    }
    super::git::run(repo, &["show", &spec])
        .ok()
        .filter(|o| o.ok)
        .and_then(|o| o.stdout.lines().nth(e.line - 1).map(str::to_string))
        .is_some_and(|line| line.contains(&e.quote))
}

#[cfg(test)]
mod tests {
    use super::super::adapter::fake::{FakeAdapter, Step};
    use super::super::adapter::{AdapterError, CapabilityMatrix, ProviderAdapter};
    use super::*;

    fn input() -> Input {
        serde_json::from_value(json!({"request_id":"panel-test","source_attempt_id":"t-a1","question":"Dónde está la base?",
            "candidates":[{"provider":"a","model":null,"effort":null},{"provider":"b","model":null,"effort":null},{"provider":"a","model":"other","effort":null}],
            "max_candidates":3,"max_cost_microusd":30000,"timeout_ms":1000,"confirm":true})).unwrap()
    }
    fn answer(path: &str, line: usize, quote: &str) -> Report {
        Report {
            answer: "La base".into(),
            confidence: 0.7,
            disagreements: vec![],
            points: vec![Point {
                statement: "La base existe".into(),
                evidence: vec![Evidence {
                    path: path.into(),
                    line,
                    quote: quote.into(),
                }],
            }],
        }
    }
    #[test]
    fn panel_quorum_requires_distinct_providers_and_real_evidence() {
        let repo = super::super::adapter_launcher_tests::repo_with_commit();
        let repo = repo.to_string_lossy();
        let head = super::super::git::head(&repo).unwrap();
        let files = super::super::git::run(&repo, &["ls-tree", "--name-only", "HEAD"])
            .unwrap()
            .stdout;
        let path = files.lines().next().unwrap();
        let content = super::super::git::run(&repo, &["show", &format!("HEAD:{path}")])
            .unwrap()
            .stdout;
        let quote = content.lines().next().unwrap();
        let good = answer(path, 1, quote);
        assert_eq!(
            synthesis(
                &[(0, "a".into(), good.clone()), (1, "b".into(), good.clone())],
                &repo,
                &head
            )[0]["status"],
            "corroborated"
        );
        assert_eq!(
            synthesis(
                &[(0, "a".into(), good.clone()), (1, "a".into(), good)],
                &repo,
                &head
            )[0]["status"],
            "unverified"
        );
        assert_eq!(
            synthesis(
                &[
                    (0, "a".into(), answer("../secret", 1, "bad")),
                    (1, "b".into(), answer(path, 999, "bad"))
                ],
                &repo,
                &head
            )[0]["status"],
            "unverified"
        );
    }
    #[test]
    fn panel_three_mixed_candidates_preserves_partial_failure_and_read_only_profile() {
        let repo = super::super::adapter_launcher_tests::repo_with_commit();
        let text = repo.to_string_lossy();
        let head = super::super::git::head(&text).unwrap();
        let a = Arc::new(FakeAdapter::full("a"));
        let b = Arc::new(FakeAdapter::full("b"));
        let failed = Arc::new(FakeAdapter::full("a"));
        for adapter in [&a, &b] {
            adapter.set_script(vec![
                Step::Output(serde_json::to_string(&answer("README.md", 1, "base")).unwrap()),
                Step::Complete(None),
            ]);
        }
        failed.fail_start_with(Some(AdapterError::provider("PRIVATE_FAILURE")));
        let adapters: Adapters = vec![a.clone() as Arc<dyn ProviderAdapter>, b.clone(), failed]
            .into_iter()
            .map(|a| (a, CapabilityMatrix::all_available()))
            .collect();
        let out = execute(&input(), adapters, &text, &head, "pn-test");
        assert_eq!(out["panelists"][0]["status"], "completed");
        assert_eq!(out["panelists"][1]["status"], "completed");
        assert_eq!(out["panelists"][2]["status"], "failed");
        assert!(out["panelists"][2]["report"].is_null());
        assert!(!out.to_string().contains("PRIVATE_FAILURE"));
        for adapter in [&a, &b] {
            assert_eq!(adapter.starts()[0].profile, "explorar");
            assert!(adapter.starts()[0].prompt.contains(&input().question));
        }
    }
    #[test]
    fn panel_deadline_does_not_report_a_timed_out_provider_as_agreement() {
        let mut i = input();
        i.timeout_ms = 100;
        let adapters: Adapters = (0..3)
            .map(|n| {
                let a = Arc::new(FakeAdapter::full(&format!("p{n}")));
                a.set_script(vec![Step::Wait]);
                (
                    a as Arc<dyn ProviderAdapter>,
                    CapabilityMatrix::all_available(),
                )
            })
            .collect();
        let before = Instant::now();
        let out = execute(&i, adapters, ".", "none", "pn-timeout");
        assert!(before.elapsed() < Duration::from_secs(2));
        assert_eq!(out["synthesis"], json!([]));
        assert!(out["panelists"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["status"] != "completed"));
    }
    #[test]
    fn panel_validates_budgets_confirmation_and_closed_schema_before_launch() {
        let mut i = input();
        assert!(validate(&i).is_ok());
        i.confirm = false;
        assert!(validate(&i).unwrap_err().contains("confirmation"));
        i.confirm = true;
        i.max_candidates = 2;
        assert!(validate(&i).is_err());
        i.max_candidates = 3;
        i.max_cost_microusd = 0;
        assert!(validate(&i).is_err());
        let mut v = serde_json::to_value(input()).unwrap();
        v["bypass"] = json!(true);
        assert!(serde_json::from_value::<Input>(v).is_err());
    }
    #[test]
    fn panel_rpc_records_once_and_replay_never_resubmits_paid_work() {
        let w = super::super::attempt_e2e_tests::world("claude", None);
        let source = w.finished("panel-source");
        let mut i = input();
        i.source_attempt_id = source;
        i.candidates = vec![
            Candidate {
                provider: "claude".into(),
                model: None,
                effort: None,
            },
            Candidate {
                provider: "codex".into(),
                model: None,
                effort: None,
            },
        ];
        let args = serde_json::to_value(i).unwrap();
        let out = w.desktop("panel", args.clone()).unwrap();
        let id = out["panel_id"].as_str().unwrap().to_string();
        let mut state = out;
        for _ in 0..100 {
            state = w.desktop("panel_status", json!({"panel_id":id})).unwrap();
            if state["status"] == "completed" {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(state["status"], "completed");
        assert_eq!(state["panelists"].as_array().unwrap().len(), 2);
        let count = w.core.panel_events(&id).unwrap().len();
        assert_eq!(w.desktop("panel", args.clone()).unwrap()["panel_id"], id);
        assert_eq!(w.core.panel_events(&id).unwrap().len(), count);
        let mut changed = args;
        changed["question"] = json!("Otra pregunta");
        assert!(w
            .desktop("panel", changed)
            .unwrap_err()
            .contains("conflict"));
        assert!(w
            .core
            .rpc(
                super::super::Caller::Agent(None),
                "",
                "panel_status",
                &json!({"panel_id":id})
            )
            .is_err());
    }
}

fn report(raw: &str) -> Option<Report> {
    let mut r: Report = serde_json::from_str(raw).ok()?;
    if !text(&r.answer, 4000)
        || !r.confidence.is_finite()
        || !(0.0..=1.0).contains(&r.confidence)
        || r.points.len() > 12
        || r.disagreements.len() > 8
        || r.disagreements.iter().any(|s| !text(s, 256))
        || r.points
            .iter()
            .any(|p| !text(&p.statement, 512) || p.evidence.len() > 4)
    {
        return None;
    }
    r.answer = super::adapter::redact(&r.answer);
    for d in &mut r.disagreements {
        *d = super::adapter::redact(d);
    }
    for p in &mut r.points {
        p.statement = super::adapter::redact(&p.statement);
        p.evidence
            .retain(|e| text(&e.path, 256) && text(&e.quote, 256));
        for e in &mut p.evidence {
            e.quote = super::adapter::redact(&e.quote);
            e.path = super::adapter::redact(&e.path);
        }
    }
    if serde_json::to_vec(&r).ok()?.len() > 5000 {
        return None;
    }
    Some(r)
}

fn synthesis(reports: &[(usize, String, Report)], repo: &str, head: &str) -> Value {
    let mut points: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (index, provider, r) in reports {
        for p in &r.points {
            let evidence: Vec<_> = p
                .evidence
                .iter()
                .filter(|e| verified(repo, head, e))
                .collect();
            points
                .entry(p.statement.clone())
                .or_default()
                .push(json!({"panelist": index, "provider": provider,
                "evidence": evidence, "evidence_verified": !evidence.is_empty()}));
        }
    }
    json!(points.into_iter().map(|(statement, sources)| {
        let providers: BTreeSet<_> = sources.iter().filter(|s| s["evidence_verified"] == true).filter_map(|s| s["provider"].as_str()).collect();
        json!({"statement": statement, "status": if providers.len() >= 2 { "corroborated" } else { "unverified" },
            "provenance": "agent_reported", "sources": sources})
    }).collect::<Vec<_>>())
}

pub(super) fn dispatch(
    core: &Arc<Core>,
    context: &MutationContext,
    cmd: &str,
    args: &Value,
) -> Option<Result<Value, String>> {
    match cmd {
        "panel" => Some(
            serde_json::from_value(args.clone())
                .map_err(|_| bad())
                .and_then(|input| start(core, context, input)),
        ),
        "panel_status" => Some((|| {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Query {
                panel_id: String,
            }
            let q: Query = serde_json::from_value(args.clone()).map_err(|_| bad())?;
            if !q.panel_id.starts_with("pn-") || q.panel_id.len() != 35 {
                return Err(bad());
            }
            read(core, context, &q.panel_id)
        })()),
        _ => None,
    }
}

fn start(core: &Arc<Core>, context: &MutationContext, input: Input) -> Result<Value, String> {
    let owner = super::fork_runtime::identity_scope(context)?;
    validate(&input)?;
    let id = format!(
        "pn-{}",
        &digest(&format!("{owner}:{}", input.request_id))[..32]
    );
    let hash = digest(&serde_json::to_string(&input).map_err(|_| bad())?);
    let _lock = REQUEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let existing = core.panel_events(&id)?;
    if let Some((_, req)) = existing.iter().find(|(k, _)| k == "panel.requested") {
        let req: Value = serde_json::from_str(req).map_err(|_| "panel_corrupt")?;
        if req["digest"] != hash {
            return Err("panel_request_conflict".into());
        }
        return read(core, context, &id);
    }
    let row = core
        .attempt_row_for_resume(&input.source_attempt_id)?
        .ok_or("panel_attempt_not_found")?;
    let (repo, project) = {
        let state = core.lock();
        let t = state
            .tasks
            .get(&row.task_id)
            .ok_or("panel_task_not_found")?;
        (t.cwd.clone(), t.project_id.clone())
    };
    let head = super::git::run(&repo, &["rev-parse", "--verify", "HEAD"])?;
    if !head.ok {
        return Err("panel_repository_required".into());
    }
    let head = head.stdout.trim().to_string();
    let mut adapters = vec![];
    for c in &input.candidates {
        match LiveRegistry::adapter_for(&core.provider_registry, &c.provider) {
            AdapterLookup::Found(a, matrix)
                if a.panel_supported()
                    && matrix.is_available(Capability::Start)
                    && matrix.is_available(Capability::Events)
                    && matrix.is_available(Capability::Interrupt) =>
            {
                adapters.push((a, matrix))
            }
            _ => {
                return Err(format!(
                    "panel_limits_unsupported: {} no garantiza consulta acotada de solo lectura",
                    c.provider
                ))
            }
        }
    }
    let fact = super::event_kinds::panel_requested(&id, &owner, &hash, &input.source_attempt_id, json!({"head_commit":head,"candidates":input.candidates.len(),"max_cost_microusd":input.max_cost_microusd,"timeout_ms":input.timeout_ms}), project.as_deref()).map_err(|e| e.to_string())?;
    if ACTIVE
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < 4).then_some(n + 1)
        })
        .is_err()
    {
        return Err("panel_busy: máximo cuatro paneles simultáneos".into());
    }
    let active = Active;
    core.record_facts(context, vec![fact])
        .map_err(|e| e.to_string())?;
    let (core, ctx, result_id) = (core.clone(), context.clone(), id.clone());
    std::thread::spawn(move || {
        let _active = active;
        let mut result = execute(&input, adapters, &repo, &head, &result_id);
        let mut facts = vec![];
        for (index, panelist) in result["panelists"].as_array().unwrap().iter().enumerate() {
            match super::event_kinds::panel_panelist(
                &result_id,
                index,
                panelist.clone(),
                project.as_deref(),
            ) {
                Ok(f) => facts.push(f),
                Err(_) => return,
            }
        }
        result.as_object_mut().unwrap().remove("panelists");
        if let Ok(fact) =
            super::event_kinds::panel_completed(&result_id, result, project.as_deref())
        {
            facts.push(fact);
            if let Err(e) = core.record_facts(&ctx, facts) {
                eprintln!("panel result persistence failed: {e}");
            }
        }
    });
    Ok(json!({"panel_id": id, "status": "requested", "digest": hash}))
}

type Adapters = Vec<(
    Arc<dyn super::adapter::ProviderAdapter>,
    super::adapter::CapabilityMatrix,
)>;
fn execute(input: &Input, adapters: Adapters, repo: &str, head: &str, id: &str) -> Value {
    let deadline = Instant::now() + Duration::from_millis(input.timeout_ms);
    let cancel = CancelToken::new();
    let (send, receive) = mpsc::channel();
    let mut results: Vec<Value> = input.candidates.iter().enumerate().map(|(index,c)| json!({"index": index,"provider":c.provider,"status":"timed_out","report":null})).collect();
    let mut reports = vec![];
    for (index, ((adapter, matrix), candidate)) in
        adapters.into_iter().zip(&input.candidates).enumerate()
    {
        let (send, cancel, repo, candidate, question, attempt) = (
            send.clone(),
            cancel.clone(),
            repo.to_string(),
            candidate.clone(),
            input.question.clone(),
            format!("{id}-{}", index + 1),
        );
        let family = adapter.panel_provider_identity();
        let cap = input.max_cost_microusd / input.candidates.len() as u64;
        std::thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let prompt = format!("Consulta de solo lectura. Responde solo JSON: {{\"answer\":\"texto\",\"confidence\":0.5,\"disagreements\":[],\"points\":[{{\"statement\":\"afirmación\",\"evidence\":[{{\"path\":\"ruta\",\"line\":1,\"quote\":\"línea citada\"}}]}}]}}. No modifiques archivos. Pregunta:\n{question}");
                let req = StartRequest { attempt_id: attempt, worktree: repo.into(), prompt, profile: "explorar".into(), model: candidate.model, effort: candidate.effort };
                let run = adapter.start_panel(req, cap, &cancel).map_err(|_| "launch_failed")?;
                let a = adapter.clone(); let r = run.clone(); let stop = cancel.clone();
                // The watchdog also interrupts a blocked events reader.
                let (done_tx, done_rx) = mpsc::channel();
                std::thread::spawn(move || { if done_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).is_err() { stop.cancel(); let _ = a.interrupt(&r); } });
                let mut output = String::new();
                let outcome = Gated::new(adapter.as_ref(), &matrix).events(&run, &cancel, &mut |e| {
                    if let AdapterEvent::Output { text } = e { if output.len() + text.len() <= 16_384 { output.push_str(&text); } else { cancel.cancel(); } }
                });
                let _ = done_tx.send(());
                match outcome {
                    Ok(RunOutcome::Completed { summary }) if !cancel.is_cancelled() => report(if output.is_empty() { summary.as_deref().unwrap_or("") } else { &output }).ok_or("invalid_report"),
                    _ => Err("provider_failed"),
                }
            })).unwrap_or(Err("provider_panicked"));
            let _ = send.send((index, candidate.provider, family, result));
        });
    }
    drop(send);
    while let Ok((index, provider, family, result)) =
        receive.recv_timeout(deadline.saturating_duration_since(Instant::now()))
    {
        match result {
            Ok(r) => {
                results[index] = json!({"index":index,"provider":provider,"requested_model":input.candidates[index].model,"requested_effort":input.candidates[index].effort,"effective_model":null,"status":"completed","provenance":"agent_reported","report":r});
                reports.push((index, family, r));
            }
            Err(code) => {
                results[index] = json!({"index":index,"provider":provider,"status":"failed","error":code,"report":null})
            }
        }
    }
    cancel.cancel();
    let mut summary = synthesis(&reports, repo, head);
    let mut truncated = false;
    while serde_json::to_vec(&summary).map_or(true, |b| b.len() > 5500) {
        if summary.as_array_mut().unwrap().pop().is_none() {
            break;
        }
        truncated = true;
    }
    json!({"panel_id":id,"status":"completed","synthesis_truncated":truncated,"head_commit":head,"max_cost_microusd":input.max_cost_microusd,
        "panelists":results,"synthesis":summary})
}
