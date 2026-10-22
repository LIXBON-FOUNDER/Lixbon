//! `lxo tasks` y `lxo task show`: Tasks del Core por Project, de solo lectura (LXO-104).
//!
//! Son Tasks del modelo legacy y se presentan como tales (`task_model: "legacy"`), nunca como Attempts.
//! La fuente es la lectura `list` del Core por el RPC autenticado: lxo no lee `state.json`. Hasta que el
//! Core publique la query de Tasks por Project (LXO-91), `list_tasks` es el único punto que la usa; el
//! `--json` de lxo es una allowlist propia que no cambia al sustituir la fuente.

use serde_json::{json, Value};

use crate::client_auth::{self, RpcFailure};
use crate::events::{clean, timestamp_utc};
use crate::projects::{failure, finish, usage, Failure};
use crate::Args;

pub(super) const HELP: &str =
    "Uso: lxo tasks [--project ID|NOMBRE] [--active | --final] [--status S] [--run ID] [--json]
     lxo task show <task_id> [--json]          (también: lxo tasks show <task_id>)

Las tareas que conoce el Core de Lixbon (modelo legacy: tarea raíz e hijas por
run), en árbol. Solo lee: no lanza, reintenta, reanuda ni marca nada como leído.

Filtros (se combinan con AND):
  --project P        id o nombre del proyecto (el nombre se resuelve con el overview del Core)
  --active           solo las que siguen en marcha
  --final            solo las terminadas (done, failed, stopped, exited)
  --status S         starting, running, waiting, awaiting_terminal_approval, done, failed,
                     stopped o exited
  --run ID           solo las de ese run

Salida:
  (por defecto)      dos líneas por tarea: id, estado y título; proyecto, run, agente y rama
  --json             {v, task_model, tasks}; show da {v, task_model, task, children}
  Lo que el modelo legacy no registra (host) sale como null o «desconocido».

`lxo task show <id>` añade fase, padre y raíz, worktree, fechas y cómo seguirla con
lxo events --task <id> y lxo attention --task <id>.

Códigos de salida: 0 correcto, 1 error interno del Core, 2 uso o filtro inválido,
3 autenticación, 4 versión o contrato, 5 Lixbon cerrado o Core no disponible,
6 tarea o proyecto inexistente.
";

const CONTRACT: u64 = 1;
const STATUSES: [&str; 8] = [
    "starting",
    "running",
    "waiting",
    "awaiting_terminal_approval",
    "done",
    "failed",
    "stopped",
    "exited",
];
/// Estados finales del vocabulario del Core (`Status::is_final`).
const FINAL: [&str; 4] = ["done", "failed", "stopped", "exited"];
const LIST_FLAGS: [&str; 7] = [
    "project", "active", "final", "status", "run", "json", "help",
];

type Rpc<'a> = &'a mut dyn FnMut(&str, &Value) -> Result<Value, RpcFailure>;

#[derive(Debug, Default, PartialEq, Eq)]
struct Filters {
    project: Option<String>,
    status: Option<String>,
    run: Option<String>,
    active: bool,
    finished: bool,
}

enum Request {
    Help,
    List(Filters),
    Show(String),
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
            "--{name} no es una opción de {command}. Mira `lxo tasks --help`."
        )));
    }
    if let Some(name) = a.duplicates.first() {
        return Err(usage(format!("--{name} aparece más de una vez.")));
    }
    for name in ["active", "final", "json", "help"] {
        if a.flags.get(name).is_some_and(|v| !v.is_boolean()) {
            return Err(usage(format!(
                "--{name} no admite un valor; úsalo como indicador."
            )));
        }
    }
    Ok(())
}

