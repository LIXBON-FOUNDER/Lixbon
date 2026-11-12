//! `lxo usage`: el uso y los límites de cada proveedor según el Core, de solo lectura (LXO-207).
//!
//! La fuente es `usage_report` del Core por el RPC autenticado, como Person (`docs/core/QUERIES.md` § `usage_report`):
//! lxo no consulta a ningún proveedor, no estima nada y no suma magnitudes de proveedores distintos. Lo que el Core no sabe
//! sale como «sin dato» (`null` en el `--json`): **desconocido no es cero**. Un proveedor con la consulta fallida, sin dato o
//! con el entorno bloqueado es parte de la respuesta, no un error del comando (y nunca de un Attempt).
//!
//! No es el `lixbon usage` del CLI de Go (el uso de la cuenta Lixbon del gateway): ese comando no cambia; este es otro
//! binario sobre otra fuente (ver `docs/core/LXO_CORTE.md`).

use std::process::ExitCode;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::client_auth::{self, RpcFailure};
use crate::events::{clean, timestamp_utc};
use crate::projects::{failure, finish, usage as usage_error, Failure};
use crate::Args;

pub(super) const HELP: &str =
    "Uso: lxo usage [--provider P] [--model M] [--account A] [--refresh] [--json]

El uso y los límites de la cuenta de cada proveedor según el Core: ventanas de cuota,
plan, créditos y coste cuando el proveedor los informa. Solo lee: lxo no pregunta a
ningún proveedor, no estima nada y no suma tokens de unos con porcentajes de otros.
Desconocido no es cero: lo que el proveedor no da sale como «sin dato».

Cada proveedor trae su estado:
  al día             dato reciente (con su procedencia: consulta al proveedor u
                     observación de una ejecución)
  desactualizado     la última actualización falló o es vieja: se conserva el último
                     dato y se dice por qué (sesión caducada, límite de peticiones…)
  sin dato           todavía no se sabe nada (no es cero)
  sin soporte        el proveedor no informa uso
  entorno bloqueado  el entorno lo impide; no es un intento fallido
Un fallo de uso no cambia el estado de ningún proveedor ni intento.

Filtros (se combinan con AND):
  --provider P       un proveedor (id, sin distinguir mayúsculas); inexistente sale con 6
  --model M          solo el uso de ese modelo. Los proveedores que no informan uso por
                     modelo no entran y se nombran aparte: no se sabe si lo usan
  --account A        solo la cuenta con esa huella de 8 hex (la que enseña lxo). Los
                     proveedores sin cuenta conocida no entran y se nombran aparte
  --refresh          pide una consulta manual y espera a que termine (el Core la concede
                     como mucho una vez cada 5 s por proveedor; si se pide antes, se
                     atiende con el dato guardado y se dice)

Salida:
  (por defecto)      texto para personas
  --json             {v, status, refreshing, generated_at_ms, filters, providers, excluded}
                     versionado y sin credenciales ni identificador de cuenta (solo su
                     huella de 8 hex). Lo que el Core no da sale como null

Es para personas: la cuota es de su cuenta. Una tarea del orquestador (agente) no puede leerla.
`lixbon usage` (el CLI de Go, uso de la cuenta Lixbon del gateway) no cambia: es otro comando.

Códigos de salida: 0 correcto (aunque algún proveedor esté sin dato o desactualizado: va en
la salida), 1 error interno del Core, 2 uso inválido, 3 autenticación, 4 versión o contrato
incompatible, 5 Lixbon cerrado o Core sin informe todavía, 6 proveedor inexistente.
";

const CONTRACT: u64 = 1;
/// Versión de `usage_report` que entiende lxo.
const API: u64 = 1;
const STATUSES: [&str; 5] = [
    "fresh",
    "stale",
    "unknown",
    "unsupported",
    "environment_blocked",
];
/// Los campos de `UsageSupport` (`docs/core/ADAPTERS.md` § Usage), en el orden en que se enseñan.
const FIELDS: [&str; 5] = ["windows", "tokens", "credits", "plan", "cost"];
const SUPPORT_STATES: [&str; 4] = [
    "available",
    "unsupported",
    "unavailable",
    "environment_blocked",
];
const TEXT_MAX: usize = 300;
const FLAGS: [&str; 6] = ["provider", "model", "account", "refresh", "json", "help"];

type Rpc<'a> = &'a mut dyn FnMut(&str, &Value) -> Result<Value, RpcFailure>;

/// Cuánto se espera: la query nunca consulta (devuelve al instante el último informe), así que lxo repite la lectura.
/// Una consulta de Claude tarda hasta 30 s.
#[derive(Clone, Copy)]
struct Wait {
    interval: Duration,
    loading_polls: u32,
    refresh_polls: u32,
}

const PRODUCTION_WAIT: Wait = Wait {
    interval: Duration::from_millis(500),
    loading_polls: 120,
    refresh_polls: 120,
};

#[derive(Debug, Default, PartialEq, Eq)]
struct Filters {
    provider: Option<String>,
    model: Option<String>,
    account: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Help,
    Report { filters: Filters, refresh: bool },
}

