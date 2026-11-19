//! `lxo delegate`: delega a un agente un trabajo que nace de una Task, de un Attempt o de una
//! selección de código, con el origen verificado por el Core (LXO-179, sobre `attempt_delegate` de
//! LXO-171). Termina siempre en una Task y un Attempt explícitos, y el Attempt nace
//! `pending_approval`: la decisión humana no se salta. lxo prepara la petición, enseña lo que se va
//! a delegar y lo que el Core contesta; el Core valida el origen, redacta y decide la policy.

use std::process::ExitCode;

use serde_json::{json, Value};

use crate::client_auth::RpcFailure;
use crate::f5_support::{self, PreparedPackage, Rpc};
use crate::projects::{self, Failure};
use crate::tasks;
use crate::Args;

pub(super) const HELP: &str = "Uso: lxo delegate --project ID|NOMBRE --provider P --profile PERFIL --instruction TEXTO <origen> [opciones]

Delega a un agente un trabajo que nace de una Task, de un Attempt o de una selección de código.
Crea una Task NUEVA con su primer Attempt; el Core verifica el origen (que exista, sea coherente y
siga vigente) y anota de dónde nace. El origen se referencia por Project y revisión, nunca por una
ruta absoluta.

Origen (al menos uno):
  --task ID                  parte de una Task existente (exige --new-task)
  --attempt ID               parte de un Attempt existente (exige --new-task)
  --file RUTA                archivo RELATIVO al Project (sin ../, ni rutas absolutas)
  --line N [--end-line M]    rango dentro de --file
  --revision SHA             revisión en la que viste la selección (7 a 64 hex). Con --attempt se
                             compara con la vigente y una obsoleta se rechaza; sin él solo se
                             comprueba que exista en el Project
  --new-task                 confirma que quieres crear OTRA Task a partir de una que ya existe.
                             Otro Attempt de la misma Task es `lxo attempt retry`

Encargo y receptor:
  --project ID|NOMBRE        obligatorio; el Core nunca lo infiere del directorio
  --instruction TEXTO        lo que le pides al agente (el origen se añade como datos)
  --provider P --profile PERFIL
                             obligatorios; lxo no elige agente por ti (admite --model, --effort, --role)
  --title TEXTO              título de la Task (por defecto «Delegado: …»)
  --context-package ID|FILE  ContextPackage que revisaste (sha256:… guardado, archivo o '-' para stdin).
                             Solo con --attempt: debe salir de ese Attempt y de ese Project
  --request-id ID            clave idempotente; si se omite, se deriva de la petición
  --dry-run                  comprueba el origen y enseña receptor, contexto y policy sin crear nada
  --json                     salida estructurada (v1)

El Attempt nuevo queda pending_approval hasta que una persona lo apruebe en Lixbon Desktop; ningún
proveedor se ejecuta antes. Repetir la misma petición no crea otra Task: lxo muestra la existente.
El host y la estrategia del worktree no son opciones: los decide el Core.

Códigos de salida: 0 correcto, 1 error interno, 2 uso, 3 autenticación o policy, 4 versión o
contrato, 5 Core no disponible o origen en otra máquina, 6 Project, Attempt o paquete inexistente,
7 revisión del origen obsoleta.
";

const CONTRACT: u64 = 1;
const FLAGS: [&str; 19] = [
    "project",
    "task",
    "attempt",
    "new-task",
    "file",
    "line",
    "end-line",
    "revision",
    "instruction",
    "provider",
    "profile",
    "model",
    "effort",
    "role",
    "title",
    "context-package",
    "request-id",
    "dry-run",
    "json",
];
const INSTRUCTION_MAX: usize = 12_000;
const REQUEST_ID_MAX: usize = 60;
const TITLE_MAX: usize = 512;
const FILE_MAX: usize = 1024;
const LINE_MAX: u64 = 10_000_000;

