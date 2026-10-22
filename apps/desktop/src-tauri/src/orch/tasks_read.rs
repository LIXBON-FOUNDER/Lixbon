//! LXO-98 · lecturas de Tasks por Project para el ADE (`tasks_by_project`, `task_detail`).
//!
//! Solo lectura: proyecta las tasks del `State` (la misma fuente que cuenta `projects_overview`) y
//! comprueba el Project en el registro de SQLite con el guard del estado tomado, igual que el overview.
//! No escribe, no toca el disco fuera del almacén y no infiere campos: lo que no existe va como `null`.
//! La clave es siempre `project_id`; la ruta o la rama nunca identifican una Task.

use serde_json::{json, Map, Value};

use super::events::{Actor, MutationContext};
use super::state::{State, Task};
use super::{Caller, Core};

const API_VERSION: u8 = 1;
const MAX_ID_CHARS: usize = 200;
const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 100;
const LIST_PARAMS: [&str; 4] = ["project_id", "status", "limit", "cursor"];
const DETAIL_PARAMS: [&str; 2] = ["project_id", "task_id"];

fn invalid(message: impl Into<String>) -> String {
    format!("tasks_invalid_request: {}", message.into())
}

/// Solo una Person autenticada, como el resto de lecturas del ADE.
fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    let context = context
        .ok_or_else(|| "tasks_auth_required: la lectura requiere un cliente autenticado".to_string())?;
    match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("tasks_auth_required: solo una Person autenticada puede leer Tasks".into()),
    }
}

fn object<'a>(args: &'a Value, allowed: &[&str], empty: &'a Map<String, Value>) -> Result<&'a Map<String, Value>, String> {
    let map = match args {
        Value::Null => empty,
        Value::Object(map) => map,
        _ => return Err(invalid("los parámetros deben ser un objeto")),
    };
    if let Some(key) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(format!("parámetro desconocido: {key}")));
    }
    Ok(map)
}

fn required_id(map: &Map<String, Value>, name: &str) -> Result<String, String> {
    match map.get(name).filter(|v| !v.is_null()) {
        None => Err(invalid(format!("falta `{name}`"))),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() || value.chars().count() > MAX_ID_CHARS {
                return Err(invalid(format!("`{name}` debe contener de 1 a {MAX_ID_CHARS} caracteres")));
            }
            Ok(value.to_string())
        }
        Some(_) => Err(invalid(format!("`{name}` debe ser texto"))),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StatusFilter {
    Active,
    Final,
    All,
}

impl StatusFilter {
    fn as_str(self) -> &'static str {
        match self {
            StatusFilter::Active => "active",
            StatusFilter::Final => "final",
            StatusFilter::All => "all",
        }
    }

    fn keeps(self, task: &Task) -> bool {
        match self {
            StatusFilter::Active => !task.status.is_final(),
            StatusFilter::Final => task.status.is_final(),
            StatusFilter::All => true,
        }
    }
}

struct ListParams {
    project_id: String,
    status: StatusFilter,
    limit: usize,
    after: Option<(u64, String)>,
}

/// El cursor es opaco para el cliente (`k<created_at>.<id>` de la última Task entregada); solo vale el
/// `next_cursor` de la página anterior. Al ser por clave y no por posición, una Task creada o cambiada
/// entre páginas no repite ni salta las que ya existían.
fn parse_cursor(value: Option<&Value>) -> Result<Option<(u64, String)>, String> {
    let bad = || invalid("`cursor` no es un next_cursor de esta query");
    match value {
        None => Ok(None),
        Some(Value::String(s)) => {
            let rest = s.strip_prefix('k').ok_or_else(bad)?;
            let (created, id) = rest.split_once('.').ok_or_else(bad)?;
            if created.is_empty() || created.len() > 20 || !created.bytes().all(|b| b.is_ascii_digit()) || id.is_empty() || id.len() > 128 {
                return Err(bad());
            }
            Ok(Some((created.parse().map_err(|_| bad())?, id.to_string())))
        }
        Some(_) => Err(invalid("`cursor` debe ser texto")),
    }
}

fn parse_list(args: &Value) -> Result<ListParams, String> {
    let empty = Map::new();
    let map = object(args, &LIST_PARAMS, &empty)?;
    let get = |name: &str| map.get(name).filter(|v| !v.is_null());
    let project_id = required_id(map, "project_id")?;
    let status = match get("status") {
        None => StatusFilter::Active,
        Some(Value::String(s)) if s == "active" => StatusFilter::Active,
        Some(Value::String(s)) if s == "final" => StatusFilter::Final,
        Some(Value::String(s)) if s == "all" => StatusFilter::All,
        Some(_) => return Err(invalid("`status` debe ser `active`, `final` o `all`")),
    };
    let limit = match get("limit") {
        None => DEFAULT_LIMIT,
        Some(v) => v
            .as_u64()
            .filter(|n| *n >= 1 && *n <= MAX_LIMIT as u64)
            .ok_or_else(|| invalid(format!("`limit` debe ser un entero entre 1 y {MAX_LIMIT}")))? as usize,
    };
    let after = parse_cursor(get("cursor"))?;
    Ok(ListParams { project_id, status, limit, after })
}

