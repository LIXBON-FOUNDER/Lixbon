//! Parser del flujo `--output-format stream-json` de Claude Code (LXO-129). Una línea de la CLI → cero o más [`Msg`].
//! Solo lee los campos que el adapter necesita; todo lo demás se ignora a propósito (`hook_*`, `thinking_tokens`,
//! `rate_limit_event`, resultados de herramientas…): ni el razonamiento (`thinking`) ni el contenido de las herramientas
//! se copian (invariante 5), y un tipo nuevo de mensaje no rompe nada.
//!
//! Formato contrastado con Claude Code 2.1.296 (`testdata/claude-2.1.296-adapter-*.jsonl`, capturas reales saneadas).

use serde_json::Value;

use crate::orch::adapter::redact::safe_text;

/// Tope de un resumen de herramienta (una ruta, un comando…): lo justo para reconocerlo, nunca el contenido.
pub const MAX_SUMMARY_CHARS: usize = 200;

/// Claves de la entrada de una herramienta que identifican QUÉ hace (en este orden). Nunca `content`, `new_string`,
/// `old_string` ni `prompt`: son el contenido del trabajo y pueden llevar secretos.
const SUMMARY_KEYS: [&str; 7] = ["command", "file_path", "path", "pattern", "url", "query", "description"];

#[derive(Clone, Debug, PartialEq, Default)]
pub struct UsageTotals {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
    pub cache_creation_tokens: Option<u64>,
    pub cost_usd: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ResultMsg {
    pub is_error: bool,
    pub subtype: String,
    pub terminal_reason: Option<String>,
    pub text: Option<String>,
    pub usage: UsageTotals,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Msg {
    Init { session_id: String, model: Option<String>, version: Option<String>, capabilities: Vec<String> },
    Text(String),
    ToolUse { tool: String, summary: String },
    /// `input` es la entrada original de la herramienta: se guarda SOLO en memoria para devolverla en el `allow`.
    PermissionRequest { request_id: String, tool: String, summary: String, input: Value },
    ApiRetry { attempt: u32, max: u32, delay_ms: u64 },
    Result(ResultMsg),
    /// Un mensaje válido que el adapter no usa.
    Ignored,
    /// Una línea que no es JSON o no es un objeto. Se cuenta y se salta: no corrompe la ejecución.
    Malformed,
}

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn n(v: &Value, key: &str) -> Option<u64> {
    v.get(key).and_then(Value::as_u64)
}

/// Un resumen corto de lo que hace una herramienta, redactado y acotado.
pub fn summarize_tool(input: &Value) -> String {
    let text = SUMMARY_KEYS.iter().find_map(|k| input.get(*k).and_then(Value::as_str)).unwrap_or("");
    // Una sola línea: un comando con saltos no debe ocupar el log.
    let one_line = text.lines().next().unwrap_or("");
    safe_text(one_line, MAX_SUMMARY_CHARS)
}

fn assistant(v: &Value) -> Vec<Msg> {
    let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else { return vec![Msg::Ignored] };
    let mut out = vec![];
    for b in blocks {
        match b.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    out.push(Msg::Text(t.to_string()));
                }
            }
            Some("tool_use") => {
                let tool = s(b, "name").unwrap_or_else(|| "?".into());
                out.push(Msg::ToolUse { tool: safe_text(&tool, 80), summary: summarize_tool(b.get("input").unwrap_or(&Value::Null)) });
            }
            // `thinking` y `redacted_thinking`: el razonamiento no se copia.
            _ => {}
        }
    }
    if out.is_empty() {
        out.push(Msg::Ignored);
    }
    out
}

fn result(v: &Value) -> Msg {
    let u = v.get("usage").unwrap_or(&Value::Null);
    Msg::Result(ResultMsg {
        is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        subtype: s(v, "subtype").unwrap_or_default(),
        terminal_reason: s(v, "terminal_reason"),
        text: s(v, "result").filter(|t| !t.is_empty()),
        usage: UsageTotals {
            input_tokens: n(u, "input_tokens"),
            output_tokens: n(u, "output_tokens"),
            cache_read_tokens: n(u, "cache_read_input_tokens"),
            cache_creation_tokens: n(u, "cache_creation_input_tokens"),
            cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
        },
    })
}

/// Una línea del flujo → mensajes. Nunca entra en pánico, con cualquier entrada.
pub fn parse_line(line: &str) -> Vec<Msg> {
    let line = line.trim();
    if line.is_empty() {
        return vec![Msg::Ignored];
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return vec![Msg::Malformed] };
    if !v.is_object() {
        return vec![Msg::Malformed];
    }
    match v.get("type").and_then(Value::as_str) {
        Some("system") => match v.get("subtype").and_then(Value::as_str) {
            Some("init") => match s(&v, "session_id") {
                Some(session_id) => vec![Msg::Init {
                    session_id,
                    model: s(&v, "model"),
                    version: s(&v, "claude_code_version"),
                    capabilities: v.get("capabilities").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
                }],
                None => vec![Msg::Malformed],
            },
            Some("api_retry") => vec![Msg::ApiRetry {
                attempt: n(&v, "attempt").unwrap_or(0) as u32,
                max: n(&v, "max_retries").unwrap_or(0) as u32,
                delay_ms: n(&v, "retry_delay_ms").unwrap_or(0),
            }],
            _ => vec![Msg::Ignored],
        },
        Some("assistant") => assistant(&v),
        Some("control_request") => {
            let req = v.get("request").unwrap_or(&Value::Null);
            match (req.get("subtype").and_then(Value::as_str), s(&v, "request_id")) {
                (Some("can_use_tool"), Some(request_id)) => {
                    let input = req.get("input").cloned().unwrap_or(Value::Null);
                    vec![Msg::PermissionRequest {
                        request_id,
                        tool: safe_text(&s(req, "tool_name").unwrap_or_else(|| "?".into()), 80),
                        summary: summarize_tool(&input),
                        input,
                    }]
                }
                _ => vec![Msg::Ignored],
            }
        }
        Some("result") => vec![result(&v)],
        _ => vec![Msg::Ignored],
    }
}
