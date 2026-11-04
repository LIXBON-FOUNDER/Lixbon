//! Proof Pack y decisión de revisión por Attempt (LXO-147, épica F5). Contrato: `docs/core/PROOF_PACK.md`.
//!
//! * `attempt_proof_pack { attempt_id }` (lectura): la evidencia ANTES del diff, con la procedencia de cada dato (la misma de Compare:
//!   `verified` · `agent_reported` · `unknown`, [`COMPARE.md`](../../../../../../docs/core/COMPARE.md)) y el estado de la aceptación frente al HEAD de ahora.
//! * `attempt_review { attempt_id, decision, head_commit, comment?, confirm }` (decisión humana): aceptar o rechazar **la revisión exacta
//!   que se vio**. Si la rama se movió, no se registra nada (`head_moved`).
//!
//! Review e Integration son decisiones distintas: aceptar no integra ni abre un PR. Rechazar no borra el Attempt ni su worktree. El texto
//! de un comentario nunca llega al log: el evento solo dice que lo había (`has_comment`).
//!
//! # Qué se revisa
//! La rama de una Task es la del Attempt ACTUAL, así que solo se decide sobre él (`review_not_current` para uno anterior) y cuando ya terminó
//! (`review_not_final`): aceptar un trabajo que sigue moviéndose sería aceptar un HEAD que va a dejar de ser ese.

use serde::Deserialize;
use serde_json::{json, Value};

use super::compare_read::{changed_files, evidence, load_one, range_of, recorded, sum, unknown, Loaded, Range, MAX_FILES};
use super::events::{Actor, MutationContext};
use super::model_read::{invalid, require_person, with_model};
use super::review;
use super::{Caller, Core};
use crate::store::AttemptStatus;

const API: u8 = 1;
const MAX_SUMMARY_CHARS: usize = 2000;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ProofPackInput {
    pub attempt_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct ReviewInput {
    pub attempt_id: String,
    pub decision: String,
    pub head_commit: String,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub confirm: bool,
}

fn final_status(s: AttemptStatus) -> bool {
    s.is_final()
}

/// El estado de la aceptación frente al HEAD de ahora: `none` · `accepted` (de este HEAD) · `stale` (se aceptó otro HEAD y la rama se movió) ·
/// `rejected`. La decisión más reciente de la Task es la que cuenta, no cualquier `accepted`.
fn acceptance(core: &Core, task_id: &str, current_head: Option<&str>) -> Value {
    let last = review::last_review_decision(&core.lock(), task_id);
    let Some((detail, id, at)) = last else { return json!({ "state": "none" }) };
    let decided_head = detail["head_commit"].as_str().unwrap_or_default().to_string();
    let matches_now = current_head.is_some_and(|h| h == decided_head);
    let state = match detail["decision"].as_str() {
        Some("accepted") if matches_now => "accepted",
        Some("accepted") => "stale",
        Some("rejected") => "rejected",
        _ => "none",
    };
    json!({ "state": state, "decision_id": id, "at": at, "decided_head": decided_head, "head_matches": matches_now })
}

/// Qué rango se enseña: el HEAD VIVO de la rama si es el Attempt actual (es sobre el que se decide, y una revisión ya hecha no lo congela),
/// y si no, lo que se pueda saber del Attempt como en Compare.
fn proof_range(core: &Core, context: &MutationContext, item: &Loaded) -> Result<Range, &'static str> {
    if item.is_current && item.worktree.is_some() {
        if let Ok((base, head, source)) = review::live_range(&core.acting(context.clone()), &item.attempt.task_id) {
            return Ok(Range { base: Some(base), head, source: if source == "recorded" { "live_branch" } else { "live_branch_merge_base" } });
        }
    }
    range_of(core, context, item)
}

