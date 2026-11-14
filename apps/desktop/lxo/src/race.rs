//! `lxo race`: lanza Forks comparables y expone el estado durable del Core (LXO-217).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::f5_support::{self, PreparedPackage, Rpc, SourceFacts};
use crate::projects::{self, Failure};
use crate::Args;

pub(super) const HELP: &str = "Uso:
  lxo race --task <task_id> [--candidate PROVIDER[:MODEL] ...] [opciones]
  lxo race <source_attempt_id> [--candidate PROVIDER[:MODEL] ...] [opciones]
  lxo race status <race_id|source_attempt_id> [--follow]
  lxo race cancel <race_id> [--attempt <attempt_id>] [--confirm]

Lanza de 2 a 4 Forks desde el Attempt actual de la Task (o desde un Attempt explícito,
por compatibilidad). Cada candidato recibe su propia Task y worktree. El Core verifica la
policy, los límites y la procedencia común; no se elige ganador. Sin --follow, devuelve el
estado inicial y deja el Race en segundo plano.

Opciones de lanzamiento:
  --task ID                Task cuyo Attempt actual será el origen del Race
  --candidate P[:M]        candidato repetible; también admite un objeto JSON
  --config FILE            JSON {\"candidates\":[{...}],\"context_package\":\"ID|FILE\"}
  --context-package ID|FILE ContextPackage guardado (sha256:.) o archivo; '-' lee stdin
  --request-id ID          clave idempotente; si se omite, se deriva de la petición
  --confirm                confirmación que puede exigir la policy efectiva
  --dry-run                muestra origen, revisión, contexto, recursos y policy sin lanzar
  --follow [--timeout-ms N] sigue el estado; vence a los 10 min (máximo 30 min)
  --background             explicita el comportamiento por defecto
  --json                   salida estructurada

Config JSON:
  {\"candidates\":[{\"provider\":\"codex\",\"model\":\"gpt-...\"},{\"provider\":\"claude\"}],
   \"context_package\":\"sha256:...\"}
Cada candidato acepta provider, model, effort, role y title. --candidate puede repetirse o
usarse --config, no ambos. Un ContextPackage relativo al config se resuelve junto a ese archivo.
El Core actual no acepta host ni estrategia de worktree por candidato: ambos los asigna el Core.
Sin un Attempt actual, una Task no puede ser origen de un Race.

Cancelación:
  Sin --attempt, cancela los candidatos que sigan activos; con --attempt, solo ese candidato.
  El Core puede exigir --confirm. Ningún candidato se cancela automáticamente al terminar otro.
Compare no elige ganador: con al menos dos lanzados se puede ejecutar `lxo compare --race <race_id>`
o abrirlos en Desktop. lxo no eleva permisos ni cambia la policy.
";

const CONTRACT: u64 = 1;
const CONFIG_MAX_BYTES: usize = 128 * 1024;
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const DEFAULT_WAIT: u64 = 10 * 60 * 1000;
const MAX_WAIT: u64 = 30 * 60 * 1000;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Candidate {
    provider: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    role: Option<String>,
    title: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum SourceSelector {
    Task(String),
    Attempt(String),
}

#[derive(Debug, PartialEq, Eq)]
struct LaunchRequest {
    source: SourceSelector,
    candidates: Vec<Candidate>,
    context_base_dir: Option<PathBuf>,
    context_package: Option<String>,
    request_id: Option<String>,
    confirm: bool,
    dry_run: bool,
    follow_ms: Option<u64>,
    compare_handoff: bool,
}

#[derive(Debug, PartialEq, Eq)]
enum Request {
    Help,
    Launch(LaunchRequest),
    Status {
        selector: String,
        follow_ms: Option<u64>,
    },
    Cancel {
        race_id: String,
        attempt_id: Option<String>,
        confirm: bool,
    },
}

fn usage(message: impl Into<String>) -> Failure {
    Failure::Usage(message.into())
}

fn value_flag(a: &Args, key: &str) -> Result<Option<String>, Failure> {
    match a.flags.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => {
            Ok(Some(value.trim().to_string()))
        }
        _ => Err(usage(format!("--{key} requiere un valor."))),
    }
}

fn bool_flags(a: &Args, names: &[&str]) -> Result<(), Failure> {
    for name in names {
        if a.flags.get(*name).is_some_and(|value| !value.is_boolean()) {
            return Err(usage(format!("--{name} no admite un valor.")));
        }
    }
    Ok(())
}

fn wait_ms(a: &Args, enabled: bool) -> Result<Option<u64>, Failure> {
    match (enabled, a.flags.get("timeout-ms")) {
        (false, Some(_)) => Err(usage("--timeout-ms solo se usa junto con --follow.")),
        (false, None) => Ok(None),
        (true, None) => Ok(Some(DEFAULT_WAIT)),
        (true, Some(Value::String(raw))) => raw
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0 && *value <= MAX_WAIT)
            .map(Some)
            .ok_or_else(|| usage(format!("--timeout-ms debe estar entre 1 y {MAX_WAIT}."))),
        (true, _) => Err(usage("--timeout-ms requiere un valor numérico.")),
    }
}

fn flag_names(a: &Args, allowed: &[&str]) -> Result<(), Failure> {
    if let Some(name) = a
        .flags
        .keys()
        .find(|name| !allowed.contains(&name.as_str()))
    {
        return Err(usage(format!("--{name} no es una opción de lxo race.")));
    }
    if let Some(name) = a
        .duplicates
        .iter()
        .find(|name| name.as_str() != "candidate")
    {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    Ok(())
}

fn candidate_values(a: &Args) -> Vec<Value> {
    a.repeated
        .get("candidate")
        .cloned()
        .or_else(|| a.flags.get("candidate").cloned().map(|value| vec![value]))
        .unwrap_or_default()
}

fn parse_candidate(raw: &str) -> Result<Candidate, Failure> {
    let raw = raw.trim();
    if raw.starts_with('{') {
        let value = serde_json::from_str(raw)
            .map_err(|_| usage("--candidate con JSON debe ser un objeto válido."))?;
        return candidate_from_value(&value);
    }
    let (provider, model) = match raw.split_once(':') {
        Some((provider, model)) => (
            Some(provider.trim().to_string()),
            Some(model.trim().to_string()),
        ),
        None => (Some(raw.to_string()), None),
    };
    let candidate = Candidate {
        provider,
        model,
        ..Candidate::default()
    };
    validate_candidate(&candidate)?;
    Ok(candidate)
}

fn optional_text(value: &Value, field: &str) -> Result<Option<String>, Failure> {
    match value {
        Value::Null => Ok(None),
        Value::String(raw) if !raw.trim().is_empty() => Ok(Some(raw.trim().to_string())),
        Value::String(_) => Err(usage(format!("El campo {field} no puede estar vacío."))),
        _ => Err(usage(format!("El campo {field} debe ser texto."))),
    }
}

fn candidate_from_value(value: &Value) -> Result<Candidate, Failure> {
    let object = value
        .as_object()
        .ok_or_else(|| usage("Cada candidato debe ser un objeto JSON."))?;
    if let Some(name) = object
        .keys()
        .find(|name| !["provider", "model", "effort", "role", "title"].contains(&name.as_str()))
    {
        return Err(usage(format!(
            "El campo {name} no forma parte de un candidato de Race."
        )));
    }
    let candidate = Candidate {
        provider: object
            .get("provider")
            .map(|value| optional_text(value, "provider"))
            .transpose()?
            .flatten(),
        model: object
            .get("model")
            .map(|value| optional_text(value, "model"))
            .transpose()?
            .flatten(),
        effort: object
            .get("effort")
            .map(|value| optional_text(value, "effort"))
            .transpose()?
            .flatten(),
        role: object
            .get("role")
            .map(|value| optional_text(value, "role"))
            .transpose()?
            .flatten(),
        title: object
            .get("title")
            .map(|value| optional_text(value, "title"))
            .transpose()?
            .flatten(),
    };
    validate_candidate(&candidate)?;
    Ok(candidate)
}

fn validate_candidate(candidate: &Candidate) -> Result<(), Failure> {
    if let Some(provider) = candidate.provider.as_deref() {
        if provider.is_empty()
            || provider.len() > 64
            || !provider
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(usage(
                "provider debe usar letras minúsculas, números o guiones (máximo 64).",
            ));
        }
    }
    for (field, value, max) in [
        ("model", candidate.model.as_deref(), 120),
        ("effort", candidate.effort.as_deref(), 120),
        ("role", candidate.role.as_deref(), 120),
    ] {
        if value.is_some_and(|value| {
            value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control)
        }) {
            return Err(usage(format!(
                "El campo {field} del candidato no es válido."
            )));
        }
    }
    if candidate.title.as_deref().is_some_and(|value| {
        value.trim().is_empty()
            || value.chars().count() > 512
            || value.chars().any(char::is_control)
    }) {
        return Err(usage("El campo title del candidato no es válido."));
    }
    Ok(())
}