#[derive(Debug, PartialEq, Eq)]
struct Request {
    project: String,
    task: Option<String>,
    attempt: Option<String>,
    new_task: bool,
    file: Option<String>,
    line: Option<u32>,
    end_line: Option<u32>,
    revision: Option<String>,
    instruction: String,
    provider: String,
    profile: String,
    model: Option<String>,
    effort: Option<String>,
    role: Option<String>,
    title: Option<String>,
    context_package: Option<String>,
    request_id: Option<String>,
    dry_run: bool,
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

fn required(a: &Args, key: &str) -> Result<String, Failure> {
    value_flag(a, key)?.ok_or_else(|| usage(format!("Falta --{key}.")))
}

fn number_flag(a: &Args, key: &str) -> Result<Option<u32>, Failure> {
    let Some(text) = value_flag(a, key)? else {
        return Ok(None);
    };
    text.parse::<u64>()
        .ok()
        .filter(|n| (1..=LINE_MAX).contains(n))
        .map(|n| Some(n as u32))
        .ok_or_else(|| usage(format!("--{key} debe ser un entero entre 1 y {LINE_MAX}.")))
}

/// Las mismas reglas que `lixbon://` para `file`: relativo, sin `..` ni controles ni doble codificación.
fn check_file(file: &str) -> Result<(), Failure> {
    let bytes = file.as_bytes();
    let escaped = |segment: &str| {
        segment
            .as_bytes()
            .windows(3)
            .any(|w| w[0] == b'%' && w[1].is_ascii_hexdigit() && w[2].is_ascii_hexdigit())
    };
    if file.chars().count() > FILE_MAX
        || file.chars().any(|c| c.is_control() || c == '\\')
        || file.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || file.split('/').any(|segment| {
            segment.is_empty() || segment == "." || segment == ".." || escaped(segment)
        })
    {
        return Err(usage(
            "--file debe ser una ruta relativa al Project: sin rutas absolutas, `..`, barras \
             invertidas, controles ni codificación `%XX`.",
        ));
    }
    Ok(())
}

/// `<task>-a<n>` canónico: devuelve la Task.
fn task_of_attempt(attempt_id: &str) -> Option<&str> {
    let (task, raw) = attempt_id.rsplit_once("-a")?;
    let n: u32 = raw.parse().ok().filter(|n| *n > 0)?;
    (!task.is_empty() && format!("{task}-a{n}") == attempt_id).then_some(task)
}

fn id_flag(a: &Args, key: &str) -> Result<Option<String>, Failure> {
    let Some(value) = value_flag(a, key)? else {
        return Ok(None);
    };
    if value.chars().count() > 256 || value.chars().any(char::is_control) {
        return Err(usage(format!("--{key} no es un id válido.")));
    }
    Ok(Some(value))
}

fn parse(a: &Args) -> Result<Option<Request>, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(None);
    }
    if a.pos.len() != 1 {
        return Err(usage(
            "lxo delegate no admite argumentos sueltos. Mira `lxo delegate --help`.",
        ));
    }
    if let Some(name) = a
        .flags
        .keys()
        .find(|name| !FLAGS.contains(&name.as_str()) && name.as_str() != "help")
    {
        return Err(usage(format!(
            "--{name} no es una opción de lxo delegate. Mira `lxo delegate --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["new-task", "dry-run", "json", "help"] {
        if a.flags.get(name).is_some_and(|value| !value.is_boolean()) {
            return Err(usage(format!("--{name} no admite un valor.")));
        }
    }

    let task = id_flag(a, "task")?;
    let attempt = id_flag(a, "attempt")?;
    let file = value_flag(a, "file")?;
    let line = number_flag(a, "line")?;
    let end_line = number_flag(a, "end-line")?;
    let revision = value_flag(a, "revision")?.map(|rev| rev.to_ascii_lowercase());
    let new_task = a.b("new-task");

    if task.is_none() && attempt.is_none() && file.is_none() {
        return Err(usage(
            "Falta el origen: usa --task, --attempt o --file (para una Task sin origen existe \
             `lxo task create`).",
        ));
    }
    if let Some(attempt) = &attempt {
        let from_attempt = task_of_attempt(attempt)
            .ok_or_else(|| usage("--attempt no es un id de Attempt válido (<tarea>-a<n>)."))?;
        if task.as_deref().is_some_and(|task| task != from_attempt) {
            return Err(usage("--attempt no es de la Task indicada con --task."));
        }
    }
    let from_existing = task.is_some() || attempt.is_some();
    if from_existing && !new_task {
        return Err(usage(
            "Delegar desde una Task o un Attempt crea una Task NUEVA: confirma con --new-task. \
             Si quieres otro Attempt de la misma Task, usa `lxo attempt retry`.",
        ));
    }
    if new_task && !from_existing {
        return Err(usage(
            "--new-task solo tiene sentido si se parte de --task o --attempt.",
        ));
    }
    if let Some(file) = &file {
        check_file(file)?;
    }
    if line.is_some() && file.is_none() {
        return Err(usage("--line necesita --file."));
    }
    if end_line.is_some() && line.is_none() {
        return Err(usage("--end-line necesita --line."));
    }
    if let (Some(start), Some(end)) = (line, end_line) {
        if end < start {
            return Err(usage("--end-line no puede ser menor que --line."));
        }
    }
    if revision.as_deref().is_some_and(|rev| {
        !(7..=64).contains(&rev.len()) || !rev.bytes().all(|b| b.is_ascii_hexdigit())
    }) {
        return Err(usage(
            "--revision es un hash hexadecimal de 7 a 64 caracteres.",
        ));
    }

    let instruction = required(a, "instruction")?;
    if instruction.chars().count() > INSTRUCTION_MAX {
        return Err(usage(format!(
            "--instruction supera el límite de {INSTRUCTION_MAX} caracteres."
        )));
    }
    let provider = required(a, "provider")?.to_ascii_lowercase();
    let profile = required(a, "profile")?;
    let model = value_flag(a, "model")?;
    let effort = value_flag(a, "effort")?;
    let role = value_flag(a, "role")?;
    if !f5_support::valid_provider(&provider)
        || !f5_support::selection_text(&profile)
        || [&model, &effort, &role]
            .into_iter()
            .flatten()
            .any(|value| !f5_support::selection_text(value))
    {
        return Err(usage("La selección del Attempt no es válida."));
    }
    let title = value_flag(a, "title")?;
    if title.as_deref().is_some_and(|title| {
        title.chars().count() > TITLE_MAX || title.chars().any(char::is_control)
    }) {
        return Err(usage("--title no es válido."));
    }
    let request_id = value_flag(a, "request-id")?;
    if request_id.as_deref().is_some_and(|id| {
        id.len() > REQUEST_ID_MAX
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    }) {
        return Err(usage(format!(
            "--request-id debe ser un token ASCII de hasta {REQUEST_ID_MAX} caracteres."
        )));
    }
    let context_package = value_flag(a, "context-package")?;
    if context_package.is_some() && attempt.is_none() {
        return Err(usage(
            "--context-package solo se acepta con --attempt: el paquete sale de ese Attempt.",
        ));
    }

    Ok(Some(Request {
        project: required(a, "project")?,
        task,
        attempt,
        new_task,
        file,
        line,
        end_line,
        revision,
        instruction,
        provider,
        profile,
        model,
        effort,
        role,
        title,
        context_package,
        request_id,
        dry_run: a.b("dry-run"),
    }))
}

/// De dónde nace la delegación, como lo llama el Core.
fn source_kind(request: &Request) -> &'static str {
    match (&request.task, &request.attempt) {
        (_, Some(_)) => "attempt",
        (Some(_), None) => "task",
        (None, None) => "selection",
    }
}

fn target(request: &Request) -> Value {
    json!({
        "provider": request.provider,
        "profile": request.profile,
        "model": request.model,
        "effort": request.effort,
        "role": request.role,
        "title": request.title,
    })
}

fn request_id(request: &Request, project_id: &str, package: Option<&PreparedPackage>) -> String {
    request.request_id.clone().unwrap_or_else(|| {
        f5_support::stable_request_id(
            "delegate",
            &json!({
                "project_id": project_id,
                "task": request.task,
                "attempt": request.attempt,
                "new_task": request.new_task,
                "file": request.file,
                "line": request.line,
                "end_line": request.end_line,
                "revision": request.revision,
                "instruction": request.instruction,
                "target": target(request),
                "package_id": package.map(|package| package.package_id.as_str()),
            }),
        )
    })
}

/// El origen visto por el Core, sin escribir nada: existe, es coherente, está aquí y su revisión sigue
/// vigente. Usa el mismo enlace que `attempt_delegate` valida al delegar de verdad.
fn check_source(request: &Request, project_id: &str, rpc: &mut Rpc<'_>) -> Result<Value, Failure> {
    let task_id = request.task.clone().or_else(|| {
        request
            .attempt
            .as_deref()
            .and_then(task_of_attempt)
            .map(String::from)
    });
    // `lixbon://` solo admite la revisión bajo un Attempt; sin él, el Core solo comprueba que exista.
    let link_revision = request.attempt.as_ref().and(request.revision.as_ref());
    let mut args = json!({ "project_id": project_id });
    for (key, value) in [
        ("task_id", task_id.as_ref().map(|v| json!(v))),
        ("attempt_id", request.attempt.as_ref().map(|v| json!(v))),
        ("file", request.file.as_ref().map(|v| json!(v))),
        ("line", request.line.map(|v| json!(v))),
        ("revision", link_revision.map(|v| json!(v))),
    ] {
        if let Some(value) = value {
            args[key] = value;
        }
    }
    let resolved = rpc("deep_link_generate", &args).map_err(|error| match error {
        RpcFailure::Rejected(message) => f5_support::rpc_failure(RpcFailure::Rejected(format!(
            "delegate_source_invalid: {message}"
        ))),
        other => f5_support::rpc_failure(other),
    })?;
    if resolved["status"] == "stale" {
        let revision = &resolved["revision"];
        return Err(f5_support::rpc_failure(RpcFailure::Rejected(format!(
            "delegate_source_stale: la revisión del origen ya no es la vigente (pedida {}, vigente {}); no se delega lo que había",
            revision["requested"].as_str().unwrap_or("?"),
            revision["current"].as_str().unwrap_or("desconocida"),
        ))));
    }
    let Some(link) = resolved["canonical"]
        .as_str()
        .filter(|url| url.starts_with("lixbon://"))
    else {
        return Err(Failure::Version(
            "El Core devolvió un origen que este lxo no entiende; actualiza Lixbon.".into(),
        ));
    };
    let revision = match (&request.revision, link_revision) {
        (None, _) => json!({ "state": "not_requested" }),
        (Some(_), Some(_)) => resolved["revision"].clone(),
        (Some(requested), None) => json!({ "requested": requested, "state": "not_checked" }),
    };
    Ok(json!({
        "kind": source_kind(request),
        "link": link,
        "project_id": project_id,
        "task_id": task_id,
        "attempt_id": request.attempt,
        "file": request.file,
        "line": request.line,
        "end_line": request.end_line,
        "revision": revision,
    }))
}

fn contract_error(what: &str) -> Failure {
    Failure::Version(format!(
        "El Core devolvió {what} que este lxo no entiende; actualiza Lixbon."
    ))
}

fn execute(request: Request, rpc: &mut Rpc<'_>) -> Result<Value, Failure> {
    let project_id = tasks::resolve_project(rpc, &request.project)?;
    let package = match &request.attempt {
        Some(attempt) if request.context_package.is_some() => {
            let source = f5_support::source(rpc, attempt)?;
            if source.project_id != project_id {
                return Err(usage("El Attempt origen no es del Project indicado."));
            }
            f5_support::context_package(request.context_package.as_deref(), None, &source, rpc)?
        }
        _ => None,
    };
    let package_id = package
        .as_ref()
        .map(|package| json!(package.package_id))
        .unwrap_or(Value::Null);
    let strategy = if package.is_some() {
        "context_package"
    } else {
        "clean"
    };
    let request_id = request_id(&request, &project_id, package.as_ref());
    let target = target(&request);

    if request.dry_run {
        let source = check_source(&request, &project_id, rpc)?;
        let policy = f5_support::policy_for(rpc, json!({ "project_id": project_id }), "start")?;
        return Ok(json!({
            "v": CONTRACT,
            "command": "delegate",
            "status": "dry_run",
            "request_id": request_id,
            "project_id": project_id,
            "source": source,
            "target": target,
            "context": {
                "strategy": strategy,
                "package_id": package_id,
                "summary": package.as_ref().map(|package| package.summary.clone()),
            },
            "policy": policy,
            "worktree": { "host": "local", "strategy": "own" },
        }));
    }

    let mut args = json!({
        "request_id": request_id,
        "project_id": project_id,
        "instruction": request.instruction,
        "provider": request.provider,
        "profile": request.profile,
    });
    for (key, value) in [
        ("task_id", request.task.as_ref().map(|v| json!(v))),
        ("attempt_id", request.attempt.as_ref().map(|v| json!(v))),
        ("file", request.file.as_ref().map(|v| json!(v))),
        ("line", request.line.map(|v| json!(v))),
        ("end_line", request.end_line.map(|v| json!(v))),
        ("revision", request.revision.as_ref().map(|v| json!(v))),
        ("model", request.model.as_ref().map(|v| json!(v))),
        ("effort", request.effort.as_ref().map(|v| json!(v))),
        ("role", request.role.as_ref().map(|v| json!(v))),
        ("title", request.title.as_ref().map(|v| json!(v))),
        (
            "package",
            package.as_ref().map(|package| json!(package.raw)),
        ),
    ] {
        if let Some(value) = value {
            args[key] = value;
        }
    }
    if request.new_task {
        args["new_task"] = json!(true);
    }
    let result = f5_support::send("attempt_delegate", &args, rpc)?;
    let outcome = result["status"]
        .as_str()
        .filter(|status| matches!(*status, "Requested" | "Replayed"))
        .ok_or_else(|| contract_error("una respuesta de delegación"))?;
    let task_id = result["task_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| contract_error("una delegación sin Task"))?;
    let attempt_id = result["attempt_id"]
        .as_str()
        .filter(|id| *id == format!("{task_id}-a1"))
        .ok_or_else(|| contract_error("una delegación sin el primer Attempt de su Task"))?;
    if result["strategy"].as_str() != Some(strategy)
        || result["package_id"].as_str() != package_id.as_str()
        || result["source"]["kind"].as_str() != Some(source_kind(&request))
    {
        return Err(contract_error(
            "una delegación con otro origen, estrategia o paquete del pedido",
        ));
    }
    let attempt = f5_support::current_attempt(rpc, attempt_id, task_id)?;
    let attempt_status = attempt["status"]
        .as_str()
        .expect("current_attempt valida el estado")
        .to_string();
    let approval_required = attempt_status == "pending_approval";
    let link = f5_support::attempt_link(rpc, &project_id, task_id, attempt_id);
    Ok(json!({
        "v": CONTRACT,
        "command": "delegate",
        "status": outcome,
        "request_id": request_id,
        "project_id": project_id,
        "run_id": result["run_id"],
        "task_id": task_id,
        "attempt_id": attempt_id,
        "attempt_status": attempt_status,
        "approval_required": approval_required,
        "approval_surface": if approval_required { Some("desktop") } else { None },
        "source": result["source"],
        "target": target,
        "strategy": strategy,
        "package_id": package_id,
        "package": package.as_ref().map(|package| package.summary.clone()),
        "provenance": {
            "source": result["source"],
            "strategy": strategy,
            "package_id": package_id,
        },
        "link": link,
    }))
}

fn human(data: &Value) -> String {
    let origin = format!(
        "{} {}",
        data["source"]["kind"].as_str().unwrap_or("origen"),
        data["source"]["link"].as_str().unwrap_or("")
    );
    if data["status"] == "dry_run" {
        return format!(
            "Previsualización de delegación desde {origin} → {} / {} · contexto {} · policy start: {}. \
             No se creó ninguna Task.",
            data["target"]["provider"].as_str().unwrap_or(""),
            data["target"]["profile"].as_str().unwrap_or(""),
            data["context"]["strategy"].as_str().unwrap_or(""),
            data["policy"]["category"]["level"]
                .as_str()
                .unwrap_or("desconocida"),
        );
    }
    let verb = if data["status"] == "Replayed" {
        "ya existía"
    } else {
        "creada"
    };
    let mut text = format!(
        "Delegación {verb} · Task {} · Attempt {} · receptor {} · origen {origin} · estado actual en Core: {}.",
        data["task_id"].as_str().unwrap_or(""),
        data["attempt_id"].as_str().unwrap_or(""),
        data["target"]["provider"].as_str().unwrap_or(""),
        data["attempt_status"].as_str().unwrap_or("desconocido"),
    );
    if let Some(link) = data["link"].as_str() {
        text.push_str(&format!(" Enlace: {link}"));
    }
    if data["approval_required"] == true {
        text.push_str(" Apruébalo o recházalo en Lixbon Desktop.");
    }
    text
}

pub(super) fn run(a: &Args) -> ExitCode {
    let json_output = a.b("json");
    let result = match parse(a) {
        Ok(None) => {
            print!("{HELP}");
            return ExitCode::SUCCESS;
        }
        Ok(Some(request)) => {
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
    use std::cell::RefCell;
    use std::rc::Rc;

    type Calls = Rc<RefCell<Vec<(String, Value)>>>;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|value| value.to_string()).collect())
    }

    /// Una delegación completa desde una selección de código; `extra` añade o cambia flags.
    fn selection(extra: &[&str]) -> Vec<String> {
        let mut raw: Vec<String> = [
            "delegate",
            "--project",
            "Lixbon",
            "--provider",
            "codex",
            "--profile",
            "explorar",
            "--instruction",
            "cambia el manejo de errores",
            "--file",
            "src/lib.rs",
            "--line",
            "10",
            "--end-line",
            "24",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        apply(&mut raw, extra);
        raw
    }

    /// Añade flags a la línea de órdenes; si el flag ya estaba, cambia su valor en vez de repetirlo.
    fn apply(raw: &mut Vec<String>, extra: &[&str]) {
        let mut items = extra.iter().peekable();
        while let Some(flag) = items.next() {
            let value = items
                .next_if(|next| !next.starts_with("--"))
                .map(|v| v.to_string());
            match (raw.iter().position(|arg| arg == flag), value) {
                (Some(at), Some(value)) => raw[at + 1] = value,
                (Some(_), None) => {}
                (None, value) => {
                    raw.push(flag.to_string());
                    raw.extend(value);
                }
            }
        }
    }

    fn from_attempt(extra: &[&str]) -> Vec<String> {
        let mut raw: Vec<String> = [
            "delegate",
            "--project",
            "p-1",
            "--provider",
            "codex",
            "--profile",
            "explorar",
            "--instruction",
            "continúa con otro enfoque",
            "--attempt",
            "t1-a1",
            "--new-task",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        apply(&mut raw, extra);
        raw
    }

    fn parsed(raw: Vec<String>) -> Request {
        parse(&crate::parse(raw)).unwrap().unwrap()
    }

    fn parse_error(raw: Vec<String>) -> String {
        parse(&crate::parse(raw)).unwrap_err().message().to_string()
    }

    #[test]
    fn parse_exige_origen_y_la_accion_explicita_de_crear_otra_task() {
        let none: Vec<String> = [
            "delegate",
            "--project",
            "p",
            "--provider",
            "codex",
            "--profile",
            "x",
            "--instruction",
            "hola",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert!(parse_error(none).contains("Falta el origen"));
        // Desde una Task o un Attempt: sin --new-task no se crea otra Task en silencio.
        let mut no_new = from_attempt(&[]);
        no_new.retain(|arg| arg != "--new-task");
        assert!(parse_error(no_new).contains("--new-task"));
        let mut task_only = from_attempt(&[]);
        task_only.retain(|arg| arg != "--attempt" && arg != "t1-a1");
        task_only.extend(["--task".into(), "t1".into()]);
        assert_eq!(parsed(task_only).task.as_deref(), Some("t1"));
        // Sin origen existente, --new-task no tiene sentido.
        assert!(parse_error(selection(&["--new-task"])).contains("--new-task"));
        // Coherencia Task/Attempt.
        assert!(parse_error(from_attempt(&["--task", "t2"])).contains("no es de la Task"));
        assert_eq!(
            parsed(from_attempt(&["--task", "t1"])).task.as_deref(),
            Some("t1")
        );
        assert!(parse_error(from_attempt(&["--attempt", "t1-a01"])).contains("Attempt válido"));
    }

    #[test]
    fn parse_valida_la_seleccion_como_lo_hace_el_core() {
        for bad in [
            "../secreto",
            "/etc/passwd",
            "C:\\x",
            "a\\b",
            "a//b",
            "./a",
            "a/%2e%2e/b",
            "a/%41",
        ] {
            let error = parse_error(selection(&["--file", bad]));
            assert!(error.contains("ruta relativa"), "{bad}: {error}");
        }
        assert!(parse_error(selection(&["--end-line", "5"])).contains("--end-line"));
        let mut no_file = selection(&[]);
        no_file.retain(|a| !["--file", "src/lib.rs"].contains(&a.as_str()));
        no_file.extend(["--task".into(), "t1".into(), "--new-task".into()]);
        assert!(parse_error(no_file).contains("--line necesita --file"));
        assert!(parse_error(selection(&["--line", "0"])).contains("--line"));
        assert!(parse_error(selection(&["--revision", "xyz1234"])).contains("hexadecimal"));
        assert!(parse_error(selection(&["--revision", "abc"])).contains("hexadecimal"));
        let ok = parsed(selection(&["--revision", "ABCDEF1"]));
        assert_eq!(
            ok.revision.as_deref(),
            Some("abcdef1"),
            "se normaliza a minúsculas"
        );
        assert_eq!((ok.line, ok.end_line), (Some(10), Some(24)));
    }

    #[test]
    fn parse_rechaza_lo_que_el_core_no_acepta_y_exige_receptor() {
        for flag in [
            "--host",
            "--worktree-strategy",
            "--confirm",
            "--session",
            "--wait",
        ] {
            assert!(
                parse(&crate::parse(selection(&[flag, "x"]))).is_err(),
                "{flag}"
            );
        }
        for missing in ["--provider", "--profile", "--instruction", "--project"] {
            let mut raw = selection(&[]);
            let at = raw.iter().position(|a| a == missing).unwrap();
            raw.drain(at..at + 2);
            assert!(parse_error(raw).contains(missing), "{missing}");
        }
        assert!(parse_error(selection(&["--request-id", "con espacios"])).contains("--request-id"));
        assert!(parse_error(selection(&["--context-package", "sha256:a"])).contains("--attempt"));
        assert!(parse(&args(&["delegate", "--help"])).unwrap().is_none());
        assert!(
            parse(&crate::parse(selection(&["extra"]))).is_err(),
            "sin sueltos"
        );
    }

    struct Core {
        calls: Calls,
        delegate: Value,
        link_check: Result<Value, String>,
        package_project: &'static str,
        attempt_status: &'static str,
    }

    impl Core {
        fn new() -> (Self, Calls) {
            let calls: Calls = Rc::new(RefCell::new(Vec::new()));
            (
                Self {
                    calls: calls.clone(),
                    delegate: json!({
                        "status": "Requested", "run_id": "r-2", "task_id": "t2", "attempt_id": "t2-a1",
                        "source": {
                            "kind": "selection", "link": "lixbon://project/p-1?file=src%2Flib.rs&line=10",
                            "project_id": "p-1", "file": "src/lib.rs", "line": 10, "end_line": 24
                        },
                        "strategy": "clean", "package_id": null
                    }),
                    link_check: Ok(json!({
                        "status": "ready",
                        "canonical": "lixbon://project/p-1?file=src%2Flib.rs&line=10",
                        "revision": {"requested": null, "current": null, "state": "not_requested"}
                    })),
                    package_project: "p-1",
                    attempt_status: "pending_approval",
                },
                calls,
            )
        }

        fn rpc(self) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
            move |cmd, args| {
                self.calls
                    .borrow_mut()
                    .push((cmd.to_string(), args.clone()));
                match cmd {
                    "projects_overview" => Ok(json!({
                        "v": 1, "projects": [{"id": "p-1", "name": "Lixbon"}],
                        "unassigned": {"tasks": 0}
                    })),
                    "attempt_detail" if args["attempt_id"] == "t1-a1" => Ok(json!({
                        "v": 1, "core_model": "task_attempt_v1",
                        "attempt": {"id": "t1-a1", "task_id": "t1", "status": "done", "provider": "claude"}
                    })),
                    "attempt_detail" => Ok(json!({
                        "v": 1, "core_model": "task_attempt_v1",
                        "attempt": {"id": args["attempt_id"], "task_id": "t2", "status": self.attempt_status}
                    })),
                    "task_detail_v2" => Ok(json!({
                        "v": 2, "core_model": "task_attempt_v1",
                        "task": {"id": "t1", "project_id": self.package_project, "state": "failed"}
                    })),
                    "context_package_get" => Ok(json!({
                        "status": "valid", "package": {"v": 1, "marker": "stored"}
                    })),
                    "context_package_preview" => Ok(json!({
                        "v": 1, "status": "valid", "package_id": "sha256:aaa",
                        "package": {
                            "source": {"attempt_id": "t1-a1", "task_id": "t1", "project_id": self.package_project},
                            "revision": null
                        },
                        "summary": {"objective": "arreglar el parser"}
                    })),
                    "policy_effective" => Ok(json!({
                        "v": 1, "revision": 3, "actor": {"class": "cli_person"},
                        "categories": [{"category": "start", "level": "confirm", "source": "baseline"}]
                    })),
                    "deep_link_generate" if args.get("attempt_id") == Some(&json!("t2-a1")) => {
                        Ok(json!({
                            "status": "ready", "canonical": "lixbon://project/p-1/task/t2/attempt/t2-a1"
                        }))
                    }
                    "deep_link_generate" => self.link_check.clone().map_err(RpcFailure::Rejected),
                    "attempt_delegate" => match &self.delegate {
                        Value::String(message) => Err(RpcFailure::Rejected(message.clone())),
                        other => Ok(other.clone()),
                    },
                    _ => panic!("RPC inesperado: {cmd}"),
                }
            }
        }
    }

    fn sent(calls: &Calls, cmd: &str) -> Option<Value> {
        calls
            .borrow()
            .iter()
            .find(|(name, _)| name == cmd)
            .map(|(_, args)| args.clone())
    }

    #[test]
    fn delegar_desde_una_seleccion_envia_solo_lo_pedido_y_conserva_la_procedencia() {
        let (core, calls) = Core::new();
        let mut rpc = core.rpc();
        let result = execute(parsed(selection(&["--revision", "abcdef1"])), &mut rpc).unwrap();
        let sent = sent(&calls, "attempt_delegate").unwrap();
        assert_eq!(sent["project_id"], "p-1", "el nombre se resuelve a su id");
        assert_eq!(sent["file"], "src/lib.rs");
        assert_eq!(
            (sent["line"].clone(), sent["end_line"].clone()),
            (json!(10), json!(24))
        );
        assert_eq!(sent["revision"], "abcdef1");
        assert_eq!(sent["profile"], "explorar");
        assert_eq!(sent["instruction"], "cambia el manejo de errores");
        for absent in [
            "task_id",
            "attempt_id",
            "new_task",
            "package",
            "confirm",
            "host",
            "worktree",
            "model",
        ] {
            assert!(sent.get(absent).is_none(), "{absent}");
        }
        let request_id = sent["request_id"].as_str().unwrap();
        assert!(
            request_id.starts_with("lxo-delegate-") && request_id.len() <= 60,
            "{request_id}"
        );

        assert_eq!(result["status"], "Requested");
        assert_eq!(
            (result["task_id"].clone(), result["attempt_id"].clone()),
            (json!("t2"), json!("t2-a1"))
        );
        assert_eq!(result["attempt_status"], "pending_approval");
        assert_eq!(result["approval_required"], true);
        assert_eq!(result["approval_surface"], "desktop");
        assert_eq!(result["strategy"], "clean");
        assert_eq!(result["source"]["kind"], "selection");
        assert_eq!(result["provenance"]["source"]["file"], "src/lib.rs");
        assert_eq!(result["link"], "lixbon://project/p-1/task/t2/attempt/t2-a1");
        let text = human(&result);
        assert!(
            text.contains("Task t2") && text.contains("Attempt t2-a1"),
            "{text}"
        );
        assert!(text.contains("Apruébalo"), "{text}");
        assert!(
            text.contains("lixbon://project/p-1/task/t2/attempt/t2-a1"),
            "{text}"
        );
    }

    #[test]
    fn la_clave_idempotente_es_estable_y_depende_de_la_peticion() {
        let id = |raw: Vec<String>| {
            let (core, calls) = Core::new();
            let mut rpc = core.rpc();
            execute(parsed(raw), &mut rpc).unwrap();
            sent(&calls, "attempt_delegate").unwrap()["request_id"].clone()
        };
        assert_eq!(
            id(selection(&[])),
            id(selection(&[])),
            "repetir la petición no cambia la clave"
        );
        assert_ne!(id(selection(&[])), id(selection(&["--title", "otro"])));
        assert_ne!(
            id(selection(&[])),
            id(selection(&["--instruction", "otra cosa distinta"])),
            "otro encargo es otra petición"
        );
        assert_ne!(id(selection(&[])), id(selection(&["--line", "11"])));
        assert_ne!(
            id(selection(&[])),
            id(selection(&["--revision", "abcdef1"]))
        );
        assert_eq!(id(selection(&["--request-id", "mi-clave"])), "mi-clave");
    }

    #[test]
    fn delegar_desde_un_attempt_con_paquete_envia_new_task_y_el_paquete_verificado() {
        let (mut core, calls) = Core::new();
        core.delegate["strategy"] = json!("context_package");
        core.delegate["package_id"] = json!("sha256:aaa");
        core.delegate["source"]["kind"] = json!("attempt");
        let mut rpc = core.rpc();
        let result = execute(
            parsed(from_attempt(&["--context-package", "sha256:aaa"])),
            &mut rpc,
        )
        .unwrap();
        let sent = sent(&calls, "attempt_delegate").unwrap();
        assert_eq!(sent["attempt_id"], "t1-a1");
        assert_eq!(sent["new_task"], true);
        assert!(
            sent["package"].as_str().unwrap().contains("stored"),
            "el paquete viaja como texto"
        );
        assert_eq!(result["strategy"], "context_package");
        assert_eq!(result["package_id"], "sha256:aaa");
        assert_eq!(result["package"]["objective"], "arreglar el parser");
        assert_eq!(result["provenance"]["package_id"], "sha256:aaa");
    }

    #[test]
    fn un_paquete_de_otro_project_no_se_envia() {
        let (mut core, calls) = Core::new();
        core.package_project = "p-otro";
        let mut rpc = core.rpc();
        let error = execute(
            parsed(from_attempt(&["--context-package", "sha256:aaa"])),
            &mut rpc,
        )
        .unwrap_err();
        assert!(matches!(error, Failure::Usage(_)), "{error:?}");
        assert!(sent(&calls, "attempt_delegate").is_none());
    }

    #[test]
    fn dry_run_comprueba_el_origen_y_la_policy_y_no_crea_nada() {
        let (core, calls) = Core::new();
        let mut rpc = core.rpc();
        let result = execute(
            parsed(selection(&["--revision", "abcdef1", "--dry-run"])),
            &mut rpc,
        )
        .unwrap();
        assert_eq!(result["status"], "dry_run");
        assert_eq!(result["source"]["kind"], "selection");
        assert_eq!(result["source"]["file"], "src/lib.rs");
        assert_eq!(
            result["source"]["revision"],
            json!({"requested": "abcdef1", "state": "not_checked"}),
            "sin Attempt la revisión no se puede comparar"
        );
        assert_eq!(result["policy"]["category"]["category"], "start");
        assert_eq!(result["context"]["strategy"], "clean");
        assert_eq!(
            result["worktree"],
            json!({"host": "local", "strategy": "own"})
        );
        assert!(sent(&calls, "attempt_delegate").is_none());
        let link_args = sent(&calls, "deep_link_generate").unwrap();
        assert!(
            link_args.get("revision").is_none(),
            "lixbon:// solo admite revision bajo un Attempt"
        );
        assert_eq!(link_args["file"], "src/lib.rs");
        assert!(human(&result).contains("No se creó ninguna Task"));
    }

    #[test]
    fn dry_run_con_una_revision_obsoleta_falla_igual_que_la_delegacion() {
        let (mut core, calls) = Core::new();
        core.link_check = Ok(json!({
            "status": "stale", "canonical": "lixbon://project/p-1/task/t1/attempt/t1-a1",
            "revision": {"requested": "abcdef1", "current": "9999999", "state": "stale"}
        }));
        let mut rpc = core.rpc();
        let error = execute(
            parsed(from_attempt(&["--revision", "abcdef1", "--dry-run"])),
            &mut rpc,
        )
        .unwrap_err();
        assert!(matches!(error, Failure::Stale(_)), "{error:?}");
        assert!(error.message().contains("9999999"), "dice la vigente");
        assert!(sent(&calls, "attempt_delegate").is_none());
        assert_eq!(
            sent(&calls, "deep_link_generate").unwrap()["revision"],
            "abcdef1",
            "con Attempt la revisión sí se compara"
        );
    }

    #[test]
    fn dry_run_traduce_los_codigos_de_enlace_del_core() {
        for (message, exit) in [
            ("link_not_found: el Attempt no existe en este Core", 6),
            (
                "link_host_unavailable: el Worktree del Attempt está en otra máquina",
                5,
            ),
            ("link_target_mismatch: el Attempt no es de esa Task", 2),
            (
                "link_unauthorized: solo una Person autenticada puede resolver enlaces",
                2,
            ),
        ] {
            let (mut core, _) = Core::new();
            core.link_check = Err(message.into());
            let mut rpc = core.rpc();
            let error = execute(parsed(from_attempt(&["--dry-run"])), &mut rpc).unwrap_err();
            assert_eq!(error.code().1, exit, "{message}: {error:?}");
        }
    }

    #[test]
    fn repetir_la_peticion_muestra_la_task_que_ya_existe() {
        let (mut core, _) = Core::new();
        core.delegate["status"] = json!("Replayed");
        core.attempt_status = "running";
        let mut rpc = core.rpc();
        let result = execute(parsed(selection(&[])), &mut rpc).unwrap();
        assert_eq!(result["status"], "Replayed");
        assert_eq!(result["approval_required"], false);
        assert!(result["approval_surface"].is_null());
        let text = human(&result);
        assert!(
            text.contains("ya existía") && !text.contains("Apruébalo"),
            "{text}"
        );
    }

    #[test]
    fn las_respuestas_incoherentes_del_core_son_un_error_de_contrato() {
        let cases: [(&str, Value); 5] = [
            ("status", json!("Otro")),
            ("task_id", json!("")),
            ("attempt_id", json!("t2-a2")),
            ("strategy", json!("context_package")),
            ("package_id", json!("sha256:zzz")),
        ];
        for (field, value) in cases {
            let (mut core, _) = Core::new();
            core.delegate[field] = value;
            let mut rpc = core.rpc();
            let error = execute(parsed(selection(&[])), &mut rpc).unwrap_err();
            assert!(matches!(error, Failure::Version(_)), "{field}: {error:?}");
        }
        let (mut core, _) = Core::new();
        core.delegate["source"]["kind"] = json!("attempt");
        let mut rpc = core.rpc();
        assert!(matches!(
            execute(parsed(selection(&[])), &mut rpc).unwrap_err(),
            Failure::Version(_)
        ));
    }

    #[test]
    fn los_rechazos_del_core_salen_con_su_codigo() {
        let cases = [
            (
                "delegate_source_stale: la revisión ya no es la vigente (pedida a, vigente b)",
                7,
            ),
            ("delegate_task_exists: la Task t1 ya existe", 2),
            ("delegate_invalid: `end_line` va de `line` a 10 000 000", 2),
            ("delegate_source_mismatch: el Attempt no es de esa Task", 2),
            (
                "delegate_source_unknown_revision: esa revisión no existe en el Project",
                2,
            ),
            (
                "delegate_source_invalid: link_not_found: el Attempt no existe en este Core",
                6,
            ),
            (
                "delegate_source_invalid: link_host_unavailable: el Project no tiene ubicación",
                5,
            ),
            (
                "delegate_provenance_failed: la Task t2 se creó pero no se pudo anotar",
                1,
            ),
            (
                "context_package_source_mismatch: el paquete no sale de ese Attempt",
                2,
            ),
            ("policy_denied: la policy niega «start» para cli_person", 3),
            (
                "delegar un trabajo solo está permitido a una Person autenticada",
                3,
            ),
            ("provider_environment_blocked: falta la credencial", 5),
            ("Comando desconocido: attempt_delegate", 4),
            ("request_conflict: la clave ya se usó con otra petición", 2),
        ];
        for (message, exit) in cases {
            let (mut core, _) = Core::new();
            core.delegate = json!(message);
            let mut rpc = core.rpc();
            let error = execute(parsed(selection(&[])), &mut rpc).unwrap_err();
            assert_eq!(error.code().1, exit, "{message}: {error:?}");
        }
    }

    #[test]
    fn un_project_inexistente_o_ambiguo_no_llega_a_delegar() {
        let (core, calls) = Core::new();
        let mut rpc = core.rpc();
        let mut raw = selection(&[]);
        let at = raw.iter().position(|a| a == "Lixbon").unwrap();
        raw[at] = "Otro".into();
        let error = execute(parsed(raw), &mut rpc).unwrap_err();
        assert!(matches!(error, Failure::NotFound(_)), "{error:?}");
        assert!(sent(&calls, "attempt_delegate").is_none());
    }
}