/// `lxo tasks …` y `lxo task show <id>` (también `lxo tasks show <id>`).
fn parse(a: &Args) -> Result<Request, Failure> {
    if a.b("help") || a.at(1).as_deref() == Some("help") {
        return Ok(Request::Help);
    }
    if a.at(0).as_deref() == Some("task") || a.at(1).as_deref() == Some("show") {
        if a.at(1).as_deref() != Some("show") {
            return Err(usage(
                "Uso: lxo task show <task_id>. Para la lista: lxo tasks.",
            ));
        }
        check_flags(a, &["json", "help"], "lxo task show")?;
        return match (a.at(2), a.at(3)) {
            (Some(id), None) if !id.trim().is_empty() => Ok(Request::Show(id)),
            (None, _) => Err(usage("Falta el id: lxo task show <task_id>.")),
            _ => Err(usage("`lxo task show` recibe un solo id.")),
        };
    }
    if let Some(extra) = a.at(1) {
        return Err(usage(format!(
            "lxo tasks no admite argumentos sueltos ({extra}). Para una tarea: lxo task show <id>."
        )));
    }
    check_flags(a, &LIST_FLAGS, "lxo tasks")?;
    let filters = Filters {
        project: text_flag(a, "project")?,
        status: text_flag(a, "status")?,
        run: text_flag(a, "run")?,
        active: a.b("active"),
        finished: a.b("final"),
    };
    if filters.active && filters.finished {
        return Err(usage("--active y --final se excluyen: usa uno o ninguno."));
    }
    if let Some(status) = &filters.status {
        if !STATUSES.contains(&status.as_str()) {
            return Err(usage(format!(
                "--status no reconoce «{status}»; usa {}.",
                STATUSES.join(", ")
            )));
        }
    }
    Ok(Request::List(filters))
}

fn contract_error() -> Failure {
    Failure::Version(
        "El Core devolvió tareas con un formato que este lxo no entiende; actualiza Lixbon.".into(),
    )
}

/// Fuente única de Tasks: la lectura legacy `list` del Core (todas las que ve esta identidad, en
/// árbol: cada raíz seguida de sus hijas). Se sustituye por la query de LXO-91 cuando exista.
fn list_tasks(rpc: Rpc) -> Result<Vec<Value>, Failure> {
    let data = rpc("list", &json!({})).map_err(failure)?;
    let tasks = data["tasks"].as_array().ok_or_else(contract_error)?;
    if tasks
        .iter()
        .any(|t| !t["id"].is_string() || !t["status"].is_string())
    {
        return Err(contract_error());
    }
    Ok(tasks.clone())
}

