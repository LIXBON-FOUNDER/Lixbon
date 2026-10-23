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

/// Resumen de resultado en el brief: como mucho estos caracteres (el completo está en `attempt_detail.summary`).
const BRIEF_SUMMARY_CHARS: usize = 280;

/// `attempt_brief`: identidad, selección, fechas y, para no pedir el detalle de cada fila, dónde corrió (Worktree y
/// rama) y su resultado corto. `origin = legacy` marca un Attempt migrado: el legado no registraba el fin de un
/// intento, así que su `ended_at` puede ser `null` aunque sea final. Los del runtime (`core`) lo traen siempre al
/// terminar (CHECK de la 008).
fn attempt_brief(s: &Store, a: &AttemptRow) -> StoreResult<Value> {
    let wt = match &a.worktree_id {
        Some(_) => s.worktree_of_attempt(&a.id)?,
        None => None,
    };
    let summary: String = a.summary.chars().take(BRIEF_SUMMARY_CHARS).collect();
    Ok(json!({ "id": a.id, "n": a.n, "status": a.status, "provider": a.provider, "model": a.model, "role": a.role, "external": a.external,
            "created_at": a.created_at, "started_at": a.started_at, "ended_at": a.ended_at, "origin": a.origin,
            "ended_at_known": a.ended_at.is_some() || !a.status.is_final(),
            "worktree": wt.map(|w| json!({ "id": w.id, "branch": w.branch, "state": w.state })),
            "result": { "summary": summary, "truncated": a.summary.chars().count() > BRIEF_SUMMARY_CHARS, "failure_reason": a.failure_reason } }))
}

fn task_item(s: &Store, t: &TaskRow) -> StoreResult<Value> {
    let attempts = s.attempts_of_task(&t.id)?;
    let current = attempts.last();
    Ok(json!({
        "id": t.id, "run_id": t.run_id, "parent_task_id": t.parent_task_id, "depth": t.depth, "project_id": t.project_id, "title": t.title,
        "intent": t.intent, "state": derived_state(s, t, current)?, "origin": t.origin, "created_at": t.created_at, "updated_at": t.updated_at,
        "attempt_count": attempts.len(), "current_attempt": current.map(|a| attempt_brief(s, a)).transpose()?,
    }))
}

fn parse_limit(map: &Map<String, Value>) -> Result<usize, String> {
    match map.get("limit") {
        None | Some(Value::Null) => Ok(DEFAULT_LIMIT),
        Some(v) => Ok(v.as_u64().filter(|n| (1..=MAX_LIMIT as u64).contains(n)).ok_or_else(|| invalid(format!("`limit` va de 1 a {MAX_LIMIT}")))? as usize),
    }
}

fn optional_id(map: &Map<String, Value>, name: &str) -> Result<Option<String>, String> {
    match map.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_id(map, name).map(Some),
    }
}

/// Cursor de `task_list_v2`: `t3:<created_at>:<task_id>`, la clave del orden (keyset). Sigue valiendo aunque la Task
/// del cursor se descarte o cambie la lista entre páginas: nunca salta ni repite filas como un desplazamiento.
fn task_cursor(t: &TaskRow) -> String {
    format!("t3:{}:{}", t.created_at, t.id)
}

fn stale(m: &str) -> String {
    format!("model_cursor_stale: {m}")
}

/// Un cursor de `task_list_v2` ya leído: la clave (`t3:`) o, en la ventana de `core_model.compat`, el formato anterior
/// (`t2:<task_id>`), que se traduce a su clave al leer la Task.
enum TaskCursor {
    Key(i64, String),
    Legacy(String),
}

fn parse_task_cursor(c: &str) -> Result<TaskCursor, String> {
    if let Some(id) = c.strip_prefix("t2:") {
        if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
            return Err(stale("cursor con formato no reconocido"));
        }
        return Ok(TaskCursor::Legacy(id.to_string()));
    }
    let rest = c.strip_prefix("t3:").ok_or_else(|| stale("cursor con formato no reconocido"))?;
    let (at, id) = rest.split_once(':').ok_or_else(|| stale("cursor con formato no reconocido"))?;
    let at = at.parse::<i64>().map_err(|_| stale("cursor con formato no reconocido"))?;
    if id.is_empty() || id.chars().count() > MAX_ID_CHARS {
        return Err(stale("cursor con formato no reconocido"));
    }
    Ok(TaskCursor::Key(at, id.to_string()))
}

