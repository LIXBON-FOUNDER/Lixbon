//! LXO-92 · lectura de Activity (`activity_list`), compartida por el RPC de Tauri y `POST /rpc`.
//!
//! Proyecta con [`super::activity_format`] las páginas del Event Log; no abre otra conexión, no escribe y no
//! guarda estado: el cursor es el `seq` del evento, igual que en `events` (`docs/core/EVENTOS.md`), así que
//! reconectar con el último `next_cursor` continúa la misma secuencia. Contrato: `docs/core/ACTIVITY.md`.

use serde_json::{json, Map, Value};

use super::activity_format::{item, PROJECTION_VERSION};
use super::events::{Actor, MutationContext};
use super::{Caller, Core};
use crate::store::{EventQuery, StoreError, DEFAULT_PAGE, MAX_PAGE};

const API_VERSION: u8 = 1;
const MAX_FILTER_CHARS: usize = 200;
const PARAMS: [&str; 7] = [
    "cursor",
    "limit",
    "order",
    "project_id",
    "run_id",
    "target_kind",
    "target_id",
];

fn invalid(message: impl Into<String>) -> String {
    format!("activity_invalid_request: {}", message.into())
}

/// Solo una Person autenticada (Desktop, CLI o Mobile). Un Agent y el token legacy no leen Activity.
fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    let context = context.ok_or_else(|| {
        "activity_auth_required: la lectura requiere un cliente autenticado".to_string()
    })?;
    match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("activity_auth_required: solo una Person autenticada puede leer Activity".into()),
    }
}

struct Params {
    cursor: i64,
    limit: usize,
    newest_first: bool,
    project_id: Option<String>,
    run_id: Option<String>,
    target_kind: Option<String>,
    target_id: Option<String>,
}

fn text_filter(map: &Map<String, Value>, name: &str) -> Result<Option<String>, String> {
    match map.get(name).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() || value.chars().count() > MAX_FILTER_CHARS {
                return Err(invalid(format!(
                    "`{name}` debe contener de 1 a {MAX_FILTER_CHARS} caracteres"
                )));
            }
            Ok(Some(value.to_string()))
        }
        Some(_) => Err(invalid(format!("`{name}` debe ser texto"))),
    }
}

fn decimal(value: &Value, name: &str, min: u64) -> Result<u64, String> {
    let parsed = match value {
        Value::Number(n) => n.as_u64(),
        Value::String(s)
            if !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()) =>
        {
            s.parse().ok()
        }
        _ => None,
    };
    parsed
        .filter(|n| *n >= min && *n <= i64::MAX as u64)
        .ok_or_else(|| invalid(format!("`{name}` debe ser un entero decimal >= {min}")))
}

fn parse_params(args: &Value) -> Result<Params, String> {
    let empty = Map::new();
    let map = match args {
        Value::Null => &empty,
        Value::Object(map) => map,
        _ => return Err(invalid("los parámetros deben ser un objeto")),
    };
    if let Some(key) = map.keys().find(|key| !PARAMS.contains(&key.as_str())) {
        return Err(invalid(format!("parámetro desconocido: {key}")));
    }
    let get = |name: &str| map.get(name).filter(|v| !v.is_null());
    let cursor = get("cursor")
        .map(|v| decimal(v, "cursor", 0))
        .transpose()?
        .unwrap_or(0) as i64;
    let limit = get("limit")
        .map(|v| decimal(v, "limit", 1))
        .transpose()?
        .map(|n| n.min(MAX_PAGE as u64) as usize)
        .unwrap_or(DEFAULT_PAGE);
    let newest_first = match get("order") {
        None => false,
        Some(Value::String(s)) if s == "asc" => false,
        Some(Value::String(s)) if s == "desc" => true,
        Some(_) => return Err(invalid("`order` debe ser `asc` o `desc`")),
    };
    let target_kind = text_filter(map, "target_kind")?;
    let target_id = text_filter(map, "target_id")?;
    if target_id.is_some() && target_kind.is_none() {
        return Err(invalid("`target_id` exige `target_kind`"));
    }
    Ok(Params {
        cursor,
        limit,
        newest_first,
        project_id: text_filter(map, "project_id")?,
        run_id: text_filter(map, "run_id")?,
        target_kind,
        target_id,
    })
}

pub(super) fn list(
    core: &Core,
    caller: &Caller,
    context: Option<&MutationContext>,
    args: &Value,
) -> Result<Value, String> {
    require_person(caller, context)?;
    let params = parse_params(args)?;
    let query = EventQuery {
        // Hacia delante `cursor` es exclusivo por abajo; hacia atrás, por arriba (0 = desde lo más nuevo).
        after: (!params.newest_first).then_some(params.cursor),
        before: (params.newest_first && params.cursor > 0).then_some(params.cursor),
        newest_first: params.newest_first,
        limit: Some(params.limit),
        project_id: params.project_id.clone(),
        run_id: params.run_id.clone(),
        entity_kind: params.target_kind.clone(),
        entity_id: params.target_id.clone(),
        ..Default::default()
    };
    let page = match core.storage.events_page(&query) {
        None => {
            return Err("activity_unavailable: el Core no tiene un Event Log disponible".into())
        }
        Some(Err(StoreError::InvalidEvent(message))) => return Err(invalid(message)),
        Some(Err(e)) if e.to_string().contains("no such table: events") => {
            return Err("activity_unavailable: el Event Log todavía no existe en esta base".into());
        }
        Some(Err(_)) => return Err("activity_read_failed: no se pudo leer el Event Log".into()),
        Some(Ok(page)) => page,
    };
    if params.cursor > page.head_seq {
        return Err(format!("activity_cursor_ahead: `cursor` {} supera head_seq {}: el cursor no pertenece a este Core", params.cursor, page.head_seq));
    }
    let next_cursor = match (params.newest_first, page.has_more, page.next_cursor) {
        (_, true, Some(last)) => last,
        (true, _, Some(last)) => last,
        (true, _, None) => params.cursor,
        (false, _, _) => page.head_seq,
    };
    Ok(json!({
        "v": API_VERSION,
        "projection": PROJECTION_VERSION,
        "order": if params.newest_first { "desc" } else { "asc" },
        "items": page.events.iter().map(item).collect::<Vec<_>>(),
        "next_cursor": next_cursor,
        "has_more": page.has_more,
        "head_seq": page.head_seq,
        "limit": params.limit,
    }))
}
