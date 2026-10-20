//! Cliente de lectura del Event Log para el helper `lxo`.
//!
//! Solo consulta GET /events mediante el cliente autenticado. El cursor local es
//! estado del cliente y nunca abre ni copia el almacén del Core.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Duration;

use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::client_auth::{self, EventRequestFailure};
use crate::Args;

const CONTRACT_VERSION: u64 = 1;
const MAX_CURSOR: u64 = i64::MAX as u64;
pub(super) const HELP: &str =
    "Uso: lxo events [--after SEQ] [--limit N] [filtros] [--json] [--follow]

Lee el Event Log del Core por GET /events con el cliente autenticado de Lixbon.
No lee SQLite ni el estado local del Core. Sin argumentos muestra la primera
pagina de hasta 100 eventos.

Paginacion:
  --after SEQ        cursor exclusivo (seq decimal; defecto 0)
  --limit N          eventos por pagina (defecto Core: 100; maximo Core: 500)
  Con mas paginas, --json incluye next_cursor; la salida humana sugiere el cursor.

Filtros (se combinan con AND):
  --project ID       --run ID           --class state|effect|decision|system
  --task ID          atajo de --entity-kind task --entity-id ID
  --entity-kind K    --entity-id ID     --kind K | --kind-prefix PREFIJO

Salida:
  --json             pagina compacta; con --follow, un objeto de evento por linea
  --follow           sondea por cursor; pagina sin espera y retrocede hasta 2 s
                     entre respuestas vacias. Guarda el ultimo cursor confirmado
                     en ~/.lixbon/events/ y reintenta errores de red desde el
                     ultimo cursor confirmado (1 s a 8 s). Ctrl+C termina.

