//! `lxo provider list` y `lxo provider status`: lo que cada proveedor ofrece ahora, de solo lectura (LXO-137).
//!
//! La fuente es `provider_capabilities` del Core por el RPC autenticado, como Person (`docs/core/QUERIES.md`
//! § `provider_capabilities`). lxo no tiene lista de proveedores ni decide soporte por nombre o versión: enseña la matriz de
//! capabilities que da el Core, las seis siempre. `--attempt` suma, como hechos y sin veredicto, la ProviderSession del
//! intento (`attempt_detail`). El `--json` es una allowlist propia: no pasa nada que el Core añada después sin subir `v`.

use std::process::ExitCode;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::attempts::model_failure;
use crate::client_auth::{self, RpcFailure};
use crate::events::{clean, timestamp_utc};
use crate::projects::{failure, finish, usage, Failure};
use crate::Args;

pub(super) const HELP: &str = "Uso: lxo provider list [--refresh] [--json]
     lxo provider status [<proveedor>] [--capability C] [--attempt <attempt_id>] [--refresh] [--json]

Qué ofrece cada proveedor (adapter) ahora, según el Core. Solo lee: no lanza, reanuda
ni configura nada. lxo no decide soporte por el nombre ni por la versión del proveedor.

`lxo provider list` enseña todos los proveedores con su versión de CLI, su entorno
(listo o bloqueado y por qué), el canal con que habla (si tiene más de uno) y las seis
capabilities: start, events, answer, interrupt, steer y resume.

`lxo provider status <proveedor>` enseña uno y fija el código de salida según lo que
mira. Sin --capability mira el entorno; con --capability C, esa capability:
  available / listo      0
  unavailable            7   la tiene, pero ahora no (con su motivo)
  environment_blocked    8   el entorno lo impide: NO es un intento fallido
  unsupported            9   el proveedor no la ofrece
Opciones:
  --capability C     start, events, answer, interrupt, steer o resume
  --attempt ID       suma la sesión del proveedor de ese intento (estado, si es
                     reanudable, si está vinculada) junto a la capability resume del
                     proveedor. Son hechos: si reanudar procede lo decide el Core.
                     Con --attempt el proveedor es opcional (sale del intento)
  --refresh          pide un sondeo nuevo y espera a que termine (el Core lo concede
                     como mucho una vez cada 5 s)

Salida:
  (por defecto)      texto para personas
  --json             {v, status, generation, checked_at_ms, providers} en list;
                     {v, …, provider, check, attempt} en status. Sin rutas, credenciales
                     ni variables de entorno. Lo que el Core no da sale como null

Un proveedor puede estar bloqueado por el entorno (CLI ausente, sandbox de Codex en
Windows…): se dice con su causa y no cuenta como fallo de ningún intento.
Solo para personas: dentro de una tarea del orquestador (agente) usa lxo agents.

Códigos de salida: 0 correcto, 1 error interno del Core, 2 uso inválido, 3 autenticación,
4 versión o contrato incompatible, 5 Lixbon cerrado o Core sin sondeo todavía,
6 proveedor o intento inexistente; solo en status: 7 unavailable, 8 bloqueado por el
entorno, 9 unsupported.
";

const CONTRACT: u64 = 1;
/// Versión de `provider_capabilities` que entiende lxo.
const API: u64 = 1;
/// Versión de `attempt_detail`.
const ATTEMPT_API: u64 = 1;
const MODEL: &str = "task_attempt_v1";
/// Las seis capabilities del contrato (`docs/core/ADAPTERS.md`), en el orden en que se enseñan.
const CAPABILITIES: [&str; 6] = ["start", "events", "answer", "interrupt", "steer", "resume"];
const STATES: [&str; 4] = [
    "available",
    "unsupported",
    "unavailable",
    "environment_blocked",
];
const REASON_MAX: usize = 300;
const LIST_FLAGS: [&str; 3] = ["refresh", "json", "help"];
const STATUS_FLAGS: [&str; 5] = ["capability", "attempt", "refresh", "json", "help"];

type Rpc<'a> = &'a mut dyn FnMut(&str, &Value) -> Result<Value, RpcFailure>;

/// Cuánto se espera al sondeo del Core: la query nunca sondea, así que lxo repite la lectura.
#[derive(Clone, Copy)]
struct Wait {
    interval: Duration,
    polls: u32,
}

const PRODUCTION_WAIT: Wait = Wait {
    interval: Duration::from_millis(500),
    polls: 60,
};

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Help,
    List {
        refresh: bool,
    },
    Status {
        provider: Option<String>,
        capability: Option<String>,
        attempt: Option<String>,
        refresh: bool,
    },
}

fn text_flag(a: &Args, name: &str) -> Result<Option<String>, Failure> {
    match a.flags.get(name) {
        None => Ok(None),
        Some(Value::String(v)) if !v.trim().is_empty() => Ok(Some(v.trim().to_string())),
        _ => Err(usage(format!("--{name} requiere un valor."))),
    }
}

