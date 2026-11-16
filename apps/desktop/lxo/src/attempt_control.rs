//! Queue, Steer y Stop & Send de un Attempt exacto (LXO-159).

use std::io::Read;
use std::process::ExitCode;

use serde_json::{json, Value};

use crate::client_auth::{self, EventRequestFailure, RpcFailure};
use crate::events::clean;
use crate::f5_support;
use crate::Args;

const CONTRACT: u64 = 1;
const MAX_BODY_CHARS: usize = 20_000;
const MAX_BODY_BYTES: usize = MAX_BODY_CHARS * 4;
const STATUSES: [&str; 5] = ["queued", "delivering", "delivered", "cancelled", "failed"];
const FAILURES: [&str; 6] = [
    "unsupported",
    "environment_blocked",
    "adapter_unavailable",
    "adapter_error",
    "attempt_ended",
    "interrupted",
];
const CONFIRMATIONS: [&str; 2] = ["adapter_event", "adapter_result"];

pub(super) const HELP: &str = "Uso:
  lxo attempt queue <attempt_id> --message \"...\" --confirm [--request-id ID] [--json]
  lxo attempt steer <attempt_id> --message \"...\" --confirm [--request-id ID] [--json]
  lxo attempt stop <attempt_id> --send --message \"...\" --confirm [--request-id ID] [--json]
  lxo queue list <attempt_id> [--json]
  lxo queue cancel <queue_id> [--json]

Queue entrega la instrucción en el siguiente límite de turno. Steer la inyecta en
el turno en curso. Stop & Send interrumpe el turno y, solo tras confirmar el stop,
envía la instrucción como un turno nuevo. No hay fallback entre estas semánticas.

`--message -` lee UTF-8 desde stdin (máximo 20 000 caracteres). `--request-id`
permite repetir una petición con idempotencia; si se omite, se deriva del Attempt,
la operación y el texto. Para enviar intencionadamente el mismo texto otra vez,
usa una clave nueva. Queue y Steer requieren `--confirm` según la policy base de
CLI; Stop & Send también requiere confirmación. El Core revalida siempre la policy.

`queue list` muestra pendientes FIFO e historial reciente; `queue cancel` solo
cancela un item que aún no empezó a entregarse. Ni la lectura ni la cancelación
requieren confirmación de policy.

Salida JSON: contrato v1. Códigos: 0 correcto, 1 error interno, 2 uso, 3
autenticación, 4 versión incompatible, 5 Core no disponible, 6 inexistente,
7 capability no soportada, 8 entorno bloqueado, 9 policy/confirmación, 10 ocupado,
11 Attempt final, 12 conflicto o estado no cancelable.";

#[derive(Debug, PartialEq, Eq)]
enum MessageSource {
    Inline(String),
    Stdin,
}

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Help,
    Enqueue {
        attempt_id: String,
        message: MessageSource,
        request_id: Option<String>,
        confirm: bool,
    },
    Steer {
        attempt_id: String,
        message: MessageSource,
        request_id: Option<String>,
        confirm: bool,
    },
    StopAndSend {
        attempt_id: String,
        message: MessageSource,
        request_id: Option<String>,
        confirm: bool,
    },
    List {
        attempt_id: String,
    },
    Cancel {
        queue_id: String,
    },
}

#[derive(Debug, PartialEq, Eq)]
struct ControlFailure {
    code: String,
    kind: Option<String>,
    exit: u8,
    message: String,
}

impl ControlFailure {
    fn new(
        code: impl Into<String>,
        kind: Option<&str>,
        exit: u8,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code: code.into(),
            kind: kind.map(str::to_string),
            exit,
            message: message.into(),
        }
    }

    fn usage(message: impl Into<String>) -> Self {
        Self::new("usage", None, 2, message)
    }

    fn version() -> Self {
        Self::new(
            "version",
            None,
            4,
            "El Core devolvió una respuesta de Queue/Instruction que lxo no reconoce; actualiza Lixbon.",
        )
    }

    fn json_value(&self) -> Value {
        let mut body = json!({
            "v": CONTRACT,
            "ok": false,
            "code": self.code,
            "error": self.message,
        });
        if let Some(kind) = &self.kind {
            body["kind"] = json!(kind);
        }
        body
    }
}

fn flags(a: &Args, allowed: &[&str], command: &str) -> Result<(), ControlFailure> {
    if let Some(name) = a
        .flags
        .keys()
        .find(|name| !allowed.contains(&name.as_str()))
    {
        return Err(ControlFailure::usage(format!(
            "--{name} no es una opción de {command}. Mira `lxo help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(ControlFailure::usage(format!(
            "--{name} aparece más de una vez."
        )));
    }
    for name in ["json", "help", "confirm", "send"] {
        if a.flags.get(name).is_some_and(|value| !value.is_boolean()) {
            return Err(ControlFailure::usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }
    Ok(())
}

fn value_flag(a: &Args, name: &str) -> Result<Option<String>, ControlFailure> {
    match a.flags.get(name) {
        None => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.to_string())),
        _ => Err(ControlFailure::usage(format!(
            "--{name} requiere un valor."
        ))),
    }
}