fn parse(a: &Args) -> Result<Request, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    if let Some(extra) = a.at(1) {
        return Err(usage_error(format!(
            "lxo usage no admite argumentos sueltos ({}); filtra con --provider, --model o --account.",
            clean(&extra)
        )));
    }
    if let Some(name) = a.flags.keys().find(|k| !FLAGS.contains(&k.as_str())) {
        return Err(usage_error(format!(
            "--{name} no es una opción de lxo usage. Mira `lxo usage --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage_error(format!("--{name} aparece más de una vez.")));
    }
    for name in ["json", "help", "refresh"] {
        if a.flags.get(name).is_some_and(|v| !v.is_boolean()) {
            return Err(usage_error(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }
    let text = |name: &str| -> Result<Option<String>, Failure> {
        match a.flags.get(name) {
            None => Ok(None),
            Some(Value::String(v)) if !v.trim().is_empty() => Ok(Some(v.trim().to_string())),
            _ => Err(usage_error(format!("--{name} requiere un valor."))),
        }
    };
    let account = text("account")?.map(|v| v.to_lowercase());
    if let Some(acc) = &account {
        if acc.len() != 8 || !acc.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(usage_error(format!(
                "--account espera la huella de 8 hex que enseña lxo usage, no «{}».",
                clean(acc)
            )));
        }
    }
    Ok(Request::Report {
        filters: Filters {
            provider: text("provider")?,
            model: text("model")?,
            account,
        },
        refresh: a.b("refresh"),
    })
}

fn contract_error() -> Failure {
    Failure::Version(
        "El Core devolvió el uso con un formato que este lxo no entiende; actualiza Lixbon.".into(),
    )
}

fn usage_failure(error: RpcFailure) -> Failure {
    if let RpcFailure::Rejected(m) = &error {
        if m.starts_with("usage_report_auth_required") {
            return Failure::Auth(
                "El uso de los proveedores es solo para personas: la cuota es de su cuenta y una tarea del orquestador (agente) no puede leerla."
                    .into(),
            );
        }
        // lxo arma la petición: si el Core la rechaza, es que no hablan el mismo contrato.
        if let Some(detail) = m.strip_prefix("usage_report_invalid_request: ") {
            return Failure::Version(format!(
                "El Core rechazó la consulta de uso ({}); actualiza Lixbon.",
                clean(detail)
            ));
        }
        if m.starts_with("Comando desconocido") {
            return Failure::Version(
                "Este Core no ofrece el uso de los proveedores; actualiza Lixbon.".into(),
            );
        }
    }
    failure(error)
}

fn text(value: &Value) -> Value {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.chars().take(TEXT_MAX).collect()))
        .unwrap_or(Value::Null)
}

/// Un número del Core o `null`: lo imposible se descarta, no se corrige (misma regla que el Core).
fn number(value: &Value, min: f64, max: f64) -> Value {
    match value.as_f64() {
        Some(n) if n.is_finite() && n >= min && n <= max => value.clone(),
        _ => Value::Null,
    }
}

fn count(value: &Value) -> Value {
    value.as_u64().map(Value::from).unwrap_or(Value::Null)
}

fn window(w: &Value) -> Value {
    json!({
        "id": text(&w["id"]),
        "minutes": count(&w["minutes"]),
        "used_percent": number(&w["used_percent"], 0.0, 100.0),
        "resets_at": count(&w["resets_at"]),
    })
}

fn model(m: &Value) -> Value {
    json!({
        "model": text(&m["model"]),
        "input_tokens": count(&m["input_tokens"]),
        "output_tokens": count(&m["output_tokens"]),
        "cost_usd": number(&m["cost_usd"], 0.0, f64::MAX),
    })
}

/// El dato de un proveedor tal como lo emite lxo, o `None` si el Core no dio ninguno.
fn snapshot_view(s: &Value) -> Option<Value> {
    if !s.is_object() {
        return None;
    }
    Some(json!({
        "account": text(&s["account"]),
        "observed_at_ms": count(&s["observed_at_ms"]),
        "provenance": text(&s["provenance"]),
        "plan": text(&s["plan"]),
        "limit_reached": s["limit_reached"].as_bool(),
        "windows": s["windows"].as_array().into_iter().flatten().map(window).collect::<Vec<_>>(),
        "credits": if s["credits"].is_object() { json!({
            "balance": text(&s["credits"]["balance"]),
            "has_credits": s["credits"]["has_credits"].as_bool(),
            "unlimited": s["credits"]["unlimited"].as_bool(),
        }) } else { Value::Null },
        "models": s["models"].as_array().into_iter().flatten().map(model).collect::<Vec<_>>(),
    }))
}

/// Un proveedor del informe a la forma de lxo, o `None` si no cumple el contrato (no se adivina nada).
fn provider_view(p: &Value) -> Option<Value> {
    let id = p["provider"].as_str().filter(|s| !s.is_empty())?;
    let status = p["status"].as_str().filter(|s| STATUSES.contains(s))?;
    let fields = p["support"]["fields"].as_object()?;
    let mut support = Map::new();
    for name in FIELDS {
        let f = fields.get(name)?;
        let state = f["state"].as_str().filter(|s| SUPPORT_STATES.contains(s))?;
        let mut out = Map::new();
        out.insert("state".into(), json!(state));
        if state == "unavailable" {
            out.insert("reason".into(), text(&f["reason"]));
        }
        support.insert(name.into(), Value::Object(out));
    }
    Some(json!({
        "provider": id,
        "status": status,
        "support": support,
        "age_ms": count(&p["age_ms"]),
        "throttled": p["throttled"].as_bool().unwrap_or(false),
        "error": if p["error"].is_object() { json!({
            "kind": text(&p["error"]["kind"]),
            "message": text(&p["error"]["message"]),
        }) } else { Value::Null },
        "snapshot": snapshot_view(&p["snapshot"]).unwrap_or(Value::Null),
    }))
}

/// La respuesta del Core validada y proyectada. `report` es `null` mientras carga: no se inventa nada.
fn project(data: &Value) -> Result<Value, Failure> {
    if data["v"].as_u64() != Some(API) {
        return Err(contract_error());
    }
    let status = match data["status"].as_str() {
        Some(s @ ("loading" | "ready")) => s,
        _ => return Err(contract_error()),
    };
    let (generated, providers) = if status == "ready" {
        let r = &data["report"];
        let providers = r["providers"]
            .as_array()
            .ok_or_else(contract_error)?
            .iter()
            .map(|p| provider_view(p).ok_or_else(contract_error))
            .collect::<Result<Vec<_>, _>>()?;
        (count(&r["generated_at_ms"]), providers)
    } else {
        (Value::Null, vec![])
    };
    Ok(json!({
        "status": status,
        "refreshing": data["refreshing"].as_bool().unwrap_or(false),
        "generated_at_ms": generated,
        "providers": providers,
    }))
}

/// Lee el informe esperando al primero y, con `refresh`, a que termine la consulta pedida. El refresco se pide UNA vez: las
/// lecturas de espera no lo repiten (el Core lo concede como mucho cada 5 s por proveedor).
fn read(rpc: Rpc, refresh: bool, wait: Wait) -> Result<Value, Failure> {
    let args = if refresh {
        json!({ "refresh": true })
    } else {
        json!({})
    };
    let mut view = project(&rpc("usage_report", &args).map_err(usage_failure)?)?;
    let mut polls = 0;
    loop {
        let limit = if refresh {
            wait.refresh_polls
        } else {
            wait.loading_polls
        };
        let waiting = view["status"] == "loading" || (refresh && view["refreshing"] == true);
        if !waiting || polls >= limit {
            break;
        }
        std::thread::sleep(wait.interval);
        polls += 1;
        view = project(&rpc("usage_report", &json!({})).map_err(usage_failure)?)?;
    }
    if view["status"] == "loading" {
        return Err(Failure::Unavailable(
            "El Core todavía no tiene un informe de uso (está sondeando a los proveedores); repite el comando en unos segundos."
                .into(),
        ));
    }
    Ok(view)
}

fn known(view: &Value) -> Vec<String> {
    view["providers"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p["provider"].as_str().map(clean))
        .collect()
}

/// Aplica los filtros. Un proveedor sin el dato por el que se filtra (modelo o cuenta) NO se descarta en silencio ni se da por
/// no coincidente: no se sabe, así que se nombra aparte en `excluded`.
fn apply(view: Value, filters: &Filters) -> Result<Value, Failure> {
    let mut providers: Vec<Value> = view["providers"].as_array().cloned().unwrap_or_default();
    if let Some(wanted) = &filters.provider {
        providers.retain(|p| {
            p["provider"]
                .as_str()
                .is_some_and(|id| id.eq_ignore_ascii_case(wanted))
        });
        if providers.is_empty() {
            let known = known(&view);
            return Err(Failure::NotFound(if known.is_empty() {
                format!(
                    "No hay ningún proveedor con id «{}»: el Core no tiene ninguno registrado.",
                    clean(wanted)
                )
            } else {
                format!(
                    "No hay ningún proveedor con id «{}». El Core conoce: {}.",
                    clean(wanted),
                    known.join(", ")
                )
            }));
        }
    }
    let mut model_unknown = vec![];
    if let Some(wanted) = &filters.model {
        providers = providers
            .into_iter()
            .filter_map(|mut p| {
                let id = p["provider"].as_str().unwrap_or("").to_string();
                let reported = p["support"]["tokens"]["state"] == "available"
                    && p["snapshot"]["models"]
                        .as_array()
                        .is_some_and(|m| !m.is_empty());
                if !reported {
                    model_unknown.push(id);
                    return None;
                }
                let models: Vec<Value> = p["snapshot"]["models"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|m| {
                        m["model"]
                            .as_str()
                            .is_some_and(|x| x.eq_ignore_ascii_case(wanted))
                    })
                    .cloned()
                    .collect();
                if models.is_empty() {
                    return None;
                }
                p["snapshot"]["models"] = Value::Array(models);
                Some(p)
            })
            .collect();
    }
    let mut account_unknown = vec![];
    if let Some(wanted) = &filters.account {
        providers.retain(|p| match p["snapshot"]["account"].as_str() {
            Some(acc) => acc == wanted,
            None => {
                account_unknown.push(p["provider"].as_str().unwrap_or("").to_string());
                false
            }
        });
    }
    Ok(json!({
        "v": CONTRACT,
        "status": view["status"],
        "refreshing": view["refreshing"],
        "generated_at_ms": view["generated_at_ms"],
        "filters": { "provider": filters.provider, "model": filters.model, "account": filters.account },
        "providers": providers,
        "excluded": { "model_unknown": model_unknown, "account_unknown": account_unknown },
    }))
}

fn report_data(rpc: Rpc, filters: &Filters, refresh: bool, wait: Wait) -> Result<Value, Failure> {
    apply(read(rpc, refresh, wait)?, filters)
}

fn utc(ms: i64) -> String {
    format!("{} UTC", timestamp_utc(ms)[..19].replace('T', " "))
}

fn age_text(ms: &Value) -> Option<String> {
    let ms = ms.as_u64()?;
    Some(match ms {
        0..=59_999 => format!("hace {} s", ms / 1000),
        60_000..=3_599_999 => format!("hace {} min", ms / 60_000),
        _ => format!("hace {} h", ms / 3_600_000),
    })
}

fn status_text(p: &Value) -> String {
    match p["status"].as_str() {
        Some("fresh") => "al día".into(),
        Some("stale") => "desactualizado (se conserva el último dato)".into(),
        Some("unknown") => "sin dato".into(),
        Some("unsupported") => "sin soporte de uso".into(),
        Some("environment_blocked") => "entorno bloqueado (no es un intento fallido)".into(),
        _ => "estado desconocido".into(),
    }
}

fn provenance_text(code: &str) -> String {
    match code {
        "provider_query" => "consulta al proveedor".into(),
        "run_observation" => "observado en una ejecución".into(),
        other => clean(other),
    }
}

fn error_text(e: &Value) -> String {
    let kind = e["kind"].as_str().unwrap_or("");
    let what = match kind {
        "auth_required" => "el proveedor pide iniciar sesión",
        "rate_limited" => "el proveedor limitó las peticiones",
        "provider_unavailable" => "el proveedor no respondió",
        "unsupported" => "el proveedor no informa uso",
        "environment_blocked" => "el entorno lo impide",
        "internal" => "error interno del Core",
        other => return format!("{} ({})", clean(other), "causa no reconocida"),
    };
    match e["message"].as_str().filter(|m| !m.is_empty()) {
        Some(m) => format!("{} ({kind}): {}", what, clean(m)),
        None => format!("{what} ({kind})"),
    }
}

/// Texto de un campo: lo que no informa el proveedor y lo que no llegó son cosas distintas.
fn absent(p: &Value, field: &str) -> String {
    match p["support"][field]["state"].as_str() {
        Some("unsupported") => "no lo informa el proveedor".into(),
        Some("unavailable") => format!(
            "no disponible ahora: {}",
            p["support"][field]["reason"]
                .as_str()
                .map(clean)
                .unwrap_or_else(|| "el Core no da el motivo".into())
        ),
        Some("environment_blocked") => "bloqueado por el entorno".into(),
        _ => "sin dato".into(),
    }
}

fn num(v: &Value) -> String {
    match v {
        Value::Null => "sin dato".into(),
        Value::Number(n) => n.to_string(),
        _ => "sin dato".into(),
    }
}

fn window_line(w: &Value) -> String {
    let mut parts = vec![match w["used_percent"].as_f64() {
        Some(p) => format!("{p:.0} % usado"),
        None => "uso sin dato".into(),
    }];
    if let Some(m) = w["minutes"].as_u64() {
        parts.push(format!("ventana de {m} min"));
    }
    parts.push(match w["resets_at"].as_u64() {
        Some(s) => format!("se reinicia {}", utc(s as i64 * 1000)),
        None => "reinicio sin dato".into(),
    });
    format!(
        "    {:<10} {}",
        w["id"].as_str().map(clean).unwrap_or_else(|| "?".into()),
        parts.join(" · ")
    )
}

fn provider_lines(p: &Value) -> Vec<String> {
    let mut head = vec![
        p["provider"].as_str().map(clean).unwrap_or_default(),
        status_text(p),
    ];
    if let Some(age) = age_text(&p["age_ms"]) {
        head.push(age);
    }
    let s = &p["snapshot"];
    if let Some(prov) = s["provenance"].as_str() {
        head.push(provenance_text(prov));
    }
    if let Some(acc) = s["account"].as_str() {
        head.push(format!("cuenta {}", clean(acc)));
    }
    if let Some(plan) = s["plan"].as_str() {
        head.push(format!("plan {}", clean(plan)));
    }
    let mut lines = vec![head.join(" · ")];
    if p["throttled"] == true {
        lines.push(
            "  Refresco atendido con el dato guardado: el Core lo concede una vez cada 5 s.".into(),
        );
    }
    if p["error"].is_object() {
        lines.push(format!(
            "  Fallo de la última actualización: {}",
            error_text(&p["error"])
        ));
    }
    if p["status"] == "unsupported" {
        return lines;
    }
    if !s.is_object() {
        if p["status"] != "unknown" || !p["error"].is_object() {
            lines.push("  Sin dato todavía: no es cero.".into());
        }
        return lines;
    }
    let windows = s["windows"].as_array().cloned().unwrap_or_default();
    if windows.is_empty() {
        lines.push(format!("  Ventanas     {}", absent(p, "windows")));
    } else {
        lines.push("  Ventanas".into());
        lines.extend(windows.iter().map(window_line));
    }
    if let Some(false) = s["limit_reached"].as_bool() {
        lines.push("  Límite       no alcanzado".into());
    } else if let Some(true) = s["limit_reached"].as_bool() {
        lines.push("  Límite       ALCANZADO".into());
    }
    let models = s["models"].as_array().cloned().unwrap_or_default();
    if models.is_empty() {
        lines.push(format!("  Tokens       {}", absent(p, "tokens")));
    } else {
        for (i, m) in models.iter().enumerate() {
            lines.push(format!(
                "  {}{} · entrada {} · salida {}{}",
                if i == 0 {
                    "Tokens       "
                } else {
                    "             "
                },
                m["model"]
                    .as_str()
                    .map(clean)
                    .unwrap_or_else(|| "modelo sin nombre".into()),
                num(&m["input_tokens"]),
                num(&m["output_tokens"]),
                m["cost_usd"]
                    .as_f64()
                    .map(|c| format!(" · coste {c:.2} USD"))
                    .unwrap_or_default()
            ));
        }
        if models.iter().all(|m| m["cost_usd"].is_null()) {
            lines.push(format!("  Coste        {}", absent(p, "cost")));
        }
    }
    let c = &s["credits"];
    lines.push(if c.is_object() {
        let unlimited = match c["unlimited"].as_bool() {
            Some(true) => " · ilimitados",
            _ => "",
        };
        let has = match c["has_credits"].as_bool() {
            Some(true) => " · con créditos",
            Some(false) => " · sin créditos",
            None => "",
        };
        format!(
            "  Créditos     saldo {}{has}{unlimited}",
            c["balance"]
                .as_str()
                .map(clean)
                .unwrap_or_else(|| "sin dato".into())
        )
    } else {
        format!("  Créditos     {}", absent(p, "credits"))
    });
    if s["plan"].is_null() {
        lines.push(format!("  Plan         {}", absent(p, "plan")));
    }
    lines
}

fn report_text(data: &Value) -> String {
    let providers = data["providers"].as_array().cloned().unwrap_or_default();
    let mut lines = vec![format!(
        "Uso de los proveedores · informe {}{}",
        data["generated_at_ms"]
            .as_u64()
            .map(|ms| utc(ms as i64))
            .unwrap_or_else(|| "sin fecha".into()),
        if data["refreshing"] == true {
            " · hay una consulta en curso"
        } else {
            ""
        }
    )];
    if providers.is_empty() {
        lines.push(String::new());
        lines.push(
            if data["filters"]["provider"].is_null()
                && data["filters"]["model"].is_null()
                && data["filters"]["account"].is_null()
            {
                "Ningún proveedor registrado.".to_string()
            } else {
                "Ningún proveedor cumple estos filtros.".to_string()
            },
        );
    }
    for p in &providers {
        lines.push(String::new());
        lines.extend(provider_lines(p));
    }
    for (key, why) in [
        (
            "model_unknown",
            "no informan uso por modelo, así que no entran en --model",
        ),
        (
            "account_unknown",
            "no tienen una cuenta conocida, así que no entran en --account",
        ),
    ] {
        let ids: Vec<String> = data["excluded"][key]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(clean))
            .collect();
        if !ids.is_empty() {
            lines.push(String::new());
            lines.push(format!(
                "Sin filtrar (se desconoce): {} {why}.",
                ids.join(", ")
            ));
        }
    }
    lines.push(String::new());
    lines.push("Sin totales: tokens y porcentajes de proveedores distintos no se suman.".into());
    lines.join("\n")
}

fn execute(request: Request, json: bool, wait: Wait) -> Result<(), Failure> {
    let mut rpc = |cmd: &str, args: &Value| client_auth::rpc(cmd, args, &crate::cwd());
    match request {
        Request::Help => print!("{HELP}"),
        Request::Report { filters, refresh } => {
            let data = report_data(&mut rpc, &filters, refresh, wait)?;
            if json {
                println!("{data}");
            } else {
                println!("{}", report_text(&data));
            }
        }
    }
    Ok(())
}

pub(super) fn run(a: &Args) -> ExitCode {
    let json = a.b("json");
    finish(
        parse(a).and_then(|request| execute(request, json, PRODUCTION_WAIT)),
        json,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    const FIXTURE: &str = include_str!("../../../../docs/core/fixtures/api/usage_report.v1.json");
    /// Texto que un Core con un campo de más podría colar: no debe llegar a ninguna salida.
    const LEAK: &str = "centinela-no-debe-salir";
    const NO_WAIT: Wait = Wait {
        interval: Duration::ZERO,
        loading_polls: 3,
        refresh_polls: 5,
    };

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|s| s.to_string()).collect())
    }

    type Calls = Rc<RefCell<Vec<Value>>>;

    /// El informe publicado dentro de la lectura viva: `sequence` da `(status, refreshing)` de cada lectura.
    fn core_with(
        calls: Calls,
        sequence: Vec<(&'static str, bool)>,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        let mut n = 0;
        move |cmd, a| {
            assert_eq!(cmd, "usage_report");
            calls.borrow_mut().push(a.clone());
            let (status, refreshing) = sequence[n.min(sequence.len() - 1)];
            n += 1;
            Ok(json!({
                "v": 1, "status": status, "refreshing": refreshing,
                "report": if status == "ready" { serde_json::from_str(FIXTURE).unwrap() } else { Value::Null },
            }))
        }
    }

    fn core() -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        core_with(Default::default(), vec![("ready", false)])
    }

    fn report(raw: &[&str]) -> Result<Value, Failure> {
        match parse(&args(raw))? {
            Request::Report { filters, refresh } => {
                report_data(&mut core(), &filters, refresh, NO_WAIT)
            }
            other => panic!("se esperaba el informe: {other:?}"),
        }
    }

    fn ids(data: &Value) -> Vec<&str> {
        data["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["provider"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn proveedores_completo_parcial_sin_dato_y_sin_soporte() {
        let data = report(&["usage"]).unwrap();
        assert_eq!(ids(&data), ["codex", "claude", "otro", "minimo"]);
        let by = |id: &str| {
            data["providers"]
                .as_array()
                .unwrap()
                .iter()
                .find(|p| p["provider"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(by("codex")["status"], "fresh");
        assert_eq!(
            by("codex")["snapshot"]["windows"].as_array().unwrap().len(),
            2
        );
        assert_eq!(by("claude")["snapshot"]["provenance"], "run_observation");
        assert_eq!(by("otro")["status"], "unknown");
        assert!(
            by("otro")["snapshot"].is_null(),
            "sin dato no inventa un snapshot"
        );
        assert_eq!(by("minimo")["status"], "unsupported");
        crate::snapshot("usage.v1.json", &data);
    }

    #[test]
    fn desconocido_no_es_cero() {
        let data = report(&["usage"]).unwrap();
        let claude = &data["providers"][1];
        let w = &claude["snapshot"]["windows"][0];
        assert!(
            w["used_percent"].is_null() && w["minutes"].is_null(),
            "lo que el Core no dio es null, nunca 0"
        );
        assert!(claude["snapshot"]["models"].as_array().unwrap().is_empty());
        assert!(claude["snapshot"]["credits"].is_null());
        assert!(claude["snapshot"]["plan"].is_null());
        let human = report_text(&data);
        assert!(
            human.contains("five_hour  uso sin dato · se reinicia"),
            "{human}"
        );
        assert!(!human.contains("0 % usado"), "{human}");
        // Lo que el proveedor no informa y lo que no llegó se dicen distinto.
        assert!(
            human.contains("Tokens       no lo informa el proveedor"),
            "{human}"
        );
        assert!(
            human.contains("Créditos     no lo informa el proveedor"),
            "{human}"
        );
        assert!(human.contains("otro · sin dato"), "{human}");
        assert!(
            human.contains("Fallo de la última actualización: el proveedor pide iniciar sesión (auth_required)"),
            "{human}"
        );
        assert!(human.contains("minimo · sin soporte de uso"), "{human}");
    }

    #[test]
    fn el_texto_enseña_ventanas_creditos_modelos_y_no_suma_nada() {
        let human = report_text(&report(&["usage"]).unwrap());
        assert!(
            human.starts_with("Uso de los proveedores · informe 2027-01-"),
            "{human}"
        );
        assert!(
            human.contains(
                "codex · al día · hace 0 s · consulta al proveedor · cuenta e7cbf1f7 · plan plus"
            ),
            "{human}"
        );
        assert!(
            human.contains("primary    12 % usado · ventana de 300 min · se reinicia 2027-01-"),
            "{human}"
        );
        assert!(human.contains("Límite       no alcanzado"), "{human}");
        assert!(
            human.contains("Tokens       m1 · entrada 10 · salida 20 · coste 0.50 USD"),
            "{human}"
        );
        assert!(
            human.contains("Créditos     saldo 42 · con créditos"),
            "{human}"
        );
        assert!(
            human.contains("claude · al día · hace 2 min · observado en una ejecución"),
            "{human}"
        );
        assert!(human.contains("Sin totales"), "{human}");
    }

    #[test]
    fn filtro_de_proveedor_modelo_y_cuenta() {
        assert_eq!(
            ids(&report(&["usage", "--provider", "CLAUDE"]).unwrap()),
            ["claude"]
        );
        let by_model = report(&["usage", "--model", "m1"]).unwrap();
        assert_eq!(ids(&by_model), ["codex"]);
        assert_eq!(
            by_model["excluded"]["model_unknown"],
            json!(["claude", "otro", "minimo"]),
            "los que no informan modelos no se descartan en silencio"
        );
        assert!(report_text(&by_model).contains(
            "Sin filtrar (se desconoce): claude, otro, minimo no informan uso por modelo"
        ));
        let by_account = report(&["usage", "--account", "E7CBF1F7"]).unwrap();
        assert_eq!(
            ids(&by_account),
            ["codex"],
            "la huella no distingue mayúsculas"
        );
        assert_eq!(
            by_account["excluded"]["account_unknown"],
            json!(["claude", "otro", "minimo"])
        );
        let all = report(&[
            "usage",
            "--provider",
            "codex",
            "--model",
            "m1",
            "--account",
            "e7cbf1f7",
        ])
        .unwrap();
        assert_eq!(ids(&all), ["codex"]);
        assert_eq!(
            all["filters"],
            json!({ "provider": "codex", "model": "m1", "account": "e7cbf1f7" })
        );
        let none = report(&["usage", "--model", "no-existe"]).unwrap();
        assert!(ids(&none).is_empty());
        assert!(report_text(&none).contains("Ningún proveedor cumple estos filtros."));
        let none = report(&["usage", "--account", "00000000"]).unwrap();
        assert!(ids(&none).is_empty());
    }

    #[test]
    fn el_filtro_de_modelo_deja_solo_ese_modelo() {
        let mut data: Value = serde_json::from_str(FIXTURE).unwrap();
        data["providers"][0]["snapshot"]["models"] = json!([
            { "model": "m1", "input_tokens": 10, "output_tokens": 20 },
            { "model": "m2", "input_tokens": 1, "output_tokens": 2 }
        ]);
        let mut rpc = move |_: &str, _: &Value| {
            Ok(json!({ "v": 1, "status": "ready", "refreshing": false, "report": data.clone() }))
        };
        let f = Filters {
            model: Some("M2".into()),
            ..Default::default()
        };
        let out = report_data(&mut rpc, &f, false, NO_WAIT).unwrap();
        let models = out["providers"][0]["snapshot"]["models"]
            .as_array()
            .unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["model"], "m2");
    }

    #[test]
    fn proveedor_inexistente_da_los_que_hay() {
        match report(&["usage", "--provider", "gemini"]) {
            Err(Failure::NotFound(m)) => {
                assert!(
                    m.contains("«gemini»") && m.contains("codex, claude, otro, minimo"),
                    "{m}"
                );
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn espera_al_primer_informe_y_se_rinde_si_no_llega() {
        let calls: Calls = Default::default();
        let mut rpc = core_with(
            calls.clone(),
            vec![("loading", false), ("loading", false), ("ready", false)],
        );
        let data = report_data(&mut rpc, &Filters::default(), false, NO_WAIT).unwrap();
        assert_eq!(data["providers"].as_array().unwrap().len(), 4);
        assert_eq!(calls.borrow().len(), 3);

        let calls: Calls = Default::default();
        let mut rpc = core_with(calls.clone(), vec![("loading", false)]);
        match report_data(&mut rpc, &Filters::default(), false, NO_WAIT) {
            Err(Failure::Unavailable(m)) => {
                assert!(m.contains("todavía no tiene un informe"), "{m}")
            }
            other => panic!("{other:?}"),
        }
        assert_eq!(
            calls.borrow().len(),
            1 + NO_WAIT.loading_polls as usize,
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
        let data = report_data(&mut rpc, &Filters::default(), true, NO_WAIT).unwrap();
        assert_eq!(data["refreshing"], false);
        let asked = calls.borrow().clone();
        assert_eq!(asked[0], json!({ "refresh": true }));
        assert!(
            asked[1..].iter().all(|a| a == &json!({})),
            "las lecturas de espera no repiten el refresco"
        );
        assert_eq!(asked.len(), 3);

        let calls: Calls = Default::default();
        let mut rpc = core_with(calls.clone(), vec![("ready", false)]);
        report_data(&mut rpc, &Filters::default(), false, NO_WAIT).unwrap();
        assert_eq!(
            calls.borrow()[0],
            json!({}),
            "sin --refresh no se fuerza ninguna consulta"
        );

        // Si la consulta no termina a tiempo, se enseña lo último que se supo y se dice que sigue en curso.
        let mut rpc = core_with(Default::default(), vec![("ready", true)]);
        let data = report_data(&mut rpc, &Filters::default(), true, NO_WAIT).unwrap();
        assert!(report_text(&data).contains("hay una consulta en curso"));
    }

    #[test]
    fn refresco_acelerado_se_dice() {
        let mut data: Value = serde_json::from_str(FIXTURE).unwrap();
        data["providers"][0]["throttled"] = json!(true);
        let mut rpc = move |_: &str, _: &Value| {
            Ok(json!({ "v": 1, "status": "ready", "refreshing": false, "report": data.clone() }))
        };
        let out = report_data(&mut rpc, &Filters::default(), true, NO_WAIT).unwrap();
        assert_eq!(out["providers"][0]["throttled"], true);
        assert!(report_text(&out).contains("Refresco atendido con el dato guardado"));
    }

    #[test]
    fn dato_viejo_tras_un_fallo_conserva_el_ultimo_valor_y_dice_por_que() {
        for (kind, message, wanted) in [
            (
                "rate_limited",
                "429",
                "el proveedor limitó las peticiones (rate_limited): 429",
            ),
            (
                "provider_unavailable",
                "sin respuesta en 15 s",
                "el proveedor no respondió (provider_unavailable)",
            ),
            (
                "auth_required",
                "caducó",
                "el proveedor pide iniciar sesión (auth_required): caducó",
            ),
            (
                "environment_blocked",
                "",
                "el entorno lo impide (environment_blocked)",
            ),
        ] {
            let mut data: Value = serde_json::from_str(FIXTURE).unwrap();
            data["providers"][0]["status"] = json!("stale");
            data["providers"][0]["error"] = json!({ "kind": kind, "message": message });
            let mut rpc = move |_: &str, _: &Value| {
                Ok(
                    json!({ "v": 1, "status": "ready", "refreshing": false, "report": data.clone() }),
                )
            };
            let out = report_data(&mut rpc, &Filters::default(), false, NO_WAIT).unwrap();
            let human = report_text(&out);
            assert!(
                human.contains("codex · desactualizado (se conserva el último dato)"),
                "{human}"
            );
            assert!(human.contains(wanted), "{kind}: {human}");
            assert!(
                human.contains("primary    12 % usado"),
                "el último dato se conserva: {human}"
            );
        }
    }

    #[test]
    fn lo_imposible_se_descarta_no_se_corrige() {
        let mut data: Value = serde_json::from_str(FIXTURE).unwrap();
        data["providers"][0]["snapshot"]["windows"][0]["used_percent"] = json!(140.0);
        data["providers"][0]["snapshot"]["windows"][1]["used_percent"] = json!(-1.0);
        data["providers"][0]["snapshot"]["models"][0]["cost_usd"] = json!(-0.5);
        let mut rpc = move |_: &str, _: &Value| {
            Ok(json!({ "v": 1, "status": "ready", "refreshing": false, "report": data.clone() }))
        };
        let out = report_data(&mut rpc, &Filters::default(), false, NO_WAIT).unwrap();
        let s = &out["providers"][0]["snapshot"];
        assert!(
            s["windows"][0]["used_percent"].is_null() && s["windows"][1]["used_percent"].is_null()
        );
        assert!(s["models"][0]["cost_usd"].is_null());
    }

    #[test]
    fn un_core_con_otro_contrato_no_se_interpreta() {
        let broken = |edit: fn(&mut Value)| {
            let mut report: Value = serde_json::from_str(FIXTURE).unwrap();
            edit(&mut report);
            let mut rpc = move |_: &str, _: &Value| {
                Ok(
                    json!({ "v": 1, "status": "ready", "refreshing": false, "report": report.clone() }),
                )
            };
            report_data(&mut rpc, &Filters::default(), false, NO_WAIT)
        };
        for (name, edit) in [
            (
                "estado",
                (|d: &mut Value| d["providers"][0]["status"] = json!("casi")) as fn(&mut Value),
            ),
            ("sin proveedores", |d| {
                d.as_object_mut().unwrap().remove("providers");
            }),
            ("sin id", |d| d["providers"][1]["provider"] = json!("")),
            ("sin support", |d| {
                d["providers"][1].as_object_mut().unwrap().remove("support");
            }),
            ("falta un campo de support", |d| {
                d["providers"][1]["support"]["fields"]
                    .as_object_mut()
                    .unwrap()
                    .remove("cost");
            }),
            ("estado de support desconocido", |d| {
                d["providers"][1]["support"]["fields"]["plan"]["state"] = json!("quizas");
            }),
        ] {
            match broken(edit) {
                Err(Failure::Version(m)) => assert!(m.contains("actualiza Lixbon"), "{name}: {m}"),
                other => panic!("{name}: {other:?}"),
            }
        }
        for resp in [
            json!({ "v": 2, "status": "ready", "report": {} }),
            json!({ "v": 1, "status": "raro" }),
            json!({ "v": 1, "status": "ready", "report": null }),
        ] {
            let mut rpc = move |_: &str, _: &Value| Ok(resp.clone());
            assert!(matches!(
                report_data(&mut rpc, &Filters::default(), false, NO_WAIT),
                Err(Failure::Version(_))
            ));
        }
    }

    #[test]
    fn la_salida_es_una_allowlist_sin_credenciales_ni_cuenta_en_claro() {
        let mut data: Value = serde_json::from_str(FIXTURE).unwrap();
        data["token"] = json!(LEAK);
        data["providers"][0]["api_key"] = json!(LEAK);
        data["providers"][0]["snapshot"]["account_id"] = json!(LEAK);
        data["providers"][0]["snapshot"]["credits"]["token"] = json!(LEAK);
        data["providers"][0]["snapshot"]["windows"][0]["secret"] = json!(LEAK);
        data["providers"][0]["support"]["fields"]["plan"]["path"] = json!(LEAK);
        let mut rpc = move |_: &str, _: &Value| {
            Ok(json!({ "v": 1, "status": "ready", "refreshing": false, "report": data.clone() }))
        };
        let out = report_data(&mut rpc, &Filters::default(), false, NO_WAIT).unwrap();
        assert!(
            !out.to_string().contains(LEAK),
            "el JSON dejó pasar un campo ajeno"
        );
        assert!(
            !report_text(&out).contains(LEAK),
            "el texto dejó pasar un campo ajeno"
        );
        assert_eq!(
            out["providers"][0]["snapshot"]["account"], "e7cbf1f7",
            "solo la huella de 8 hex"
        );
    }

    #[test]
    fn el_texto_no_lleva_caracteres_de_control() {
        let mut data: Value = serde_json::from_str(FIXTURE).unwrap();
        data["providers"][0]["snapshot"]["plan"] = json!("plus\u{1b}[31m");
        data["providers"][2]["error"]["message"] = json!("línea 1\nlínea 2\u{7}");
        let mut rpc = move |_: &str, _: &Value| {
            Ok(json!({ "v": 1, "status": "ready", "refreshing": false, "report": data.clone() }))
        };
        let out = report_data(&mut rpc, &Filters::default(), false, NO_WAIT).unwrap();
        let human = report_text(&out);
        assert!(
            !human.chars().any(|c| c.is_control() && c != '\n'),
            "caracter de control en el texto"
        );
        assert!(human.contains("plan plus?[31m"), "{human}");
        assert!(human.contains("línea 1?línea 2?"), "{human}");
    }

    #[test]
    fn los_errores_del_core_se_traducen_a_codigos() {
        let fails = |m: &str| {
            let m = m.to_string();
            let mut rpc = move |_: &str, _: &Value| Err(RpcFailure::Rejected(m.clone()));
            report_data(&mut rpc, &Filters::default(), false, NO_WAIT).unwrap_err()
        };
        assert!(
            matches!(fails("usage_report_auth_required: x"), Failure::Auth(m) if m.contains("solo para personas"))
        );
        assert!(
            matches!(fails("usage_report_invalid_request: parámetro desconocido: x"), Failure::Version(m) if m.contains("actualiza Lixbon"))
        );
        assert!(matches!(
            fails("Comando desconocido: usage_report"),
            Failure::Version(_)
        ));
        assert!(matches!(fails("algo raro"), Failure::Internal(_)));
        assert_eq!(fails("usage_report_auth_required: x").code().1, 3);
    }

    #[test]
    fn uso_invalido_se_rechaza_antes_de_llamar_al_core() {
        for (raw, wanted) in [
            (&["usage", "codex"][..], "no admite argumentos sueltos"),
            (&["usage", "--provider"][..], "--provider requiere un valor"),
            (&["usage", "--model"][..], "--model requiere un valor"),
            (&["usage", "--account"][..], "--account requiere un valor"),
            (&["usage", "--account", "123"][..], "huella de 8 hex"),
            (&["usage", "--account", "zzzzzzzz"][..], "huella de 8 hex"),
            (
                &["usage", "--account", "e7cbf1f7e7cbf1f7"][..],
                "huella de 8 hex",
            ),
            (&["usage", "--json=si"][..], "no admite un valor"),
            (&["usage", "--refresh=1"][..], "no admite un valor"),
            (
                &["usage", "--attempt", "t1"][..],
                "--attempt no es una opción de lxo usage",
            ),
            (
                &["usage", "--provider", "a", "--provider", "b"][..],
                "aparece más de una vez",
            ),
        ] {
            match parse(&args(raw)) {
                Err(Failure::Usage(m)) => assert!(m.contains(wanted), "{raw:?}: {m}"),
                other => panic!("{raw:?}: {other:?}"),
            }
        }
        assert_eq!(parse(&args(&["usage", "help"])).unwrap(), Request::Help);
        assert_eq!(parse(&args(&["usage", "--help"])).unwrap(), Request::Help);
        assert_eq!(
            parse(&args(&["usage", "--refresh"])).unwrap(),
            Request::Report {
                filters: Filters::default(),
                refresh: true
            }
        );
    }

    #[test]
    fn la_ayuda_documenta_el_corte_con_el_comando_historico() {
        assert!(HELP.contains("`lixbon usage`") && HELP.contains("no cambia"));
        assert!(HELP.contains("Desconocido no es cero"));
        assert!(crate::HELP.contains("lxo usage"));
    }
}
