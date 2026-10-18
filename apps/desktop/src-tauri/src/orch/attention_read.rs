//! LXO-89 · frontera de lectura de Attention, compartida por RPC/Tauri y HTTP `/rpc`.
//!
//! El scope llega exclusivamente del cliente que `Store` autenticó. El DTO es una allowlist explícita;
//! los cursores son HMAC, ligados a versión, filtros canónicos, límite, principal y client_id.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::Sha256;

use super::events::{Actor, MutationContext};
use super::{Caller, Core};
use crate::store::{
    AttentionCategory, AttentionCursorKey, AttentionQuery, AttentionRow, Resolution, Severity, TargetKind,
    DEFAULT_PAGE, MAX_PAGE,
};

const API_VERSION: u8 = 1;
const MAX_FILTER_CHARS: usize = 200;
const MAX_CURSOR_CHARS: usize = 4096;
const LIST_PARAMS: [&str; 7] = ["cursor", "limit", "project_id", "target_kind", "target_id", "category", "severity"];

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CanonicalFilters {
    project_id: Option<String>,
    target_kind: Option<String>,
    target_id: Option<String>,
    category: Option<String>,
    severity: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorScope {
    principal: String,
    client_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorKey {
    created_at: i64,
    id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CursorPayload {
    v: u8,
    after: CursorKey,
    filters: CanonicalFilters,
    scope: CursorScope,
    limit: usize,
}

struct ListParams {
    filters: CanonicalFilters,
    limit: usize,
    cursor: Option<String>,
}

fn invalid(message: impl Into<String>) -> String {
    format!("attention_invalid_request: {}", message.into())
}

fn text_filter(map: &Map<String, Value>, name: &str) -> Result<Option<String>, String> {
    match map.get(name).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() || value.chars().count() > MAX_FILTER_CHARS {
                return Err(invalid(format!("`{name}` debe contener de 1 a {MAX_FILTER_CHARS} caracteres")));
            }
            Ok(Some(value.to_string()))
        }
        Some(_) => Err(invalid(format!("`{name}` debe ser texto"))),
    }
}

fn parse_list_params(args: &Value) -> Result<ListParams, String> {
    let empty = Map::new();
    let map = match args {
        Value::Null => &empty,
        Value::Object(map) => map,
        _ => return Err(invalid("los parámetros deben ser un objeto")),
    };
    if let Some(key) = map.keys().find(|key| !LIST_PARAMS.contains(&key.as_str())) {
        return Err(invalid(format!("parámetro desconocido: {key}")));
    }

    let cursor = match map.get("cursor").filter(|value| !value.is_null()) {
        None => None,
        Some(Value::String(cursor)) if !cursor.is_empty() && cursor.chars().count() <= MAX_CURSOR_CHARS => Some(cursor.clone()),
        Some(_) => return Err(invalid("`cursor` debe ser un cursor opaco válido")),
    };
    let limit = match map.get("limit").filter(|value| !value.is_null()) {
        None => DEFAULT_PAGE,
        Some(Value::Number(value)) => value.as_u64().filter(|value| *value > 0).ok_or_else(|| invalid("`limit` debe ser un entero positivo"))?.min(MAX_PAGE as u64) as usize,
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 20 && value.bytes().all(|byte| byte.is_ascii_digit()) => {
            value.parse::<u64>().ok().filter(|value| *value > 0).ok_or_else(|| invalid("`limit` debe ser un entero positivo"))?.min(MAX_PAGE as u64) as usize
        }
        Some(_) => return Err(invalid("`limit` debe ser un entero positivo")),
    };

    let project_id = text_filter(map, "project_id")?;
    let target_kind = text_filter(map, "target_kind")?;
    if target_kind.as_deref().is_some_and(|kind| TargetKind::parse(kind).is_err()) {
        return Err(invalid("`target_kind` no es un tipo de target válido"));
    }
    let target_id = text_filter(map, "target_id")?;
    let category = text_filter(map, "category")?;
    if category.as_deref().is_some_and(|category| AttentionCategory::parse(category).is_err()) {
        return Err(invalid("`category` no es una categoría de Attention válida"));
    }
    let severity = text_filter(map, "severity")?;
    if severity.as_deref().is_some_and(|severity| Severity::parse(severity).is_err()) {
        return Err(invalid("`severity` no es una severidad válida"));
    }

    Ok(ListParams {
        filters: CanonicalFilters { project_id, target_kind, target_id, category, severity },
        limit,
        cursor,
    })
}

fn cursor_scope(caller: &Caller, context: Option<&MutationContext>) -> Result<CursorScope, String> {
    let context = context.ok_or_else(|| "attention_auth_required: la lectura requiere un cliente autenticado".to_string())?;
    let client_id = context.client_id.as_deref().filter(|id| !id.is_empty())
        .ok_or_else(|| "attention_auth_required: falta client_id autenticado".to_string())?;
    let principal = match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => format!("person:{id}"),
        (Actor::Agent(actor_task), Caller::Agent(Some(scope_task))) if actor_task == scope_task && !scope_task.is_empty() => format!("agent_task:{scope_task}"),
        _ => return Err("attention_auth_required: principal y scope no coinciden con el cliente autenticado".into()),
    };
    Ok(CursorScope { principal, client_id: client_id.to_string() })
}

fn task_scope(scope: &CursorScope) -> Option<String> {
    scope.principal.strip_prefix("agent_task:").map(str::to_string)
}

fn cursor_key(core: &Core) -> Result<[u8; 32], String> {
    let mut stored = core.attention_cursor_key.lock().unwrap_or_else(|error| error.into_inner());
    if stored.is_none() {
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).map_err(|_| "attention_cursor_unavailable: no se pudo inicializar la clave aleatoria".to_string())?;
        *stored = Some(key);
    }
    Ok(stored.expect("la clave se inicializó arriba"))
}