fn load_config(path: &str) -> Result<(Vec<Candidate>, Option<String>, PathBuf), Failure> {
    let path = PathBuf::from(path);
    let display = path.display().to_string();
    let file = std::fs::File::open(&path).map_err(|error| {
        usage(format!(
            "No se pudo leer el config de Race «{display}»: {error}."
        ))
    })?;
    let mut bytes = Vec::new();
    let _ = file
        .take((CONFIG_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| usage(format!("No se pudo leer el config de Race: {error}.")))?;
    if bytes.len() > CONFIG_MAX_BYTES {
        return Err(usage(format!(
            "El config de Race supera el límite de {CONFIG_MAX_BYTES} bytes."
        )));
    }
    let config: Value = serde_json::from_slice(&bytes)
        .map_err(|_| usage("El config de Race debe ser JSON UTF-8 válido."))?;
    let object = config
        .as_object()
        .ok_or_else(|| usage("El config de Race debe ser un objeto JSON."))?;
    if let Some(name) = object
        .keys()
        .find(|name| !["candidates", "context_package"].contains(&name.as_str()))
    {
        return Err(usage(format!(
            "El campo {name} no es válido en el config de Race."
        )));
    }
    let raw_candidates = object
        .get("candidates")
        .and_then(Value::as_array)
        .ok_or_else(|| usage("El config de Race requiere una lista «candidates»."))?;
    let candidates = raw_candidates
        .iter()
        .map(candidate_from_value)
        .collect::<Result<Vec<_>, _>>()?;
    let context_package = object
        .get("context_package")
        .map(|value| optional_text(value, "context_package"))
        .transpose()?
        .flatten();
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    Ok((candidates, context_package, parent))
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
}

fn parse(a: &Args) -> Result<Request, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    match a.at(1).as_deref() {
        Some("status") => parse_status(a),
        Some("cancel") => parse_cancel(a),
        _ => parse_launch(a),
    }
}

fn parse_status(a: &Args) -> Result<Request, Failure> {
    flag_names(a, &["follow", "timeout-ms", "json", "help"])?;
    bool_flags(a, &["follow", "json", "help"])?;
    let selector = a
        .at(2)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| usage("Uso: lxo race status <race_id|source_attempt_id>."))?;
    if a.pos.len() != 3 {
        return Err(usage(
            "lxo race status recibe un race_id o un source_attempt_id.",
        ));
    }
    if selector.starts_with("rc-") && !valid_race_id(&selector) {
        return Err(usage(
            "race_id debe ser rc- seguido de 20 dígitos hexadecimales.",
        ));
    }
    if a.b("follow") && !selector.starts_with("rc-") {
        return Err(usage(
            "--follow requiere un race_id, no una lista por Attempt.",
        ));
    }
    Ok(Request::Status {
        selector,
        follow_ms: wait_ms(a, a.b("follow"))?,
    })
}

