//! LXO-119 · lecturas vNext del modelo Task/Attempt: `core_model`, `task_list_v2`, `task_detail_v2`, `attempts_by_task`
//! y `attempt_detail`. Contrato: `docs/core/QUERIES.md` § Modelo Task/Attempt y fixtures en
//! `docs/core/fixtures/api/`.
//!
//! * Solo una Person autenticada, como el resto de lecturas del ADE.
//! * Leen las tablas normalizadas. Antes del corte responden `core_model_inactive`: un cliente vNext sigue con las
//!   lecturas F2 (`tasks_by_project`, `task_detail`), que no cambian.
//! * Lo que es de la Task (intención, estado derivado) y lo que es de la ejecución (Attempt, sesión, Worktree,
//!   Artifacts, revisión) van separados: un cliente nunca infiere el Attempt por la rama o la carpeta.

use serde_json::{json, Map, Value};

use super::events::{Actor, MutationContext};
use super::{Caller, Core};
use crate::store::{AttemptRow, AttemptStatus, Store, StoreResult, TaskIntent, TaskRow, AGENTIC_MODEL};

const TASK_API: u8 = 2;
const ATTEMPT_API: u8 = 1;
const MAX_ID_CHARS: usize = 200;
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 100;
/// Modelo que sirve el Core antes del corte.
pub(super) const LEGACY_MODEL: &str = "legacy";
/// Vista de compatibilidad para clientes F2 tras el corte (ADR §11.1).
pub(super) const LEGACY_COMPAT: &str = "legacy_task_v1";

fn invalid(m: impl Into<String>) -> String {
    format!("model_invalid_request: {}", m.into())
}

fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    match (context.map(|c| &c.actor), caller) {
        (Some(Actor::PersonId(id)), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("model_auth_required: solo una Person autenticada puede leer el modelo Task/Attempt".into()),
    }
}

fn args_of<'a>(args: &'a Value, allowed: &[&str], empty: &'a Map<String, Value>) -> Result<&'a Map<String, Value>, String> {
    let map = match args {
        Value::Null => empty,
        Value::Object(m) => m,
        _ => return Err(invalid("los parámetros deben ser un objeto")),
    };
    if let Some(k) = map.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(invalid(format!("parámetro desconocido: {k}")));
    }
    Ok(map)
}

fn required_id(map: &Map<String, Value>, name: &str) -> Result<String, String> {
    match map.get(name) {
        Some(Value::String(v)) if !v.trim().is_empty() && v.chars().count() <= MAX_ID_CHARS => Ok(v.trim().to_string()),
        Some(Value::String(_)) => Err(invalid(format!("`{name}` debe contener de 1 a {MAX_ID_CHARS} caracteres"))),
        Some(_) => Err(invalid(format!("`{name}` debe ser texto"))),
        None => Err(invalid(format!("falta `{name}`"))),
    }
}

fn store_err(e: crate::store::StoreError) -> String {
    format!("model_unavailable: {e}")
}

/// Lee el almacén con el modelo activo; antes del corte, `core_model_inactive`.
fn with_model<T>(core: &Core, f: impl FnOnce(&Store) -> StoreResult<Result<T, String>>) -> Result<T, String> {
    core.storage
        .read_store(|s| {
            if !s.agentic_model_active().map_err(store_err)? {
                return Err("core_model_inactive: el Core aún sirve el modelo legacy; usa tasks_by_project y task_detail".to_string());
            }
            f(s).map_err(store_err)?
        })
        .unwrap_or_else(|| Err("model_unavailable: el almacén no está abierto".into()))
}

/// `core_model`: qué modelo sirve el Core y qué compatibilidad ofrece. Funciona antes y después del corte.
pub(super) fn core_model(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    args_of(args, &[], &Map::new())?;
    let active = core.storage.read_store(|s| s.agentic_model_active()).unwrap_or(Ok(false)).map_err(store_err)?;
    Ok(if active {
        json!({ "core_model": AGENTIC_MODEL, "compat": [LEGACY_COMPAT], "queries": ["task_list_v2", "task_detail_v2", "attempts_by_task", "attempt_detail"] })
    } else {
        json!({ "core_model": LEGACY_MODEL, "compat": [], "queries": [] })
    })
}

/// Estado de la Task derivado de sus Attempts (ADR D17); la Task solo guarda la intención.
fn derived_state(s: &Store, t: &TaskRow, current: Option<&AttemptRow>) -> StoreResult<&'static str> {
    if t.intent == TaskIntent::Discarded {
        return Ok("discarded");
    }
    Ok(match current {
        None => "open",
        Some(a) if !a.status.is_final() => "in_progress",
        Some(a) if a.status == AttemptStatus::Done && s.attempt_integrated(&a.id)? => "integrated",
        Some(a) if a.status == AttemptStatus::Done => "in_review",
        Some(_) => "open",
    })
}

fn attempt_brief(a: &AttemptRow) -> Value {
    json!({ "id": a.id, "n": a.n, "status": a.status, "provider": a.provider, "model": a.model, "role": a.role, "external": a.external,
            "created_at": a.created_at, "started_at": a.started_at, "ended_at": a.ended_at })
}

fn task_item(s: &Store, t: &TaskRow) -> StoreResult<Value> {
    let attempts = s.attempts_of_task(&t.id)?;
    let current = attempts.last();
    Ok(json!({
        "id": t.id, "run_id": t.run_id, "parent_task_id": t.parent_task_id, "depth": t.depth, "project_id": t.project_id, "title": t.title,
        "intent": t.intent, "state": derived_state(s, t, current)?, "origin": t.origin, "created_at": t.created_at, "updated_at": t.updated_at,
        "attempt_count": attempts.len(), "current_attempt": current.map(attempt_brief),
    }))
}