fn mac(key: &[u8; 32], bytes: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC-SHA256 acepta claves de cualquier tamaño");
    mac.update(b"lixbon.attention.cursor.v1\0");
    mac.update(bytes);
    mac.finalize().into_bytes().to_vec()
}

fn encode_cursor(key: &[u8; 32], payload: &CursorPayload) -> Result<String, String> {
    let bytes = serde_json::to_vec(payload).map_err(|_| "attention_internal: no se pudo serializar el cursor".to_string())?;
    Ok(format!("{}.{}", URL_SAFE_NO_PAD.encode(&bytes), URL_SAFE_NO_PAD.encode(mac(key, &bytes))))
}

fn decode_cursor(
    key: &[u8; 32],
    encoded: &str,
    filters: &CanonicalFilters,
    scope: &CursorScope,
    limit: usize,
) -> Result<AttentionCursorKey, String> {
    let invalid_cursor = || "attention_invalid_cursor: cursor inválido para esta versión, identidad o consulta".to_string();
    if encoded.chars().count() > MAX_CURSOR_CHARS {
        return Err(invalid_cursor());
    }
    let (payload, signature) = encoded.split_once('.').ok_or_else(invalid_cursor)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload).map_err(|_| invalid_cursor())?;
    let supplied = URL_SAFE_NO_PAD.decode(signature).map_err(|_| invalid_cursor())?;
    let mut verifier = HmacSha256::new_from_slice(key).expect("HMAC-SHA256 acepta claves de cualquier tamaño");
    verifier.update(b"lixbon.attention.cursor.v1\0");
    verifier.update(&bytes);
    verifier.verify_slice(&supplied).map_err(|_| invalid_cursor())?;
    let cursor: CursorPayload = serde_json::from_slice(&bytes).map_err(|_| invalid_cursor())?;
    if cursor.v != API_VERSION
        || cursor.filters != *filters
        || cursor.scope != *scope
        || cursor.limit != limit
        || cursor.after.created_at < 0
        || cursor.after.id.is_empty()
    {
        return Err(invalid_cursor());
    }
    Ok(AttentionCursorKey { created_at: cursor.after.created_at, id: cursor.after.id })
}

fn dto(row: &AttentionRow) -> Value {
    json!({
        "id": row.id,
        "category": row.category.as_str(),
        "severity": row.severity.as_str(),
        "status": row.status.as_str(),
        "target_kind": row.target.kind.as_str(),
        "target_id": row.target.id,
        "project_id": row.project_id,
        "run_id": row.run_id,
        "occurrence": row.occurrence,
        "created_at": row.created_at,
        "resolved_at": row.resolved_at,
        "resolution": row.resolution.map(Resolution::as_str),
    })
}

pub(super) fn list(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    let scope = cursor_scope(caller, context)?;
    let params = parse_list_params(args)?;
    let key = cursor_key(core)?;
    let after = params.cursor.as_deref()
        .map(|cursor| decode_cursor(&key, cursor, &params.filters, &scope, params.limit))
        .transpose()?;
    let query = AttentionQuery {
        after,
        limit: Some(params.limit),
        project_id: params.filters.project_id.clone(),
        target_kind: params.filters.target_kind.as_deref().map(TargetKind::parse).transpose().map_err(|_| invalid("`target_kind` no es válido"))?,
        target_id: params.filters.target_id.clone(),
        category: params.filters.category.as_deref().map(AttentionCategory::parse).transpose().map_err(|_| invalid("`category` no es válida"))?,
        severity: params.filters.severity.as_deref().map(Severity::parse).transpose().map_err(|_| invalid("`severity` no es válida"))?,
        scope_task_id: task_scope(&scope),
    };
    let page = core.storage.attention_page(&query)
        .ok_or_else(|| "attention_unavailable: el Core no tiene un almacén autoritativo disponible".to_string())?
        .map_err(|_| "attention_read_failed: no se pudo consultar Attention".to_string())?;
    let next_cursor = if page.has_more {
        page.items.last().map(|row| encode_cursor(&key, &CursorPayload {
            v: API_VERSION,
            after: CursorKey { created_at: row.created_at, id: row.id.clone() },
            filters: params.filters,
            scope,
            limit: params.limit,
        })).transpose()?
    } else {
        None
    };
    Ok(json!({
        "v": API_VERSION,
        "items": page.items.iter().map(dto).collect::<Vec<_>>(),
        "next_cursor": next_cursor,
        "has_more": page.has_more,
        "limit": params.limit,
    }))
}

pub(super) fn detail(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    let scope = cursor_scope(caller, context)?;
    let map = args.as_object().ok_or_else(|| invalid("los parámetros deben ser un objeto"))?;
    if let Some(key) = map.keys().find(|key| key.as_str() != "attention_id") {
        return Err(invalid(format!("parámetro desconocido: {key}")));
    }
    let id = map.get("attention_id").and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.chars().count() <= MAX_FILTER_CHARS)
        .ok_or_else(|| invalid("`attention_id` debe ser un id válido"))?;
    let row = core.storage.attention_get_scoped(id, task_scope(&scope).as_deref())
        .ok_or_else(|| "attention_unavailable: el Core no tiene un almacén autoritativo disponible".to_string())?
        .map_err(|_| "attention_read_failed: no se pudo consultar Attention".to_string())?;
    row.as_ref().map(dto).ok_or_else(|| "attention_not_found: Attention inexistente o fuera de scope".into())
}