fn valid_attempt_id(id: &str) -> bool {
    if id.is_empty()
        || id.len() > 256
        || id
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return false;
    }
    let Some((task, raw_n)) = id.rsplit_once("-a") else {
        return false;
    };
    !task.is_empty()
        && raw_n
            .parse::<u32>()
            .ok()
            .is_some_and(|n| n > 0 && format!("{task}-a{n}") == id)
}

fn valid_queue_id(id: &str) -> bool {
    let Some((attempt, raw_seq)) = id.rsplit_once("-q") else {
        return false;
    };
    valid_attempt_id(attempt)
        && raw_seq
            .parse::<u64>()
            .ok()
            .is_some_and(|seq| seq > 0 && format!("{attempt}-q{seq}") == id)
}

fn parse_message(a: &Args, command: &str) -> Result<MessageSource, ControlFailure> {
    match value_flag(a, "message")? {
        Some(value) if value == "-" => Ok(MessageSource::Stdin),
        Some(value) => Ok(MessageSource::Inline(value)),
        None => Err(ControlFailure::usage(format!(
            "Falta --message \"...\" para {command}."
        ))),
    }
}

fn mutation(
    a: &Args,
    command: &str,
    attempt_id: &str,
    is_stop_send: bool,
) -> Result<Request, ControlFailure> {
    let allowed = if is_stop_send {
        &["message", "request-id", "confirm", "send", "json", "help"][..]
    } else {
        &["message", "request-id", "confirm", "json", "help"][..]
    };
    flags(a, allowed, command)?;
    if a.pos.len() != 3 {
        return Err(ControlFailure::usage(format!(
            "Uso: {command} <attempt_id> --message \"...\" --confirm."
        )));
    }
    if is_stop_send && a.flags.get("send") != Some(&Value::Bool(true)) {
        return Err(ControlFailure::usage(
            "`lxo attempt stop` requiere `--send` para enviar una instrucción; parar sin enviar es otro comando.",
        ));
    }
    if !is_stop_send && a.flags.contains_key("send") {
        return Err(ControlFailure::usage(
            "`--send` solo se usa con `lxo attempt stop <attempt_id>`.",
        ));
    }
    if a.flags.get("confirm") != Some(&Value::Bool(true)) {
        return Err(ControlFailure::usage(format!(
            "{command} requiere --confirm según la policy base del CLI."
        )));
    }
    let request_id = value_flag(a, "request-id")?;
    if request_id
        .as_deref()
        .is_some_and(|id| !valid_request_id(id))
    {
        return Err(ControlFailure::usage(
            "--request-id debe tener de 1 a 64 caracteres entre letras, dígitos, `_`, `.` y `-`.",
        ));
    }
    let message = parse_message(a, command)?;
    let attempt_id = attempt_id.to_string();
    if !valid_attempt_id(&attempt_id) {
        return Err(ControlFailure::usage(
            "El id debe ser un Attempt exacto (formato <task_id>-a<n>).",
        ));
    }
    let confirm = true;
    Ok(match command {
        "lxo attempt queue" => Request::Enqueue {
            attempt_id,
            message,
            request_id,
            confirm,
        },
        "lxo attempt steer" => Request::Steer {
            attempt_id,
            message,
            request_id,
            confirm,
        },
        _ => Request::StopAndSend {
            attempt_id,
            message,
            request_id,
            confirm,
        },
    })
}