fn check_flags(a: &Args, allowed: &[&str], command: &str) -> Result<(), Failure> {
    if let Some(name) = a.flags.keys().find(|k| !allowed.contains(&k.as_str())) {
        return Err(usage(format!(
            "--{name} no es una opción de {command}. Mira `lxo provider --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["json", "help", "refresh"] {
        if a.flags.get(name).is_some_and(|v| !v.is_boolean()) {
            return Err(usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }
    Ok(())
}

fn parse(a: &Args) -> Result<Request, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    match a.at(1).as_deref() {
        Some("list") => {
            check_flags(a, &LIST_FLAGS, "lxo provider list")?;
            if let Some(extra) = a.at(2) {
                return Err(usage(format!(
                    "lxo provider list no admite argumentos ({}); para uno solo: lxo provider status <proveedor>.",
                    clean(&extra)
                )));
            }
            Ok(Request::List {
                refresh: a.b("refresh"),
            })
        }
        Some("status") => {
            check_flags(a, &STATUS_FLAGS, "lxo provider status")?;
            let capability = text_flag(a, "capability")?;
            if let Some(c) = &capability {
                if !CAPABILITIES.contains(&c.as_str()) {
                    return Err(usage(format!(
                        "--capability no reconoce «{}»; usa {}.",
                        clean(c),
                        CAPABILITIES.join(", ")
                    )));
                }
            }
            let attempt = text_flag(a, "attempt")?;
            let provider = match a.pos.get(2..).unwrap_or_default() {
                [] => None,
                [id] if !id.trim().is_empty() => Some(id.trim().to_string()),
                _ => return Err(usage("lxo provider status recibe un solo proveedor.")),
            };
            if provider.is_none() && attempt.is_none() {
                return Err(usage(
                    "Falta el proveedor: lxo provider status <proveedor>. Los ids salen en lxo provider list.",
                ));
            }
            Ok(Request::Status {
                provider,
                capability,
                attempt,
                refresh: a.b("refresh"),
            })
        }
        Some(other) => Err(usage(format!(
            "«{}» no es una orden de lxo provider; usa list o status.",
            clean(other)
        ))),
        None => Err(usage(
            "Uso: lxo provider list | lxo provider status <proveedor>. Mira `lxo provider --help`.",
        )),
    }
}

fn contract_error() -> Failure {
    Failure::Version(
        "El Core devolvió las capabilities con un formato que este lxo no entiende; actualiza Lixbon."
            .into(),
    )
}

fn provider_failure(error: RpcFailure) -> Failure {
    if let RpcFailure::Rejected(m) = &error {
        if m.starts_with("provider_capabilities_auth_required") {
            return Failure::Auth(
                "Las capabilities de los proveedores son solo para personas: una tarea del orquestador (agente) usa lxo agents."
                    .into(),
            );
        }
        // lxo arma la petición: si el Core la rechaza, es que no hablan el mismo contrato.
        if let Some(detail) = m.strip_prefix("provider_capabilities_invalid_request: ") {
            return Failure::Version(format!(
                "El Core rechazó la consulta de capabilities ({}); actualiza Lixbon.",
                clean(detail)
            ));
        }
        if m.starts_with("Comando desconocido") {
            return Failure::Version(
                "Este Core no ofrece las capabilities de los proveedores; actualiza Lixbon.".into(),
            );
        }
    }
    failure(error)
}

fn text(value: &Value) -> Value {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.chars().take(REASON_MAX).collect()))
        .unwrap_or(Value::Null)
}

/// Una capability tal como la emite lxo: `state` y, solo si el Core los da, `reason` o `block`.
fn capability_view(c: &Value) -> Option<Value> {
    let state = c["state"].as_str().filter(|s| STATES.contains(s))?;
    let mut out = Map::new();
    out.insert("state".into(), json!(state));
    match state {
        "unavailable" => {
            out.insert("reason".into(), text(&c["reason"]));
        }
        "environment_blocked" => {
            out.insert("block".into(), text(&c["block"]));
        }
        _ => {}
    }
    Some(Value::Object(out))
}

/// Un proveedor del Core a la forma de lxo, o `None` si no cumple el contrato (no se adivina nada).
fn provider_view(p: &Value) -> Option<Value> {
    let id = p["id"].as_str().filter(|s| !s.is_empty())?;
    let caps = p["matrix"]["capabilities"].as_object()?;
    let mut matrix = Map::new();
    for name in CAPABILITIES {
        matrix.insert(name.into(), capability_view(caps.get(name)?)?);
    }
    let environment = match p["environment"]["state"].as_str()? {
        "ready" => json!({ "state": "ready", "blocks": [] }),
        "blocked" => json!({
            "state": "blocked",
            "blocks": p["environment"]["blocks"].as_array()?.iter()
                .filter_map(|b| b.as_str().filter(|s| !s.is_empty()))
                .map(|s| s.chars().take(REASON_MAX).collect::<String>())
                .collect::<Vec<_>>(),
        }),
        _ => return None,
    };
    // Solo el Core dice que el canal en uso es un respaldo (`transport_fallback`): lxo no lo deduce del nombre del canal. Un
    // respaldo sin canal o sin motivo no cumple el contrato.
    let fallback = match p.get("transport_fallback") {
        None | Some(Value::Null) => Value::Null,
        Some(f) => {
            let reason = f["reason"].as_str().filter(|s| !s.is_empty())?;
            p["transport"].as_str().filter(|s| !s.is_empty())?;
            json!({ "reason": reason.chars().take(REASON_MAX).collect::<String>() })
        }
    };
    Some(json!({
        "id": id,
        "cli_version": text(&p["cli_version"]),
        "transport": text(&p["transport"]),
        "transport_fallback": fallback,
        "environment": environment,
        "capabilities": matrix,
    }))
}

/// La respuesta del Core ya validada y proyectada: `{status, refreshing, generation, checked_at_ms, providers}`.
fn project(data: &Value) -> Result<Value, Failure> {
    if data["version"].as_u64() != Some(API) {
        return Err(contract_error());
    }
    let status = match data["status"].as_str() {
        Some(s @ ("probing" | "ready")) => s,
        // Un Core que no manda `status` es de antes de la lectura viva.
        _ => return Err(contract_error()),
    };
    let providers = data["providers"]
        .as_array()
        .ok_or_else(contract_error)?
        .iter()
        .map(|p| provider_view(p).ok_or_else(contract_error))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "v": CONTRACT,
        "status": status,
        "refreshing": data["refreshing"].as_bool().unwrap_or(false),
        "generation": data["generation"].as_u64(),
        "checked_at_ms": data["checked_at_ms"].as_u64(),
        "providers": providers,
    }))
}