Codigos de salida: 0 correcto, 1 error interno/Event Log no disponible,
2 uso o filtro invalido, 3 autenticacion, 4 version/contrato, 5 red,
6 cursor invalido o adelantado.
";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct EventsOptions {
    pub(super) after: Option<u64>,
    pub(super) query: BTreeMap<String, String>,
    pub(super) json: bool,
    pub(super) follow: bool,
    help: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ErrorKind {
    Internal,
    Usage,
    Authentication,
    Version,
    Network,
    Cursor,
    CursorAhead,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct EventsError {
    kind: ErrorKind,
    code: String,
    message: String,
}

impl EventsError {
    fn new(kind: ErrorKind, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            kind,
            code: code.into(),
            message: message.into(),
        }
    }

    pub(super) fn exit_code(&self) -> u8 {
        match self.kind {
            ErrorKind::Internal => 1,
            ErrorKind::Usage => 2,
            ErrorKind::Authentication => 3,
            ErrorKind::Version => 4,
            ErrorKind::Network => 5,
            ErrorKind::Cursor | ErrorKind::CursorAhead => 6,
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct EventPage {
    pub(super) data: Value,
    pub(super) events: Vec<Value>,
    next_cursor: u64,
    has_more: bool,
    head_seq: u64,
}

pub(super) fn parse_events_options(args: &Args) -> Result<EventsOptions, EventsError> {
    let allowed = [
        "after",
        "limit",
        "project",
        "run",
        "task",
        "entity-kind",
        "entity-id",
        "kind",
        "kind-prefix",
        "class",
        "json",
        "follow",
        "help",
    ];
    for flag in args.flags.keys() {
        if !allowed.contains(&flag.as_str()) {
            return Err(usage(format!(
                "Filtro desconocido --{flag}; ejecuta `lxo events --help`."
            )));
        }
    }
    if let Some(flag) = args.duplicates.first() {
        return Err(usage(format!("El filtro --{flag} aparece repetido.")));
    }
    let positional: Vec<String> = args
        .pos
        .iter()
        .skip(1)
        .filter(|arg| arg.as_str() != "-h")
        .cloned()
        .collect();
    if !positional.is_empty() {
        return Err(usage(format!(
            "events no admite argumentos sueltos ({:?}).",
            positional[0]
        )));
    }

    let help = bool_arg(args, "help")? || args.pos.iter().any(|arg| arg == "-h");
    let after = text_arg(args, "after")?
        .map(|text| parse_cursor(&text))
        .transpose()?;
    let mut query = BTreeMap::new();
    if let Some(limit) = text_arg(args, "limit")? {
        if limit.is_empty()
            || !limit.bytes().all(|b| b.is_ascii_digit())
            || limit.parse::<u64>().is_err()
            || limit == "0"
        {
            return Err(usage("--limit debe ser un entero decimal mayor que cero."));
        }
        query.insert("limit".into(), limit);
    }

    for (flag, param) in [
        ("project", "project"),
        ("run", "run"),
        ("entity-kind", "entity_kind"),
        ("entity-id", "entity_id"),
        ("kind", "kind"),
        ("kind-prefix", "kind_prefix"),
        ("class", "class"),
    ] {
        if let Some(value) = text_arg(args, flag)? {
            validate_filter(flag, &value).map_err(usage)?;
            query.insert(param.into(), value);
        }
    }

    if let Some(task) = text_arg(args, "task")? {
        validate_filter("task", &task).map_err(usage)?;
        if text_arg(args, "entity-kind")?.is_some() || text_arg(args, "entity-id")?.is_some() {
            return Err(usage(
                "--task no se combina con --entity-kind ni --entity-id.",
            ));
        }
        query.insert("entity_kind".into(), "task".into());
        query.insert("entity_id".into(), task);
    }
    if query.contains_key("entity_id") && !query.contains_key("entity_kind") {
        return Err(usage("--entity-id requiere --entity-kind."));
    }
    if query.contains_key("kind") && query.contains_key("kind_prefix") {
        return Err(usage("--kind y --kind-prefix son incompatibles."));
    }
    if let Some(class) = query.get("class") {
        if !["state", "effect", "decision", "system"].contains(&class.as_str()) {
            return Err(usage("--class debe ser state, effect, decision o system."));
        }
    }

    Ok(EventsOptions {
        after,
        query,
        json: bool_arg(args, "json")?,
        follow: bool_arg(args, "follow")?,
        help,
    })
}

fn usage(message: impl Into<String>) -> EventsError {
    EventsError::new(ErrorKind::Usage, "invalid_filter", message)
}

fn text_arg(args: &Args, name: &str) -> Result<Option<String>, EventsError> {
    match args.flags.get(name) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(usage(format!("--{name} requiere un valor."))),
    }
}

fn bool_arg(args: &Args, name: &str) -> Result<bool, EventsError> {
    match args.flags.get(name) {
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        _ => Err(usage(format!(
            "--{name} no admite un valor; úsalo como indicador."
        ))),
    }
}

fn validate_filter(name: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > 128 {
        return Err(format!("--{name} requiere un valor de 1 a 128 caracteres."));
    }
    Ok(())
}

fn parse_cursor(text: &str) -> Result<u64, EventsError> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(EventsError::new(
            ErrorKind::Cursor,
            "invalid_cursor",
            format!("El cursor debe ser un entero decimal >= 0 (recibido {text:?})."),
        ));
    }
    let cursor = text.parse::<u64>().map_err(|_| {
        EventsError::new(
            ErrorKind::Cursor,
            "invalid_cursor",
            format!("El cursor {text:?} está fuera de rango."),
        )
    })?;
    if cursor > MAX_CURSOR {
        return Err(EventsError::new(
            ErrorKind::Cursor,
            "invalid_cursor",
            format!("El cursor {text:?} está fuera del rango admitido por el Core."),
        ));
    }
    Ok(cursor)
}