fn parse_cancel(a: &Args) -> Result<Request, Failure> {
    flag_names(a, &["attempt", "confirm", "json", "help"])?;
    bool_flags(a, &["confirm", "json", "help"])?;
    let race_id = a
        .at(2)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| usage("Uso: lxo race cancel <race_id> [--attempt <attempt_id>]."))?;
    if a.pos.len() != 3 || !valid_race_id(&race_id) {
        return Err(usage(
            "lxo race cancel requiere un race_id válido y ningún argumento extra.",
        ));
    }
    Ok(Request::Cancel {
        race_id,
        attempt_id: value_flag(a, "attempt")?,
        confirm: a.b("confirm"),
    })
}

fn parse_launch(a: &Args) -> Result<Request, Failure> {
    flag_names(
        a,
        &[
            "candidate",
            "config",
            "task",
            "context-package",
            "request-id",
            "confirm",
            "dry-run",
            "follow",
            "background",
            "timeout-ms",
            "json",
            "help",
            "compare",
        ],
    )?;
    bool_flags(
        a,
        &[
            "confirm",
            "dry-run",
            "follow",
            "background",
            "json",
            "help",
            "compare",
        ],
    )?;
    let source =
        match (value_flag(a, "task")?, a.at(1)) {
            (Some(task_id), None) if a.pos.len() == 1 => {
                if task_id.chars().count() > 200 || task_id.chars().any(char::is_control) {
                    return Err(usage(
                        "--task debe contener de 1 a 200 caracteres sin controles.",
                    ));
                }
                SourceSelector::Task(task_id)
            }
            (Some(_), _) => {
                return Err(usage(
                    "Usa --task sin un Attempt posicional, o bien pasa solo <source_attempt_id>.",
                ))
            }
            (None, Some(source_attempt_id))
                if a.pos.len() == 2
                    && !source_attempt_id.trim().is_empty()
                    && source_attempt_id != "status" =>
            {
                SourceSelector::Attempt(source_attempt_id.trim().to_string())
            }
            (None, _) => return Err(usage(
                "Falta el origen: usa lxo race --task <task_id> o lxo race <source_attempt_id>.",
            )),
        };
    if matches!(&source, SourceSelector::Attempt(id) if id.chars().count() > 200 || id.chars().any(char::is_control))
    {
        return Err(usage(
            "El Attempt origen debe contener de 1 a 200 caracteres sin controles.",
        ));
    }
    if a.b("follow") && a.b("background") {
        return Err(usage("--follow y --background se excluyen mutuamente."));
    }
    let follow_ms = wait_ms(a, a.b("follow"))?;
    let config_path = value_flag(a, "config")?;
    let inline_candidates = candidate_values(a);
    if config_path.is_some() && !inline_candidates.is_empty() {
        return Err(usage(
            "--config y --candidate se excluyen; usa una sola fuente de candidatos.",
        ));
    }
    let (candidates, config_package, config_dir) = if let Some(path) = config_path {
        let (candidates, package, dir) = load_config(&path)?;
        (candidates, package, Some(dir))
    } else {
        let candidates = inline_candidates
            .iter()
            .map(|value| match value {
                Value::String(raw) if !raw.trim().is_empty() => parse_candidate(raw),
                _ => Err(usage("--candidate requiere PROVIDER[:MODEL].")),
            })
            .collect::<Result<Vec<_>, _>>()?;
        (candidates, None, None)
    };
    if !(2..=4).contains(&candidates.len()) {
        return Err(usage(
            "lxo race requiere de 2 a 4 candidatos; usa --candidate repetible o un config.",
        ));
    }
    let cli_package = value_flag(a, "context-package")?;
    let (context_package, context_base_dir) = match (cli_package, config_package) {
        (Some(_), Some(_)) => {
            return Err(usage(
                "El ContextPackage está definido tanto por --context-package como por config.",
            ))
        }
        (Some(value), None) => (Some(value), None),
        (None, Some(value)) => (Some(value), config_dir),
        (None, None) => (None, None),
    };
    let request_id = value_flag(a, "request-id")?;
    if request_id
        .as_deref()
        .is_some_and(|value| !valid_request_id(value))
    {
        return Err(usage(
            "--request-id debe tener de 1 a 64 caracteres ASCII: letras, números, punto, guion o guion bajo.",
        ));
    }
    Ok(Request::Launch(LaunchRequest {
        source,
        candidates,
        context_base_dir,
        context_package,
        request_id,
        confirm: a.b("confirm"),
        dry_run: a.b("dry-run"),
        follow_ms,
        compare_handoff: a.b("compare"),
    }))
}