/// Comprueba en el registro que el Project existe. Se llama con el guard del estado tomado.
fn ensure_project(core: &Core, project_id: &str) -> Result<(), String> {
    let found = core
        .storage
        .read_store(|store| store.project(project_id))
        .ok_or_else(|| "tasks_unavailable: el Core no tiene un almacén autoritativo disponible".to_string())?
        .map_err(|_| "tasks_read_failed: no se pudo consultar el registro de proyectos".to_string())?;
    match found {
        Some(_) => Ok(()),
        None => Err(format!("tasks_project_not_found: no existe el Project {project_id}")),
    }
}

fn root_of<'a>(state: &'a State, task: &Task) -> Option<&'a str> {
    state.runs.get(&task.run).map(|run| run.root.as_str())
}

/// Elemento de la lista: identidad durable, estado real y metadatos opcionales.
fn item(state: &State, task: &Task) -> Value {
    json!({
        "id": task.id,
        "run_id": task.run,
        "parent_id": task.parent,
        "root_id": root_of(state, task),
        "status": task.status,
        "title": task.title,
        "provider": task.agent,
        "model": task.model,
        "branch": task.branch,
        "worktree": task.worktree,
        "created_at": task.created,
        "updated_at": task.updated,
    })
}

pub(super) fn list(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let params = parse_list(args)?;
    let state = core.lock();
    ensure_project(core, &params.project_id)?;
    let mut tasks: Vec<&Task> = state
        .tasks
        .values()
        .filter(|t| t.project_id.as_deref() == Some(params.project_id.as_str()))
        .filter(|t| params.status.keeps(t))
        .collect();
    // Orden estable por clave inmutable: lo creado más reciente primero y, a igualdad, por id.
    tasks.sort_by(|a, b| (b.created as u64).cmp(&(a.created as u64)).then_with(|| a.id.cmp(&b.id)));
    let rest: Vec<&&Task> = tasks
        .iter()
        .filter(|t| match &params.after {
            None => true,
            Some((created, id)) => (t.created as u64) < *created || ((t.created as u64) == *created && t.id.as_str() > id.as_str()),
        })
        .collect();
    let has_more = rest.len() > params.limit;
    let shown = &rest[..rest.len().min(params.limit)];
    let page: Vec<Value> = shown.iter().map(|t| item(&state, t)).collect();
    let next_cursor = match (has_more, shown.last()) {
        (true, Some(last)) => Value::String(format!("k{}.{}", last.created as u64, last.id)),
        _ => Value::Null,
    };
    Ok(json!({
        "v": API_VERSION,
        "project_id": params.project_id,
        "filters": { "status": params.status.as_str() },
        "limit": params.limit,
        "tasks": page,
        "has_more": has_more,
        "next_cursor": next_cursor,
    }))
}

fn last_decision<'a>(state: &'a State, task: &str, kind: &str) -> Option<&'a super::state::Decision> {
    state.decisions.iter().filter(|d| d.task == task && d.kind == kind).max_by_key(|d| d.id)
}

fn detail_json(decision: &super::state::Decision) -> Value {
    decision
        .detail_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .unwrap_or(Value::Null)
}

pub(super) fn detail(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let map = object(args, &DETAIL_PARAMS, &empty)?;
    let project_id = required_id(map, "project_id")?;
    let task_id = required_id(map, "task_id")?;
    let state = core.lock();
    ensure_project(core, &project_id)?;
    let task = state
        .tasks
        .get(&task_id)
        .filter(|t| t.project_id.as_deref() == Some(project_id.as_str()))
        .ok_or_else(|| format!("tasks_not_found: no existe la Task {task_id} en el Project {project_id}"))?;

    let mut out = item(&state, task);
    let mut child_ids: Vec<&str> = state.children(&task.id).into_iter().map(|t| t.id.as_str()).collect();
    child_ids.sort_unstable();
    let messages: Vec<Value> = state
        .messages
        .iter()
        .filter(|m| m.from == task.id || m.to == task.id)
        .map(|m| json!({ "id": m.id, "kind": m.kind, "from": m.from, "to": m.to, "body": m.body, "reply_to": m.reply_to, "at": m.at }))
        .collect();
    let review = last_decision(&state, &task.id, "review").map(|d| {
        let detail = detail_json(d);
        json!({ "decision": detail.get("decision").cloned().unwrap_or(Value::Null), "head_commit": detail.get("head_commit").cloned().unwrap_or(Value::Null), "at": d.at })
    });
    let integration = last_decision(&state, &task.id, "merge").map(|d| {
        let detail = detail_json(d);
        json!({ "outcome": detail.get("outcome").cloned().unwrap_or(Value::Null), "decision_id": d.id, "at": d.at })
    });
    let extra = json!({
        "project_id": project_id,
        "child_ids": child_ids,
        "phase": task.phases.last().map(|p| json!({ "name": p.name, "done": p.done, "note": p.note, "at": p.at })),
        "messages": messages,
        "cwd": task.cwd,
        "merged": task.merged,
        "review": review,
        "integration": integration,
    });
    if let (Some(out), Value::Object(extra)) = (out.as_object_mut(), extra) {
        out.extend(extra);
    }
    Ok(json!({ "v": API_VERSION, "task": out }))
}