/// `attempt_proof_pack` · `{ attempt_id }`. Solo lectura, solo una Person de Desktop.
pub(super) fn proof_pack(core: &Core, caller: &Caller, context: Option<&MutationContext>, input: &ProofPackInput) -> Result<Value, String> {
    require_person(caller, context)?;
    let context = context.ok_or_else(|| "model_auth_required: solo una Person autenticada puede leer el Proof Pack".to_string())?;
    if input.attempt_id.trim().is_empty() || input.attempt_id.chars().count() > 200 {
        return Err(invalid("`attempt_id` debe contener de 1 a 200 caracteres"));
    }
    let item = with_model(core, |s| load_one(s, input.attempt_id.trim(), None))?;
    let a = &item.attempt;

    let range = proof_range(core, context, &item);
    let (revision, changes) = match &range {
        Err(reason) => (
            json!({ "source": null, "base_commit": unknown(reason), "head_commit": unknown(reason) }),
            json!({ "files": unknown(reason), "additions": unknown(reason), "deletions": unknown(reason), "list": [], "truncated": false, "total_files": null }),
        ),
        Ok(r) => {
            let revision = json!({ "source": r.source, "base_commit": recorded(r.base.clone().map(Value::from), "no_base"), "head_commit": evidence(json!(r.head), "verified") });
            let changes = match changed_files(core, r, &a.task_id) {
                Err(reason) => json!({ "files": unknown(reason), "additions": unknown(reason), "deletions": unknown(reason), "list": [], "truncated": false, "total_files": null }),
                Ok((files, total)) => {
                    let truncated = total > files.len();
                    let (adds, dels) = if truncated { (None, None) } else { (sum(&files, |f| f.1), sum(&files, |f| f.2)) };
                    let why = if truncated { "truncated" } else { "binary_files" };
                    json!({
                        "files": evidence(json!(total), "verified"),
                        "additions": recorded(adds.map(Value::from), why),
                        "deletions": recorded(dels.map(Value::from), why),
                        "list": files.iter().map(|(path, add, del)| json!({ "path": path, "additions": add, "deletions": del })).collect::<Vec<_>>(),
                        "truncated": truncated,
                        "total_files": total,
                    })
                }
            };
            (revision, changes)
        }
    };

    // Lo que el agente cuenta no es una prueba: va como `agent_reported`, recortado.
    let summary = if a.summary.trim().is_empty() {
        unknown("no_summary")
    } else {
        evidence(json!(a.summary.chars().take(MAX_SUMMARY_CHARS).collect::<String>()), "agent_reported")
    };
    let artifacts = if item.artifacts.is_empty() {
        json!({ "provenance": "unknown", "reason": "none_recorded", "items": [] })
    } else {
        json!({
            "provenance": "agent_reported",
            "items": item.artifacts.iter().map(|x| json!({ "id": x.id, "kind": x.kind, "uri": x.uri, "sha256": x.sha256, "bytes": x.bytes })).collect::<Vec<_>>(),
        })
    };
    let (task_title, objective) = {
        let st = core.lock();
        let title = st.tasks.get(&a.task_id).map(|t| t.title.clone()).unwrap_or_default();
        let objective = st.tasks.get(&a.task_id).and_then(|t| st.runs.get(&t.run)).map(|r| r.objective.clone()).unwrap_or_default();
        (title, objective)
    };
    let objective = if objective.trim().is_empty() && task_title.trim().is_empty() {
        unknown("no_objective")
    } else {
        evidence(json!({ "title": task_title, "objective": objective }), "verified")
    };

    let current_head = range.as_ref().ok().filter(|r| r.source.starts_with("live")).map(|r| r.head.clone());
    let acceptance = acceptance(core, &a.task_id, current_head.as_deref());
    // Qué puede decidir la persona AHORA y sobre qué HEAD: el mismo que se muestra y que viaja al aceptar.
    let can_decide = match (&current_head, a.status) {
        (_, AttemptStatus::PendingApproval) => Err("pending_approval"),
        _ if !item.is_current => Err("not_current_attempt"),
        _ if !final_status(a.status) => Err("not_final"),
        (None, _) => Err("no_revision"),
        (Some(_), _) => Ok(()),
    };

    // Completo = lo imprescindible para decidir (la revisión y sus cambios) está comprobado. Las lagunas se dicen siempre.
    let known = |v: &Value| v["provenance"] != "unknown";
    let mut gaps: Vec<&str> = Vec::new();
    if !known(&revision["head_commit"]) {
        gaps.push("revision");
    }
    if !known(&changes["files"]) {
        gaps.push("changes");
    }
    if !known(&summary) {
        gaps.push("summary");
    }
    if artifacts["provenance"] == "unknown" {
        gaps.push("artifacts");
    }
    gaps.push("tests"); // el Core aún no recoge resultados de pruebas
    let complete = !gaps.contains(&"revision") && !gaps.contains(&"changes");

    Ok(json!({
        "v": API,
        "attempt_id": a.id,
        "task_id": a.task_id,
        "n": a.n,
        "is_current": item.is_current,
        "status": evidence(json!({ "status": a.status, "failure_reason": a.failure_reason }), "verified"),
        "objective": objective,
        "revision": revision,
        "changes": changes,
        "summary": summary,
        "artifacts": artifacts,
        "tests": unknown("not_collected"),
        "acceptance": acceptance,
        "decision": match can_decide {
            Ok(()) => json!({ "can_decide": true, "head_commit": current_head }),
            Err(reason) => json!({ "can_decide": false, "reason": reason, "head_commit": null }),
        },
        "completeness": { "state": if complete { "complete" } else { "partial" }, "gaps": gaps },
        "limits": { "max_files": MAX_FILES, "max_summary_chars": MAX_SUMMARY_CHARS },
    }))
}

/// `attempt_review`: la decisión de la persona sobre el HEAD que vio. Solo una Person de Desktop.
pub(super) fn review_attempt(core: &Core, context: &MutationContext, input: &ReviewInput) -> Result<Value, String> {
    if !context.is_person() || !matches!(context.actor, Actor::PersonId(_)) || context.client_id.as_deref().is_none_or(str::is_empty) {
        return Err("revisar un Attempt requiere una Person autenticada".into());
    }
    let id = input.attempt_id.trim();
    let (task_id, n) = id
        .rsplit_once("-a")
        .and_then(|(t, n)| n.parse::<u32>().ok().filter(|n| *n > 0 && format!("{t}-a{n}") == id).map(|n| (t.to_string(), n)))
        .ok_or_else(|| "Falta un id de Attempt válido".to_string())?;
    let (current, status) = {
        let st = core.lock();
        let task = st.tasks.get(&task_id).ok_or_else(|| format!("review_not_found: no existe la Task {task_id}"))?;
        (st.attempt_n.get(&task_id).copied(), task.status)
    };
    if current != Some(n) {
        return Err(format!("review_not_current: solo se revisa el Attempt actual de la Task ({task_id}-a{}); la rama es la suya", current.unwrap_or(0)));
    }
    if !status.is_final() {
        return Err("review_not_final: el Attempt todavía no terminó; aceptar un trabajo en marcha sería aceptar un HEAD que va a cambiar".into());
    }
    let out = review::review_task(&core.acting(context.clone()), &task_id, &input.decision, &input.head_commit, input.comment.as_deref(), input.confirm)?;
    if out["outcome"] == "recorded" {
        core.emit(review::EV_REVIEWED, &json!({ "task_id": task_id, "decision": input.decision, "head_commit": input.head_commit, "at": out["at"] }));
    }
    let mut out = out;
    out["attempt_id"] = json!(id);
    Ok(out)
}