pub(super) fn valid_race_id(value: &str) -> bool {
    value.len() == 23
        && value.starts_with("rc-")
        && value[3..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn candidate_value(candidate: &Candidate) -> Value {
    let mut object = Map::new();
    for (name, value) in [
        ("provider", candidate.provider.as_ref()),
        ("model", candidate.model.as_ref()),
        ("effort", candidate.effort.as_ref()),
        ("role", candidate.role.as_ref()),
        ("title", candidate.title.as_ref()),
    ] {
        if let Some(value) = value {
            object.insert(name.to_string(), Value::String(value.clone()));
        }
    }
    Value::Object(object)
}

fn candidate_preview(
    candidate: &Candidate,
    source: &SourceFacts,
    index: usize,
    total: usize,
) -> Value {
    let provider = candidate
        .provider
        .as_deref()
        .or_else(|| source.attempt["provider"].as_str())
        .unwrap_or("");
    let same_provider = provider == source.attempt["provider"].as_str().unwrap_or("");
    json!({
        "index": index,
        "provider": provider,
        "model": candidate.model.as_ref().map(|value| json!(value)).unwrap_or_else(|| {
            if same_provider { source.attempt["model"].clone() } else { Value::Null }
        }),
        "effort": candidate.effort.as_ref().map(|value| json!(value)).unwrap_or_else(|| {
            if same_provider { source.attempt["effort"].clone() } else { Value::Null }
        }),
        "role": candidate.role.as_ref().map(|value| json!(value)).unwrap_or_else(|| source.attempt["role"].clone()),
        "title": candidate.title.as_ref().map(|value| json!(value)).unwrap_or_else(|| {
            let title = source.task["title"].as_str().unwrap_or("origen");
            json!(format!("Race {}/{total} · {}", index, title.chars().take(160).collect::<String>()))
        }),
    })
}

fn request_id(
    request: &LaunchRequest,
    source: &SourceFacts,
    package: Option<&PreparedPackage>,
) -> String {
    request.request_id.clone().unwrap_or_else(|| {
        f5_support::stable_request_id(
            "race",
            &json!({
                "source_attempt_id": source.attempt_id,
                "candidates": request.candidates.iter().map(candidate_value).collect::<Vec<_>>(),
                "package_id": package.map(|package| package.package_id.as_str()),
            }),
        )
    })
}

pub(super) fn status_value(mut value: Value, race_id: Option<&str>) -> Result<Value, Failure> {
    if value["v"].as_u64() != Some(CONTRACT)
        || !value["candidates"].is_array()
        || !value["summary"].is_object()
        || !value["compare"].is_object()
        || !value["cancellable"].is_array()
        || race_id.is_some_and(|id| value["race_id"].as_str() != Some(id))
    {
        return Err(Failure::Version(
            "El Core devolvió un estado de Race con un formato que este lxo no entiende.".into(),
        ));
    }
    let id = value["race_id"]
        .as_str()
        .filter(|id| valid_race_id(id))
        .ok_or_else(|| Failure::Version("El Core devolvió un race_id inválido.".into()))?
        .to_string();
    let attempt_ids = value["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|candidate| candidate["outcome"] == "launched")
        .filter_map(|candidate| candidate["attempt_id"].as_str().map(str::to_string))
        .collect::<Vec<_>>();
    value["attempt_ids"] = json!(attempt_ids);
    value["compare_handoff"] = json!({
        "available": attempt_ids.len() >= 2,
        "surface": "lxo compare --race",
        "command": if attempt_ids.len() >= 2 { json!(format!("lxo compare --race {id}")) } else { Value::Null },
        "attempt_ids": attempt_ids,
        "direct_cli": true,
    });
    Ok(value)
}

fn status_list(value: Value, source_attempt_id: &str) -> Result<Value, Failure> {
    if value["v"].as_u64() != Some(CONTRACT)
        || value["source_attempt_id"].as_str() != Some(source_attempt_id)
        || !value["races"].is_array()
    {
        return Err(Failure::Version(
            "El Core devolvió una lista de Races con un formato que este lxo no entiende.".into(),
        ));
    }
    Ok(value)
}

fn follow(rpc: &mut Rpc<'_>, race_id: &str, timeout_ms: u64) -> Result<Value, Failure> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let current = status_value(
            f5_support::send("task_race_status", &json!({ "race_id": race_id }), rpc)?,
            Some(race_id),
        )?;
        if current["summary"]["active"].as_u64().unwrap_or(0) == 0 {
            return Ok(json!({ "timed_out": false, "race": current }));
        }
        if Instant::now() >= deadline {
            return Ok(json!({
                "timed_out": true,
                "race_id": race_id,
                "summary": current["summary"],
                "cancellable": current["cancellable"],
                "race": current,
            }));
        }
        std::thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())));
    }
}

fn run_launch(request: LaunchRequest, rpc: &mut Rpc<'_>) -> Result<Value, Failure> {
    let (source, expected_current_attempt_id) = match &request.source {
        SourceSelector::Task(task_id) => {
            let source = f5_support::source_for_task(rpc, task_id)?;
            let expected = source.attempt_id.clone();
            (source, Some(expected))
        }
        SourceSelector::Attempt(attempt_id) => (f5_support::source(rpc, attempt_id)?, None),
    };
    let package = f5_support::context_package(
        request.context_package.as_deref(),
        request.context_base_dir.as_deref(),
        &source,
        rpc,
    )?;
    let request_id = request_id(&request, &source, package.as_ref());
    let candidates: Vec<Value> = request.candidates.iter().map(candidate_value).collect();
    let candidate_preview: Vec<Value> = request
        .candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            candidate_preview(candidate, &source, index + 1, request.candidates.len())
        })
        .collect();
    let package_id = package
        .as_ref()
        .map(|package| Value::String(package.package_id.clone()))
        .unwrap_or(Value::Null);
    if request.dry_run {
        let (resource, policy) = f5_support::dry_run_facts(rpc, &source)?;
        return Ok(json!({
            "v": CONTRACT,
            "status": "dry_run",
            "request_id": request_id,
            "source": f5_support::source_preview(&source),
            "candidates": candidate_preview,
            "attempt_ids": [],
            "context": {
                "strategy": if package.is_some() { "context_package" } else { "clean" },
                "package_id": package_id,
                "revision": package.as_ref().map(|package| package.revision.clone()),
            },
            "resource": resource,
            "policy": policy,
            "worktree": { "host": "local", "strategy": "own" },
            "compare_handoff": {
                "available": false,
                "will_be_available_if_launch_succeeds": candidate_preview.len() >= 2,
                "surface": "lxo compare --race",
                "command": null,
                "attempt_ids": [],
                "direct_cli": true,
            },
        }));
    }

    let mut race_args = json!({
        "request_id": request_id,
        "source_attempt_id": source.attempt_id,
        "candidates": candidates,
        "package": package.map(|package| package.raw),
        "confirm": request.confirm,
    });
    if let Some(expected) = expected_current_attempt_id {
        race_args["expected_current_attempt_id"] = json!(expected);
    }
    let result = f5_support::send("task_race", &race_args, rpc)?;
    let race_id = result["race_id"]
        .as_str()
        .filter(|id| valid_race_id(id))
        .map(str::to_string)
        .ok_or_else(|| Failure::Version("El Core no devolvió un race_id válido.".into()))?;
    let mut output = status_value(result, Some(&race_id))?;
    output["compare_handoff"]["requested"] = json!(request.compare_handoff);
    if let Some(timeout_ms) = request.follow_ms {
        output["follow"] = follow(rpc, &race_id, timeout_ms)?;
    }
    Ok(output)
}

