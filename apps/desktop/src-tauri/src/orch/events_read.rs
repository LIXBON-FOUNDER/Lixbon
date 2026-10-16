//! Lectura del Event Log (LXO-83): contrato versionado, solo lectura. Lo comparten el comando RPC
//! `events` y `GET /events` del servidor local; ninguno de los dos toca SQLite directamente.

use serde_json::{json, Map, Value};

use super::{Caller, Core};
use crate::store::{EventClass, EventQuery, EventRow, StoreError, DEFAULT_PAGE, MAX_PAGE};

pub(super) const API_VERSION: i64 = 1;
const MAX_FILTER_CHARS: usize = 128;
const PARAMS: [&str; 9] = ["cursor", "limit", "project", "run", "entity_kind", "entity_id", "kind", "kind_prefix", "class"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Code {
    InvalidCursor,
    CursorAhead,
    InvalidLimit,
    InvalidFilter,
    Forbidden,
    Unavailable,
    Internal,
}

impl Code {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Code::InvalidCursor => "invalid_cursor",
            Code::CursorAhead => "cursor_ahead",
            Code::InvalidLimit => "invalid_limit",
            Code::InvalidFilter => "invalid_filter",
            Code::Forbidden => "forbidden",
            Code::Unavailable => "event_log_unavailable",
            Code::Internal => "internal",
        }
    }

    pub(super) fn http_status(self) -> u16 {
        match self {
            Code::InvalidCursor | Code::InvalidLimit | Code::InvalidFilter => 400,
            Code::Forbidden => 403,
            Code::CursorAhead => 409,
            Code::Unavailable => 503,
            Code::Internal => 500,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct EventsError {
    pub code: Code,
    pub message: String,
}

impl EventsError {
    fn new(code: Code, message: impl Into<String>) -> Self {
        EventsError { code, message: message.into() }
    }

    pub(super) fn to_json(&self) -> Value {
        json!({ "ok": false, "error": self.message, "code": self.code.as_str() })
    }
}

impl From<EventsError> for String {
    fn from(e: EventsError) -> String {
        format!("{}: {}", e.code.as_str(), e.message)
    }
}

pub(super) fn parse_query(query: &str) -> Result<Value, EventsError> {
    let mut out = Map::new();
    for pair in query.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let (k, v) = (percent_decode(k)?, percent_decode(v)?);
        if out.insert(k.clone(), Value::String(v)).is_some() {
            return Err(EventsError::new(Code::InvalidFilter, format!("parámetro repetido: {k}")));
        }
    }
    Ok(Value::Object(out))
}

fn percent_decode(raw: &str) -> Result<String, EventsError> {
    let bad = || EventsError::new(Code::InvalidFilter, "codificación de URL inválida");
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                let hex = raw.get(i + 1..i + 3).ok_or_else(bad)?;
                out.push(u8::from_str_radix(hex, 16).map_err(|_| bad())?);
                i += 3;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).map_err(|_| bad())
}

struct Params {
    cursor: i64,
    limit: Option<usize>,
    query: EventQuery,
}

fn integer(v: &Value, name: &str, code: Code, min: u64, max: u64) -> Result<u64, EventsError> {
    let parsed = match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) if !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()) => s.parse().ok(),
        _ => None,
    };
    parsed
        .filter(|n| (min..=max).contains(n))
        .ok_or_else(|| EventsError::new(code, format!("`{name}` debe ser un entero decimal >= {min}")))
}

fn text(v: &Value, name: &str) -> Result<String, EventsError> {
    match v {
        Value::String(s) if !s.is_empty() && s.chars().count() <= MAX_FILTER_CHARS => Ok(s.clone()),
        _ => Err(EventsError::new(Code::InvalidFilter, format!("`{name}` debe ser un texto de 1 a {MAX_FILTER_CHARS} caracteres"))),
    }
}

fn parse_params(args: &Value) -> Result<Params, EventsError> {
    let empty = Map::new();
    let map = match args {
        Value::Null => &empty,
        Value::Object(m) => m,
        _ => return Err(EventsError::new(Code::InvalidFilter, "los parámetros deben ser un objeto")),
    };
    if let Some(unknown) = map.keys().find(|k| !PARAMS.contains(&k.as_str())) {
        return Err(EventsError::new(Code::InvalidFilter, format!("parámetro desconocido: {unknown}")));
    }
    let get = |name: &str| map.get(name).filter(|v| !v.is_null());
    let cursor = get("cursor").map(|v| integer(v, "cursor", Code::InvalidCursor, 0, i64::MAX as u64)).transpose()?.unwrap_or(0) as i64;
    let limit = get("limit").map(|v| integer(v, "limit", Code::InvalidLimit, 1, u64::MAX)).transpose()?.map(|n| n.min(MAX_PAGE as u64) as usize);
    let string = |name: &str| get(name).map(|v| text(v, name)).transpose();
    let class = get("class")
        .map(|v| {
            v.as_str()
                .and_then(|s| EventClass::parse(s).ok())
                .ok_or_else(|| EventsError::new(Code::InvalidFilter, "`class` debe ser state, effect, decision o system"))
        })
        .transpose()?;
    let query = EventQuery {
        after: Some(cursor),
        limit,
        project_id: string("project")?,
        run_id: string("run")?,
        entity_kind: string("entity_kind")?,
        entity_id: string("entity_id")?,
        kind: string("kind")?,
        kind_prefix: string("kind_prefix")?,
        class,
        ..Default::default()
    };
    Ok(Params { cursor, limit, query })
}