/// Lee las capabilities esperando al primer sondeo y, con `refresh`, a que termine el que se pidió. El refresco se pide UNA vez:
/// las lecturas de espera no lo repiten (el Core lo concede como mucho cada 5 s).
fn snapshot(rpc: Rpc, refresh: bool, wait: Wait) -> Result<Value, Failure> {
    let args = if refresh {
        json!({ "refresh": true })
    } else {
        json!({})
    };
    let mut view = project(&rpc("provider_capabilities", &args).map_err(provider_failure)?)?;
    let mut polls = 0;
    while (view["status"] == "probing" || (refresh && view["refreshing"] == true))
        && polls < wait.polls
    {
        std::thread::sleep(wait.interval);
        polls += 1;
        view = project(&rpc("provider_capabilities", &json!({})).map_err(provider_failure)?)?;
    }
    if view["status"] == "probing" {
        return Err(Failure::Unavailable(
            "El Core todavía está sondeando a los proveedores; repite el comando en unos segundos."
                .into(),
        ));
    }
    Ok(view)
}

/// Un id que no es de ningún proveedor del Core: lo dice y da los que hay, sin elegir uno.
fn unknown_provider(view: &Value, id: &str) -> Failure {
    let known: Vec<String> = view["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["id"].as_str().map(clean))
        .collect();
    Failure::NotFound(if known.is_empty() {
        format!(
            "No hay ningún proveedor con id «{}»: el Core no tiene ninguno registrado.",
            clean(id)
        )
    } else {
        format!(
            "No hay ningún proveedor con id «{}». El Core conoce: {}.",
            clean(id),
            known.join(", ")
        )
    })
}

fn find<'a>(view: &'a Value, id: &str) -> Option<&'a Value> {
    view["providers"]
        .as_array()?
        .iter()
        .find(|p| p["id"].as_str().is_some_and(|x| x.eq_ignore_ascii_case(id)))
}

/// La sesión del proveedor de un intento (hechos de `attempt_detail`; nunca su referencia opaca).
fn attempt_facts(rpc: Rpc, attempt_id: &str) -> Result<Value, Failure> {
    let data = match rpc("attempt_detail", &json!({ "attempt_id": attempt_id })) {
        Ok(data) => data,
        Err(RpcFailure::Rejected(m)) if m.starts_with("model_not_found") => {
            return Err(Failure::NotFound(format!(
                "No hay ningún intento con id «{}». Los de una tarea salen con lxo attempts --task <task_id>.",
                clean(attempt_id)
            )))
        }
        Err(error) => return Err(model_failure(error)),
    };
    let a = &data["attempt"];
    if data["v"].as_u64() != Some(ATTEMPT_API)
        || data["core_model"] != MODEL
        || !a["id"].is_string()
        || !a["status"].is_string()
    {
        return Err(contract_error());
    }
    let s = &a["provider_session"];
    Ok(json!({
        "attempt_id": text(&a["id"]),
        "task_id": text(&a["task_id"]),
        "status": text(&a["status"]),
        "provider": text(&a["provider"]),
        "provider_session": if s.is_object() { json!({
            "provider_session_id": text(&s["id"]),
            "status": text(&s["status"]),
            "resumable": s["resumable"].as_bool(),
            "binding": text(&s["binding"]),
            "bound": s["bound"].as_bool(),
            "opened_by_attempt_id": text(&s["opened_by_attempt_id"]),
        }) } else { Value::Null },
    }))
}

/// Lo que fija el código de salida de `status`: la capability pedida o, sin ella, el entorno.
fn check(provider: &Value, capability: Option<&str>) -> Value {
    match capability {
        Some(name) => {
            let c = &provider["capabilities"][name];
            json!({
                "scope": "capability", "capability": name, "state": c["state"],
                "reason": c.get("reason").cloned().unwrap_or(Value::Null),
                "block": c.get("block").cloned().unwrap_or(Value::Null),
            })
        }
        None => {
            let blocked = provider["environment"]["state"] == "blocked";
            json!({
                "scope": "environment", "capability": null,
                "state": if blocked { "environment_blocked" } else { "ready" },
                "reason": null,
                "block": provider["environment"]["blocks"].get(0).cloned().unwrap_or(Value::Null),
            })
        }
    }
}

fn exit_code(check: &Value) -> u8 {
    match check["state"].as_str() {
        Some("unavailable") => 7,
        Some("environment_blocked") => 8,
        Some("unsupported") => 9,
        _ => 0,
    }
}

fn list_data(rpc: Rpc, refresh: bool, wait: Wait) -> Result<Value, Failure> {
    snapshot(rpc, refresh, wait)
}

fn status_data(
    rpc: Rpc,
    provider: Option<&str>,
    capability: Option<&str>,
    attempt: Option<&str>,
    refresh: bool,
    wait: Wait,
) -> Result<(Value, u8), Failure> {
    let attempt_facts = attempt.map(|id| attempt_facts(rpc, id)).transpose()?;
    let id = match (provider, &attempt_facts) {
        (Some(p), Some(f)) => {
            if let Some(owner) = f["provider"].as_str() {
                if !owner.eq_ignore_ascii_case(p) {
                    return Err(usage(format!(
                        "El intento {} es de {}, no de {}.",
                        clean(f["attempt_id"].as_str().unwrap_or("")),
                        clean(owner),
                        clean(p)
                    )));
                }
            }
            p.to_string()
        }
        (Some(p), None) => p.to_string(),
        (None, Some(f)) => f["provider"].as_str().map(String::from).ok_or_else(|| {
            usage("El intento no registra su proveedor: indícalo con lxo provider status <proveedor> --attempt <id>.")
        })?,
        (None, None) => return Err(usage("Falta el proveedor.")),
    };
    let view = snapshot(rpc, refresh, wait)?;
    let p = find(&view, &id)
        .ok_or_else(|| unknown_provider(&view, &id))?
        .clone();
    let check = check(&p, capability);
    let code = exit_code(&check);
    let attempt = attempt_facts.map(|mut f| {
        f["resume"] = p["capabilities"]["resume"].clone();
        f
    });
    Ok((
        json!({
            "v": CONTRACT,
            "status": view["status"],
            "refreshing": view["refreshing"],
            "generation": view["generation"],
            "checked_at_ms": view["checked_at_ms"],
            "provider": p,
            "check": check,
            "attempt": attempt.unwrap_or(Value::Null),
        }),
        code,
    ))
}