fn run_status(selector: &str, follow_ms: Option<u64>, rpc: &mut Rpc<'_>) -> Result<Value, Failure> {
    if selector.starts_with("rc-") {
        let race_id = selector;
        let data = status_value(
            f5_support::send("task_race_status", &json!({ "race_id": race_id }), rpc)?,
            Some(race_id),
        )?;
        if let Some(timeout_ms) = follow_ms {
            let mut output = data;
            output["follow"] = follow(rpc, race_id, timeout_ms)?;
            Ok(output)
        } else {
            Ok(data)
        }
    } else {
        if follow_ms.is_some() {
            return Err(usage("--follow requiere un race_id concreto."));
        }
        status_list(
            f5_support::send(
                "task_race_status",
                &json!({ "source_attempt_id": selector }),
                rpc,
            )?,
            selector,
        )
    }
}

fn run_cancel(
    race_id: &str,
    attempt_id: Option<&str>,
    confirm: bool,
    rpc: &mut Rpc<'_>,
) -> Result<Value, Failure> {
    let result = f5_support::send(
        "task_race_cancel",
        &json!({
            "race_id": race_id,
            "attempt_id": attempt_id,
            "confirm": confirm,
        }),
        rpc,
    )?;
    if result["race_id"].as_str() != Some(race_id) || result["results"].as_array().is_none() {
        return Err(Failure::Version(
            "El Core devolvió una cancelación de Race con un formato que este lxo no entiende."
                .into(),
        ));
    }
    let mut result = result;
    result["race"] = status_value(result["race"].clone(), Some(race_id))?;
    Ok(result)
}

fn execute(request: Request, rpc: &mut Rpc<'_>) -> Result<Value, Failure> {
    match request {
        Request::Help => unreachable!("la ayuda se imprime antes de ejecutar"),
        Request::Launch(request) => run_launch(request, rpc),
        Request::Status {
            selector,
            follow_ms,
        } => run_status(&selector, follow_ms, rpc),
        Request::Cancel {
            race_id,
            attempt_id,
            confirm,
        } => run_cancel(&race_id, attempt_id.as_deref(), confirm, rpc),
    }
}

