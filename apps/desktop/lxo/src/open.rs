//! `lxo open`: genera —y, si se puede, abre— el enlace `lixbon://` de una entidad (LXO-178, sobre
//! `deep_link_generate` de LXO-168). El Core valida el destino y emite la forma canónica; lxo no inventa
//! ninguna. Un enlace no concede permisos: solo nombra un sitio por identidad durable (nunca una ruta
//! absoluta) y quien lo abre sigue necesitando acceso.
//!
//! Sin el Core (Lixbon cerrado) `--print` todavía puede generar el enlace a partir de ids dados a mano,
//! con `validated: false`: el esquema es público y estable, pero nadie ha comprobado que el destino exista.

use std::cell::Cell;
use std::process::{Command, ExitCode, Stdio};

use serde_json::{json, Value};

use crate::client_auth::{EventRequestFailure, RpcFailure};
use crate::f5_support::{self, value_flag, Rpc};
use crate::projects::{self, Failure};
use crate::tasks;
use crate::Args;

pub(super) const HELP: &str = "Uso: lxo open project <id|nombre> [opciones]
     lxo open task <task_id> [opciones]
     lxo open attempt <attempt_id> [opciones]
     lxo open review <attempt_id> [opciones]
     lxo open artifact <attempt_id> [opciones]

Genera el enlace lixbon:// de una entidad y lo abre en Lixbon Desktop. El enlace nombra el destino por
identidad durable (Project, Task, Attempt), nunca por una ruta de esta máquina, y no concede permisos:
quien lo abra necesita acceso igualmente. El Core valida que el destino exista y sea coherente.

Opciones:
  --project ID|NOMBRE   Project de la Task o el Attempt; si se omite, lo lee el Core de la Task
  --view V              overview, activity, diff, review o artifact (review y artifact ya la implican;
                        diff, review y artifact necesitan un Attempt)
  --file RUTA           archivo RELATIVO al Project o al worktree del Attempt (sin ../ ni rutas absolutas)
  --line N              línea dentro de --file
  --revision SHA        revisión en la que lo viste (7 a 64 hex); solo con un Attempt. Si ya no es la
                        vigente, lxo lo dice y no abre otra por ti (código 7)
  --print               solo imprime el enlace: no lanza ninguna aplicación
  --json                salida estructurada (v1) con el enlace canónico

Sin --print, lxo pide al sistema que abra el enlace con su manejador de lixbon:// (el que registra
Lixbon Desktop). Si el sistema no lo tiene, lo dice y el código de salida es 5: el enlace sigue siendo
válido y --print lo imprime. Con Lixbon cerrado, --print genera el enlace sin validarlo si das los ids a
mano (para Task y Attempt, --project con el id del Project) y lo marca con validated: false.

Códigos de salida: 0 correcto, 1 error interno, 2 uso, 3 autenticación, 4 versión o contrato,
5 Lixbon cerrado, worktree en otra máquina o sin manejador de lixbon://, 6 destino inexistente,
7 revisión obsoleta.
";

const CONTRACT: u64 = 1;
const FLAGS: [&str; 7] = [
    "project", "view", "file", "line", "revision", "print", "json",
];
const VIEWS: [&str; 5] = ["overview", "activity", "diff", "review", "artifact"];
const ID_MAX: usize = 200;
const LINE_MAX: u64 = 10_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Project,
    Task,
    Attempt,
    Review,
    Artifact,
}

impl Kind {
    fn parse(name: &str) -> Option<Kind> {
        Some(match name {
            "project" => Kind::Project,
            "task" => Kind::Task,
            "attempt" => Kind::Attempt,
            "review" => Kind::Review,
            "artifact" => Kind::Artifact,
            _ => return None,
        })
    }