/// `task_list_v2 {project_id, include_discarded?, limit?, cursor?}`: las Tasks del Project por (creación, id), con su
/// estado derivado y su Attempt actual. Cursor opaco por clave (keyset).
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
    let limit = parse_limit(map)?;
    let after = match map.get("cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(c)) => Some(parse_task_cursor(c)?),
        Some(_) => return Err(invalid("`cursor` debe ser texto")),
    };
    with_model(core, |s| {
        // El cursor es de ESTE Project: su Task existe, es del Project y la clave coincide. Un `t2:` (ventana de
        // compatibilidad) toma la clave de su Task y la respuesta ya devuelve `t3:`.
        let after: Option<(i64, String)> = match &after {
            None => None,
            Some(TaskCursor::Key(at, id)) => match s.task_row(id)? {
                Some(t) if t.project_id.as_deref() == Some(project.as_str()) && t.created_at == *at => Some((*at, id.clone())),
                _ => return Ok(Err(invalid("el cursor no es de esta lista"))),
            },
            Some(TaskCursor::Legacy(id)) => match s.task_row(id)? {
                Some(t) if t.project_id.as_deref() == Some(project.as_str()) => {
                    eprintln!("task_list_v2: cursor `t2:` (formato anterior) aceptado por compatibilidad; la respuesta usa `t3:`");
                    Some((t.created_at, t.id))
                }
                _ => return Ok(Err(invalid("el cursor no es de esta lista"))),
            },
        };
        let ids = s.task_ids_after(&project, discarded, after.as_ref().map(|(at, id)| (*at, id.as_str())), limit + 1)?;
        let more = ids.len() > limit;
        let mut page = Vec::with_capacity(limit);
        for id in ids.iter().take(limit) {
            if let Some(t) = s.task_row(id)? {
                page.push(t);
            }
        }
        let next = if more { page.last().map(task_cursor) } else { None };
        let items = page.iter().map(|t| task_item(s, t)).collect::<StoreResult<Vec<_>>>()?;
        Ok(Ok(json!({ "v": TASK_API, "core_model": AGENTIC_MODEL, "project_id": project, "items": items, "next_cursor": next })))
    })
}

/// `task_detail_v2 {task_id}`: la intención, el estado derivado y la historia de Attempts (de la Task); el detalle de
/// cada ejecución se pide con `attempt_detail`.
pub(super) fn task_detail(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["task_id", "project_id"], &empty)?;
    let id = required_id(map, "task_id")?;
    let project = optional_id(map, "project_id")?;
    with_model(core, |s| {
        let Some(t) = s.task_row(&id)? else { return Ok(Err(format!("model_not_found: no existe la Task {id}"))) };
        if project.as_deref().is_some_and(|p| t.project_id.as_deref() != Some(p)) {
            return Ok(Err(format!("model_not_found: la Task {id} no es de ese Project")));
        }
        let mut v = task_item(s, &t)?;
        v["spec"] = json!(t.spec);
        v["children"] = json!(s.task_children(&id)?.iter().map(|c| c.id.clone()).collect::<Vec<_>>());
        v["attempts"] = json!(s.attempts_of_task(&id)?.iter().map(|a| attempt_brief(s, a)).collect::<StoreResult<Vec<_>>>()?);
        v["thread"] = json!(s.thread_of_task(&id)?.map(|th| json!({ "id": th.id, "has_summary": th.summary.is_some() })));
        Ok(Ok(json!({ "v": TASK_API, "core_model": AGENTIC_MODEL, "task": v })))
    })
}

/// `attempts_by_task {task_id, project_id?, limit?, cursor?}`: los Attempts de la Task por `n`, paginados por clave
/// (`a1:<n>`). Con `project_id`, la Task tiene que ser de ese Project.
pub(super) fn attempts_by_task(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["task_id", "project_id", "limit", "cursor"], &empty)?;
    let id = required_id(map, "task_id")?;
    let project = optional_id(map, "project_id")?;
    let limit = parse_limit(map)?;
    let after = match map.get("cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(c)) => Some(c.strip_prefix("a1:").and_then(|n| n.parse::<i64>().ok()).filter(|n| *n >= 1).ok_or_else(|| stale("cursor con formato no reconocido"))?),
        Some(_) => return Err(invalid("`cursor` debe ser texto")),
    };
    with_model(core, |s| {
        let Some(t) = s.task_row(&id)? else { return Ok(Err(format!("model_not_found: no existe la Task {id}"))) };
        if project.as_deref().is_some_and(|p| t.project_id.as_deref() != Some(p)) {
            return Ok(Err(format!("model_not_found: la Task {id} no es de ese Project")));
        }
        if let Some(n) = after {
            if s.attempt_row(&format!("{id}-a{n}"))?.is_none() {
                return Ok(Err(invalid("el cursor no es de esta lista")));
            }
        }
        let ns = s.attempt_ns_after(&id, after.unwrap_or(0), limit + 1)?;
        let more = ns.len() > limit;
        let mut items = Vec::with_capacity(limit);
        let mut last = None;
        for n in ns.iter().take(limit) {
            if let Some(a) = s.attempt_row(&format!("{id}-a{n}"))? {
                items.push(attempt_brief(s, &a)?);
                last = Some(a.n);
            }
        }
        let next = if more { last.map(|n| format!("a1:{n}")) } else { None };
        Ok(Ok(json!({ "v": ATTEMPT_API, "core_model": AGENTIC_MODEL, "task_id": id, "items": items, "next_cursor": next })))
    })
}