fn human(data: &Value) -> String {
    if data["status"] == "dry_run" {
        let source = data["source"]["attempt_id"].as_str().unwrap_or("");
        let candidates = data["candidates"]
            .as_array()
            .map(|items| items.len())
            .unwrap_or(0);
        return format!(
            "Previsualización de Race desde {source}: {candidates} candidatos · contexto {} · policy fork: {}. No se creó ningún Race.",
            data["context"]["strategy"].as_str().unwrap_or(""),
            data["policy"]["category"]["level"].as_str().unwrap_or("desconocida"),
        );
    }
    if data["race_id"].is_string() && data["results"].is_array() {
        let result_lines = data["results"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|item| {
                format!(
                    "  {}: {}",
                    item["attempt_id"].as_str().unwrap_or(""),
                    item["outcome"].as_str().unwrap_or("fallido"),
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        return format!(
            "Cancelación del Race {} registrada.{}",
            data["race_id"].as_str().unwrap_or(""),
            if result_lines.is_empty() {
                String::new()
            } else {
                format!("\n{result_lines}")
            },
        );
    }
    if let Some(races) = data["races"].as_array() {
        if races.is_empty() {
            return format!(
                "No hay Races para el Attempt {}.",
                data["source_attempt_id"].as_str().unwrap_or("")
            );
        }
        return races
            .iter()
            .map(|race| {
                format!(
                    "{} · {} candidatos · {}",
                    race["race_id"].as_str().unwrap_or(""),
                    race["requested"].as_u64().unwrap_or(0),
                    race["created_at"].as_i64().unwrap_or(0),
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    let race = data["follow"]
        .get("race")
        .filter(|race| race.is_object())
        .or_else(|| data.get("race").filter(|race| race.is_object()))
        .unwrap_or(data);
    let candidates = race["candidates"].as_array().cloned().unwrap_or_default();
    let details = candidates
        .iter()
        .map(|candidate| {
            let idx = candidate["index"].as_u64().unwrap_or(0) + 1;
            let provider = candidate["provider"].as_str().unwrap_or("origen");
            let model = candidate["model"].as_str().unwrap_or("");
            let attempt_id = candidate["attempt_id"].as_str().unwrap_or("");
            let status = candidate["status"].as_str().unwrap_or("");
            if candidate["outcome"] == "failed" {
                format!(
                    "  [{idx}] {provider} {model}: fallido ({})",
                    candidate["code"].as_str().unwrap_or("fallo_desconocido")
                )
            } else if candidate["outcome"] == "not_attempted" {
                format!("  [{idx}] no intentado")
            } else {
                format!("  [{idx}] {attempt_id} · {provider} {model} · {status}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let compare = race["attempt_ids"]
        .as_array()
        .or_else(|| race["compare"]["attempt_ids"].as_array())
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let mut text = format!(
        "Race {} · {} lanzados · {} fallidos · {} sin intentar.",
        race["race_id"].as_str().unwrap_or(""),
        race["summary"]["launched"].as_u64().unwrap_or(0),
        race["summary"]["failed"].as_u64().unwrap_or(0),
        race["summary"]["not_attempted"].as_u64().unwrap_or(0),
    );
    if !details.is_empty() {
        text.push('\n');
        text.push_str(&details);
    }
    if !compare.is_empty() {
        let command = data["compare_handoff"]["command"]
            .as_str()
            .unwrap_or("lxo compare --race <race_id>");
        if data["compare_handoff"]["requested"] == true {
            text.push_str(&format!(
                "\nCompara desde CLI con `{command}` o abre esos Attempts en Desktop: {compare}."
            ));
        } else {
            text.push_str(&format!(
                "\nCompara con `{command}` o abre esos Attempts en Desktop: {compare}."
            ));
        }
    } else if data["compare_handoff"]["requested"] == true {
        text.push_str(
            "\nCompare aún no está disponible: se necesitan al menos dos candidatos lanzados.",
        );
    }
    if data["follow"]["timed_out"] == true {
        text.push_str("\nLa espera terminó; hay candidatos que siguen activos.");
    }
    text
}

pub(super) fn run(a: &Args) -> ExitCode {
    let json_output = a.b("json");
    let result = match parse(a) {
        Ok(Request::Help) => {
            print!("{HELP}");
            return ExitCode::SUCCESS;
        }
        Ok(request) => {
            let mut rpc = f5_support::live_rpc();
            execute(request, &mut rpc)
        }
        Err(error) => Err(error),
    };
    match result {
        Ok(data) => {
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&data).unwrap_or_default()
                );
            } else {
                println!("{}", human(&data));
            }
            ExitCode::SUCCESS
        }
        Err(error) => projects::finish(Err(error), json_output),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client_auth::RpcFailure;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|value| value.to_string()).collect())
    }

    fn source_attempt() -> Value {
        json!({
            "v": 1,
            "core_model": "task_attempt_v1",
            "attempt": {
                "id": "t1-a1", "task_id": "t1", "provider": "claude", "model": "sonnet",
                "effort": "high", "role": "implementar", "status": "done",
                "review": {"base_commit": "base123", "head_commit": "head456"},
                "worktree": {"branch": "feature", "state": "active", "machine": null}
            }
        })
    }

    fn task() -> Value {
        json!({"v": 2, "core_model": "task_attempt_v1", "task": {
            "id": "t1", "project_id": "p1", "state": "integrated", "title": "Origen",
            "current_attempt": {"id":"t1-a1"}
        }})
    }

    fn race_status() -> Value {
        json!({
            "v": 1, "race_id": "rc-aaaaaaaaaaaaaaaaaaaa", "source_attempt_id": "t1-a1",
            "requested": 2, "strategy": "clean", "package_id": null, "created_at": 123,
            "candidates": [
                {"index":0,"outcome":"launched","provider":"claude","model":"sonnet","task_id":"t2","attempt_id":"t2-a1","status":"pending_approval","code":null},
                {"index":1,"outcome":"failed","provider":"missing","model":null,"task_id":null,"attempt_id":null,"status":null,"code":"provider_not_found"}
            ],
            "summary":{"launched":1,"failed":1,"not_attempted":0,"active":1,"finished":0},
            "compare":{"attempt_ids":null}, "cancellable":["t2-a1"],
            "limits":{"min_candidates":2,"max_candidates":4,"max_active_tasks":8}
        })
    }

    fn facts(
        calls: Rc<RefCell<Vec<(String, Value)>>>,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        move |cmd, args| {
            calls.borrow_mut().push((cmd.to_string(), args.clone()));
            match cmd {
                "attempt_detail" => Ok(source_attempt()),
                "task_detail_v2" => Ok(task()),
                "resource_inspect" => {
                    Ok(json!({"v":1,"task_id":"t1","worktree":{"state":"present","dirty":false}}))
                }
                "policy_effective" => Ok(
                    json!({"v":1,"revision":3,"actor":{"class":"cli_person"},"categories":[{"category":"fork","level":"deny","source":"baseline"}]}),
                ),
                "task_race" => {
                    let mut status = race_status();
                    status["summary"]["launched"] = json!(1);
                    status["status"] = json!("Requested");
                    status["replayed"] = json!(0);
                    Ok(status)
                }
                "task_race_status" => Ok(race_status()),
                "task_race_cancel" => Ok(json!({
                    "status":"Cancelled", "race_id":"rc-aaaaaaaaaaaaaaaaaaaa",
                    "results":[{"attempt_id":"t2-a1","outcome":"rejected"}],
                    "race":race_status()
                })),
                _ => panic!("RPC inesperado: {cmd}"),
            }
        }
    }

    #[test]
    fn parse_acepta_candidatos_repetidos_y_rechaza_host() {
        let parsed = parse(&args(&[
            "race",
            "t1-a1",
            "--candidate",
            "claude:opus",
            "--candidate",
            "codex",
        ]))
        .unwrap();
        let Request::Launch(request) = parsed else {
            panic!("se esperaba lanzamiento");
        };
        assert_eq!(request.candidates.len(), 2);
        assert_eq!(request.candidates[0].provider.as_deref(), Some("claude"));
        assert_eq!(request.candidates[0].model.as_deref(), Some("opus"));
        assert_eq!(request.candidates[1].model, None);
        assert!(parse(&args(&[
            "race",
            "t1-a1",
            "--candidate",
            "claude",
            "--candidate",
            "codex",
            "--host",
            "remote"
        ]))
        .is_err());
        assert!(parse(&args(&[
            "race",
            "t1-a1",
            "--candidate",
            r#"{"provider":"claude","host":"remote"}"#,
            "--candidate",
            "codex"
        ]))
        .is_err());
    }

    #[test]
    fn parse_acepta_task_y_attempt_explicito_y_exige_dos_a_cuatro_candidatos() {
        assert_eq!(
            parse(&args(&[
                "race",
                "--task",
                "t1",
                "--candidate",
                "claude",
                "--candidate",
                "codex"
            ])),
            Ok(Request::Launch(LaunchRequest {
                source: SourceSelector::Task("t1".into()),
                candidates: vec![
                    Candidate {
                        provider: Some("claude".into()),
                        ..Candidate::default()
                    },
                    Candidate {
                        provider: Some("codex".into()),
                        ..Candidate::default()
                    }
                ],
                context_base_dir: None,
                context_package: None,
                request_id: None,
                confirm: false,
                dry_run: false,
                follow_ms: None,
                compare_handoff: false,
            }))
        );
        assert!(matches!(
            parse(&args(&["race", "t1-a1", "--candidate", "claude", "--candidate", "codex"])),
            Ok(Request::Launch(LaunchRequest { source: SourceSelector::Attempt(id), .. })) if id == "t1-a1"
        ));
        assert!(parse(&args(&[
            "race",
            "--task",
            "t1",
            "t1-a1",
            "--candidate",
            "claude",
            "--candidate",
            "codex"
        ]))
        .is_err());
        assert!(parse(&args(&["race", "--task", "t1", "--candidate", "claude"])).is_err());
        assert!(parse(&args(&[
            "race",
            "t1-a1",
            "--candidate",
            "claude",
            "--candidate",
            "codex",
            "--candidate",
            "other",
            "--candidate",
            "fourth",
            "--candidate",
            "fifth"
        ]))
        .is_err());
    }

    #[test]
    fn race_task_resuelve_el_attempt_actual_y_no_lanza_si_falta_el_origen() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = facts(calls.clone());
        let Request::Launch(request) = parse(&args(&[
            "race",
            "--task",
            "t1",
            "--candidate",
            "claude",
            "--candidate",
            "codex",
        ]))
        .unwrap() else {
            panic!("se esperaba lanzamiento");
        };
        let output = run_launch(request, &mut rpc).unwrap();
        assert_eq!(output["source_attempt_id"], "t1-a1");
        assert_eq!(
            calls
                .borrow()
                .iter()
                .find(|(cmd, _)| cmd == "task_race")
                .unwrap()
                .1["source_attempt_id"],
            "t1-a1"
        );
        assert_eq!(
            calls
                .borrow()
                .iter()
                .find(|(cmd, _)| cmd == "task_race")
                .unwrap()
                .1["expected_current_attempt_id"],
            "t1-a1"
        );
        assert_eq!(
            calls
                .borrow()
                .iter()
                .filter(|(cmd, _)| cmd == "task_detail_v2")
                .count(),
            1,
            "CLI resuelve una sola vez; el Core valida atómicamente el Attempt esperado"
        );

        let mut no_origin = |cmd: &str, _args: &Value| match cmd {
            "task_detail_v2" => Ok(json!({
                "v":2,
                "core_model":"task_attempt_v1",
                "task":{"id":"t-empty","project_id":"p1","current_attempt":null}
            })),
            other => panic!("no debía llamar {other}"),
        };
        assert!(matches!(
            f5_support::source_for_task(&mut no_origin, "t-empty"),
            Err(Failure::Usage(message)) if message.contains("no tiene un Attempt actual")
        ));
    }

    #[test]
    fn estado_publica_handoff_cli_solo_con_dos_attempts_lanzados() {
        let one = status_value(race_status(), Some("rc-aaaaaaaaaaaaaaaaaaaa")).unwrap();
        assert_eq!(one["compare_handoff"]["available"], false);
        assert_eq!(one["compare_handoff"]["command"], Value::Null);

        let mut two = race_status();
        two["candidates"][1] = json!({
            "index":1,"outcome":"launched","provider":"codex","model":"m2",
            "task_id":"t3","attempt_id":"t3-a1","status":"pending_approval","code":null
        });
        two["summary"]["launched"] = json!(2);
        two["summary"]["failed"] = json!(0);
        two["summary"]["active"] = json!(2);
        two["cancellable"] = json!(["t2-a1", "t3-a1"]);
        two["compare"]["attempt_ids"] = json!(["t2-a1", "t3-a1"]);
        let two = status_value(two, Some("rc-aaaaaaaaaaaaaaaaaaaa")).unwrap();
        assert_eq!(two["compare_handoff"]["available"], true);
        assert_eq!(
            two["compare_handoff"]["command"],
            "lxo compare --race rc-aaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(two["attempt_ids"], json!(["t2-a1", "t3-a1"]));
    }

    #[test]
    fn config_admite_opciones_por_candidato_y_resuelve_contexto_junto_al_archivo() {
        let path = std::env::temp_dir().join(format!(
            "lxo-race-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(
            &path,
            r#"{"candidates":[{"provider":"claude","model":"opus","effort":"high"},{"provider":"codex","title":"Otro"}],"context_package":"context.json"}"#,
        )
        .unwrap();
        let raw_path = path.to_string_lossy().to_string();
        let parsed = parse(&args(&["race", "t1-a1", "--config", raw_path.as_str()])).unwrap();
        let Request::Launch(request) = parsed else {
            panic!("se esperaba lanzamiento");
        };
        assert_eq!(request.candidates.len(), 2);
        assert_eq!(request.candidates[0].effort.as_deref(), Some("high"));
        assert_eq!(request.candidates[1].title.as_deref(), Some("Otro"));
        assert_eq!(request.context_package.as_deref(), Some("context.json"));
        assert_eq!(request.context_base_dir.as_deref(), path.parent());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn dry_run_muestra_revision_contexto_policy_y_no_lanza() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = facts(calls.clone());
        let Request::Launch(request) = parse(&args(&[
            "race",
            "t1-a1",
            "--candidate",
            "claude:opus",
            "--candidate",
            "codex",
            "--dry-run",
        ]))
        .unwrap() else {
            panic!("se esperaba lanzamiento");
        };
        let output = run_launch(request, &mut rpc).unwrap();
        assert_eq!(output["status"], "dry_run");
        assert_eq!(output["source"]["revision"]["head_commit"], "head456");
        assert_eq!(output["candidates"][0]["model"], "opus");
        assert_eq!(output["candidates"][1]["model"], Value::Null);
        assert_eq!(output["policy"]["category"]["level"], "deny");
        assert!(!calls.borrow().iter().any(|(cmd, _)| cmd == "task_race"));
    }

    #[test]
    fn dry_run_verifica_paquete_guardado_y_muestra_solo_su_revision() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let package_id = format!("sha256:{}", "a".repeat(64));
        let mut rpc = {
            let calls = calls.clone();
            let package_id = package_id.clone();
            move |cmd: &str, args: &Value| {
                calls.borrow_mut().push((cmd.to_string(), args.clone()));
                match cmd {
                    "attempt_detail" => Ok(source_attempt()),
                    "task_detail_v2" => Ok(task()),
                    "context_package_get" => Ok(json!({
                        "status":"valid",
                        "package":{
                            "package_id":package_id.clone(),
                            "source":{"attempt_id":"t1-a1","task_id":"t1","project_id":"p1"},
                            "revision":{"base_commit":"base123","head_commit":"head456","head_tree":"tree789","branch":"main","files":[{"path":"private.txt"}]}
                        }
                    })),
                    "context_package_preview" => {
                        let raw = args["package"].as_str().expect("paquete serializado");
                        let parsed: Value = serde_json::from_str(raw).unwrap();
                        assert_eq!(parsed["source"]["attempt_id"], "t1-a1");
                        Ok(json!({
                            "status":"valid","package_id":package_id.clone(),
                            "package":{"source":parsed["source"],"revision":parsed["revision"]}
                        }))
                    }
                    "resource_inspect" => Ok(
                        json!({"v":1,"task_id":"t1","worktree":{"state":"present","dirty":false}}),
                    ),
                    "policy_effective" => Ok(
                        json!({"v":1,"revision":3,"actor":{"class":"cli_person"},"categories":[{"category":"fork","level":"deny","source":"baseline"}]}),
                    ),
                    _ => panic!("RPC inesperado: {cmd}"),
                }
            }
        };
        let Request::Launch(request) = parse(&args(&[
            "race",
            "t1-a1",
            "--candidate",
            "claude",
            "--candidate",
            "codex",
            "--context-package",
            package_id.as_str(),
            "--dry-run",
        ]))
        .unwrap() else {
            panic!("se esperaba lanzamiento");
        };
        let output = run_launch(request, &mut rpc).unwrap();
        assert_eq!(output["context"]["package_id"], package_id);
        assert_eq!(output["context"]["revision"]["head_commit"], "head456");
        assert!(output.to_string().contains("head456"));
        assert!(!output.to_string().contains("private.txt"));
        assert!(!calls.borrow().iter().any(|(cmd, _)| cmd == "task_race"));
    }

    #[test]
    fn launch_representa_fallos_parciales_y_prepara_handoff_sin_puntuar() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = facts(calls.clone());
        let Request::Launch(request) = parse(&args(&[
            "race",
            "t1-a1",
            "--candidate",
            "claude",
            "--candidate",
            "missing",
            "--compare",
        ]))
        .unwrap() else {
            panic!("se esperaba lanzamiento");
        };
        let output = run_launch(request, &mut rpc).unwrap();
        assert_eq!(output["summary"]["failed"], 1);
        assert_eq!(output["candidates"][1]["code"], "provider_not_found");
        assert_eq!(output["compare_handoff"]["available"], false);
        let call = calls
            .borrow()
            .iter()
            .find(|(cmd, _)| cmd == "task_race")
            .unwrap()
            .clone();
        assert_eq!(call.1["source_attempt_id"], "t1-a1");
        assert!(
            call.1.get("expected_current_attempt_id").is_none(),
            "el selector posicional explícito no cambia de contrato"
        );
        assert_eq!(call.1["candidates"].as_array().unwrap().len(), 2);
        assert_eq!(call.1["confirm"], false);
        assert!(!calls
            .borrow()
            .iter()
            .any(|(cmd, _)| cmd == "attempt_compare"));
    }

    #[test]
    fn status_cancel_y_follow_usan_los_commands_del_core() {
        let calls = Rc::new(RefCell::new(Vec::new()));
        let mut rpc = facts(calls.clone());
        let status = run_status("rc-aaaaaaaaaaaaaaaaaaaa", None, &mut rpc).unwrap();
        assert_eq!(status["race_id"], "rc-aaaaaaaaaaaaaaaaaaaa");
        let canceled =
            run_cancel("rc-aaaaaaaaaaaaaaaaaaaa", Some("t2-a1"), true, &mut rpc).unwrap();
        assert_eq!(canceled["results"][0]["outcome"], "rejected");
        let followed = follow(&mut rpc, "rc-aaaaaaaaaaaaaaaaaaaa", 1).unwrap();
        assert_eq!(followed["timed_out"], true);
        assert!(calls
            .borrow()
            .iter()
            .any(|(cmd, args)| cmd == "task_race_cancel" && args["attempt_id"] == "t2-a1"));
    }

    #[test]
    fn follow_termina_al_no_quedar_candidatos_activos() {
        let mut rpc = |cmd: &str, _args: &Value| {
            assert_eq!(cmd, "task_race_status");
            let mut status = race_status();
            status["summary"]["active"] = json!(0);
            status["summary"]["finished"] = json!(1);
            Ok(status)
        };
        let followed = follow(&mut rpc, "rc-aaaaaaaaaaaaaaaaaaaa", 500).unwrap();
        assert_eq!(followed["timed_out"], false);
        assert_eq!(followed["race"]["summary"]["active"], 0);
        assert_eq!(followed["race"]["attempt_ids"], json!(["t2-a1"]));
    }

    #[test]
    fn request_id_y_cancelacion_se_validan_sin_host_ni_bypass() {
        assert!(parse(&args(&[
            "race",
            "t1-a1",
            "--candidate",
            "claude",
            "--candidate",
            "codex",
            "--request-id",
            "bad key"
        ]))
        .is_err());
        assert!(parse(&args(&[
            "race",
            "cancel",
            "rc-aaaaaaaaaaaaaaaaaaaa",
            "--host",
            "x"
        ]))
        .is_err());
        assert!(parse(&args(&[
            "race",
            "t1-a1",
            "--candidate",
            "claude",
            "--candidate",
            "codex",
            "--confirm=false"
        ]))
        .is_err());
    }
}