pub(super) fn parse_events_page(response: &Value, cursor: u64) -> Result<EventPage, EventsError> {
    if response["ok"].as_bool() != Some(true) {
        return Err(EventsError::new(
            ErrorKind::Version,
            "bad_response",
            "Respuesta inválida del Core en /events.",
        ));
    }
    let data = &response["data"];
    if data["v"].as_u64() != Some(CONTRACT_VERSION) {
        return Err(EventsError::new(
            ErrorKind::Version,
            "version",
            "El contrato del Event Log no es compatible; actualiza Lixbon.",
        ));
    }
    let events = data["events"].as_array().cloned().ok_or_else(|| {
        EventsError::new(
            ErrorKind::Version,
            "contract",
            "Contrato roto: falta events o no es un array.",
        )
    })?;
    let next_cursor = event_seq(data.get("next_cursor"), "next_cursor")?;
    let head_seq = event_seq(data.get("head_seq"), "head_seq")?;
    let has_more = data["has_more"].as_bool().ok_or_else(|| {
        EventsError::new(
            ErrorKind::Version,
            "contract",
            "Contrato roto: has_more no es booleano.",
        )
    })?;
    if next_cursor < cursor {
        return Err(EventsError::new(
            ErrorKind::Version,
            "contract",
            "Contrato roto: next_cursor es anterior al cursor pedido.",
        ));
    }
    let mut previous = cursor;
    for (index, event) in events.iter().enumerate() {
        let seq = event_seq(event.get("seq"), "seq")?;
        if seq == 0 || seq <= previous || seq > head_seq {
            return Err(EventsError::new(ErrorKind::Version, "contract", format!("Contrato roto: seq del evento {} no es creciente, posterior al cursor y <= head_seq.", index + 1)));
        }
        previous = seq;
    }
    if has_more && events.is_empty() {
        return Err(EventsError::new(
            ErrorKind::Version,
            "contract",
            "Contrato roto: has_more=true sin eventos.",
        ));
    }
    if has_more && next_cursor != previous {
        return Err(EventsError::new(
            ErrorKind::Version,
            "contract",
            "Contrato roto: next_cursor no coincide con el último seq de la página.",
        ));
    }
    if !has_more && next_cursor != head_seq {
        return Err(EventsError::new(
            ErrorKind::Version,
            "contract",
            "Contrato roto: next_cursor debe coincidir con head_seq cuando has_more=false.",
        ));
    }
    Ok(EventPage {
        data: data.clone(),
        events,
        next_cursor,
        has_more,
        head_seq,
    })
}

fn event_seq(value: Option<&Value>, name: &str) -> Result<u64, EventsError> {
    value
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_CURSOR)
        .ok_or_else(|| {
            EventsError::new(
                ErrorKind::Version,
                "contract",
                format!("Contrato roto: {name} no es un entero decimal dentro del rango."),
            )
        })
}

pub(super) fn events_json(value: &Value) -> Result<String, EventsError> {
    serde_json::to_string(value).map_err(|_| {
        EventsError::new(
            ErrorKind::Internal,
            "internal",
            "No se pudo serializar la respuesta del Event Log.",
        )
    })
}

pub(super) fn events_human_line(event: &Value) -> Result<String, EventsError> {
    let seq = event_seq(event.get("seq"), "seq")?;
    let ts = event["ts"].as_i64().ok_or_else(|| {
        EventsError::new(
            ErrorKind::Version,
            "contract",
            "Contrato roto: evento sin ts entero.",
        )
    })?;
    let kind = event["kind"].as_str().ok_or_else(|| {
        EventsError::new(
            ErrorKind::Version,
            "contract",
            "Contrato roto: evento sin kind.",
        )
    })?;
    let actor = event["actor"].as_object().ok_or_else(|| {
        EventsError::new(
            ErrorKind::Version,
            "contract",
            "Contrato roto: evento sin actor.",
        )
    })?;
    let entity = event["entity"].as_object().ok_or_else(|| {
        EventsError::new(
            ErrorKind::Version,
            "contract",
            "Contrato roto: evento sin entity.",
        )
    })?;
    let mut line = format!(
        "{seq}  {}  {}  {}  {}",
        timestamp_utc(ts),
        clean(kind),
        ref_text(entity),
        ref_text(actor)
    );
    if let Some(run) = event["run_id"].as_str() {
        line.push_str(&format!("  run={}", clean(run)));
    }
    if let Some(project) = event["project_id"].as_str() {
        line.push_str(&format!("  project={}", clean(project)));
    }
    Ok(line)
}

fn ref_text(value: &serde_json::Map<String, Value>) -> String {
    let kind = value.get("kind").and_then(Value::as_str).unwrap_or("?");
    match value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        Some(id) => format!("{}:{}", clean(kind), clean(id)),
        None => clean(kind),
    }
}

pub(super) fn clean(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_control() { '?' } else { ch })
        .collect()
}

fn timestamp_utc(milliseconds: i64) -> String {
    let seconds = milliseconds.div_euclid(1000);
    let millis = milliseconds.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = day_seconds / 3600;
    let minute = (day_seconds % 3600) / 60;
    let second = day_seconds % 60;
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 }.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