pub(super) fn event_json(e: &EventRow) -> Result<Value, EventsError> {
    let payload: Value = serde_json::from_str(&e.payload).map_err(|_| EventsError::new(Code::Internal, "payload ilegible en el Event Log"))?;
    Ok(json!({
        "seq": e.seq,
        "id": e.id,
        "ts": e.at,
        "v": e.v,
        "kind": e.kind,
        "class": e.class.as_str(),
        "actor": { "kind": e.actor_kind.as_str(), "id": e.actor_id },
        "channel": e.channel,
        "client_id": e.client_id,
        "project_id": e.project_id,
        "run_id": e.run_id,
        "entity": { "kind": e.entity_kind, "id": e.entity_id },
        "correlation_id": e.correlation_id,
        "payload": payload,
    }))
}

impl Core {
    /// Un agente solo lee el Event Log de su propio run; la interfaz lee todo. Sin identidad no hay alcance.
    /// La identidad es la que declara el cliente (`X-Lixbon-Caller` / `caller`) bajo un token compartido: acota
    /// lecturas por error o por rol, no aísla a un agente hostil que declare el id de otra tarea.
    fn events_scope(&self, caller: &Caller) -> Result<Option<String>, EventsError> {
        let forbidden = |m: &str| EventsError::new(Code::Forbidden, m);
        match caller {
            Caller::User => Ok(None),
            Caller::Agent(None) => Err(forbidden("Leer el Event Log exige la identidad de una tarea del orquestador")),
            Caller::Agent(Some(id)) => {
                if !self.settings().enabled {
                    return Err(forbidden("El orquestador está desactivado"));
                }
                self.lock().tasks.get(id).map(|t| Some(t.run.clone())).ok_or_else(|| forbidden("La tarea no existe: no hay run que leer"))
            }
        }
    }

    pub(super) fn events_read(&self, caller: &Caller, args: &Value) -> Result<Value, EventsError> {
        let mut params = parse_params(args)?;
        if let Some(own_run) = self.events_scope(caller)? {
            match params.query.run_id.as_deref() {
                Some(asked) if asked != own_run => {
                    return Err(EventsError::new(Code::Forbidden, "Un agente solo lee los eventos de su propio run"));
                }
                _ => params.query.run_id = Some(own_run),
            }
        }
        let page = match self.storage.events_page(&params.query) {
            None => return Err(EventsError::new(Code::Unavailable, "El Event Log no está disponible (el Core no usa SQLite como autoridad)")),
            Some(Err(StoreError::InvalidEvent(m))) => return Err(EventsError::new(Code::InvalidFilter, m)),
            Some(Err(e)) if e.to_string().contains("no such table: events") => {
                return Err(EventsError::new(Code::Unavailable, "El Event Log todavía no existe en esta base (migración 004 pendiente)"));
            }
            Some(Err(_)) => return Err(EventsError::new(Code::Internal, "No se pudo leer el Event Log")),
            Some(Ok(page)) => page,
        };
        if params.cursor > page.head_seq {
            return Err(EventsError::new(
                Code::CursorAhead,
                format!("`cursor` {} supera head_seq {}: el cursor no pertenece a este Core", params.cursor, page.head_seq),
            ));
        }
        let next_cursor = match (page.has_more, page.next_cursor) {
            (true, Some(last)) => last,
            _ => page.head_seq,
        };
        let events = page.events.iter().map(event_json).collect::<Result<Vec<_>, _>>()?;
        Ok(json!({
            "v": API_VERSION,
            "events": events,
            "next_cursor": next_cursor,
            "has_more": page.has_more,
            "head_seq": page.head_seq,
            "limit": params.limit.unwrap_or(DEFAULT_PAGE),
        }))
    }

    pub(super) fn events_http(&self, caller: Caller, query: &str) -> (u16, Value) {
        let run = || parse_query(query).and_then(|args| self.events_read(&caller, &args));
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
            Ok(Ok(data)) => (200, json!({ "ok": true, "data": data })),
            Ok(Err(e)) => (e.code.http_status(), e.to_json()),
            Err(_) => (500, EventsError::new(Code::Internal, "Error interno al leer el Event Log").to_json()),
        }
    }
}