/// `attempt_detail {attempt_id}`: la ejecución con su sesión (sin la referencia del proveedor), su Worktree, sus
/// Artifacts y su revisión vigente.
pub(super) fn attempt_detail(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["attempt_id", "task_id", "project_id"], &empty)?;
    let id = required_id(map, "attempt_id")?;
    let task = optional_id(map, "task_id")?;
    let project = optional_id(map, "project_id")?;
    with_model(core, |s| {
        let Some(a) = s.attempt_row(&id)? else { return Ok(Err(format!("model_not_found: no existe el Attempt {id}"))) };
        if task.as_ref().is_some_and(|t| t != &a.task_id) {
            return Ok(Err(format!("model_not_found: el Attempt {id} no es de esa Task")));
        }
        if let Some(p) = &project {
            if s.task_row(&a.task_id)?.and_then(|t| t.project_id) != Some(p.clone()) {
                return Ok(Err(format!("model_not_found: el Attempt {id} no es de ese Project")));
            }
        }
        let mut v = attempt_brief(s, &a)?;
        v["task_id"] = json!(a.task_id);
        v["effort"] = json!(a.effort);
        v["profile"] = json!(a.profile);
        v["summary"] = json!(a.summary);
        v["failure_reason"] = json!(a.failure_reason);
        let integrated = s.attempt_integrated(&a.id)?;
        v["integrated"] = json!(integrated);
        // Hora del hecho `attempt.integrated` si el runtime lo registró; los integrados del corte no la tienen.
        let integrated_at: Option<i64> = if integrated {
            s.attempt_integrated_at(&a.id)?
        } else {
            None
        };
        v["integrated_at"] = json!(integrated_at);
        let current_n = s.attempt_current(&a.task_id)?.map(|c| c.n);
        v["provider_session"] = json!(s.provider_session_of_attempt(&id)?.map(|ps| json!({
            "id": ps.id, "status": ps.status, "resumable": ps.resumable, "binding": ps.binding, "bound": ps.external_ref.is_some(),
            "opened_by_attempt_id": ps.opened_by_attempt_id,
        })));
        v["worktree"] = json!(s.worktree_of_attempt(&id)?.map(|w| json!({
            "id": w.id, "provenance": w.provenance, "state": w.state, "machine": w.machine, "path": w.path, "branch": w.branch, "base_branch": w.base_branch,
            "branch_kept": w.branch_kept, "registered_by_attempt_id": w.attempt_id,
        })));
        v["artifacts"] = json!(s.artifacts_of_attempt(&id)?.iter().map(|x| json!({ "id": x.id, "kind": x.kind, "uri": x.uri, "sha256": x.sha256, "bytes": x.bytes })).collect::<Vec<_>>());
        // La última revisión con su vigencia: cuándo se hizo y se cerró, el HEAD que invalidó una `stale`, si es la
        // activa, si el Attempt sigue siendo el actual de su Task (D8) y si ya se integró.
        v["review"] = json!(s.reviews_of_attempt(&id)?.pop().map(|r| {
            let active = r.status == crate::store::ReviewStatus::Active;
            json!({ "decision_id": r.decision_id, "verdict": r.verdict, "head_commit": r.head_commit, "base_commit": r.base_commit, "status": r.status,
                    "at": r.at, "closed_at": r.closed_at, "observed_head": r.observed_head,
                    "validity": { "active": active, "attempt_is_current": current_n == Some(a.n), "integrated": integrated, "integrated_at": integrated_at } })
        }));
        Ok(Ok(json!({ "v": ATTEMPT_API, "core_model": AGENTIC_MODEL, "attempt": v })))
    })
}