    /// La vista que el propio tipo implica.
    fn implied_view(self) -> Option<&'static str> {
        match self {
            Kind::Review => Some("review"),
            Kind::Artifact => Some("artifact"),
            _ => None,
        }
    }

    fn is_attempt(self) -> bool {
        matches!(self, Kind::Attempt | Kind::Review | Kind::Artifact)
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Request {
    kind: Kind,
    id: String,
    project: Option<String>,
    view: Option<String>,
    file: Option<String>,
    line: Option<u32>,
    revision: Option<String>,
    print: bool,
}

fn usage(message: impl Into<String>) -> Failure {
    Failure::Usage(message.into())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= ID_MAX
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn parse(a: &Args) -> Result<Option<Request>, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(None);
    }
    if let Some(name) = a.flags.keys().find(|name| !FLAGS.contains(&name.as_str())) {
        return Err(usage(format!(
            "--{name} no es una opción de lxo open. Mira `lxo open --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["print", "json"] {
        if a.flags.get(name).is_some_and(|value| !value.is_boolean()) {
            return Err(usage(format!("--{name} no admite un valor.")));
        }
    }
    let (kind, id) = match a.pos.get(1..) {
        Some([kind, id]) => {
            let kind = Kind::parse(kind).ok_or_else(|| {
                usage(format!(
                    "«{kind}» no es algo que lxo open sepa abrir: project, task, attempt, review o artifact."
                ))
            })?;
            (kind, id.trim().to_string())
        }
        Some([]) | None => {
            return Err(usage(
                "Falta qué abrir: lxo open <project|task|attempt|review|artifact> <id>.",
            ))
        }
        Some([_]) => return Err(usage("Falta el id de lo que quieres abrir.")),
        _ => return Err(usage("lxo open recibe un solo id.")),
    };
    if id.is_empty() || id.chars().count() > ID_MAX || id.chars().any(char::is_control) {
        return Err(usage("El id no es válido."));
    }
    let project = value_flag(a, "project")?;
    if kind == Kind::Project && project.is_some() {
        return Err(usage(
            "--project no se combina con `lxo open project`: el Project es el propio id.",
        ));
    }
    let view = value_flag(a, "view")?;
    if let Some(view) = &view {
        if !VIEWS.contains(&view.as_str()) {
            return Err(usage(format!(
                "--view «{view}» no existe: overview, activity, diff, review o artifact."
            )));
        }
    }
    if let (Some(view), Some(implied)) = (&view, kind.implied_view()) {
        if view != implied {
            return Err(usage(format!(
                "`lxo open {}` ya implica la vista {implied}: --view {view} la contradice.",
                match kind {
                    Kind::Review => "review",
                    _ => "artifact",
                }
            )));
        }
    }
    let effective_view = kind.implied_view().map(String::from).or(view);
    let file = value_flag(a, "file")?;
    if let Some(file) = &file {
        f5_support::check_relative_file(file)?;
    }
    let line = match value_flag(a, "line")? {
        None => None,
        Some(text) => Some(
            text.parse::<u64>()
                .ok()
                .filter(|n| (1..=LINE_MAX).contains(n))
                .map(|n| n as u32)
                .ok_or_else(|| usage(format!("--line debe ser un entero entre 1 y {LINE_MAX}.")))?,
        ),
    };
    let revision = value_flag(a, "revision")?.map(|rev| rev.to_ascii_lowercase());
    // Las mismas comprobaciones entre campos que hace el Core al generar: fallan antes de preguntar.
    if let Some(view) = effective_view.as_deref() {
        if matches!(view, "diff" | "review" | "artifact") && !kind.is_attempt() {
            return Err(usage(format!(
                "La vista {view} necesita un Attempt concreto: usa `lxo open attempt <attempt_id> --view {view}`."
            )));
        }
        if file.is_some() && matches!(view, "overview" | "activity") {
            return Err(usage(format!("La vista {view} no abre archivos.")));
        }
    }
    if line.is_some() && file.is_none() {
        return Err(usage("--line necesita --file."));
    }
    if let Some(revision) = &revision {
        if !kind.is_attempt() {
            return Err(usage(
                "--revision se compara con la de un Attempt: usa `lxo open attempt <attempt_id>`.",
            ));
        }
        if !(7..=64).contains(&revision.len()) || !revision.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(usage(
                "--revision es un hash hexadecimal de 7 a 64 caracteres.",
            ));
        }
    }
    Ok(Some(Request {
        kind,
        id,
        project,
        view: effective_view,
        file,
        line,
        revision,
        print: a.b("print"),
    }))
}

/// El destino ya con sus ids resueltos: lo que se pide al Core y, sin Core, lo que se escribe a mano.
#[derive(Debug, PartialEq, Eq)]
struct Target {
    project_id: String,
    task_id: Option<String>,
    attempt_id: Option<String>,
    view: Option<String>,
    file: Option<String>,
    line: Option<u32>,
    revision: Option<String>,
}

impl Target {
    fn of(request: &Request, project_id: String) -> Result<Target, Failure> {
        let (task_id, attempt_id) = match request.kind {
            Kind::Project => (None, None),
            Kind::Task => (Some(request.id.clone()), None),
            _ => {
                let task = f5_support::task_of_attempt(&request.id).ok_or_else(|| {
                    usage("El id no es el de un Attempt (<tarea>-a<n>): para una Task usa `lxo open task`.")
                })?;
                (Some(task.to_string()), Some(request.id.clone()))
            }
        };
        Ok(Target {
            project_id,
            task_id,
            attempt_id,
            view: request.view.clone(),
            file: request.file.clone(),
            line: request.line,
            revision: request.revision.clone(),
        })
    }

    /// Los argumentos de `deep_link_generate`: solo lo que hay.
    fn link_args(&self) -> Value {
        let mut args = json!({ "project_id": self.project_id });
        for (key, value) in [
            ("task_id", self.task_id.as_ref().map(|v| json!(v))),
            ("attempt_id", self.attempt_id.as_ref().map(|v| json!(v))),
            ("view", self.view.as_ref().map(|v| json!(v))),
            ("file", self.file.as_ref().map(|v| json!(v))),
            ("line", self.line.map(|v| json!(v))),
            ("revision", self.revision.as_ref().map(|v| json!(v))),
        ] {
            if let Some(value) = value {
                args[key] = value;
            }
        }
        args
    }

    fn to_json(&self) -> Value {
        json!({
            "project_id": self.project_id,
            "task_id": self.task_id,
            "attempt_id": self.attempt_id,
            "view": self.view,
            "file": self.file,
            "line": self.line,
            "revision": self.revision,
        })
    }

    /// La forma canónica del esquema v1 sin preguntar al Core (ver `docs/core/DEEP_LINKS.md`): segmentos fijos,
    /// claves en el orden `view, file, line, revision` y `file` con todo lo que no sea `A-Za-z0-9-._~/` en `%XX`.
    fn local_url(&self) -> Result<String, Failure> {
        let ids = [
            Some(&self.project_id),
            self.task_id.as_ref(),
            self.attempt_id.as_ref(),
        ];
        if ids.into_iter().flatten().any(|id| !valid_id(id)) {
            return Err(usage(
                "Sin el Core, un id solo puede llevar letras, dígitos, `.`, `_` y `-`.",
            ));
        }
        let mut url = format!("lixbon://project/{}", self.project_id);
        if let Some(task) = &self.task_id {
            url.push_str(&format!("/task/{task}"));
        }
        if let Some(attempt) = &self.attempt_id {
            url.push_str(&format!("/attempt/{attempt}"));
        }
        let mut query = Vec::new();
        if let Some(view) = &self.view {
            query.push(format!("view={view}"));
        }
        if let Some(file) = &self.file {
            let mut encoded = String::new();
            for b in file.bytes() {
                if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~' | b'/') {
                    encoded.push(b as char);
                } else {
                    encoded.push_str(&format!("%{b:02X}"));
                }
            }
            query.push(format!("file={encoded}"));
        }
        if let Some(line) = self.line {
            query.push(format!("line={line}"));
        }
        if let Some(revision) = &self.revision {
            query.push(format!("revision={revision}"));
        }
        if !query.is_empty() {
            url.push('?');
            url.push_str(&query.join("&"));
        }
        Ok(url)
    }
}

/// El Project de una Task, leído del Core.
fn project_of_task(rpc: &mut Rpc<'_>, task_id: &str) -> Result<String, Failure> {
    let detail = f5_support::send("task_detail_v2", &json!({ "task_id": task_id }), rpc)?;
    if detail["v"].as_u64() != Some(2)
        || detail["core_model"].as_str() != Some("task_attempt_v1")
        || detail["task"]["id"].as_str() != Some(task_id)
    {
        return Err(Failure::Version(
            "El Core devolvió una Task con un formato que este lxo no entiende; actualiza Lixbon."
                .into(),
        ));
    }
    detail["task"]["project_id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .map(String::from)
        .ok_or_else(|| usage("La Task no pertenece a ningún Project: no hay enlace posible."))
}

/// Con el Core: resuelve los ids (el Project sale de la Task si no se dio) y deja que el Core emita el enlace.
fn online(request: &Request, rpc: &mut Rpc<'_>) -> Result<(String, Value, Value), Failure> {
    let project_id = match (request.kind, &request.project) {
        (Kind::Project, _) => tasks::resolve_project(rpc, &request.id)?,
        (_, Some(project)) => tasks::resolve_project(rpc, project)?,
        (Kind::Task, None) => project_of_task(rpc, &request.id)?,
        (_, None) => {
            let task = f5_support::task_of_attempt(&request.id).ok_or_else(|| {
                usage("El id no es el de un Attempt (<tarea>-a<n>): para una Task usa `lxo open task`.")
            })?;
            project_of_task(rpc, task)?
        }
    };
    let target = Target::of(request, project_id)?;
    let resolved = f5_support::send("deep_link_generate", &target.link_args(), rpc)?;
    let canonical = resolved["canonical"]
        .as_str()
        .filter(|url| url.starts_with("lixbon://"))
        .ok_or_else(|| {
            Failure::Version(
                "El Core devolvió un enlace que este lxo no entiende; actualiza Lixbon.".into(),
            )
        })?;
    match resolved["status"].as_str() {
        Some("ready") => {}
        Some("stale") => {
            let revision = &resolved["revision"];
            return Err(Failure::Stale(match revision["current"].as_str() {
                Some(current) => format!(
                    "La revisión {} ya no es la vigente del Attempt ({current}). lxo no abre otra por ti: \
                     repite con --revision {current} si quieres la vigente.",
                    revision["requested"].as_str().unwrap_or("pedida")
                ),
                None => format!(
                    "El Core no conoce ninguna revisión de ese Attempt, así que no puede confirmar la {}.",
                    revision["requested"].as_str().unwrap_or("pedida")
                ),
            }));
        }
        _ => {
            return Err(Failure::Version(
                "El Core devolvió un estado de enlace que este lxo no entiende; actualiza Lixbon."
                    .into(),
            ))
        }
    }
    Ok((
        canonical.to_string(),
        resolved["target"].clone(),
        resolved["revision"].clone(),
    ))
}

/// Sin el Core: solo con ids dados a mano, y siempre marcado como no validado.
fn offline(request: &Request, why: Failure) -> Result<Value, Failure> {
    let hint = "Con --print y el id del Project (--project <id>; para un Project, su id) \
                lxo genera el enlace sin validarlo.";
    let why = why.message().trim_end_matches('.').to_string();
    if !request.print {
        return Err(Failure::Unavailable(format!(
            "{why}. No se puede validar ni abrir el enlace sin Lixbon abierto. {hint}"
        )));
    }
    let project_id = match (request.kind, &request.project) {
        (Kind::Project, _) => request.id.clone(),
        (_, Some(project)) => project.clone(),
        (_, None) => {
            return Err(Failure::Unavailable(format!(
                "{why}. Sin ese dato lxo no puede saber el Project. {hint}"
            )))
        }
    };
    let target = Target::of(request, project_id)?;
    let link = target.local_url()?;
    Ok(data(
        "printed",
        &link,
        false,
        target.to_json(),
        Value::Null,
        false,
    ))
}

fn data(
    status: &str,
    link: &str,
    validated: bool,
    target: Value,
    revision: Value,
    launched: bool,
) -> Value {
    json!({
        "v": CONTRACT,
        "command": "open",
        "status": status,
        "link": link,
        "validated": validated,
        "target": target,
        "revision": revision,
        "launched": launched,
    })
}

type Launch<'a> = dyn FnMut(&str) -> Result<(), String> + 'a;

fn execute(
    request: &Request,
    rpc: &mut Rpc<'_>,
    launch: &mut Launch<'_>,
) -> Result<Value, Failure> {
    let down = Cell::new(false);
    let mut watched = |cmd: &str, args: &Value| {
        let result = rpc(cmd, args);
        if matches!(
            &result,
            Err(RpcFailure::Transport(
                EventRequestFailure::CoreUnavailable(_) | EventRequestFailure::Network(_)
            ))
        ) {
            down.set(true);
        }
        result
    };
    let (link, target, revision) = match online(request, &mut watched) {
        Ok(found) => found,
        Err(error) if down.get() => return offline(request, error),
        Err(error) => return Err(error),
    };
    if request.print {
        return Ok(data("printed", &link, true, target, revision, false));
    }
    launch(&link).map_err(|reason| {
        Failure::Unavailable(format!(
            "No se pudo abrir Lixbon Desktop: {reason}. El enlace es válido ({link}); --print lo imprime \
             para abrirlo desde otro sitio."
        ))
    })?;
    Ok(data("opened", &link, true, target, revision, true))
}

/// Pide al sistema que abra el enlace con su manejador de `lixbon://`. Sin manejador registrado no lanza nada:
/// abrir un esquema desconocido haría saltar un diálogo del sistema en vez de abrir Lixbon.
#[cfg(windows)]
fn os_launch(url: &str) -> Result<(), String> {
    let registered = Command::new("reg")
        .args(["query", r"HKCR\lixbon"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success());
    if !registered {
        return Err(
            "este sistema no tiene un manejador de lixbon:// (lo registra Lixbon Desktop)".into(),
        );
    }
    run_to_end(Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]))
}

#[cfg(target_os = "macos")]
fn os_launch(url: &str) -> Result<(), String> {
    run_to_end(Command::new("open").arg(url))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn os_launch(url: &str) -> Result<(), String> {
    let handler = Command::new("xdg-mime")
        .args(["query", "default", "x-scheme-handler/lixbon"])
        .stderr(Stdio::null())
        .output()
        .map_err(|_| {
            "no se encontró xdg-mime para comprobar el manejador de lixbon://".to_string()
        })?;
    if String::from_utf8_lossy(&handler.stdout).trim().is_empty() {
        return Err(
            "este sistema no tiene un manejador de lixbon:// (lo registra Lixbon Desktop)".into(),
        );
    }
    run_to_end(Command::new("xdg-open").arg(url))
}

#[cfg(not(any(windows, unix)))]
fn os_launch(_url: &str) -> Result<(), String> {
    Err("este sistema no sabe abrir enlaces lixbon://".into())
}

fn run_to_end(command: &mut Command) -> Result<(), String> {
    let status = command
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("no se pudo lanzar el manejador del sistema ({error})"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "el manejador del sistema terminó con {}",
            status
                .code()
                .map_or("una señal".to_string(), |c| c.to_string())
        ))
    }
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
            execute(&request, &mut rpc, &mut os_launch)
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
                let link = data["link"].as_str().unwrap_or_default();
                if data["launched"] == true {
                    println!("Abierto en Lixbon Desktop: {link}");
                } else {
                    println!("{link}");
                }
                if data["validated"] == false {
                    eprintln!(
                        "lxo: aviso: el Core no está disponible; el enlace no se ha validado."
                    );
                }
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

    fn request(raw: &[&str]) -> Request {
        parse(&args(raw)).unwrap().unwrap()
    }

    fn parse_error(raw: &[&str]) -> String {
        parse(&args(raw)).unwrap_err().message().to_string()
    }

    enum Generate {
        Ready(&'static str),
        Stale(Option<&'static str>),
        Reject(&'static str),
        Down,
    }

    struct Core {
        generate: Generate,
    }

    impl Core {
        fn rpc(self, calls: Calls) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
            move |cmd, args| {
                calls.borrow_mut().push((cmd.to_string(), args.clone()));
                if matches!(self.generate, Generate::Down) {
                    return Err(RpcFailure::Transport(EventRequestFailure::CoreUnavailable(
                        "El Core de Lixbon no está disponible.".into(),
                    )));
                }
                match cmd {
                    "projects_overview" => Ok(json!({
                        "v": 1, "projects": [{"id": "p-1", "name": "Lixbon"}], "unassigned": {"tasks": 0}
                    })),
                    "task_detail_v2" => Ok(json!({
                        "v": 2, "core_model": "task_attempt_v1",
                        "task": {"id": args["task_id"], "project_id": "p-1", "state": "failed"}
                    })),
                    "deep_link_generate" => match &self.generate {
                        Generate::Ready(link) => Ok(json!({
                            "v": 1, "status": "ready", "canonical": link,
                            "target": {"project_id": "p-1", "task_id": args["task_id"], "attempt_id": args["attempt_id"],
                                       "view": args["view"], "file": args["file"], "line": args["line"], "revision": args["revision"]},
                            "revision": {"requested": args["revision"], "current": null, "state": "not_requested"}
                        })),
                        Generate::Stale(current) => Ok(json!({
                            "v": 1, "status": "stale", "code": "link_stale",
                            "canonical": "lixbon://project/p-1/task/t1/attempt/t1-a1?revision=abcdef1",
                            "revision": {"requested": "abcdef1", "current": current, "state": "stale"}
                        })),
                        Generate::Reject(message) => Err(RpcFailure::Rejected((*message).into())),
                        Generate::Down => unreachable!(),
                    },
                    _ => panic!("RPC inesperado: {cmd}"),
                }
            }
        }
    }

    fn calls() -> Calls {
        Rc::new(RefCell::new(Vec::new()))
    }

    fn sent(calls: &Calls, cmd: &str) -> Option<Value> {
        calls
            .borrow()
            .iter()
            .find(|(name, _)| name == cmd)
            .map(|(_, args)| args.clone())
    }

    fn no_launch() -> impl FnMut(&str) -> Result<(), String> {
        |_| panic!("no debía lanzar nada")
    }

    const ATTEMPT_LINK: &str =
        "lixbon://project/p-1/task/t1/attempt/t1-a1?view=diff&file=src/a.rs&line=3";

    #[test]
    fn parse_pide_un_tipo_y_un_id_y_rechaza_lo_que_no_conoce() {
        assert!(parse_error(&["open"]).contains("Falta qué abrir"));
        assert!(parse_error(&["open", "task"]).contains("Falta el id"));
        assert!(parse_error(&["open", "task", "t1", "t2"]).contains("un solo id"));
        assert!(
            parse_error(&["open", "carpeta", "x"]).contains("no es algo que lxo open sepa abrir")
        );
        assert!(parse_error(&["open", "task", "t1", "--host", "x"]).contains("--host"));
        assert!(
            parse_error(&["open", "task", "t1", "--print", "--print"]).contains("más de una vez")
        );
        assert!(parse_error(&["open", "task", "t1", "--print=si"]).contains("no admite un valor"));
        assert!(parse(&args(&["open", "--help"])).unwrap().is_none());
        // Un Attempt tiene que parecer uno.
        let raw = request(&["open", "attempt", "t1"]);
        assert!(Target::of(&raw, "p-1".into())
            .unwrap_err()
            .message()
            .contains("Attempt"));
    }

    #[test]
    fn review_y_artifact_implican_su_vista_y_no_admiten_otra() {
        assert_eq!(
            request(&["open", "review", "t1-a1"]).view.as_deref(),
            Some("review")
        );
        assert_eq!(
            request(&["open", "artifact", "t1-a1"]).view.as_deref(),
            Some("artifact")
        );
        assert_eq!(
            request(&["open", "review", "t1-a1", "--view", "review"])
                .view
                .as_deref(),
            Some("review")
        );
        assert!(parse_error(&["open", "review", "t1-a1", "--view", "diff"]).contains("ya implica"));
        assert!(parse_error(&["open", "task", "t1", "--view", "mapa"]).contains("no existe"));
    }

    #[test]
    fn parse_aplica_las_mismas_reglas_entre_campos_que_el_core() {
        // Las vistas de un Attempt necesitan un Attempt.
        for view in ["diff", "review", "artifact"] {
            assert!(
                parse_error(&["open", "task", "t1", "--view", view])
                    .contains("necesita un Attempt"),
                "{view}"
            );
            assert!(
                parse_error(&["open", "project", "p", "--view", view])
                    .contains("necesita un Attempt"),
                "{view}"
            );
        }
        assert_eq!(
            request(&["open", "task", "t1", "--view", "activity"])
                .view
                .as_deref(),
            Some("activity")
        );
        // Un resumen no abre archivos; una línea necesita archivo; una revisión necesita Attempt.
        assert!(
            parse_error(&["open", "attempt", "t1-a1", "--view", "overview", "--file", "a.rs"])
                .contains("no abre archivos")
        );
        assert!(parse_error(&["open", "attempt", "t1-a1", "--line", "3"])
            .contains("--line necesita --file"));
        assert!(
            parse_error(&["open", "task", "t1", "--revision", "abcdef1"]).contains("de un Attempt")
        );
        assert!(
            parse_error(&["open", "attempt", "t1-a1", "--revision", "xyz1234"])
                .contains("hexadecimal")
        );
        assert!(
            parse_error(&["open", "attempt", "t1-a1", "--revision", "abc"]).contains("hexadecimal")
        );
        assert!(
            parse_error(&["open", "attempt", "t1-a1", "--revision", "abcdef"])
                .contains("hexadecimal"),
            "6 caracteres no bastan"
        );
        assert!(
            parse_error(&["open", "attempt", "t1-a1", "--view", "activity", "--file", "a.rs"])
                .contains("no abre archivos")
        );
        assert_eq!(
            request(&["open", "attempt", "t1-a1", "--revision", "ABCDEF1"])
                .revision
                .as_deref(),
            Some("abcdef1")
        );
        for line in ["0", "-1", "x", "10000001"] {
            assert!(
                parse_error(&["open", "attempt", "t1-a1", "--file", "a.rs", "--line", line])
                    .contains("--line"),
                "{line}"
            );
        }
        assert!(parse_error(&["open", "project", "p", "--project", "q"]).contains("no se combina"));
    }

    #[test]
    fn un_file_absoluto_o_con_traversal_nunca_llega_al_core() {
        for bad in [
            "../secreto",
            "/etc/passwd",
            "C:\\x",
            "a\\b",
            "a//b",
            "./a",
            "a/%2e%2e/b",
        ] {
            let calls = calls();
            let error = parse(&args(&["open", "attempt", "t1-a1", "--file", bad])).unwrap_err();
            assert!(matches!(error, Failure::Usage(_)), "{bad}");
            assert!(calls.borrow().is_empty());
        }
    }

    #[test]
    fn abrir_un_attempt_pide_el_enlace_al_core_con_el_project_de_su_task() {
        let calls = calls();
        let mut rpc = Core {
            generate: Generate::Ready(ATTEMPT_LINK),
        }
        .rpc(calls.clone());
        let result = execute(
            &request(&[
                "open", "attempt", "t1-a1", "--view", "diff", "--file", "src/a.rs", "--line", "3",
                "--print",
            ]),
            &mut rpc,
            &mut no_launch(),
        )
        .unwrap();
        assert_eq!(
            sent(&calls, "deep_link_generate").unwrap(),
            json!({"project_id": "p-1", "task_id": "t1", "attempt_id": "t1-a1", "view": "diff", "file": "src/a.rs", "line": 3}),
            "solo lo que hay: ni nulos ni rutas de esta máquina"
        );
        assert_eq!(
            sent(&calls, "task_detail_v2").unwrap()["task_id"],
            "t1",
            "el Project sale de la Task del Attempt"
        );
        assert_eq!(
            (result["status"].as_str(), result["link"].as_str()),
            (Some("printed"), Some(ATTEMPT_LINK))
        );
        assert_eq!(
            (
                result["validated"].clone(),
                result["launched"].clone(),
                result["v"].clone()
            ),
            (json!(true), json!(false), json!(1))
        );
        assert_eq!(result["target"]["attempt_id"], "t1-a1");
    }

    #[test]
    fn project_task_review_y_artifact_piden_lo_que_nombran() {
        let cases: [(&[&str], Value); 5] = [
            (&["open", "project", "Lixbon"], json!({"project_id": "p-1"})),
            (&["open", "project", "p-1"], json!({"project_id": "p-1"})),
            (
                &["open", "task", "t1"],
                json!({"project_id": "p-1", "task_id": "t1"}),
            ),
            (
                &["open", "review", "t1-a2"],
                json!({"project_id": "p-1", "task_id": "t1", "attempt_id": "t1-a2", "view": "review"}),
            ),
            (
                &["open", "artifact", "t1-a2", "--project", "Lixbon"],
                json!({"project_id": "p-1", "task_id": "t1", "attempt_id": "t1-a2", "view": "artifact"}),
            ),
        ];
        for (raw, expected) in cases {
            let calls = calls();
            let mut rpc = Core {
                generate: Generate::Ready("lixbon://project/p-1"),
            }
            .rpc(calls.clone());
            let mut with_print = raw.to_vec();
            with_print.push("--print");
            execute(&request(&with_print), &mut rpc, &mut no_launch()).unwrap();
            assert_eq!(
                sent(&calls, "deep_link_generate").unwrap(),
                expected,
                "{raw:?}"
            );
        }
        // Con --project dado, no hace falta leer la Task: el Core comprueba la coherencia.
        let calls = calls();
        let mut rpc = Core {
            generate: Generate::Ready("lixbon://project/p-1"),
        }
        .rpc(calls.clone());
        execute(
            &request(&["open", "task", "t1", "--project", "p-1", "--print"]),
            &mut rpc,
            &mut no_launch(),
        )
        .unwrap();
        assert!(sent(&calls, "task_detail_v2").is_none());
    }

    #[test]
    fn sin_print_abre_el_enlace_validado_y_con_print_no_lanza_nada() {
        let launched = Rc::new(RefCell::new(Vec::new()));
        let seen = launched.clone();
        let mut launch = move |url: &str| {
            seen.borrow_mut().push(url.to_string());
            Ok(())
        };
        let mut rpc = Core {
            generate: Generate::Ready(ATTEMPT_LINK),
        }
        .rpc(calls());
        let result = execute(
            &request(&["open", "attempt", "t1-a1"]),
            &mut rpc,
            &mut launch,
        )
        .unwrap();
        assert_eq!(
            *launched.borrow(),
            [ATTEMPT_LINK],
            "lanza el enlace canónico del Core, no uno propio"
        );
        assert_eq!(
            (result["status"].as_str(), result["launched"].as_bool()),
            (Some("opened"), Some(true))
        );

        let mut rpc = Core {
            generate: Generate::Ready(ATTEMPT_LINK),
        }
        .rpc(calls());
        execute(
            &request(&["open", "attempt", "t1-a1", "--print"]),
            &mut rpc,
            &mut no_launch(),
        )
        .unwrap();
    }

    #[test]
    fn si_el_sistema_no_puede_abrirlo_el_enlace_sigue_valido_y_sale_con_5() {
        let mut rpc = Core {
            generate: Generate::Ready(ATTEMPT_LINK),
        }
        .rpc(calls());
        let mut launch =
            |_: &str| Err("este sistema no tiene un manejador de lixbon://".to_string());
        let error = execute(
            &request(&["open", "attempt", "t1-a1"]),
            &mut rpc,
            &mut launch,
        )
        .unwrap_err();
        assert_eq!(error.code().1, 5);
        assert!(
            error.message().contains(ATTEMPT_LINK) && error.message().contains("--print"),
            "{}",
            error.message()
        );
    }

    #[test]
    fn una_revision_obsoleta_no_se_abre_y_dice_cual_es_la_vigente() {
        for (current, needle) in [(Some("9999999"), "9999999"), (None, "ninguna revisión")] {
            let calls = calls();
            let mut rpc = Core {
                generate: Generate::Stale(current),
            }
            .rpc(calls.clone());
            let error = execute(
                &request(&["open", "attempt", "t1-a1", "--revision", "abcdef1"]),
                &mut rpc,
                &mut no_launch(),
            )
            .unwrap_err();
            assert_eq!(error.code(), ("stale", 7));
            assert!(error.message().contains(needle), "{}", error.message());
            assert!(error.message().contains("abcdef1") || current.is_none());
            assert_eq!(
                sent(&calls, "deep_link_generate").unwrap()["revision"],
                "abcdef1",
                "la revisión viaja al Core, que es quien sabe cuál es la vigente"
            );
        }
    }

    #[test]
    fn los_codigos_de_enlace_del_core_salen_con_su_codigo_de_salida() {
        let cases = [
            ("link_not_found: el Attempt no existe en este Core", 6),
            (
                "link_host_unavailable: el Worktree del Attempt está en otra máquina",
                5,
            ),
            ("link_target_mismatch: el Attempt no es de esa Task", 2),
            ("link_malformed: `file` es relativo", 2),
            ("link_version_unsupported: el enlace usa la versión 2", 2),
            (
                "link_unauthorized: solo una Person autenticada puede resolver enlaces",
                3,
            ),
            ("Comando desconocido: deep_link_generate", 4),
            ("core_model_inactive: el Core aún no usa Task/Attempt", 4),
        ];
        for (message, exit) in cases {
            let mut rpc = Core {
                generate: Generate::Reject(message),
            }
            .rpc(calls());
            let error = execute(
                &request(&["open", "attempt", "t1-a1", "--print"]),
                &mut rpc,
                &mut no_launch(),
            )
            .unwrap_err();
            assert_eq!(error.code().1, exit, "{message}: {error:?}");
        }
    }

    #[test]
    fn con_lixbon_cerrado_print_genera_el_enlace_sin_validar_si_se_dan_los_ids() {
        let down = || {
            Core {
                generate: Generate::Down,
            }
            .rpc(calls())
        };
        let result = execute(
            &request(&[
                "open",
                "attempt",
                "t1-a1",
                "--project",
                "p-1",
                "--view",
                "diff",
                "--file",
                "src/a.rs",
                "--line",
                "3",
                "--print",
            ]),
            &mut down(),
            &mut no_launch(),
        )
        .unwrap();
        assert_eq!(
            result["link"], ATTEMPT_LINK,
            "es la forma canónica del esquema, sin preguntar a nadie"
        );
        assert_eq!(
            (
                result["validated"].clone(),
                result["status"].clone(),
                result["launched"].clone()
            ),
            (json!(false), json!("printed"), json!(false))
        );
        assert_eq!(result["target"]["task_id"], "t1");

        let project = execute(
            &request(&["open", "project", "p-1", "--print"]),
            &mut down(),
            &mut no_launch(),
        )
        .unwrap();
        assert_eq!(project["link"], "lixbon://project/p-1");
        let task = execute(
            &request(&["open", "task", "t1", "--project", "p-1", "--print"]),
            &mut down(),
            &mut no_launch(),
        )
        .unwrap();
        assert_eq!(task["link"], "lixbon://project/p-1/task/t1");

        // Sin ids a mano, sin --print o con ids que el Core tendría que resolver, no se inventa nada.
        for raw in [
            &["open", "task", "t1", "--print"][..],
            &["open", "attempt", "t1-a1", "--project", "p-1"][..],
            &["open", "project", "p-1"][..],
        ] {
            let error = execute(&request(raw), &mut down(), &mut no_launch()).unwrap_err();
            assert_eq!(error.code().1, 5, "{raw:?}: {error:?}");
            assert!(
                error.message().contains("--print") || error.message().contains("Lixbon abierto"),
                "{}",
                error.message()
            );
        }
        let named = execute(
            &request(&["open", "project", "Mi proyecto", "--print"]),
            &mut down(),
            &mut no_launch(),
        )
        .unwrap_err();
        assert_eq!(
            named.code().0,
            "usage",
            "un nombre no se resuelve sin el Core: {named:?}"
        );
    }

    #[test]
    fn el_enlace_local_codifica_la_ruta_como_el_core() {
        let target = |view: Option<&str>, file: &str, revision: Option<&str>| Target {
            project_id: "p-1".into(),
            task_id: Some("t1".into()),
            attempt_id: Some("t1-a1".into()),
            view: view.map(String::from),
            file: Some(file.into()),
            line: Some(7),
            revision: revision.map(String::from),
        };
        assert_eq!(
            target(Some("review"), "src/a b/ñ#.rs", Some("abcdef1")).local_url().unwrap(),
            "lixbon://project/p-1/task/t1/attempt/t1-a1?view=review&file=src/a%20b/%C3%B1%23.rs&line=7&revision=abcdef1"
        );
        assert_eq!(
            target(None, "README.md", None).local_url().unwrap(),
            "lixbon://project/p-1/task/t1/attempt/t1-a1?file=README.md&line=7"
        );
        assert_eq!(
            target(None, "src/a~b.rs", None).local_url().unwrap(),
            "lixbon://project/p-1/task/t1/attempt/t1-a1?file=src/a~b.rs&line=7",
            "la tilde es de las que no se codifican"
        );
        let mut bad = target(None, "a.rs", None);
        bad.project_id = "p 1".into();
        assert!(
            bad.local_url().is_err(),
            "un id con caracteres no permitidos no se escribe"
        );
        bad.project_id = "..".into();
        assert!(bad.local_url().is_err());
    }
}