fn parse(a: &Args) -> Result<Request, ControlFailure> {
    if a.flags.contains_key("help") && a.flags["help"] != Value::Bool(true) {
        return Err(ControlFailure::usage("--help no admite un valor."));
    }
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }

    match (a.at(0).as_deref(), a.at(1).as_deref()) {
        (Some("attempt"), Some("queue" | "steer")) => {
            let sub = a.at(1).unwrap_or_default();
            let id = a.at(2).ok_or_else(|| {
                ControlFailure::usage(format!(
                    "Falta el Attempt: `lxo attempt {sub} <attempt_id>`."
                ))
            })?;
            mutation(
                a,
                &format!("lxo attempt {sub}"),
                &id,
                false,
            )
        }
        (Some("attempt"), Some("stop")) if a.b("send") || a.flags.contains_key("send") => {
            let id = a.at(2).ok_or_else(|| {
                ControlFailure::usage("Falta el Attempt: `lxo attempt stop <attempt_id> --send`.")
            })?;
            mutation(a, "lxo attempt stop --send", &id, true)
        }
        (Some("queue"), Some("list")) => {
            flags(a, &["json", "help"], "lxo queue list")?;
            if a.pos.len() != 3 {
                return Err(ControlFailure::usage(
                    "Uso: lxo queue list <attempt_id> [--json].",
                ));
            }
            let id = a.at(2).unwrap_or_default();
            if !valid_attempt_id(&id) {
                return Err(ControlFailure::usage(
                    "El id debe ser un Attempt exacto (formato <task_id>-a<n>).",
                ));
            }
            Ok(Request::List { attempt_id: id })
        }
        (Some("queue"), Some("cancel")) => {
            flags(a, &["json", "help"], "lxo queue cancel")?;
            if a.pos.len() != 3 {
                return Err(ControlFailure::usage(
                    "Uso: lxo queue cancel <queue_id> [--json].",
                ));
            }
            let queue_id = a.at(2).unwrap_or_default();
            if !valid_queue_id(&queue_id) {
                return Err(ControlFailure::usage(
                    "El id debe ser exacto (formato <attempt_id>-q<n>).",
                ));
            }
            Ok(Request::Cancel { queue_id })
        }
        (Some("queue"), _) => Err(ControlFailure::usage(
            "Uso: lxo queue list <attempt_id> | lxo queue cancel <queue_id>.",
        )),
        _ => Err(ControlFailure::usage(
            "Uso: lxo attempt queue|steer <attempt_id> … | lxo attempt stop <attempt_id> --send … | lxo queue list|cancel ….",
        )),
    }
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn message_text(source: MessageSource) -> Result<String, ControlFailure> {
    let body = match source {
        MessageSource::Inline(body) => body,
        MessageSource::Stdin => {
            let mut bytes = Vec::new();
            std::io::stdin()
                .take((MAX_BODY_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| ControlFailure::usage("No se pudo leer --message - desde stdin."))?;
            if bytes.len() > MAX_BODY_BYTES {
                return Err(ControlFailure::usage(format!(
                    "El mensaje supera el límite de {MAX_BODY_CHARS} caracteres."
                )));
            }
            String::from_utf8(bytes).map_err(|_| {
                ControlFailure::usage("El mensaje recibido por stdin debe ser UTF-8.")
            })?
        }
    };
    if body.trim().is_empty() {
        return Err(ControlFailure::usage("El mensaje no puede estar vacío."));
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return Err(ControlFailure::usage(format!(
            "El mensaje admite hasta {MAX_BODY_CHARS} caracteres."
        )));
    }
    Ok(body)
}

fn rpc_failure(error: RpcFailure) -> ControlFailure {
    match error {
        RpcFailure::Transport(EventRequestFailure::Network(message))
        | RpcFailure::Transport(EventRequestFailure::CoreUnavailable(message)) => {
            ControlFailure::new("core_unavailable", None, 5, message)
        }
        RpcFailure::Transport(EventRequestFailure::Authentication(message)) => {
            ControlFailure::new("authentication", None, 3, message)
        }
        RpcFailure::Transport(EventRequestFailure::Version(message)) => {
            ControlFailure::new("version", None, 4, message)
        }
        RpcFailure::Transport(EventRequestFailure::Internal(message)) => {
            ControlFailure::new("internal", None, 1, message)
        }
        RpcFailure::Rejected(message) => rejected_failure(&message),
    }
}

fn rejected_failure(message: &str) -> ControlFailure {
    if message.starts_with("Comando desconocido")
        || message.starts_with("core_model_inactive")
        || message.starts_with("queue_model_inactive")
    {
        return ControlFailure::new(
            "version",
            None,
            4,
            "Este Core no ofrece Queue/Steer/Stop & Send; actualiza Lixbon.",
        );
    }
    if message.starts_with("Acción no permitida")
        || message.contains("solo está permitido a una Person")
        || message.contains("requiere una Person autenticada")
    {
        return ControlFailure::new(
            "authentication",
            None,
            3,
            "Queue, Steer y Stop & Send solo están disponibles para una Person autenticada de Desktop o CLI.",
        );
    }
    if message.starts_with("policy_") {
        let code = message
            .split_once(':')
            .map(|(code, _)| code)
            .unwrap_or("policy_error");
        let detail = message
            .split_once(": ")
            .map(|(_, detail)| detail)
            .unwrap_or(message);
        let message = if code == "policy_confirm_required" {
            format!(
                "La policy requiere confirmación explícita: vuelve a ejecutar con --confirm. {}",
                detail
            )
        } else {
            clean(&detail.chars().take(300).collect::<String>())
        };
        return ControlFailure::new(code, Some("policy"), 9, message);
    }

    let (kind, code, detail) = if let Some((prefix, detail)) = message.split_once(": ") {
        if let Some((kind, code)) = prefix.split_once('/') {
            (Some(kind), code, detail)
        } else {
            (None, prefix, detail)
        }
    } else {
        (None, "internal", message)
    };
    let exit = match (kind, code) {
        (Some("unsupported"), _) => 7,
        (Some("environment_blocked"), _) => 8,
        (Some("busy"), _) => 10,
        (_, "attempt_missing" | "queue_missing" | "model_not_found") => 6,
        (_, "attempt_final") => 11,
        (_, "request_conflict" | "not_cancellable" | "queue_full") => 12,
        (_, "invalid_request" | "attachment_unknown" | "not_allowed") => {
            if code == "not_allowed" {
                3
            } else {
                2
            }
        }
        (_, "model_inactive") => 4,
        (
            _,
            "store" | "adapter_error" | "stop_failed" | "stop_timeout" | "send_failed"
            | "steer_failed",
        ) => 1,
        _ => 1,
    };
    ControlFailure::new(
        code,
        kind,
        exit,
        clean(&detail.chars().take(300).collect::<String>()),
    )
}

fn rpc(
    request: &mut f5_support::Rpc<'_>,
    command: &str,
    args: Value,
) -> Result<Value, ControlFailure> {
    request(command, &args).map_err(rpc_failure)
}

fn contract_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, ControlFailure> {
    value[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(ControlFailure::version)
}

fn enqueue(
    request: &mut f5_support::Rpc<'_>,
    attempt_id: &str,
    body: &str,
    request_id: &str,
    confirm: bool,
) -> Result<(Value, String), ControlFailure> {
    let data = rpc(
        request,
        "attempt_queue",
        json!({
            "attempt_id": attempt_id,
            "request_id": request_id,
            "body": body,
            "confirm": confirm,
        }),
    )?;
    let status = contract_string(&data, "status")?;
    if !matches!(status, "Queued" | "Replayed")
        || contract_string(&data, "attempt_id")? != attempt_id
    {
        return Err(ControlFailure::version());
    }
    let queue_id = contract_string(&data, "queue_id")?;
    if !valid_queue_id(queue_id) || !queue_id.starts_with(&format!("{attempt_id}-q")) {
        return Err(ControlFailure::version());
    }
    let position = if status == "Queued" {
        data["position"]
            .as_u64()
            .filter(|position| *position > 0)
            .map(Value::from)
            .ok_or_else(ControlFailure::version)?
    } else {
        if !data["position"].is_null() {
            return Err(ControlFailure::version());
        }
        Value::Null
    };
    let output = json!({
        "v": CONTRACT,
        "command": "attempt.queue",
        "status": status,
        "attempt_id": attempt_id,
        "queue_id": queue_id,
        "position": position,
    });
    let human = if position.is_null() {
        format!("La petición ya existe como {queue_id}; no se ha vuelto a encolar.")
    } else {
        format!(
            "Instrucción encolada como {queue_id}, posición {}.",
            position.as_u64().unwrap_or(0)
        )
    };
    Ok((output, human))
}

fn instruction(
    request: &mut f5_support::Rpc<'_>,
    command: &str,
    mode: &str,
    attempt_id: &str,
    body: &str,
    request_id: &str,
    confirm: bool,
) -> Result<(Value, String), ControlFailure> {
    let data = rpc(
        request,
        command,
        json!({
            "attempt_id": attempt_id,
            "request_id": request_id,
            "body": body,
            "confirm": confirm,
        }),
    )?;
    let status = contract_string(&data, "status")?;
    if !matches!(status, "Delivered" | "Replayed")
        || contract_string(&data, "mode")? != mode
        || contract_string(&data, "attempt_id")? != attempt_id
        || contract_string(&data, "request_id")? != request_id
    {
        return Err(ControlFailure::version());
    }
    let output = json!({
        "v": CONTRACT,
        "command": format!("attempt.{mode}"),
        "status": status,
        "mode": mode,
        "attempt_id": attempt_id,
        "request_id": request_id,
    });
    let human = if status == "Replayed" {
        format!("La instrucción {request_id} ya se atendió; no se repitió.")
    } else if mode == "steer" {
        format!("Steer entregado al turno en curso del Attempt {attempt_id}.")
    } else {
        format!("Stop & Send confirmado y enviado en un turno nuevo del Attempt {attempt_id}.")
    };
    Ok((output, human))
}

fn item(raw: &Value, attempt_id: &str, pending: bool) -> Result<Value, ControlFailure> {
    let queue_id = contract_string(raw, "queue_id")?;
    let seq = raw["seq"]
        .as_u64()
        .filter(|seq| *seq > 0)
        .ok_or_else(ControlFailure::version)?;
    if !valid_queue_id(queue_id)
        || !queue_id.starts_with(&format!("{attempt_id}-q"))
        || queue_id
            .rsplit_once("-q")
            .and_then(|(_, value)| value.parse::<u64>().ok())
            != Some(seq)
    {
        return Err(ControlFailure::version());
    }
    let status = contract_string(raw, "status")?;
    if !STATUSES.contains(&status) || pending != matches!(status, "queued" | "delivering") {
        return Err(ControlFailure::version());
    }
    let author_kind = contract_string(raw, "author_kind")?;
    if !matches!(author_kind, "person" | "agent" | "system") {
        return Err(ControlFailure::version());
    }
    let body = raw["body"].as_str().ok_or_else(ControlFailure::version)?;
    let failure = match raw.get("failure") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(value)) if FAILURES.contains(&value.as_str()) => json!(value),
        _ => return Err(ControlFailure::version()),
    };
    let confirmed_by = match raw.get("confirmed_by") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::String(value)) if CONFIRMATIONS.contains(&value.as_str()) => json!(value),
        _ => return Err(ControlFailure::version()),
    };
    let timestamp = |key: &str| -> Result<Value, ControlFailure> {
        match raw.get(key) {
            None | Some(Value::Null) => Ok(Value::Null),
            Some(Value::Number(value)) if value.as_i64().is_some() || value.as_u64().is_some() => {
                Ok(Value::Number(value.clone()))
            }
            _ => Err(ControlFailure::version()),
        }
    };
    let mut shown = json!({
        "queue_id": queue_id,
        "seq": seq,
        "author_kind": author_kind,
        "body": body,
        "status": status,
        "failure": failure,
        "confirmed_by": confirmed_by,
        "created_at": timestamp("created_at")?,
        "delivered_at": timestamp("delivered_at")?,
        "ended_at": timestamp("ended_at")?,
    });
    if pending {
        shown["position"] = json!(raw["position"]
            .as_u64()
            .filter(|position| *position > 0)
            .ok_or_else(ControlFailure::version)?);
    }
    Ok(shown)
}