/// Resuelve `--project` por id o por nombre con el overview del Core (también archivados).
fn resolve_project(rpc: Rpc, wanted: &str) -> Result<String, Failure> {
    let data = rpc("projects_overview", &json!({ "archived": "include" })).map_err(failure)?;
    let projects = data["projects"].as_array().ok_or_else(contract_error)?;
    if let Some(p) = projects.iter().find(|p| p["id"].as_str() == Some(wanted)) {
        return Ok(p["id"].as_str().unwrap_or_default().to_string());
    }
    let by_name: Vec<&Value> = projects
        .iter()
        .filter(|p| {
            p["name"]
                .as_str()
                .is_some_and(|n| n.to_lowercase() == wanted.to_lowercase())
        })
        .collect();
    match by_name.as_slice() {
        [one] => Ok(one["id"].as_str().unwrap_or_default().to_string()),
        [] => Err(Failure::NotFound(format!(
            "No hay ningún proyecto con id o nombre «{}». Míralos con lxo projects --all.",
            clean(wanted)
        ))),
        many => Err(usage(format!(
            "Hay {} proyectos llamados «{}»; usa su id: {}.",
            many.len(),
            clean(wanted),
            many.iter()
                .filter_map(|p| p["id"].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

fn find<'a>(tasks: &'a [Value], id: &str) -> Option<&'a Value> {
    tasks.iter().find(|t| t["id"].as_str() == Some(id))
}

/// La raíz del árbol: el primer antepasado sin padre. `None` si la cadena se corta (padre que esta
/// identidad no ve): mejor desconocido que inventado.
fn root_of(tasks: &[Value], task: &Value) -> Option<String> {
    let mut current = task;
    for _ in 0..=tasks.len() {
        match current["parent"].as_str() {
            None => return current["id"].as_str().map(String::from),
            Some(parent) => current = find(tasks, parent)?,
        }
    }
    None
}

fn text(value: &Value) -> Value {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null)
}

/// Allowlist del `--json` de lxo: lo que el modelo legacy sabe, y `null` para lo que no registra.
fn dto(tasks: &[Value], t: &Value) -> Value {
    let status = t["status"].as_str().unwrap_or("");
    let phase = t["phases"]
        .as_array()
        .and_then(|p| p.last())
        .map(|p| json!({ "name": text(&p["name"]), "done": p["done"].as_bool().unwrap_or(false) }))
        .unwrap_or(Value::Null);
    let model = [&t["model_effective"], &t["model"]]
        .into_iter()
        .map(text)
        .find(|m| !m.is_null())
        .unwrap_or(Value::Null);
    json!({
        "id": text(&t["id"]),
        "title": text(&t["title"]),
        "project_id": text(&t["project_id"]),
        "run_id": text(&t["run"]),
        "root_id": root_of(tasks, t),
        "parent_id": text(&t["parent"]),
        "depth": t["depth"].as_u64(),
        "status": status,
        "final": FINAL.contains(&status),
        "phase": phase,
        "provider": text(&t["agent"]),
        "model": model,
        "role": text(&t["role"]),
        "branch": text(&t["branch"]),
        "base": text(&t["base"]),
        "worktree": text(&t["worktree"]),
        "shared_checkout": t["parent"].is_string() && t["worktree"].as_str().is_none_or(str::is_empty),
        "cwd": text(&t["cwd"]),
        "host": null,
        "origin": if t["external"].as_bool() == Some(true) { "external" } else { "lixbon" },
        "created_at": t["created"].as_u64(),
        "updated_at": t["updated"].as_u64(),
        "failure_reason": text(&t["failure_reason"]),
        "merged": t["merged"].as_bool().unwrap_or(false),
        "pr_url": text(&t["pr_url"]),
    })
}

fn list_data(rpc: Rpc, filters: &Filters) -> Result<Value, Failure> {
    let project = match &filters.project {
        Some(wanted) => Some(resolve_project(rpc, wanted)?),
        None => None,
    };
    let tasks = list_tasks(rpc)?;
    let selected: Vec<Value> = tasks
        .iter()
        .map(|t| dto(&tasks, t))
        .filter(|d| {
            project.as_deref().is_none_or(|p| d["project_id"] == p)
                && filters.run.as_deref().is_none_or(|r| d["run_id"] == r)
                && filters.status.as_deref().is_none_or(|s| d["status"] == s)
                && (!filters.active || d["final"] == false)
                && (!filters.finished || d["final"] == true)
        })
        .collect();
    Ok(json!({ "v": CONTRACT, "task_model": "legacy", "tasks": selected }))
}

fn show_data(rpc: Rpc, id: &str) -> Result<Value, Failure> {
    let tasks = list_tasks(rpc)?;
    let task = find(&tasks, id).ok_or_else(|| {
        Failure::NotFound(format!(
            "No existe la tarea {} o no es visible para esta identidad.",
            clean(id)
        ))
    })?;
    let children: Vec<Value> = tasks
        .iter()
        .filter(|t| t["parent"].as_str() == Some(id))
        .map(|t| text(&t["id"]))
        .collect();
    Ok(
        json!({ "v": CONTRACT, "task_model": "legacy", "task": dto(&tasks, task), "children": children }),
    )
}

fn status_text(code: &str) -> String {
    match code {
        "starting" => "arrancando".into(),
        "running" => "en curso".into(),
        "waiting" => "esperando respuesta".into(),
        "awaiting_terminal_approval" => "esperando aprobación".into(),
        "done" => "terminada".into(),
        "failed" => "fallida".into(),
        "stopped" => "detenida".into(),
        "exited" => "salió".into(),
        other => clean(other),
    }
}

fn field(d: &Value, name: &str) -> Option<String> {
    d[name].as_str().map(clean)
}

fn agent_text(d: &Value) -> String {
    match (field(d, "provider"), field(d, "model")) {
        (Some(p), Some(m)) => format!("{p} ({m})"),
        (Some(p), None) => p,
        (None, Some(m)) => m,
        (None, None) => "agente desconocido".into(),
    }
}

fn place_text(d: &Value) -> String {
    match field(d, "branch") {
        Some(branch) => format!("rama {branch}"),
        None if d["shared_checkout"] == true => "checkout compartido".into(),
        None => "sin rama".into(),
    }
}

fn task_lines(d: &Value) -> String {
    let indent = "  ".repeat(d["depth"].as_u64().unwrap_or(0).min(8) as usize);
    format!(
        "{indent}{} · {} · {}\n{indent}  {} · run {} · {} · {}",
        field(d, "id").unwrap_or_default(),
        status_text(d["status"].as_str().unwrap_or("?")),
        field(d, "title").unwrap_or_else(|| "(sin título)".into()),
        match (field(d, "project_name"), field(d, "project_id")) {
            (Some(name), _) => format!("proyecto {name}"),
            (None, Some(id)) => format!("proyecto {id}"),
            (None, None) => "sin proyecto".into(),
        },
        field(d, "run_id").unwrap_or_else(|| "—".into()),
        agent_text(d),
        place_text(d),
    )
}

fn list_text(data: &Value, filtered: bool) -> String {
    let tasks = data["tasks"].as_array().cloned().unwrap_or_default();
    if tasks.is_empty() {
        return if filtered {
            "Ninguna tarea cumple estos filtros.".into()
        } else {
            "Sin tareas. Aparecen al lanzar un run desde Lixbon o con lxo run create.".into()
        };
    }
    tasks.iter().map(task_lines).collect::<Vec<_>>().join("\n")
}

fn when(d: &Value, name: &str) -> String {
    d[name]
        .as_u64()
        .map(|ms| timestamp_utc(ms as i64))
        .unwrap_or_else(|| "—".into())
}

fn show_text(data: &Value) -> String {
    let d = &data["task"];
    let id = field(d, "id").unwrap_or_default();
    let dash = |v: Option<String>| v.unwrap_or_else(|| "—".into());
    let phase = match (d["phase"]["name"].as_str(), d["phase"]["done"].as_bool()) {
        (Some(name), Some(true)) => format!(" · fase «{}» hecha", clean(name)),
        (Some(name), _) => format!(" · fase «{}» en curso", clean(name)),
        _ => String::new(),
    };
    let children: Vec<String> = data["children"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| c.as_str().map(clean))
        .collect();
    let worktree = match field(d, "worktree") {
        Some(w) => w,
        None if d["shared_checkout"] == true => {
            format!("checkout compartido ({})", dash(field(d, "cwd")))
        }
        None => dash(field(d, "cwd")),
    };
    let mut lines = vec![
        format!("{id} · {}", dash(field(d, "title"))),
        format!(
            "  Estado:      {}{phase}",
            status_text(d["status"].as_str().unwrap_or("?"))
        ),
        format!(
            "  Proyecto:    {}",
            match (field(d, "project_name"), field(d, "project_id")) {
                (Some(name), Some(id)) => format!("{name} ({id})"),
                (_, Some(id)) => id,
                _ => "sin proyecto".into(),
            }
        ),
        format!(
            "  Run:         {} · raíz {} · padre {}",
            dash(field(d, "run_id")),
            field(d, "root_id").unwrap_or_else(|| "desconocida".into()),
            dash(field(d, "parent_id"))
        ),
        format!(
            "  Hijas:       {}",
            if children.is_empty() {
                "ninguna".into()
            } else {
                children.join(", ")
            }
        ),
        format!("  Agente:      {}", agent_text(d)),
        format!("  Rol:         {}", dash(field(d, "role"))),
        format!(
            "  Rama:        {}{}",
            dash(field(d, "branch")),
            field(d, "base")
                .map(|b| format!(" (base {b})"))
                .unwrap_or_default()
        ),
        format!("  Worktree:    {worktree}"),
        format!(
            "  Origen:      {} · host desconocido (el modelo legacy no lo registra)",
            if d["origin"] == "external" {
                "coordinador externo"
            } else {
                "Lixbon"
            }
        ),
        format!("  Creada:      {}", when(d, "created_at")),
        format!("  Actualizada: {}", when(d, "updated_at")),
    ];
    if let Some(reason) = field(d, "failure_reason") {
        lines.push(format!("  Fallo:       {reason}"));
    }
    if let Some(pr) = field(d, "pr_url") {
        lines.push(format!("  PR:          {pr}"));
    }
    lines.push(format!(
        "  Seguir:      lxo events --task {id} · lxo attention --task {id}"
    ));
    lines.join("\n")
}

/// Solo para la salida humana: el nombre de cada Project según el overview del Core. Si no se puede
/// leer (un agente no ve el overview) se queda el id; el `--json` lleva siempre solo `project_id`.
fn name_projects(rpc: Rpc, tasks: &mut [Value]) {
    let Ok(data) = rpc("projects_overview", &json!({ "archived": "include" })) else {
        return;
    };
    let projects = data["projects"].as_array().cloned().unwrap_or_default();
    for task in tasks {
        if let Some(name) = projects
            .iter()
            .find(|p| p["id"] == task["project_id"] && !task["project_id"].is_null())
            .and_then(|p| p["name"].as_str())
        {
            task["project_name"] = json!(name);
        }
    }
}

fn execute(request: Request, json: bool) -> Result<(), Failure> {
    let mut rpc = |cmd: &str, args: &Value| client_auth::rpc(cmd, args, &crate::cwd());
    match request {
        Request::Help => print!("{HELP}"),
        Request::List(filters) => {
            let mut data = list_data(&mut rpc, &filters)?;
            if json {
                println!("{data}");
            } else {
                if let Some(tasks) = data["tasks"].as_array_mut() {
                    name_projects(&mut rpc, tasks);
                }
                println!("{}", list_text(&data, filters != Filters::default()));
            }
        }
        Request::Show(id) => {
            let mut data = show_data(&mut rpc, &id)?;
            if json {
                println!("{data}");
            } else {
                name_projects(&mut rpc, std::slice::from_mut(&mut data["task"]));
                println!("{}", show_text(&data));
            }
        }
    }
    Ok(())
}

pub(super) fn run(a: &Args) -> std::process::ExitCode {
    let json = a.b("json");
    finish(parse(a).and_then(|request| execute(request, json)), json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(raw: &[&str]) -> Args {
        crate::parse(raw.iter().map(|s| s.to_string()).collect())
    }

    fn filters(raw: &[&str]) -> Result<Filters, Failure> {
        match parse(&args(raw))? {
            Request::List(f) => Ok(f),
            _ => panic!("se esperaba la lista"),
        }
    }

    /// Tareas legacy tal como las serializa el Core (con campos internos que lxo no debe copiar).
    fn legacy(id: &str, parent: Option<&str>, depth: u64, status: &str) -> Value {
        json!({
            "id": id, "run": "r1", "parent": parent, "depth": depth, "agent": "claude",
            "model": "sonnet", "model_effective": null, "role": null, "title": format!("tarea {id}"),
            "spec": "texto privado del encargo", "repo": "C:/r/api", "project_id": "p-api",
            "cwd": "C:/r/api", "branch": null, "base": null, "worktree": null, "status": status,
            "phases": [], "summary": "", "files": [], "external": false, "merged": false,
            "pr_url": null, "requested_argv": ["claude", "--secret-flag"], "created": 1_760_000_000_000u64,
            "updated": 1_760_000_060_000u64
        })
    }

    /// root t1 (externa, en curso) → t2 (worktree propio, fallida) y t3 (checkout compartido, esperando);
    /// otro run r2 sin proyecto.
    fn fixture() -> Vec<Value> {
        let mut root = legacy("t1", None, 0, "running");
        root["external"] = json!(true);
        root["phases"] = json!([{ "name": "plan", "done": true, "note": "", "at": 1 }, { "name": "tests", "done": false, "note": "", "at": 2 }]);
        let mut wt = legacy("t2", Some("t1"), 1, "failed");
        wt["branch"] = json!("lxo/t2");
        wt["base"] = json!("main");
        wt["worktree"] = json!("C:/r/api-wt/t2");
        wt["model_effective"] = json!("claude-sonnet-4");
        wt["failure_reason"] = json!("agent_idle_timeout");
        let shared = legacy("t3", Some("t1"), 1, "waiting");
        let mut other = legacy("t9", None, 0, "done");
        other["run"] = json!("r2");
        other["project_id"] = Value::Null;
        other["agent"] = Value::Null;
        other["model"] = Value::Null;
        vec![root, wt, shared, other]
    }

    fn core(tasks: Vec<Value>) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        move |cmd, args| match cmd {
            "list" => {
                assert_eq!(
                    args,
                    &json!({}),
                    "list se pide sin sesión ni run: todo lo visible"
                );
                Ok(json!({ "tasks": tasks.clone() }))
            }
            "projects_overview" => Ok(json!({ "v": 1, "projects": [
                { "id": "p-api", "name": "api" }, { "id": "p-a", "name": "dup" }, { "id": "p-b", "name": "Dup" }
            ], "unassigned": {} })),
            other => panic!("comando inesperado {other}"),
        }
    }

    fn ids(data: &Value) -> Vec<String> {
        data["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["id"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn filtros_de_proyecto_estado_y_run() {
        let list =
            |raw: &[&str]| ids(&list_data(&mut core(fixture()), &filters(raw).unwrap()).unwrap());
        assert_eq!(list(&["tasks"]), ["t1", "t2", "t3", "t9"]);
        assert_eq!(list(&["tasks", "--project", "api"]), ["t1", "t2", "t3"]);
        assert_eq!(
            list(&["tasks", "--project", "p-api", "--active"]),
            ["t1", "t3"]
        );
        assert_eq!(list(&["tasks", "--final"]), ["t2", "t9"]);
        assert_eq!(list(&["tasks", "--status", "waiting"]), ["t3"]);
        assert_eq!(list(&["tasks", "--run", "r2"]), ["t9"]);
    }

    #[test]
    fn proyecto_inexistente_o_ambiguo() {
        let fail = |p: &str| {
            list_data(
                &mut core(fixture()),
                &filters(&["tasks", "--project", p]).unwrap(),
            )
            .unwrap_err()
        };
        assert_eq!(fail("nada").code().1, 6);
        let ambiguous = fail("dup");
        assert_eq!(ambiguous.code().1, 2);
        assert!(ambiguous.message().contains("p-a, p-b"), "{ambiguous:?}");
    }

    #[test]
    fn uso_invalido_se_rechaza_antes_de_llamar_al_core() {
        for raw in [
            &["tasks", "t1"][..],
            &["tasks", "--active", "--final"],
            &["tasks", "--status", "working"],
            &["tasks", "--estado", "x"],
            &["tasks", "--project"],
            &["tasks", "--active=si"],
            &["task"],
            &["task", "ver", "t1"],
            &["task", "show"],
            &["task", "show", "t1", "t2"],
            &["task", "show", "t1", "--project", "p"],
        ] {
            let failure = parse(&args(raw))
                .err()
                .unwrap_or_else(|| panic!("{raw:?} debía fallar"));
            assert_eq!(failure.code().1, 2, "{raw:?}: {failure:?}");
        }
    }

    #[test]
    fn fixtures_root_child_shared_y_worktree() {
        let tasks = fixture();
        let root = dto(&tasks, &tasks[0]);
        let wt = dto(&tasks, &tasks[1]);
        let shared = dto(&tasks, &tasks[2]);
        assert_eq!(
            (
                root["root_id"].clone(),
                root["parent_id"].clone(),
                root["origin"].clone()
            ),
            (json!("t1"), Value::Null, json!("external"))
        );
        assert_eq!(root["phase"], json!({ "name": "tests", "done": false }));
        assert_eq!(
            (
                wt["root_id"].clone(),
                wt["worktree"].clone(),
                wt["shared_checkout"].clone()
            ),
            (json!("t1"), json!("C:/r/api-wt/t2"), json!(false))
        );
        assert_eq!(
            wt["model"], "claude-sonnet-4",
            "el modelo efectivo manda sobre el pedido"
        );
        assert_eq!(
            (wt["final"].clone(), wt["failure_reason"].clone()),
            (json!(true), json!("agent_idle_timeout"))
        );
        assert_eq!(
            (shared["shared_checkout"].clone(), shared["branch"].clone()),
            (json!(true), Value::Null)
        );
        let other = dto(&tasks, &tasks[3]);
        assert_eq!(
            (
                other["provider"].clone(),
                other["model"].clone(),
                other["project_id"].clone()
            ),
            (Value::Null, Value::Null, Value::Null),
            "lo desconocido queda null"
        );
        assert_eq!(root["host"], Value::Null);
        // Una hija cuyo padre no se ve tiene raíz desconocida, no inventada.
        let orphan = legacy("t5", Some("no-visible"), 1, "running");
        assert_eq!(dto(&[orphan.clone()], &orphan)["root_id"], Value::Null);
    }

    #[test]
    fn snapshot_json_contractual_sin_campos_internos() {
        let data = show_data(&mut core(fixture()), "t2").unwrap();
        assert_eq!(
            data.to_string(),
            r#"{"children":[],"task":{"base":"main","branch":"lxo/t2","created_at":1760000000000,"cwd":"C:/r/api","depth":1,"failure_reason":"agent_idle_timeout","final":true,"host":null,"id":"t2","merged":false,"model":"claude-sonnet-4","origin":"lixbon","parent_id":"t1","phase":null,"pr_url":null,"project_id":"p-api","provider":"claude","role":null,"root_id":"t1","run_id":"r1","shared_checkout":false,"status":"failed","title":"tarea t2","updated_at":1760000060000,"worktree":"C:/r/api-wt/t2"},"task_model":"legacy","v":1}"#
        );
        let all = list_data(&mut core(fixture()), &Filters::default())
            .unwrap()
            .to_string();
        for private in [
            "texto privado",
            "secret-flag",
            "requested_argv",
            "spec",
            "Attempt",
            "attempt",
        ] {
            assert!(!all.contains(private), "el JSON no copia {private}");
        }
        assert_eq!(
            show_data(&mut core(fixture()), "t1").unwrap()["children"],
            json!(["t2", "t3"])
        );
    }

    #[test]
    fn tarea_inexistente_da_un_error_estable() {
        let missing = show_data(&mut core(fixture()), "t404").unwrap_err();
        assert_eq!(
            missing,
            Failure::NotFound(
                "No existe la tarea t404 o no es visible para esta identidad.".into()
            )
        );
        assert_eq!(missing.code(), ("not_found", 6));
    }

    #[test]
    fn errores_del_core_y_contrato() {
        let mut down = |_: &str, _: &Value| -> Result<Value, RpcFailure> {
            Err(RpcFailure::Transport(
                client_auth::EventRequestFailure::Network("cerrado".into()),
            ))
        };
        assert_eq!(list_tasks(&mut down).unwrap_err().code().1, 5);
        let mut broken = |_: &str, _: &Value| Ok(json!({ "tasks": [{ "id": 1 }] }));
        assert_eq!(list_tasks(&mut broken).unwrap_err().code().1, 4);
    }

    #[test]
    fn snapshot_humano_en_arbol_y_estado_vacio() {
        let data = list_data(
            &mut core(fixture()),
            &filters(&["tasks", "--project", "api"]).unwrap(),
        )
        .unwrap();
        assert_eq!(
            list_text(&data, true),
            "t1 · en curso · tarea t1\n  proyecto p-api · run r1 · claude (sonnet) · sin rama\n  \
             t2 · fallida · tarea t2\n    proyecto p-api · run r1 · claude (claude-sonnet-4) · rama lxo/t2\n  \
             t3 · esperando respuesta · tarea t3\n    proyecto p-api · run r1 · claude (sonnet) · checkout compartido"
        );
        let empty = json!({ "v": 1, "task_model": "legacy", "tasks": [] });
        assert!(list_text(&empty, false).starts_with("Sin tareas."));
        assert_eq!(
            list_text(&empty, true),
            "Ninguna tarea cumple estos filtros."
        );
    }

    #[test]
    fn detalle_y_terminal_estrecha() {
        let text = show_text(&show_data(&mut core(fixture()), "t2").unwrap());
        assert!(
            text.starts_with("t2 · tarea t2\n  Estado:      fallida\n"),
            "{text}"
        );
        assert!(
            text.contains("  Run:         r1 · raíz t1 · padre t1"),
            "{text}"
        );
        assert!(text.contains("  Rama:        lxo/t2 (base main)"), "{text}");
        assert!(text.contains("  Worktree:    C:/r/api-wt/t2"), "{text}");
        assert!(text.contains("host desconocido"), "{text}");
        assert!(text.contains("  Fallo:       agent_idle_timeout"), "{text}");
        assert!(
            text.ends_with("  Seguir:      lxo events --task t2 · lxo attention --task t2"),
            "{text}"
        );
        let root = show_text(&show_data(&mut core(fixture()), "t1").unwrap());
        assert!(
            root.contains("en curso · fase «tests» en curso")
                && root.contains("Hijas:       t2, t3")
                && root.contains("coordinador externo"),
            "{root}"
        );
        let mut evil = fixture();
        evil[2]["title"] = json!("x\u{1b}[2Jy");
        let lines = list_text(
            &list_data(&mut core(evil), &Filters::default()).unwrap(),
            false,
        );
        assert!(lines.contains("x?[2Jy"), "{lines}");
        for line in lines
            .lines()
            .chain(text.lines())
            .filter(|l| !l.contains(":/"))
        {
            assert!(line.chars().count() <= 80, "{line}");
        }
    }

    #[test]
    fn el_nombre_del_proyecto_es_solo_para_la_salida_humana() {
        let mut data = list_data(
            &mut core(fixture()),
            &filters(&["tasks", "--run", "r1"]).unwrap(),
        )
        .unwrap();
        name_projects(&mut core(fixture()), data["tasks"].as_array_mut().unwrap());
        assert!(list_text(&data, true).starts_with(
            "t1 · en curso · tarea t1
  proyecto api · run r1"
        ));
        // Sin overview (un agente no lo ve) se queda el id.
        let mut denied = |_: &str, _: &Value| -> Result<Value, RpcFailure> {
            Err(RpcFailure::Rejected(
                "projects_overview_auth_required".into(),
            ))
        };
        let mut plain = list_data(
            &mut core(fixture()),
            &filters(&["tasks", "--run", "r1"]).unwrap(),
        )
        .unwrap();
        name_projects(&mut denied, plain["tasks"].as_array_mut().unwrap());
        assert!(list_text(&plain, true).contains("proyecto p-api"));
        let mut detail = show_data(&mut core(fixture()), "t2").unwrap();
        name_projects(
            &mut core(fixture()),
            std::slice::from_mut(&mut detail["task"]),
        );
        assert!(show_text(&detail).contains("  Proyecto:    api (p-api)"));
    }

    #[test]
    fn tasks_show_es_un_alias_de_task_show() {
        for raw in [
            &["task", "show", "t5"][..],
            &["tasks", "show", "t5"],
            &["tasks", "show", "t5", "--json"],
        ] {
            assert!(
                matches!(parse(&args(raw)), Ok(Request::Show(id)) if id == "t5"),
                "{raw:?}"
            );
        }
        assert_eq!(parse(&args(&["tasks", "show"])).err().unwrap().code().1, 2);
    }
}
