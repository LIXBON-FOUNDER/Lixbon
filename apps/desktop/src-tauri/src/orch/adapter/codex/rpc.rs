//! Mensajes del protocolo de `codex app-server` (LXO-130): JSON por línea sobre stdio, estilo JSON-RPC pero SIN el campo
//! `"jsonrpc"`. Contrastado con Codex 0.162.1, 0.163.0 y 0.164.0; el esquema completo lo genera la propia CLI
//! (`codex app-server generate-json-schema`). Los ids que numera el cliente son enteros; los de las peticiones del
//! servidor (aprobaciones) son suyos y se devuelven tal cual.

use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Incoming {
    Response { id: i64, result: Result<Value, RpcError> },
    Notification { method: String, params: Value },
    /// Petición del servidor (aprobaciones, entrada del usuario…): su `id` se devuelve en la respuesta.
    Request { id: Value, method: String, params: Value },
    /// No es JSON, no es un objeto o no encaja en ninguna forma conocida. Se cuenta y se salta.
    Malformed,
    /// El proceso cerró stdout. Lo pone el adapter, no el servidor.
    Eof,
}

/// Una línea de stdout → mensaje. Nunca entra en pánico.
pub fn parse(line: &str) -> Incoming {
    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { return Incoming::Malformed };
    let Some(o) = v.as_object() else { return Incoming::Malformed };
    let params = o.get("params").cloned().unwrap_or(Value::Null);
    match (o.get("method").and_then(Value::as_str), o.get("id")) {
        (Some(m), Some(id)) => Incoming::Request { id: id.clone(), method: m.to_string(), params },
        (Some(m), None) => Incoming::Notification { method: m.to_string(), params },
        (None, Some(id)) => {
            let Some(id) = id.as_i64() else { return Incoming::Malformed };
            if let Some(e) = o.get("error") {
                let code = e.get("code").and_then(Value::as_i64).unwrap_or(0);
                let message = e.get("message").and_then(Value::as_str).unwrap_or("").to_string();
                Incoming::Response { id, result: Err(RpcError { code, message }) }
            } else if let Some(r) = o.get("result") {
                Incoming::Response { id, result: Ok(r.clone()) }
            } else {
                Incoming::Malformed
            }
        }
        (None, None) => Incoming::Malformed,
    }
}

pub fn request_line(id: i64, method: &str, params: Option<Value>) -> String {
    match params {
        Some(p) => json!({ "id": id, "method": method, "params": p }),
        None => json!({ "id": id, "method": method }),
    }
    .to_string()
}

pub fn notification_line(method: &str) -> String {
    json!({ "method": method }).to_string()
}

pub fn result_line(id: &Value, result: Value) -> String {
    json!({ "id": id, "result": result }).to_string()
}

pub fn error_line(id: &Value, code: i64, message: &str) -> String {
    json!({ "id": id, "error": { "code": code, "message": message } }).to_string()
}

/// El texto de una entrada de usuario para `turn/start` y `turn/steer`.
pub fn text_input(text: &str) -> Value {
    json!([{ "type": "text", "text": text, "text_elements": [] }])
}