/// `task_list_v2 {project_id, include_discarded?, limit?, cursor?}`: las Tasks del Project por creación, con su estado
/// derivado y su Attempt actual. El cursor es opaco.
pub(super) fn task_list(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["project_id", "include_discarded", "limit", "cursor"], &empty)?;
    let project = required_id(map, "project_id")?;
    let discarded = match map.get("include_discarded") {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(invalid("`include_discarded` debe ser booleano")),
    };
    let limit = match map.get("limit") {
        None | Some(Value::Null) => DEFAULT_LIMIT,
        Some(v) => v.as_u64().filter(|n| (1..=MAX_LIMIT as u64).contains(n)).ok_or_else(|| invalid(format!("`limit` va de 1 a {MAX_LIMIT}")))? as usize,
    };
    let after = match map.get("cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(c)) => Some(c.strip_prefix("t2:").map(String::from).ok_or_else(|| invalid("cursor desconocido"))?),
        Some(_) => return Err(invalid("`cursor` debe ser texto")),
    };
    with_model(core, |s| {
        let tasks = s.tasks_of_project(&project, discarded)?;
        let start = match &after {
            Some(id) => match tasks.iter().position(|t| &t.id == id) {
                Some(i) => i + 1,
                None => return Ok(Err(invalid("el cursor no es de esta lista"))),
            },
            None => 0,
        };
        let page: Vec<&TaskRow> = tasks.iter().skip(start).take(limit).collect();
        let next = (start + page.len() < tasks.len()).then(|| page.last().map(|t| format!("t2:{}", t.id))).flatten();
        let items = page.into_iter().map(|t| task_item(s, t)).collect::<StoreResult<Vec<_>>>()?;
        Ok(Ok(json!({ "v": TASK_API, "core_model": AGENTIC_MODEL, "project_id": project, "items": items, "next_cursor": next })))
    })
}

/// `task_detail_v2 {task_id}`: la intención, el estado derivado y la historia de Attempts (de la Task); el detalle de
/// cada ejecución se pide con `attempt_detail`.
pub(super) fn task_detail(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let id = required_id(args_of(args, &["task_id"], &empty)?, "task_id")?;
    with_model(core, |s| {
        let Some(t) = s.task_row(&id)? else { return Ok(Err(format!("model_not_found: no existe la Task {id}"))) };
        let mut v = task_item(s, &t)?;
        v["spec"] = json!(t.spec);
        v["children"] = json!(s.task_children(&id)?.iter().map(|c| c.id.clone()).collect::<Vec<_>>());
        v["attempts"] = json!(s.attempts_of_task(&id)?.iter().map(attempt_brief).collect::<Vec<_>>());
        v["thread"] = json!(s.thread_of_task(&id)?.map(|th| json!({ "id": th.id, "has_summary": th.summary.is_some() })));
        Ok(Ok(json!({ "v": TASK_API, "core_model": AGENTIC_MODEL, "task": v })))
    })
}

/// `attempts_by_task {task_id}`: los Attempts de la Task, del primero al último.
pub(super) fn attempts_by_task(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let id = required_id(args_of(args, &["task_id"], &empty)?, "task_id")?;
    with_model(core, |s| {
        if s.task_row(&id)?.is_none() {
            return Ok(Err(format!("model_not_found: no existe la Task {id}")));
        }
        let items: Vec<Value> = s.attempts_of_task(&id)?.iter().map(attempt_brief).collect();
        Ok(Ok(json!({ "v": ATTEMPT_API, "core_model": AGENTIC_MODEL, "task_id": id, "items": items })))
    })
}

/// `attempt_detail {attempt_id}`: la ejecución con su sesión (sin la referencia del proveedor), su Worktree, sus
/// Artifacts y su revisión vigente.
pub(super) fn attempt_detail(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let id = required_id(args_of(args, &["attempt_id"], &empty)?, "attempt_id")?;
    with_model(core, |s| {
        let Some(a) = s.attempt_row(&id)? else { return Ok(Err(format!("model_not_found: no existe el Attempt {id}"))) };
        let mut v = attempt_brief(&a);
        v["task_id"] = json!(a.task_id);
        v["effort"] = json!(a.effort);
        v["profile"] = json!(a.profile);
        v["summary"] = json!(a.summary);
        v["failure_reason"] = json!(a.failure_reason);
        v["integrated"] = json!(s.attempt_integrated(&a.id)?);
        v["provider_session"] = json!(s.provider_session_of_attempt(&id)?.map(|ps| json!({
            "id": ps.id, "status": ps.status, "resumable": ps.resumable, "binding": ps.binding, "bound": ps.external_ref.is_some(),
            "opened_by_attempt_id": ps.opened_by_attempt_id,
        })));
        v["worktree"] = json!(s.worktree_of_attempt(&id)?.map(|w| json!({
            "id": w.id, "provenance": w.provenance, "state": w.state, "machine": w.machine, "path": w.path, "branch": w.branch, "base_branch": w.base_branch,
            "branch_kept": w.branch_kept, "registered_by_attempt_id": w.attempt_id,
        })));
        v["artifacts"] = json!(s.artifacts_of_attempt(&id)?.iter().map(|x| json!({ "id": x.id, "kind": x.kind, "uri": x.uri, "sha256": x.sha256, "bytes": x.bytes })).collect::<Vec<_>>());
        v["review"] = json!(s.reviews_of_attempt(&id)?.pop().map(|r| json!({ "decision_id": r.decision_id, "verdict": r.verdict, "head_commit": r.head_commit, "base_commit": r.base_commit, "status": r.status })));
        Ok(Ok(json!({ "v": ATTEMPT_API, "core_model": AGENTIC_MODEL, "attempt": v })))
    })
}