fn state_text(c: &Value) -> String {
    match c["state"].as_str() {
        Some("available") => "disponible".into(),
        Some("unsupported") => "no soportada por el proveedor".into(),
        Some("unavailable") => format!(
            "no disponible ahora: {}",
            c["reason"]
                .as_str()
                .map(clean)
                .unwrap_or_else(|| "el Core no da el motivo".into())
        ),
        Some("environment_blocked") => format!(
            "bloqueada por el entorno ({})",
            c["block"]
                .as_str()
                .map(block_text)
                .unwrap_or_else(|| "causa no informada".into())
        ),
        _ => "desconocida".into(),
    }
}

fn block_text(code: &str) -> String {
    match code {
        "cli_missing" => "la CLI no está en el PATH".into(),
        "cli_flags_unsupported" => "la CLI instalada no trae los flags que exige el perfil".into(),
        "windows_sandbox_elevated" => {
            "el sandbox elevado de Codex en Windows impide el perfil de solo lectura".into()
        }
        "windows_sandbox_setup" => {
            "el sandbox de Windows de Codex no está listo: en uso, sin configurar o con actualización pendiente"
                .into()
        }
        other => clean(other),
    }
}

fn environment_text(p: &Value) -> String {
    if p["environment"]["state"] != "blocked" {
        return "entorno listo".into();
    }
    let blocks: Vec<String> = p["environment"]["blocks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(block_text)
        .collect();
    if blocks.is_empty() {
        "entorno bloqueado (causa no informada)".into()
    } else {
        format!("entorno bloqueado: {}", blocks.join("; "))
    }
}

fn utc(ms: &Value) -> String {
    ms.as_u64()
        .map(|ms| format!("{} UTC", timestamp_utc(ms as i64)[..19].replace('T', " ")))
        .unwrap_or_else(|| "sin sondeo".into())
}

fn provider_block(p: &Value) -> Vec<String> {
    let mut head = format!(
        "{} · {}",
        p["id"].as_str().map(clean).unwrap_or_default(),
        p["cli_version"]
            .as_str()
            .map(|v| format!("CLI {}", clean(v)))
            .unwrap_or_else(|| "CLI sin versión".into())
    );
    if let Some(t) = p["transport"].as_str() {
        head.push_str(&format!(" · canal {}", clean(t)));
        if p["transport_fallback"].is_object() {
            head.push_str(" (respaldo)");
        }
    }
    head.push_str(&format!(" · {}", environment_text(p)));
    let mut lines = vec![head];
    if let Some(reason) = p["transport_fallback"]["reason"].as_str() {
        lines.push(format!(
            "  Canal de respaldo: {}.",
            clean(reason).trim_end_matches('.')
        ));
    }
    for name in CAPABILITIES {
        lines.push(format!(
            "  {name:<10} {}",
            state_text(&p["capabilities"][name])
        ));
    }
    lines
}

fn list_text(view: &Value) -> String {
    let providers = view["providers"].as_array().cloned().unwrap_or_default();
    let mut lines = vec![format!(
        "Proveedores del Core · generación {} · comprobado {}{}",
        view["generation"]
            .as_u64()
            .map(|g| g.to_string())
            .unwrap_or_else(|| "?".into()),
        utc(&view["checked_at_ms"]),
        if view["refreshing"] == true {
            " · hay un sondeo en curso"
        } else {
            ""
        }
    )];
    if providers.is_empty() {
        lines.push("  Ningún proveedor registrado.".into());
        return lines.join("\n");
    }
    for p in &providers {
        lines.push(String::new());
        lines.extend(provider_block(p));
    }
    if providers
        .iter()
        .any(|p| p["environment"]["state"] == "blocked")
    {
        lines.push(String::new());
        lines.push("Un entorno bloqueado no es un intento fallido: no consume reintentos.".into());
    }
    lines.push("Uno solo: lxo provider status <proveedor> [--capability C]".into());
    lines.join("\n")
}

fn check_text(check: &Value) -> String {
    let what = match check["capability"].as_str() {
        Some(c) => format!("la capability {c}"),
        None => "el entorno".to_string(),
    };
    match check["state"].as_str() {
        Some("ready") => format!("Comprobado: {what} está lista."),
        Some("available") => format!("Comprobado: {what} está disponible."),
        Some("unavailable") => format!(
            "Comprobado: {what} no está disponible ahora (código 7): {}.",
            check["reason"]
                .as_str()
                .map(clean)
                .unwrap_or_else(|| "el Core no da el motivo".into())
        ),
        Some("environment_blocked") => format!(
            "Comprobado: {what} está bloqueado por el entorno (código 8). No es un intento fallido."
        ),
        Some("unsupported") => {
            format!("Comprobado: {what} no la ofrece el proveedor (código 9).")
        }
        _ => format!("Comprobado: {what} está en un estado desconocido."),
    }
}

fn attempt_text(a: &Value) -> Vec<String> {
    let id = a["attempt_id"].as_str().map(clean).unwrap_or_default();
    let mut lines = vec![format!(
        "Intento {id} · {}",
        a["status"]
            .as_str()
            .map(clean)
            .unwrap_or_else(|| "?".into())
    )];
    let s = &a["provider_session"];
    if s.is_object() {
        let resumable = match s["resumable"].as_bool() {
            Some(true) => "reanudable",
            Some(false) => "no reanudable",
            None => "reanudable: desconocido",
        };
        let bound = match s["bound"].as_bool() {
            Some(true) => "vinculada al proveedor",
            Some(false) => "sin vincular al proveedor",
            None => "vinculación desconocida",
        };
        lines.push(format!(
            "  Sesión:      {} · {} · {resumable} · {bound}",
            s["provider_session_id"]
                .as_str()
                .map(clean)
                .unwrap_or_else(|| "—".into()),
            s["status"]
                .as_str()
                .map(clean)
                .unwrap_or_else(|| "estado desconocido".into())
        ));
    } else {
        lines.push("  Sesión:      ninguna registrada".into());
    }
    lines.push(format!("  resume:      {}", state_text(&a["resume"])));
    lines.push("  Si reanudar procede lo decide el Core; aquí solo se enseñan los hechos.".into());
    lines
}

fn status_text(data: &Value) -> String {
    let mut lines = provider_block(&data["provider"]);
    lines.push(String::new());
    lines.push(check_text(&data["check"]));
    if data["attempt"].is_object() {
        lines.push(String::new());
        lines.extend(attempt_text(&data["attempt"]));
    }
    lines.join("\n")
}

fn execute(request: Request, json: bool, wait: Wait) -> Result<u8, Failure> {
    let mut rpc = |cmd: &str, args: &Value| client_auth::rpc(cmd, args, &crate::cwd());
    match request {
        Request::Help => {
            print!("{HELP}");
            Ok(0)
        }
        Request::List { refresh } => {
            let data = list_data(&mut rpc, refresh, wait)?;
            if json {
                println!("{data}");
            } else {
                println!("{}", list_text(&data));
            }
            Ok(0)
        }
        Request::Status {
            provider,
            capability,
            attempt,
            refresh,
        } => {
            let (data, code) = status_data(
                &mut rpc,
                provider.as_deref(),
                capability.as_deref(),
                attempt.as_deref(),
                refresh,
                wait,
            )?;
            if json {
                println!("{data}");
            } else {
                println!("{}", status_text(&data));
            }
            Ok(code)
        }
    }
}

pub(super) fn run(a: &Args) -> ExitCode {
    let json = a.b("json");
    match parse(a).and_then(|request| execute(request, json, PRODUCTION_WAIT)) {
        Ok(code) => ExitCode::from(code),
        Err(failure) => finish(Err(failure), json),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    const FIXTURE: &str =
        include_str!("../../../../docs/core/fixtures/api/provider_capabilities.v1.json");
    const FIXTURE_RESPALDO: &str =
        include_str!("../../../../docs/core/fixtures/api/provider_capabilities_respaldo.v1.json");
    const FIXTURE_DETAIL: &str =
        include_str!("../../../../docs/core/fixtures/api/attempt_detail.v1.json");
    /// Texto que un Core con un campo de más podría colar: no debe llegar a ninguna salida.
    const LEAK: &str = "centinela-no-debe-salir";
    const NO_WAIT: Wait = Wait {
        interval: Duration::ZERO,
        polls: 5,
    };

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|s| s.to_string()).collect())
    }

    type Calls = Rc<RefCell<Vec<(String, Value)>>>;

    /// La respuesta viva del Core sobre el snapshot publicado: `sequence` da `(status, refreshing)` de cada lectura.
    fn core_with(
        calls: Calls,
        sequence: Vec<(&'static str, bool)>,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        let mut n = 0;
        move |cmd, args| {
            calls.borrow_mut().push((cmd.to_string(), args.clone()));
            match cmd {
                "provider_capabilities" => {
                    let (status, refreshing) = sequence[n.min(sequence.len() - 1)];
                    n += 1;
                    let mut data: Value = serde_json::from_str(FIXTURE).unwrap();
                    data["status"] = json!(status);
                    data["refreshing"] = json!(refreshing);
                    data["checked_at_ms"] = if status == "ready" {
                        json!(1_792_000_000_000u64)
                    } else {
                        Value::Null
                    };
                    if status == "probing" {
                        data["providers"] = json!([]);
                    }
                    Ok(data)
                }
                "attempt_detail" => match args["attempt_id"].as_str().unwrap() {
                    // El intento de la fixture publicada, cuyo proveedor es uno del registro simulado.
                    id @ ("t3-a1" | "t3-sin-sesion" | "t3-sin-proveedor") => {
                        let mut d: Value = serde_json::from_str(FIXTURE_DETAIL).unwrap();
                        d["attempt"]["id"] = json!(id);
                        d["attempt"]["provider"] = json!("fake-parcial");
                        if id == "t3-sin-sesion" {
                            d["attempt"]["provider_session"] = Value::Null;
                        }
                        if id == "t3-sin-proveedor" {
                            d["attempt"]["provider"] = Value::Null;
                        }
                        Ok(d)
                    }
                    id => Err(RpcFailure::Rejected(format!(
                        "model_not_found: no existe el Attempt {id}"
                    ))),
                },
                other => panic!("comando inesperado {other}"),
            }
        }
    }

    fn core() -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        core_with(Default::default(), vec![("ready", false)])
    }

    fn status(raw: &[&str]) -> Result<(Value, u8), Failure> {
        match parse(&args(raw))? {
            Request::Status {
                provider,
                capability,
                attempt,
                refresh,
            } => status_data(
                &mut core(),
                provider.as_deref(),
                capability.as_deref(),
                attempt.as_deref(),
                refresh,
                NO_WAIT,
            ),
            other => panic!("se esperaba status: {other:?}"),
        }
    }

    #[test]
    fn list_enseña_los_tres_proveedores_con_las_seis_capabilities() {
        let view = list_data(&mut core(), false, NO_WAIT).unwrap();
        let ids: Vec<&str> = view["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["fake-bloqueado", "fake-completo", "fake-parcial"]);
        for p in view["providers"].as_array().unwrap() {
            let keys: Vec<&String> = p["capabilities"].as_object().unwrap().keys().collect();
            let mut want: Vec<&str> = CAPABILITIES.to_vec();
            want.sort_unstable();
            assert_eq!(keys, want, "las seis capabilities siempre, sin huecos");
        }
        crate::snapshot("provider_list.v1.json", &view);
        let human = list_text(&view);
        assert!(
            human.contains("generación 3 · comprobado 2026-10-"),
            "{human}"
        );
        assert!(
            human.contains("fake-completo · CLI 0.0.0-fake · entorno listo"),
            "{human}"
        );
        assert!(
            human.contains("  steer      no soportada por el proveedor"),
            "{human}"
        );
        assert!(
            human.contains("  resume     no disponible ahora: la sesión nativa no se puede reanudar con esta versión"),
            "{human}"
        );
    }

    #[test]
    fn bloqueado_no_es_fallido_y_tiene_su_codigo() {
        let (data, code) = status(&["provider", "status", "fake-bloqueado"]).unwrap();
        assert_eq!(code, 8);
        assert_eq!(data["check"]["state"], "environment_blocked");
        assert_eq!(data["check"]["block"], "cli_missing");
        assert_eq!(data["provider"]["environment"]["state"], "blocked");
        let human = status_text(&data);
        assert!(
            human.contains("entorno bloqueado: la CLI no está en el PATH"),
            "{human}"
        );
        assert!(human.contains("No es un intento fallido."), "{human}");
        assert!(
            human.contains("  start      bloqueada por el entorno (la CLI no está en el PATH)"),
            "{human}"
        );
        assert!(
            !human.contains("falló") && !human.contains("failed"),
            "{human}"
        );
        let (data, code) = status(&[
            "provider",
            "status",
            "fake-bloqueado",
            "--capability",
            "start",
        ])
        .unwrap();
        assert_eq!(
            (code, data["check"]["scope"].as_str()),
            (8, Some("capability"))
        );
    }

    #[test]
    fn codigos_de_salida_por_capability() {
        for (provider, capability, want) in [
            ("fake-completo", None, 0),
            ("fake-completo", Some("resume"), 0),
            ("fake-parcial", None, 0),
            ("fake-parcial", Some("start"), 0),
            ("fake-parcial", Some("resume"), 7),
            ("fake-parcial", Some("steer"), 9),
            ("fake-bloqueado", Some("steer"), 8),
        ] {
            let mut raw = vec!["provider", "status", provider];
            if let Some(c) = capability {
                raw.extend(["--capability", c]);
            }
            let (_, code) = status(&raw).unwrap();
            assert_eq!(code, want, "{provider} {capability:?}");
        }
        let (data, _) = status(&[
            "provider",
            "status",
            "fake-parcial",
            "--capability",
            "resume",
        ])
        .unwrap();
        let human = status_text(&data);
        assert!(
            human.contains(
                "la capability resume no está disponible ahora (código 7): la sesión nativa"
            ),
            "{human}"
        );
        let (data, _) = status(&[
            "provider",
            "status",
            "fake-parcial",
            "--capability",
            "steer",
        ])
        .unwrap();
        assert!(status_text(&data).contains("(código 9)"));
    }

    #[test]
    fn status_snapshot_json_es_estable() {
        let (data, code) = status(&[
            "provider",
            "status",
            "fake-parcial",
            "--capability",
            "resume",
        ])
        .unwrap();
        assert_eq!(code, 7);
        crate::snapshot("provider_status.v1.json", &data);
        let (data, code) = status(&["provider", "status", "--attempt", "t3-a1"]).unwrap();
        assert_eq!(code, 0, "sin --capability mira el entorno, que está listo");
        crate::snapshot("provider_status_attempt.v1.json", &data);
    }

    #[test]
    fn el_intento_suma_hechos_de_la_sesion_y_la_capability_resume_sin_veredicto() {
        let (data, _) = status(&["provider", "status", "--attempt", "t3-a1"]).unwrap();
        assert_eq!(
            data["provider"]["id"], "fake-parcial",
            "el proveedor sale del intento"
        );
        let a = &data["attempt"];
        assert_eq!(a["attempt_id"], "t3-a1");
        assert_eq!(a["provider_session"]["resumable"], true);
        assert_eq!(a["provider_session"]["bound"], true);
        assert_eq!(a["provider_session"]["status"], "idle");
        assert_eq!(a["resume"]["state"], "unavailable");
        assert!(
            a.get("verdict").is_none() && a["provider_session"].get("ref").is_none(),
            "hechos, sin veredicto ni referencia opaca"
        );
        let human = status_text(&data);
        assert!(
            human.contains("Sesión:      ps-t3-a1 · idle · reanudable · vinculada al proveedor"),
            "{human}"
        );
        assert!(human.contains("lo decide el Core"), "{human}");
        let (data, _) = status(&[
            "provider",
            "status",
            "fake-parcial",
            "--attempt",
            "t3-sin-sesion",
        ])
        .unwrap();
        assert!(data["attempt"]["provider_session"].is_null());
        assert!(status_text(&data).contains("ninguna registrada"));
    }

    #[test]
    fn el_intento_y_el_proveedor_no_se_contradicen_ni_se_adivinan() {
        match status(&["provider", "status", "fake-completo", "--attempt", "t3-a1"]) {
            Err(Failure::Usage(m)) => assert!(
                m.contains("t3-a1 es de fake-parcial, no de fake-completo"),
                "{m}"
            ),
            other => panic!("{other:?}"),
        }
        match status(&["provider", "status", "--attempt", "t3-sin-proveedor"]) {
            Err(Failure::Usage(m)) => assert!(m.contains("no registra su proveedor"), "{m}"),
            other => panic!("{other:?}"),
        }
        match status(&["provider", "status", "--attempt", "t9-a9"]) {
            Err(Failure::NotFound(m)) => {
                assert!(m.contains("No hay ningún intento con id «t9-a9»"), "{m}")
            }
            other => panic!("{other:?}"),
        }
        let (_, code) = status(&["provider", "status", "FAKE-PARCIAL"]).unwrap();
        assert_eq!(code, 0, "el id del proveedor no distingue mayúsculas");
    }

    #[test]
    fn proveedor_inexistente_da_los_que_hay() {
        match status(&["provider", "status", "gemini"]) {
            Err(Failure::NotFound(m)) => {
                assert!(
                    m.contains("«gemini»")
                        && m.contains("fake-bloqueado, fake-completo, fake-parcial"),
                    "{m}"
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn espera_al_primer_sondeo_y_se_rinde_si_no_llega() {
        let calls: Calls = Default::default();
        let mut rpc = core_with(
            calls.clone(),
            vec![("probing", false), ("probing", false), ("ready", false)],
        );
        let view = list_data(&mut rpc, false, NO_WAIT).unwrap();
        assert_eq!(view["providers"].as_array().unwrap().len(), 3);
        assert_eq!(
            calls.borrow().len(),
            3,
            "repite la lectura hasta el primer sondeo"
        );

        let calls: Calls = Default::default();
        let mut rpc = core_with(calls.clone(), vec![("probing", false)]);
        match list_data(&mut rpc, false, NO_WAIT) {
            Err(Failure::Unavailable(m)) => assert!(m.contains("todavía está sondeando"), "{m}"),
            other => panic!("{other:?}"),
        }
        assert_eq!(
            calls.borrow().len(),
            1 + NO_WAIT.polls as usize,
            "la espera tiene tope"
        );
    }

    #[test]
    fn refresh_se_pide_una_vez_y_espera_a_que_termine() {
        let calls: Calls = Default::default();
        let mut rpc = core_with(
            calls.clone(),
            vec![("ready", true), ("ready", true), ("ready", false)],
        );
        let view = list_data(&mut rpc, true, NO_WAIT).unwrap();
        assert_eq!(view["refreshing"], false);
        let asked: Vec<Value> = calls.borrow().iter().map(|(_, a)| a.clone()).collect();
        assert_eq!(asked[0], json!({ "refresh": true }));
        assert!(
            asked[1..].iter().all(|a| a == &json!({})),
            "las lecturas de espera no repiten el refresco (el Core lo concede cada 5 s)"
        );
        assert_eq!(asked.len(), 3);

        let calls: Calls = Default::default();
        let mut rpc = core_with(calls.clone(), vec![("ready", false)]);
        list_data(&mut rpc, false, NO_WAIT).unwrap();
        assert_eq!(
            calls.borrow()[0].1,
            json!({}),
            "sin --refresh no se fuerza ningún sondeo"
        );

        // Si el sondeo no termina a tiempo, se enseña lo último que se supo y se dice que sigue en curso.
        let mut rpc = core_with(Default::default(), vec![("ready", true)]);
        let view = list_data(&mut rpc, true, NO_WAIT).unwrap();
        assert!(list_text(&view).contains("hay un sondeo en curso"));
    }

    #[test]
    fn un_core_con_otro_contrato_no_se_interpreta() {
        let broken = |edit: fn(&mut Value)| {
            let mut data: Value = serde_json::from_str(FIXTURE).unwrap();
            data["status"] = json!("ready");
            edit(&mut data);
            let mut rpc = move |_: &str, _: &Value| Ok(data.clone());
            list_data(&mut rpc, false, NO_WAIT)
        };
        for (name, edit) in [
            (
                "versión",
                (|d: &mut Value| d["version"] = json!(2)) as fn(&mut Value),
            ),
            ("sin status", |d| {
                d.as_object_mut().unwrap().remove("status");
            }),
            ("providers no es lista", |d| d["providers"] = json!("x")),
            ("falta una capability", |d| {
                d["providers"][1]["matrix"]["capabilities"]
                    .as_object_mut()
                    .unwrap()
                    .remove("resume");
            }),
            ("estado desconocido", |d| {
                d["providers"][1]["matrix"]["capabilities"]["start"]["state"] = json!("quizas");
            }),
            ("entorno desconocido", |d| {
                d["providers"][0]["environment"]["state"] = json!("raro")
            }),
            ("bloqueado sin causas", |d| {
                d["providers"][0]["environment"]
                    .as_object_mut()
                    .unwrap()
                    .remove("blocks");
            }),
            ("proveedor sin id", |d| d["providers"][2]["id"] = json!("")),
        ] {
            match broken(edit) {
                Err(Failure::Version(m)) => assert!(m.contains("actualiza Lixbon"), "{name}: {m}"),
                other => panic!("{name}: {other:?}"),
            }
        }
    }

    #[test]
    fn la_salida_es_una_allowlist_y_no_deja_pasar_campos_ajenos() {
        let mut data: Value = serde_json::from_str(FIXTURE).unwrap();
        data["status"] = json!("ready");
        data["token"] = json!(LEAK);
        data["providers"][1]["path"] = json!(LEAK);
        data["providers"][1]["environment"]["env"] = json!({ "KEY": LEAK });
        data["providers"][1]["matrix"]["capabilities"]["start"]["secret"] = json!(LEAK);
        data["providers"][1]["transport"] = json!("app_server");
        let mut rpc = move |_: &str, _: &Value| Ok(data.clone());
        let view = list_data(&mut rpc, false, NO_WAIT).unwrap();
        assert!(
            !view.to_string().contains(LEAK),
            "el JSON dejó pasar un campo ajeno"
        );
        assert!(
            !list_text(&view).contains(LEAK),
            "el texto dejó pasar un campo ajeno"
        );
        // El canal sale tal cual lo dice el Core; que sea un respaldo solo lo dice `transport_fallback`, nunca el nombre del canal.
        let human = list_text(&view);
        assert!(
            human.contains("fake-completo · CLI 0.0.0-fake · canal app_server ·"),
            "{human}"
        );
        assert!(
            !human.contains("respaldo") && !human.to_lowercase().contains("fallback"),
            "{human}"
        );
        assert!(view["providers"][1]["transport_fallback"].is_null());
    }

    #[test]
    fn el_canal_de_respaldo_se_dice_solo_si_el_core_lo_dice() {
        let respaldo: Value = serde_json::from_str(FIXTURE_RESPALDO).unwrap();
        let live = |edit: fn(&mut Value)| {
            let mut data = respaldo.clone();
            data["status"] = json!("ready");
            data["checked_at_ms"] = json!(1_792_000_000_000u64);
            edit(&mut data);
            let mut rpc = move |_: &str, _: &Value| Ok(data.clone());
            list_data(&mut rpc, false, NO_WAIT)
        };
        let view = live(|_| {}).unwrap();
        // El principal no lleva respaldo; el que cayó a él, sí, con su motivo.
        assert!(view["providers"][0]["transport_fallback"].is_null());
        assert_eq!(
            view["providers"][1]["transport_fallback"],
            json!({ "reason": "esta versión de Codex no incluye app-server" })
        );
        crate::snapshot("provider_list_respaldo.v1.json", &view);
        let human = list_text(&view);
        assert!(
            human.contains(
                "fake-principal · CLI 2.0.0 · canal app_server · entorno listo
"
            ),
            "{human}"
        );
        assert!(
            human.contains(
                "fake-respaldo · CLI 0.166.0 · canal exec_json (respaldo) · entorno listo"
            ),
            "{human}"
        );
        assert!(
            human.contains("  Canal de respaldo: esta versión de Codex no incluye app-server."),
            "{human}"
        );
        assert_eq!(human.matches("Canal de respaldo").count(), 1, "{human}");
        // El nombre del canal no basta: `exec_json` sin `transport_fallback` no se dice respaldo.
        let sin = live(|d| {
            d["providers"][1]
                .as_object_mut()
                .unwrap()
                .remove("transport_fallback");
        })
        .unwrap();
        let human = list_text(&sin);
        assert!(
            !human.contains("(respaldo)")
                && !human.contains("Canal de respaldo")
                && human.contains("canal exec_json"),
            "{human}"
        );
        // Un respaldo sin motivo, con el motivo vacío o sin canal no cumple el contrato.
        for edit in [
            (|d: &mut Value| d["providers"][1]["transport_fallback"] = json!({})) as fn(&mut Value),
            |d| d["providers"][1]["transport_fallback"] = json!({ "reason": "" }),
            |d| d["providers"][1]["transport_fallback"] = json!("respaldo"),
            |d| {
                d["providers"][1]
                    .as_object_mut()
                    .unwrap()
                    .remove("transport");
            },
        ] {
            assert!(matches!(live(edit), Err(Failure::Version(_))));
        }
    }

    #[test]
    fn el_texto_no_lleva_caracteres_de_control() {
        let mut data: Value = serde_json::from_str(FIXTURE).unwrap();
        data["status"] = json!("ready");
        data["providers"][2]["matrix"]["capabilities"]["resume"]["reason"] =
            json!("rojo\u{1b}[31m\nlínea 2");
        data["providers"][1]["cli_version"] = json!("1.0\u{7}");
        let mut rpc = move |_: &str, _: &Value| Ok(data.clone());
        let view = list_data(&mut rpc, false, NO_WAIT).unwrap();
        let human = list_text(&view);
        assert!(
            !human.chars().any(|c| c.is_control() && c != '\n'),
            "caracter de control en el texto"
        );
        assert!(human.contains("rojo?[31m?línea 2"), "{human}");
    }

    #[test]
    fn los_errores_del_core_se_traducen_a_codigos() {
        let fails = |m: &str| {
            let m = m.to_string();
            let mut rpc = move |_: &str, _: &Value| Err(RpcFailure::Rejected(m.clone()));
            list_data(&mut rpc, false, NO_WAIT).unwrap_err()
        };
        assert!(
            matches!(fails("provider_capabilities_auth_required: x"), Failure::Auth(m) if m.contains("solo para personas"))
        );
        assert!(
            matches!(fails("provider_capabilities_invalid_request: parámetro desconocido: x"), Failure::Version(m) if m.contains("actualiza Lixbon"))
        );
        assert!(matches!(
            fails("Comando desconocido: provider_capabilities"),
            Failure::Version(_)
        ));
        assert!(matches!(fails("algo raro"), Failure::Internal(_)));
        assert_eq!(fails("provider_capabilities_auth_required: x").code().1, 3);
    }

    #[test]
    fn uso_invalido_se_rechaza_antes_de_llamar_al_core() {
        for (raw, wanted) in [
            (&["provider"][..], "Uso: lxo provider list"),
            (
                &["provider", "lista"][..],
                "no es una orden de lxo provider",
            ),
            (&["provider", "list", "claude"][..], "no admite argumentos"),
            (
                &["provider", "list", "--capability", "start"][..],
                "no es una opción de lxo provider list",
            ),
            (&["provider", "status"][..], "Falta el proveedor"),
            (&["provider", "status", "a", "b"][..], "un solo proveedor"),
            (
                &["provider", "status", "claude", "--capability", "volar"][..],
                "--capability no reconoce",
            ),
            (
                &["provider", "status", "claude", "--capability"][..],
                "--capability requiere un valor",
            ),
            (
                &["provider", "status", "claude", "--attempt"][..],
                "--attempt requiere un valor",
            ),
            (
                &["provider", "status", "claude", "--json=si"][..],
                "no admite un valor",
            ),
            (
                &["provider", "status", "claude", "--refresh=1"][..],
                "no admite un valor",
            ),
            (
                &["provider", "status", "claude", "--task", "t1"][..],
                "--task no es una opción",
            ),
            (
                &["provider", "status", "claude", "--refresh", "--refresh"][..],
                "aparece más de una vez",
            ),
        ] {
            match parse(&args(raw)) {
                Err(Failure::Usage(m)) => assert!(m.contains(wanted), "{raw:?}: {m}"),
                other => panic!("{raw:?}: {other:?}"),
            }
        }
        assert_eq!(parse(&args(&["provider", "help"])).unwrap(), Request::Help);
        assert_eq!(
            parse(&args(&["provider", "--help"])).unwrap(),
            Request::Help
        );
        assert_eq!(
            parse(&args(&["provider", "list", "--refresh"])).unwrap(),
            Request::List { refresh: true }
        );
    }

    #[test]
    fn la_ayuda_enseña_los_codigos_y_el_resumen_la_lista() {
        for code in [
            "unavailable            7",
            "environment_blocked    8",
            "unsupported            9",
        ] {
            assert!(HELP.contains(code), "{code}");
        }
        assert!(crate::HELP.contains("lxo provider list"));
        assert!(crate::HELP.contains("lxo provider status"));
    }
}