fn fetch_page(cursor: u64, query: &BTreeMap<String, String>) -> Result<EventPage, EventsError> {
    let mut params: Vec<(String, String)> =
        query.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    params.push(("cursor".into(), cursor.to_string()));
    let (status, response) = client_auth::get_events(&params).map_err(|error| match error {
        EventRequestFailure::Network(message) => {
            EventsError::new(ErrorKind::Network, "network", message)
        }
        EventRequestFailure::CoreUnavailable(message) => {
            EventsError::new(ErrorKind::Network, "core_unavailable", message)
        }
        EventRequestFailure::Authentication(message) => {
            EventsError::new(ErrorKind::Authentication, "authentication", message)
        }
        EventRequestFailure::Version(message) => {
            EventsError::new(ErrorKind::Version, "version", message)
        }
        EventRequestFailure::Internal(message) => {
            EventsError::new(ErrorKind::Internal, "internal", message)
        }
    })?;
    if status != 200 {
        return Err(response_error(status, &response));
    }
    parse_events_page(&response, cursor)
}

fn response_error(status: u16, response: &Value) -> EventsError {
    let code = match response["code"].as_str().unwrap_or("") {
        "forbidden"
        | "credential_expired"
        | "credential_revoked"
        | "invalid_credential"
        | "core_unavailable"
        | "version_mismatch"
        | "invalid_cursor"
        | "cursor_ahead"
        | "invalid_limit"
        | "invalid_filter"
        | "event_log_unavailable"
        | "internal" => response["code"].as_str().unwrap_or(""),
        _ => "",
    };
    let message = response["error"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("El Core respondió HTTP {status}."));
    match (status, code) {
        (401 | 403, _) => EventsError::new(
            ErrorKind::Authentication,
            if code.is_empty() { "forbidden" } else { code },
            message,
        ),
        (404 | 405, _) => EventsError::new(
            ErrorKind::Version,
            "no_events_api",
            format!("Este Core no ofrece GET /events (HTTP {status}); actualiza Lixbon."),
        ),
        (_, "core_unavailable") => EventsError::new(ErrorKind::Network, code, message),
        (_, "version_mismatch") => EventsError::new(ErrorKind::Version, code, message),
        (_, "invalid_cursor") => EventsError::new(ErrorKind::Cursor, code, message),
        (_, "cursor_ahead") => EventsError::new(ErrorKind::CursorAhead, code, message),
        (_, "invalid_limit" | "invalid_filter") => {
            EventsError::new(ErrorKind::Usage, code, message)
        }
        (_, "event_log_unavailable") => EventsError::new(ErrorKind::Internal, code, message),
        (_, "") => EventsError::new(
            ErrorKind::Version,
            "bad_response",
            "Respuesta inválida del Core en /events.",
        ),
        _ => EventsError::new(ErrorKind::Internal, code, message),
    }
}

fn cursor_path(query: &BTreeMap<String, String>, task_id: Option<&str>) -> PathBuf {
    let mut cursor_query = query.clone();
    cursor_query.remove("limit");
    let normalized =
        serde_json::to_vec(&(task_id.unwrap_or("person"), cursor_query)).unwrap_or_default();
    let hash = Sha256::digest(normalized);
    let filename: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
    crate::home()
        .join(".lixbon")
        .join("events")
        .join(format!("{filename}.cursor"))
}

fn load_cursor(path: &Path) -> Result<Option<u64>, EventsError> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(EventsError::new(
                ErrorKind::Internal,
                "cursor_store",
                "No se pudo leer el cursor local de events.",
            ))
        }
    };
    parse_cursor(text.trim()).map(Some)
}

fn save_cursor(path: &Path, cursor: u64) -> Result<(), EventsError> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|_| {
        EventsError::new(
            ErrorKind::Internal,
            "cursor_store",
            "No se pudo crear el directorio local del cursor.",
        )
    })?;
    let temp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temp, cursor.to_string()).map_err(|_| {
        EventsError::new(
            ErrorKind::Internal,
            "cursor_store",
            "No se pudo guardar el cursor confirmado.",
        )
    })?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|_| {
            EventsError::new(
                ErrorKind::Internal,
                "cursor_store",
                "No se pudo reemplazar el cursor confirmado.",
            )
        })?;
    }
    std::fs::rename(temp, path).map_err(|_| {
        EventsError::new(
            ErrorKind::Internal,
            "cursor_store",
            "No se pudo confirmar el cursor local.",
        )
    })
}