fn human_body(body: &str) -> String {
    body.chars()
        .map(|character| {
            if character == '\n' || !character.is_control() {
                character
            } else {
                '?'
            }
        })
        .collect::<String>()
        .replace('\n', "\n  ")
}

fn queue_list(
    request: &mut f5_support::Rpc<'_>,
    attempt_id: &str,
) -> Result<(Value, String), ControlFailure> {
    let data = rpc(
        request,
        "pending_queue",
        json!({ "attempt_id": attempt_id }),
    )?;
    if data["v"].as_u64() != Some(1) || contract_string(&data, "attempt_id")? != attempt_id {
        return Err(ControlFailure::version());
    }
    let task_id = contract_string(&data, "task_id")?;
    if attempt_id.rsplit_once("-a").map(|(task, _)| task) != Some(task_id) {
        return Err(ControlFailure::version());
    }
    let pending = data["items"]
        .as_array()
        .ok_or_else(ControlFailure::version)?;
    let finished = data["finished"]
        .as_array()
        .ok_or_else(ControlFailure::version)?;
    let limit = data["finished_limit"]
        .as_u64()
        .filter(|limit| *limit == 20)
        .ok_or_else(ControlFailure::version)?;
    let items = pending
        .iter()
        .map(|item_data| item(item_data, attempt_id, true))
        .collect::<Result<Vec<_>, _>>()?;
    let finished = finished
        .iter()
        .map(|item_data| item(item_data, attempt_id, false))
        .collect::<Result<Vec<_>, _>>()?;
    let output = json!({
        "v": CONTRACT,
        "command": "queue.list",
        "attempt_id": attempt_id,
        "task_id": task_id,
        "items": items,
        "finished": finished,
        "finished_limit": limit,
    });
    let mut sections = Vec::new();
    if !items.is_empty() {
        sections.push(format!(
            "Pendientes:\n{}",
            items
                .iter()
                .map(|entry| {
                    format!(
                        "{} · {} · {}: {}",
                        entry["position"].as_u64().unwrap_or(0),
                        entry["queue_id"].as_str().unwrap_or(""),
                        entry["status"].as_str().unwrap_or(""),
                        human_body(entry["body"].as_str().unwrap_or(""))
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if !finished.is_empty() {
        sections.push(format!(
            "Historial reciente:\n{}",
            finished
                .iter()
                .map(|entry| {
                    let failure = entry["failure"]
                        .as_str()
                        .map(|reason| format!(" ({reason})"))
                        .unwrap_or_default();
                    format!(
                        "{} · {}{}: {}",
                        entry["queue_id"].as_str().unwrap_or(""),
                        entry["status"].as_str().unwrap_or(""),
                        failure,
                        human_body(entry["body"].as_str().unwrap_or(""))
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let human = if sections.is_empty() {
        format!("{attempt_id}: no hay instrucciones pendientes ni historial reciente.")
    } else {
        format!("{attempt_id}\n{}", sections.join("\n"))
    };
    Ok((output, human))
}

fn cancel(
    request: &mut f5_support::Rpc<'_>,
    queue_id: &str,
) -> Result<(Value, String), ControlFailure> {
    let data = rpc(
        request,
        "attempt_queue_cancel",
        json!({ "queue_id": queue_id }),
    )?;
    let status = contract_string(&data, "status")?;
    if !matches!(status, "Cancelled" | "AlreadyCancelled")
        || contract_string(&data, "queue_id")? != queue_id
    {
        return Err(ControlFailure::version());
    }
    let output = json!({
        "v": CONTRACT,
        "command": "queue.cancel",
        "status": status,
        "queue_id": queue_id,
    });
    let human = if status == "AlreadyCancelled" {
        format!("{queue_id} ya estaba cancelado.")
    } else {
        format!("Instrucción {queue_id} cancelada.")
    };
    Ok((output, human))
}

fn execute(
    request: Request,
    rpc: &mut f5_support::Rpc<'_>,
) -> Result<(Value, String), ControlFailure> {
    match request {
        Request::Help => Ok((Value::Null, HELP.to_string())),
        Request::Enqueue {
            attempt_id,
            message,
            request_id,
            confirm,
        } => {
            let body = message_text(message)?;
            let request_id = request_id.unwrap_or_else(|| {
                f5_support::stable_request_id(
                    "queue",
                    &json!({"attempt_id": attempt_id, "body": body}),
                )
            });
            enqueue(rpc, &attempt_id, &body, &request_id, confirm)
        }
        Request::Steer {
            attempt_id,
            message,
            request_id,
            confirm,
        } => {
            let body = message_text(message)?;
            let request_id = request_id.unwrap_or_else(|| {
                f5_support::stable_request_id(
                    "steer",
                    &json!({"attempt_id": attempt_id, "body": body}),
                )
            });
            instruction(
                rpc,
                "attempt_steer",
                "steer",
                &attempt_id,
                &body,
                &request_id,
                confirm,
            )
        }
        Request::StopAndSend {
            attempt_id,
            message,
            request_id,
            confirm,
        } => {
            let body = message_text(message)?;
            let request_id = request_id.unwrap_or_else(|| {
                f5_support::stable_request_id(
                    "stop-send",
                    &json!({"attempt_id": attempt_id, "body": body}),
                )
            });
            instruction(
                rpc,
                "attempt_stop_and_send",
                "stop_and_send",
                &attempt_id,
                &body,
                &request_id,
                confirm,
            )
        }
        Request::List { attempt_id } => queue_list(rpc, &attempt_id),
        Request::Cancel { queue_id } => cancel(rpc, &queue_id),
    }
}

fn finish(result: Result<(Value, String), ControlFailure>, json_output: bool) -> ExitCode {
    match result {
        Ok((_, human)) if human == HELP => {
            println!("{human}");
            ExitCode::SUCCESS
        }
        Ok((data, human)) => {
            if json_output {
                println!("{data}");
            } else {
                println!("{human}");
            }
            ExitCode::SUCCESS
        }
        Err(error) => {
            if json_output {
                eprintln!("{}", error.json_value());
            } else {
                eprintln!("lxo: {}", error.message);
            }
            ExitCode::from(error.exit)
        }
    }
}

pub(super) fn run(a: &Args) -> ExitCode {
    let request = match parse(a) {
        Ok(request) => request,
        Err(error) => return finish(Err(error), a.b("json")),
    };
    if request == Request::Help {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    let mut rpc = |command: &str, args: &Value| client_auth::rpc(command, args, &crate::cwd());
    finish(execute(request, &mut rpc), a.b("json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|value| value.to_string()).collect())
    }

    fn execute_with(
        request: Request,
        calls: Rc<RefCell<Vec<(String, Value)>>>,
        response: Value,
    ) -> Result<(Value, String), ControlFailure> {
        let mut rpc = move |command: &str, arguments: &Value| {
            calls
                .borrow_mut()
                .push((command.to_string(), arguments.clone()));
            Ok(response.clone())
        };
        execute(request, &mut rpc)
    }

    #[test]
    fn parser_exige_semantica_explicita_y_confirmacion_para_instruir() {
        assert!(matches!(
            parse(&args(&[
                "attempt",
                "queue",
                "task-a1",
                "--message",
                "luego"
            ])),
            Err(ControlFailure { exit: 2, .. })
        ));
        assert_eq!(
            parse(&args(&[
                "attempt",
                "queue",
                "task-a1",
                "--message",
                "  conserva estos espacios  ",
                "--confirm"
            ])),
            Ok(Request::Enqueue {
                attempt_id: "task-a1".into(),
                message: MessageSource::Inline("  conserva estos espacios  ".into()),
                request_id: None,
                confirm: true,
            })
        );
        assert!(matches!(
            parse(&args(&[
                "attempt",
                "steer",
                "task-a1",
                "--message",
                "ahora",
                "--confirm",
                "--queue"
            ])),
            Err(ControlFailure { exit: 2, .. })
        ));
        assert!(matches!(
            parse(&args(&[
                "attempt",
                "stop",
                "task-a1",
                "--send",
                "--message",
                "rehaz",
                "--confirm"
            ])),
            Ok(Request::StopAndSend { .. })
        ));
        assert!(matches!(
            parse(&args(&[
                "attempt",
                "stop",
                "task-a1",
                "--send",
                "--message",
                "rehaz",
                "--confirm",
                "--steer"
            ])),
            Err(ControlFailure { exit: 2, .. })
        ));
    }

    #[test]
    fn valida_ids_y_cuerpo_antes_de_hacer_rpc() {
        for raw in [
            &["attempt", "queue", "task-a0", "--message", "x", "--confirm"][..],
            &[
                "attempt",
                "queue",
                " task-a1",
                "--message",
                "x",
                "--confirm",
            ][..],
            &["queue", "cancel", "task-a1-q01"][..],
            &[
                "attempt",
                "steer",
                "task-a1",
                "--message",
                "x",
                "--confirm",
                "--request-id",
                "no spaces",
            ][..],
            &[
                "attempt",
                "steer",
                "task-a1",
                "--message",
                "x",
                "--confirm",
                "--request-id",
                " padded ",
            ][..],
            &[
                "attempt",
                "steer",
                "task-a1",
                "--message",
                "x",
                "--confirm",
                "--request-id",
                "r",
                "--request-id",
                "s",
            ][..],
        ] {
            assert!(parse(&args(raw)).is_err(), "{raw:?}");
        }
        assert_eq!(valid_queue_id("task-a1-q4"), true);
        assert_eq!(valid_queue_id("task-a1-q04"), false);
        assert_eq!(valid_queue_id("task-a1-q0"), false);
    }

    #[test]
    fn enqueue_genera_request_id_estable_y_no_devuelve_el_texto() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let request = Request::Enqueue {
            attempt_id: "task-a1".into(),
            message: MessageSource::Inline("texto privado".into()),
            request_id: None,
            confirm: true,
        };
        let response = json!({
            "status":"Queued", "attempt_id":"task-a1", "queue_id":"task-a1-q1", "position":1
        });
        let result = execute_with(request, calls.clone(), response).unwrap().0;
        assert_eq!(result["v"], CONTRACT);
        assert_eq!(result["queue_id"], "task-a1-q1");
        assert!(!result.to_string().contains("texto privado"));
        let (command, arguments) = &calls.borrow()[0];
        assert_eq!(command, "attempt_queue");
        assert_eq!(arguments["confirm"], true);
        assert_eq!(arguments["body"], "texto privado");
        let request_id = arguments["request_id"].as_str().unwrap();
        assert!(valid_request_id(request_id));
        assert_eq!(
            request_id,
            f5_support::stable_request_id(
                "queue",
                &json!({"attempt_id":"task-a1", "body":"texto privado"})
            )
        );
        crate::snapshot("attempt_queue.v1.json", &result);
    }

    #[test]
    fn enqueue_replay_tiene_snapshot_y_no_publica_el_cuerpo() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let result = execute_with(
            Request::Enqueue {
                attempt_id: "task-a1".into(),
                message: MessageSource::Inline("texto privado".into()),
                request_id: Some("q-replay".into()),
                confirm: true,
            },
            calls.clone(),
            json!({
                "status":"Replayed",
                "attempt_id":"task-a1",
                "queue_id":"task-a1-q1",
                "position":null
            }),
        )
        .unwrap()
        .0;
        assert_eq!(result["status"], "Replayed");
        assert!(result["position"].is_null());
        assert!(!result.to_string().contains("texto privado"));
        assert_eq!(calls.borrow()[0].0, "attempt_queue");
        crate::snapshot("attempt_queue_replay.v1.json", &result);
    }

    #[test]
    fn queue_list_publica_solo_el_allowlist_versionado_y_preserva_fifo() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let response = json!({
            "v":1,
            "attempt_id":"task-a1",
            "task_id":"task",
            "items":[{
                "queue_id":"task-a1-q1", "seq":1, "author_kind":"person", "body":"después",
                "status":"queued", "failure":null, "confirmed_by":null, "created_at":123,
                "delivered_at":null, "ended_at":null, "position":1,
                "request_id":"no-publicar", "request_digest":"no-publicar", "client_id":"no-publicar"
            }],
            "finished":[{
                "queue_id":"task-a1-q2", "seq":2, "author_kind":"agent", "body":"resultado",
                "status":"failed", "failure":"adapter_error", "confirmed_by":null, "created_at":124,
                "delivered_at":null, "ended_at":125,
                "request_id":"no-publicar", "request_digest":"no-publicar", "client_id":"no-publicar"
            }],
            "finished_limit":20
        });
        let (result, human) = execute_with(
            Request::List {
                attempt_id: "task-a1".into(),
            },
            calls,
            response,
        )
        .unwrap();
        assert_eq!(result["items"][0]["position"], 1);
        assert_eq!(result["finished"][0]["failure"], "adapter_error");
        assert_eq!(result["finished"][0]["ended_at"], 125);
        assert!(human.contains("Pendientes:"));
        assert!(human.contains("Historial reciente:"));
        assert!(human.contains("(adapter_error)"));
        // Nombres de campos internos que la lectura no publica (no son valores).
        for campo_interno in [
            "request_id",
            "request_digest",
            "client_id",
            "author_id",
            "attachments",
        ] {
            assert!(
                result["items"][0].get(campo_interno).is_none()
                    && result["finished"][0].get(campo_interno).is_none(),
                "el campo interno {campo_interno} no debe publicarse"
            );
        }
        crate::snapshot("queue_list.v1.json", &result);
    }

    #[test]
    fn steer_y_stop_send_llegan_a_rpc_distintos_y_validan_su_respuesta() {
        for (command, mode, request) in [
            (
                "attempt_steer",
                "steer",
                Request::Steer {
                    attempt_id: "task-a1".into(),
                    message: MessageSource::Inline("ahora".into()),
                    request_id: Some("s-1".into()),
                    confirm: true,
                },
            ),
            (
                "attempt_stop_and_send",
                "stop_and_send",
                Request::StopAndSend {
                    attempt_id: "task-a1".into(),
                    message: MessageSource::Inline("nuevo turno".into()),
                    request_id: Some("ss-1".into()),
                    confirm: true,
                },
            ),
        ] {
            let calls = Rc::new(RefCell::new(Vec::new()));
            let response = json!({
                "status":"Delivered",
                "mode":mode,
                "attempt_id":"task-a1",
                "request_id":if mode == "steer" { "s-1" } else { "ss-1" }
            });
            let output = execute_with(request, calls.clone(), response).unwrap().0;
            assert_eq!(output["mode"], mode);
            assert_eq!(calls.borrow()[0].0, command);
            crate::snapshot(
                if mode == "steer" {
                    "attempt_steer.v1.json"
                } else {
                    "attempt_stop_send.v1.json"
                },
                &output,
            );
        }
    }

    #[test]
    fn queue_cancel_y_replay_tienen_snapshot_y_no_cambian_semantica() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let output = execute_with(
            Request::Cancel {
                queue_id: "task-a1-q2".into(),
            },
            calls.clone(),
            json!({"status":"Cancelled", "queue_id":"task-a1-q2"}),
        )
        .unwrap()
        .0;
        assert_eq!(calls.borrow()[0].0, "attempt_queue_cancel");
        crate::snapshot("queue_cancel.v1.json", &output);

        let already_cancelled = execute_with(
            Request::Cancel {
                queue_id: "task-a1-q2".into(),
            },
            Rc::new(RefCell::new(Vec::new())),
            json!({"status":"AlreadyCancelled", "queue_id":"task-a1-q2"}),
        )
        .unwrap()
        .0;
        assert_eq!(already_cancelled["status"], "AlreadyCancelled");

        let calls = Rc::new(RefCell::new(Vec::new()));
        let replay = execute_with(
            Request::Steer {
                attempt_id: "task-a1".into(),
                message: MessageSource::Inline("ahora".into()),
                request_id: Some("s-1".into()),
                confirm: true,
            },
            calls,
            json!({"status":"Replayed", "mode":"steer", "attempt_id":"task-a1", "request_id":"s-1"}),
        )
        .unwrap()
        .0;
        assert_eq!(replay["status"], "Replayed");
        assert_eq!(replay["mode"], "steer");
    }

    #[test]
    fn las_capabilities_no_soportadas_y_la_policy_conservan_codigos_estables() {
        let error = |text: &str| rejected_failure(text);
        assert_eq!(
            error("unsupported/steer_unsupported: provider").code,
            "steer_unsupported"
        );
        assert_eq!(error("unsupported/queue_unsupported: provider").exit, 7);
        assert_eq!(
            error("environment_blocked/environment_blocked: blocked").exit,
            8
        );
        assert_eq!(
            error("policy_confirm_required: confirm").code,
            "policy_confirm_required"
        );
        assert_eq!(error("policy_denied: deny").exit, 9);
        assert_eq!(error("busy/not_running: waiting").exit, 10);
        assert_eq!(error("invalid/attempt_final: ended").exit, 11);
        assert_eq!(error("invalid/request_conflict: reused").exit, 12);
    }

    #[test]
    fn error_policy_json_tiene_contrato_versionado() {
        let failure = rejected_failure("policy_confirm_required: falta confirmación");
        assert_eq!(failure.exit, 9);
        crate::snapshot(
            "attempt_control_policy_error.v1.json",
            &failure.json_value(),
        );
    }

    #[test]
    fn respuestas_de_otra_semantica_o_version_no_se_aceptan() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let output = execute_with(
            Request::Steer {
                attempt_id: "task-a1".into(),
                message: MessageSource::Inline("ahora".into()),
                request_id: Some("s-1".into()),
                confirm: true,
            },
            calls,
            json!({"status":"Delivered", "mode":"stop_and_send", "attempt_id":"task-a1", "request_id":"s-1"}),
        );
        assert!(matches!(output, Err(ControlFailure { exit: 4, .. })));

        let calls = Rc::new(RefCell::new(Vec::new()));
        let output = execute_with(
            Request::List {
                attempt_id: "task-a1".into(),
            },
            calls,
            json!({
                "v":1,
                "attempt_id":"task-a1",
                "task_id":"otro",
                "items":[],
                "finished":[],
                "finished_limit":20
            }),
        );
        assert!(matches!(output, Err(ControlFailure { exit: 4, .. })));

        let calls = Rc::new(RefCell::new(Vec::new()));
        let output = execute_with(
            Request::List {
                attempt_id: "task-a1".into(),
            },
            calls,
            json!({"v":2, "attempt_id":"task-a1"}),
        );
        assert!(matches!(output, Err(ControlFailure { exit: 4, .. })));
    }

    #[test]
    fn queue_list_humano_escapa_controles_de_terminal_y_conserva_saltos_de_linea() {
        assert_eq!(
            human_body("primera\n\u{1b}[31mroja\u{1b}[0m\r"),
            "primera\n  ?[31mroja?[0m?"
        );
    }
}