fn write_events_page(page: &EventPage, json: bool, following: bool) -> Result<(), EventsError> {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    if json && !following {
        writeln!(out, "{}", events_json(&page.data)?).map_err(|_| {
            EventsError::new(
                ErrorKind::Internal,
                "stdout",
                "No se pudo escribir la salida.",
            )
        })?;
    } else {
        for event in &page.events {
            let line = if json {
                events_json(event)?
            } else {
                events_human_line(event)?
            };
            writeln!(out, "{line}").map_err(|_| {
                EventsError::new(
                    ErrorKind::Internal,
                    "stdout",
                    "No se pudo escribir la salida.",
                )
            })?;
        }
        if !following && !json {
            if page.events.is_empty() {
                eprintln!("Sin eventos (head_seq={}).", page.head_seq);
            } else if page.has_more {
                eprintln!(
                    "Hay más eventos: repite con --after {} (head_seq={}).",
                    page.next_cursor, page.head_seq
                );
            }
        }
    }
    Ok(())
}

fn run_once(options: &EventsOptions) -> Result<(), EventsError> {
    let cursor = options.after.unwrap_or(0);
    let page = fetch_page(cursor, &options.query)?;
    write_events_page(&page, options.json, false)
}

fn run_follow(options: &EventsOptions) -> Result<(), EventsError> {
    let task_id = std::env::var("LXO_TASK_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let path = cursor_path(&options.query, task_id.as_deref());
    let explicit = options.after.is_some();
    let mut cursor = match options.after {
        Some(cursor) => cursor,
        None => load_cursor(&path)?.unwrap_or(0),
    };
    follow_with(
        &mut cursor,
        &path,
        explicit,
        |cursor| fetch_page(cursor, &options.query),
        |event| {
            let line = if options.json {
                events_json(event)?
            } else {
                events_human_line(event)?
            };
            println!("{line}");
            Ok(())
        },
        |duration| std::thread::sleep(duration),
        || false,
    )
}

fn follow_with<F, E, S, C>(
    cursor: &mut u64,
    path: &Path,
    explicit: bool,
    mut fetch: F,
    mut emit: E,
    mut sleep: S,
    mut stopped: C,
) -> Result<(), EventsError>
where
    F: FnMut(u64) -> Result<EventPage, EventsError>,
    E: FnMut(&Value) -> Result<(), EventsError>,
    S: FnMut(Duration),
    C: FnMut() -> bool,
{
    let mut empty_delay = Duration::from_millis(500);
    let mut network_delay = Duration::from_secs(1);
    loop {
        if stopped() {
            return Ok(());
        }
        match fetch(*cursor) {
            Ok(page) => {
                let received_events = !page.events.is_empty();
                for event in &page.events {
                    emit(event)?;
                }
                *cursor = page.next_cursor;
                save_cursor(path, *cursor)?;
                network_delay = Duration::from_secs(1);
                if page.has_more {
                    empty_delay = Duration::from_millis(500);
                    continue;
                }
                if received_events {
                    empty_delay = Duration::from_millis(500);
                }
                sleep(empty_delay);
                if !received_events {
                    empty_delay = (empty_delay * 2).min(Duration::from_secs(2));
                }
            }
            Err(error) if error.kind == ErrorKind::CursorAhead && !explicit && *cursor > 0 => {
                eprintln!("El cursor guardado supera el head del Core; se vuelve a leer desde 0.");
                *cursor = 0;
                save_cursor(path, 0)?;
                empty_delay = Duration::from_millis(500);
            }
            Err(error) if error.kind == ErrorKind::Network => {
                eprintln!(
                    "{}; se reintentará desde el cursor confirmado {}.",
                    error.message, *cursor
                );
                sleep(network_delay);
                network_delay = (network_delay * 2).min(Duration::from_secs(8));
            }
            Err(error) => return Err(error),
        }
    }
}

fn display_error(error: &EventsError, json: bool) -> ExitCode {
    if json {
        eprintln!(
            "{{\"ok\":false,\"code\":{},\"error\":{}}}",
            serde_json::to_string(&error.code).unwrap_or_else(|_| "\"internal\"".into()),
            serde_json::to_string(&error.message).unwrap_or_else(|_| "\"Error interno\"".into())
        );
    } else {
        eprintln!("lxo: {}", error.message);
    }
    ExitCode::from(error.exit_code())
}

pub(super) fn run(args: &Args) -> ExitCode {
    match parse_events_options(args) {
        Err(error) => display_error(&error, args.b("json")),
        Ok(options) if options.help => {
            print!("{HELP}");
            ExitCode::SUCCESS
        }
        Ok(options) => {
            let result = if options.follow {
                run_follow(&options)
            } else {
                run_once(&options)
            };
            match result {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => display_error(&error, options.json),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_decimal_no_reinterpreta_digitos_mas_alla_de_js_number() {
        assert_eq!(
            parse_cursor("9007199254740993").unwrap(),
            9_007_199_254_740_993
        );
        assert!(parse_cursor("9223372036854775808").is_err());
        assert!(parse_cursor("+1").is_err());
    }

    #[test]
    fn cursor_persistido_se_reutiliza_al_cambiar_el_limite_de_pagina() {
        let mut query = BTreeMap::from([
            ("project".to_string(), "project-1".to_string()),
            ("limit".to_string(), "100".to_string()),
        ]);
        let path = cursor_path(&query, None);

        query.insert("limit".to_string(), "500".to_string());
        let resumed_path = cursor_path(&query, None);

        assert_eq!(resumed_path, path);
    }

    #[test]
    fn cursor_avanza_hasta_head_con_filtros_sin_eventos() {
        let response = serde_json::json!({ "ok": true, "data": {
            "v": 1, "events": [], "next_cursor": 17, "has_more": false, "head_seq": 17
        }});
        let page = parse_events_page(&response, 10).unwrap();
        assert_eq!(page.next_cursor, 17);
        assert!(page.events.is_empty());
    }

    #[test]
    fn follow_reintenta_desde_el_ultimo_cursor_confirmado_y_no_duplica() {
        let path =
            std::env::temp_dir().join(format!("lxo-events-follow-{}.cursor", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut cursor = 0;
        let attempts = std::cell::Cell::new(0);
        let mut requested = Vec::new();
        let mut emitted = Vec::new();
        let mut waits = Vec::new();
        let result = follow_with(
            &mut cursor,
            &path,
            false,
            |after| {
                requested.push(after);
                let attempt = attempts.get();
                attempts.set(attempt + 1);
                match attempt {
                    0 => Ok(EventPage {
                        data: serde_json::json!({}),
                        events: vec![serde_json::json!({ "seq": 1 })],
                        next_cursor: 1,
                        has_more: true,
                        head_seq: 2,
                    }),
                    1 => Err(EventsError::new(ErrorKind::Network, "network", "offline")),
                    2 => Ok(EventPage {
                        data: serde_json::json!({}),
                        events: vec![serde_json::json!({ "seq": 2 })],
                        next_cursor: 2,
                        has_more: false,
                        head_seq: 2,
                    }),
                    _ => unreachable!(),
                }
            },
            |event| {
                emitted.push(event["seq"].as_u64().unwrap());
                Ok(())
            },
            |duration| waits.push(duration),
            || attempts.get() >= 3,
        );
        assert!(result.is_ok());
        assert_eq!(requested, vec![0, 1, 1]);
        assert_eq!(emitted, vec![1, 2]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "2");
        assert_eq!(
            waits,
            vec![Duration::from_secs(1), Duration::from_millis(500)]
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn follow_no_aumenta_el_backoff_mientras_llegan_eventos() {
        let path = std::env::temp_dir().join(format!(
            "lxo-events-follow-active-{}.cursor",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let mut cursor = 0;
        let attempts = std::cell::Cell::new(0);
        let mut waits = Vec::new();
        let mut emitted = Vec::new();

        let result = follow_with(
            &mut cursor,
            &path,
            false,
            |after| {
                let attempt = attempts.get();
                attempts.set(attempt + 1);
                Ok(EventPage {
                    data: serde_json::json!({}),
                    events: vec![serde_json::json!({ "seq": after + 1 })],
                    next_cursor: after + 1,
                    has_more: false,
                    head_seq: after + 1,
                })
            },
            |event| {
                emitted.push(event["seq"].as_u64().unwrap());
                Ok(())
            },
            |duration| waits.push(duration),
            || attempts.get() >= 2,
        );

        assert!(result.is_ok());
        assert_eq!(emitted, vec![1, 2]);
        assert_eq!(
            waits,
            vec![Duration::from_millis(500), Duration::from_millis(500)]
        );
        let _ = std::fs::remove_file(path);
    }
}
