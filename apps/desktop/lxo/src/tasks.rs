//! `lxo tasks` y `lxo task show`: Tasks del Core por Project, de solo lectura (LXO-104, LXO-38).
//!
//! Son Tasks del modelo legacy y se presentan como tales (`task_model: "legacy"`), nunca como Attempts.
//! La fuente son las queries del Core por el RPC autenticado, como Person (`docs/core/QUERIES.md`):
//! `projects_overview` para los Projects, `tasks_by_project` para la lista, `task_detail` para la ficha y
//! `activity_list` para su Activity. lxo no lee `state.json` ni las lecturas `list`/`show` del orquestador.
//! El `--json` es una allowlist propia de lxo.

use serde_json::{json, Value};

use crate::client_auth::{self, RpcFailure};
use crate::events::{clean, timestamp_utc};
use crate::projects::{failure, finish, usage, Failure};
use crate::Args;

pub(super) const HELP: &str =
    "Uso: lxo tasks [--project ID|NOMBRE] [--active | --final] [--status S] [--run ID] [--json]
     lxo tasks --json --schema 2 [--project ID|NOMBRE] [--state S] [--run ID]
     lxo task show <id o nombre> [--json]      (también: lxo tasks show …)
     lxo task show <task_id> --json --schema 2

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
  --json             forma 1 (por defecto): {v: 1, task_model: \"legacy\", tasks,
                     unassigned_tasks}; show da {v, task_model, task, children, activity}
  --json --schema 2  forma 2, modelo Task/Attempt (tras el corte): la tarea sin nada
                     de la ejecución y sus intentos por id (attempt_id), sin elegir
                     ninguno. Filtra por el estado de la tarea con --state (open,
                     in_progress, in_review, integrated o discarded); show va por id.
  Matriz y paso de la forma 1 a la 2: docs/core/LXO_CORTE.md.
  Lo que el modelo legacy no registra (host) sale como null o «desconocido».
  Las tareas sin proyecto no se listan: se cuentan al final.

`lxo task show <id o nombre>` añade fase, padre y raíz, worktree, fechas, la
actividad reciente y cómo seguirla con lxo events --task <id> y lxo attention
--task <id>. El nombre es el título de la tarea, sin distinguir mayúsculas ni acentos: vale el
título exacto o un trozo; si encajan varias, lxo dice sus ids.

Con el Core ya en el modelo Task/Attempt (tras el corte), el agente, la rama, el
worktree, el fallo y el PR son los del intento actual y lxo lo avisa en stderr;
cada ejecución se ve con lxo attempts --task <id> y lxo attempt show <attempt_id>.

Solo para personas: dentro de una tarea del orquestador, usa lxo list y lxo show.

Códigos de salida: 0 correcto, 1 error interno del Core, 2 uso o filtro inválido,
3 autenticación, 4 versión o contrato (también: --schema 2 antes del corte),
5 Lixbon cerrado o Core no disponible, 6 tarea o proyecto inexistente. El aviso de
compatibilidad no cambia el código ni sale con --json.
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
const LIST_FLAGS: [&str; 9] = [
    "project", "active", "final", "status", "state", "run", "schema", "json", "help",
];
/// Estado derivado de la Task (`contracts/status-vocabulary.json` `task_derived_state`), para `--state`.
const STATES: [&str; 5] = ["open", "in_progress", "in_review", "integrated", "discarded"];
/// Forma del `--json` vNext (LXO-125): `{v: 2, task_model: "task_attempt_v1"}`.
const CONTRACT_V2: u64 = 2;
const MODEL_V2: &str = "task_attempt_v1";

type Rpc<'a> = &'a mut dyn FnMut(&str, &Value) -> Result<Value, RpcFailure>;

#[derive(Debug, Default, PartialEq, Eq)]
struct Filters {
    project: Option<String>,
    status: Option<String>,
    state: Option<String>,
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
            return Err(usage(match a.at(1) {
                Some(other) if "show".starts_with(&other) || other.starts_with("sh") => format!(
                    "«{}» no es una orden de lxo task; ¿querías lxo task show <id o nombre>?",
                    clean(&other)
                ),
                _ => "Uso: lxo task show <id o nombre>. Para la lista: lxo tasks.".into(),
            }));
        }
        check_flags(a, &["json", "schema", "help"], "lxo task show")?;
        let wanted = task_wanted(&a.pos[2.min(a.pos.len())..]);
        return if wanted.is_empty() {
            Err(usage("Falta la tarea: lxo task show <id o nombre>."))
        } else {
            Ok(Request::Show(wanted))
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
        state: text_flag(a, "state")?,
        run: text_flag(a, "run")?,
        active: a.b("active"),
        finished: a.b("final"),
    };
    if let Some(state) = &filters.state {
        if !STATES.contains(&state.as_str()) {
            return Err(usage(format!(
                "--state no reconoce «{}»; usa {}.",
                clean(state),
                STATES.join(", ")
            )));
        }
    }
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

/// Lo que se pide a `task show`: las palabras juntas (un nombre con espacios no necesita comillas) y sin
/// las comillas que las rodeen, porque el chat del CLI pasa cada palabra tal cual.
fn task_wanted(words: &[String]) -> String {
    let joined = words.join(" ");
    let trimmed = joined.trim();
    for q in ['"', '\''] {
        if trimmed.len() >= 2 && trimmed.starts_with(q) && trimmed.ends_with(q) {
            return trimmed[1..trimmed.len() - 1].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn contract_error() -> Failure {
    Failure::Version(
        "El Core devolvió tareas con un formato que este lxo no entiende; actualiza Lixbon.".into(),
    )
}

/// Tasks por página de `tasks_by_project` (el máximo que acepta el Core).
const PAGE_LIMIT: u64 = 100;
/// Tope de páginas por Project: 1000 × 100 Tasks. Pasarlo es un Core que no avanza el cursor.
const MAX_PAGES: usize = 1000;
/// Items de Activity en `lxo task show`: los últimos; el resto, con `lxo events --task`.
const ACTIVITY_LIMIT: u64 = 10;

/// Los errores de `tasks_by_project`, `task_detail` y `activity_list` (`docs/core/QUERIES.md`, `ACTIVITY.md`).
fn tasks_failure(error: RpcFailure) -> Failure {
    if let RpcFailure::Rejected(m) = &error {
        if m.starts_with("tasks_auth_required") || m.starts_with("activity_auth_required") {
            return Failure::Auth(
                "Las tareas del Core son solo para personas: una tarea del orquestador (agente) usa lxo list y lxo show."
                    .into(),
            );
        }
        if m.starts_with("tasks_project_not_found") {
            return Failure::NotFound(
                "El proyecto ya no está en el registro del Core. Míralos con lxo projects --all."
                    .into(),
            );
        }
        if m.starts_with("tasks_unavailable") || m.starts_with("activity_unavailable") {
            return Failure::Unavailable(
                "El Core de Lixbon no tiene su almacén abierto; reinicia Lixbon.".into(),
            );
        }
        // lxo arma la petición: si el Core la rechaza, es que no hablan el mismo contrato.
        if let Some(detail) = m.strip_prefix("tasks_invalid_request: ") {
            return Failure::Version(format!(
                "El Core rechazó la consulta de tareas ({}); actualiza Lixbon.",
                clean(detail)
            ));
        }
        if m.starts_with("Comando desconocido") {
            return Failure::Version(
                "Este Core no ofrece las tareas por proyecto; actualiza Lixbon.".into(),
            );
        }
    }
    failure(error)
}

/// Los Projects del overview del Core (también archivados) y cuántas Tasks no tienen Project.
#[derive(Debug)]
struct Overview {
    projects: Vec<Value>,
    unassigned: u64,
}

fn overview(rpc: Rpc) -> Result<Overview, Failure> {
    let data = rpc("projects_overview", &json!({ "archived": "include" })).map_err(failure)?;
    let projects = data["projects"].as_array().ok_or_else(contract_error)?;
    if projects.iter().any(|p| !p["id"].is_string()) {
        return Err(contract_error());
    }
    Ok(Overview {
        projects: projects.clone(),
        unassigned: data["unassigned"]["tasks"].as_u64().unwrap_or(0),
    })
}

impl Overview {
    fn ids(&self) -> Vec<String> {
        self.projects
            .iter()
            .filter_map(|p| p["id"].as_str().map(String::from))
            .collect()
    }

    /// `--project` por id o por nombre.
    fn resolve(&self, wanted: &str) -> Result<String, Failure> {
        if let Some(p) = self
            .projects
            .iter()
            .find(|p| p["id"].as_str() == Some(wanted))
        {
            return Ok(p["id"].as_str().unwrap_or_default().to_string());
        }
        let by_name: Vec<&Value> = self
            .projects
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

    /// Solo para la salida humana: el nombre de cada Project. El `--json` lleva solo `project_id`.
    fn name(&self, tasks: &mut [Value]) {
        for task in tasks {
            if let Some(name) = self
                .projects
                .iter()
                .find(|p| p["id"] == task["project_id"] && !task["project_id"].is_null())
                .and_then(|p| p["name"].as_str())
            {
                task["project_name"] = json!(name);
            }
        }
    }
}

/// Todas las Tasks de un Project con `tasks_by_project` (LXO-91), página a página.
fn project_tasks(rpc: Rpc, project_id: &str) -> Result<Vec<Value>, Failure> {
    let mut out = vec![];
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut args = json!({ "project_id": project_id, "status": "all", "limit": PAGE_LIMIT });
        if let Some(cursor) = &cursor {
            args["cursor"] = json!(cursor);
        }
        let data = rpc("tasks_by_project", &args).map_err(tasks_failure)?;
        let page = data["tasks"]
            .as_array()
            .filter(|_| data["v"].as_u64() == Some(CONTRACT))
            .ok_or_else(contract_error)?;
        if page
            .iter()
            .any(|t| !t["id"].is_string() || !t["status"].is_string())
        {
            return Err(contract_error());
        }
        out.extend(page.iter().map(|t| {
            let mut t = t.clone();
            t["project_id"] = json!(project_id);
            t
        }));
        match (data["has_more"].as_bool(), data["next_cursor"].as_str()) {
            (Some(true), Some(next)) => cursor = Some(next.to_string()),
            (Some(false), _) => return Ok(out),
            _ => return Err(contract_error()),
        }
    }
    Err(Failure::Internal(
        "El Core no terminó de paginar las tareas del proyecto.".into(),
    ))
}

/// Por fecha de creación y, a igualdad, por id (el orden de Lixbon).
fn by_creation(tasks: &mut [&Value]) {
    tasks.sort_by_key(|t| {
        (
            t["created_at"].as_u64().unwrap_or(0),
            t["id"].as_str().unwrap_or("").to_string(),
        )
    });
}

/// En árbol, como las enseña Lixbon: cada raíz seguida de sus hijas. Una Task cuyo padre no está entre las
/// leídas (otro Project) cuenta como raíz. Calcula `depth`.
fn tree(tasks: Vec<Value>) -> Vec<Value> {
    use std::collections::HashSet;
    fn walk(
        tasks: &[Value],
        node: &Value,
        depth: u64,
        seen: &mut HashSet<String>,
        out: &mut Vec<Value>,
    ) {
        let id = node["id"].as_str().unwrap_or("").to_string();
        if !seen.insert(id.clone()) {
            return;
        }
        let mut item = node.clone();
        item["depth"] = json!(depth);
        out.push(item);
        let mut kids: Vec<&Value> = tasks
            .iter()
            .filter(|t| t["parent_id"].as_str() == Some(id.as_str()))
            .collect();
        by_creation(&mut kids);
        for kid in kids {
            walk(tasks, kid, depth + 1, seen, out);
        }
    }
    let ids: HashSet<&str> = tasks.iter().filter_map(|t| t["id"].as_str()).collect();
    let mut roots: Vec<&Value> = tasks
        .iter()
        .filter(|t| t["parent_id"].as_str().is_none_or(|p| !ids.contains(p)))
        .collect();
    by_creation(&mut roots);
    let mut seen = HashSet::new();
    let mut out = vec![];
    for root in roots {
        walk(&tasks, root, 0, &mut seen, &mut out);
    }
    out
}

fn text(value: &Value) -> Value {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.to_string()))
        .unwrap_or(Value::Null)
}

/// Allowlist del `--json` de lxo sobre el DTO del Core: lo que el Core da y `null` para lo que no. La lista
/// (`tasks_by_project`) no trae fase, rol, base, cwd, fallo ni PR: salen en `lxo task show` (`task_detail`).
fn dto(t: &Value) -> Value {
    let status = t["status"].as_str().unwrap_or("");
    let phase = Some(&t["phase"])
        .filter(|p| p.is_object())
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
        "run_id": text(&t["run_id"]),
        "root_id": text(&t["root_id"]),
        "parent_id": text(&t["parent_id"]),
        "depth": t["depth"].as_u64(),
        "status": status,
        "final": FINAL.contains(&status),
        "phase": phase,
        "provider": text(&t["provider"]),
        "model": model,
        "role": text(&t["role"]),
        "branch": text(&t["branch"]),
        "base": text(&t["base"]),
        "worktree": text(&t["worktree"]),
        "shared_checkout": t["parent_id"].is_string() && t["worktree"].as_str().is_none_or(str::is_empty),
        "cwd": text(&t["cwd"]),
        "host": null,
        "origin": match t["external"].as_bool() {
            Some(true) => json!("external"),
            Some(false) => json!("lixbon"),
            None => Value::Null,
        },
        "created_at": t["created_at"].as_u64(),
        "updated_at": t["updated_at"].as_u64(),
        "failure_reason": text(&t["failure_reason"]),
        "merged": t["merged"].as_bool().unwrap_or(false),
        "pr_url": text(&t["pr_url"]),
    })
}

/// La lista y el overview que la acompaña (para los nombres de la salida humana).
fn list_data(rpc: Rpc, filters: &Filters) -> Result<(Value, Overview), Failure> {
    let overview = overview(rpc)?;
    let projects = match &filters.project {
        Some(wanted) => vec![overview.resolve(wanted)?],
        None => overview.ids(),
    };
    let mut tasks = vec![];
    for project in &projects {
        tasks.extend(project_tasks(rpc, project)?);
    }
    let selected: Vec<Value> = tree(tasks)
        .iter()
        .map(dto)
        .filter(|d| {
            filters.run.as_deref().is_none_or(|r| d["run_id"] == r)
                && filters.status.as_deref().is_none_or(|s| d["status"] == s)
                && (!filters.active || d["final"] == false)
                && (!filters.finished || d["final"] == true)
        })
        .collect();
    let data = json!({
        "v": CONTRACT,
        "task_model": "legacy",
        "tasks": selected,
        // El Core solo lista Tasks por Project: las que no tienen se cuentan, no se esconden.
        "unassigned_tasks": overview.unassigned,
    });
    Ok((data, overview))
}

/// Los últimos items de Activity de la Task (o del Attempt, con `kind = "attempt"`), en orden cronológico y ya
/// traducidos. `null` si este Core no tiene Activity (la ficha se enseña igual); un fallo de transporte sí corta.
pub(super) fn activity(rpc: Rpc, kind: &str, id: &str) -> Result<Value, Failure> {
    let args =
        json!({ "target_kind": kind, "target_id": id, "order": "desc", "limit": ACTIVITY_LIMIT });
    let data = match rpc("activity_list", &args) {
        Ok(data) => data,
        Err(RpcFailure::Rejected(_)) => return Ok(Value::Null),
        Err(error) => return Err(tasks_failure(error)),
    };
    let Some(items) = data["items"]
        .as_array()
        .filter(|_| data["v"].as_u64() == Some(CONTRACT))
    else {
        return Ok(Value::Null);
    };
    let mut items: Vec<Value> = items
        .iter()
        .map(|item| {
            let key = item["message_key"].as_str().unwrap_or("");
            json!({
                "seq": item["seq"].as_u64(),
                "ts": item["ts"].as_u64(),
                "kind": text(&item["kind"]),
                "message_key": text(&item["message_key"]),
                "visual": text(&item["visual"]),
                "text": crate::activity::translate(key, &item["args"]),
            })
        })
        .collect();
    items.reverse();
    Ok(json!({ "items": items, "has_more": data["has_more"].as_bool().unwrap_or(false) }))
}

/// Forma de comparar nombres: minúsculas, sin acentos ni marcas de acento sueltas (una «ó» que llega como
/// «o» más el acento combinado, como al escribir con tecla muerta) y con los espacios reducidos a uno.
fn fold(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| !('\u{300}'..='\u{36f}').contains(c))
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' | 'ã' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            other => other,
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `task_detail` de `id` en `project`; `None` si la Task no está en ese Project.
fn detail_in(rpc: Rpc, project: &str, id: &str) -> Result<Option<Value>, Failure> {
    let data = match rpc(
        "task_detail",
        &json!({ "project_id": project, "task_id": id }),
    ) {
        Ok(data) => data,
        Err(RpcFailure::Rejected(m)) if m.starts_with("tasks_not_found") => return Ok(None),
        Err(error) => return Err(tasks_failure(error)),
    };
    let task = &data["task"];
    if data["v"].as_u64() != Some(CONTRACT)
        || !task["id"].is_string()
        || !task["status"].is_string()
    {
        return Err(contract_error());
    }
    Ok(Some(task.clone()))
}

/// Por nombre: el título exacto (sin distinguir mayúsculas) y, si ninguno coincide, el que lo contiene.
/// Devuelve el Project y el id de la única Task que encaja; si encajan varias, pide el id.
fn find_by_name(
    rpc: Rpc,
    overview: &Overview,
    wanted: &str,
) -> Result<Option<(String, String)>, Failure> {
    let mut tasks = vec![];
    for project in overview.ids() {
        tasks.extend(project_tasks(rpc, &project)?);
    }
    let needle = fold(wanted);
    let title = |t: &Value| fold(t["title"].as_str().unwrap_or(""));
    let mut found: Vec<&Value> = tasks.iter().filter(|t| title(t) == needle).collect();
    if found.is_empty() {
        found = tasks
            .iter()
            .filter(|t| title(t).contains(&needle))
            .collect();
    }
    by_creation(&mut found);
    let pair = |t: &Value| {
        (
            t["project_id"].as_str().unwrap_or_default().to_string(),
            t["id"].as_str().unwrap_or_default().to_string(),
        )
    };
    match found.as_slice() {
        [] => Ok(None),
        [one] => Ok(Some(pair(one))),
        many => {
            let mut named: Vec<Value> = many.iter().map(|t| (*t).clone()).collect();
            overview.name(&mut named);
            let options: Vec<String> = named
                .iter()
                .take(8)
                .map(|t| {
                    format!(
                        "{} «{}» ({})",
                        field(t, "id").unwrap_or_default(),
                        field(t, "title").unwrap_or_default(),
                        field(t, "project_name")
                            .unwrap_or_else(|| field(t, "project_id").unwrap_or_default())
                    )
                })
                .collect();
            let more = if many.len() > 8 {
                format!(" y {} más", many.len() - 8)
            } else {
                String::new()
            };
            Err(usage(format!(
                "Hay {} tareas que encajan con «{}»; usa su id: {}{more}.",
                many.len(),
                clean(wanted),
                options.join(", ")
            )))
        }
    }
}

/// La ficha de una Task, buscada por id y, si no hay ninguna con ese id, por nombre. `task_detail` necesita
/// el Project: el id se busca en cada uno. Devuelve también el overview.
fn show_data(rpc: Rpc, wanted: &str) -> Result<(Value, Overview), Failure> {
    let overview = overview(rpc)?;
    let mut found = None;
    for project in overview.ids() {
        if let Some(task) = detail_in(rpc, &project, wanted)? {
            found = Some(task);
            break;
        }
    }
    if found.is_none() {
        if let Some((project, id)) = find_by_name(rpc, &overview, wanted)? {
            found = detail_in(rpc, &project, &id)?;
        }
    }
    let Some(mut task) = found else {
        return Err(Failure::NotFound(format!(
            "No hay ninguna tarea con id o nombre «{}» en los proyectos, o no es visible para esta identidad. Las tareas sin proyecto no se pueden consultar.",
            clean(wanted)
        )));
    };
    let id = task["id"].as_str().unwrap_or_default().to_string();
    // La ficha no trae la profundidad: 0 en la raíz, 1 si el padre es la raíz, desconocida si no.
    task["depth"] = match (task["parent_id"].as_str(), task["root_id"].as_str()) {
        (None, _) => json!(0),
        (Some(parent), Some(root)) if parent == root => json!(1),
        _ => Value::Null,
    };
    let children: Vec<Value> = task["child_ids"]
        .as_array()
        .into_iter()
        .flatten()
        .map(text)
        .filter(|c| !c.is_null())
        .collect();
    let data = json!({
        "v": CONTRACT,
        "task_model": "legacy",
        "task": dto(&task),
        "children": children,
        "activity": activity(rpc, "task", &id)?,
    });
    Ok((data, overview))
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

fn list_text(data: &Value, filters: &Filters) -> String {
    let tasks = data["tasks"].as_array().cloned().unwrap_or_default();
    let mut out = if tasks.is_empty() {
        if *filters != Filters::default() {
            "Ninguna tarea cumple estos filtros.".to_string()
        } else {
            "Sin tareas. Aparecen al lanzar un run desde Lixbon o con lxo run create.".to_string()
        }
    } else {
        tasks.iter().map(task_lines).collect::<Vec<_>>().join("\n")
    };
    // Sin --project, el aviso de las que no tienen Project: el Core solo lista Tasks por Project.
    match data["unassigned_tasks"].as_u64() {
        Some(n) if n > 0 && filters.project.is_none() => out.push_str(&format!(
            "\nSin proyecto: {}, que no {} aquí (el Core las lista por proyecto).",
            if n == 1 {
                "1 tarea".to_string()
            } else {
                format!("{n} tareas")
            },
            if n == 1 { "sale" } else { "salen" }
        )),
        _ => {}
    }
    out
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
    lines.extend(activity_lines(
        &data["activity"],
        &format!("lxo events --task {id}"),
    ));
    if let Some(n) = data["attempt_count"].as_u64() {
        lines.push(format!(
            "  Intentos:    {n} · cada uno con lxo attempts --task {id}"
        ));
    }
    lines.push(format!(
        "  Seguir:      lxo events --task {id} · lxo attention --task {id}"
    ));
    lines.join("\n")
}

/// Parte `text` en líneas de 80 columnas como mucho: la primera tras `first`, el resto tras `rest`.
pub(super) fn wrap(first: &str, rest: &str, text: &str) -> Vec<String> {
    let mut lines = vec![];
    let mut line = first.to_string();
    let mut empty = true;
    for word in text.split_whitespace() {
        if !empty && line.chars().count() + 1 + word.chars().count() > 80 {
            lines.push(std::mem::replace(&mut line, rest.to_string()));
            empty = true;
        }
        if !empty || !line.ends_with(' ') {
            line.push(' ');
        }
        line.push_str(word);
        empty = false;
    }
    lines.push(line);
    lines
}

/// La Activity (proyección del Core, LXO-92), traducida como en Desktop y Mobile. `more` es la orden que da
/// lo anterior a los items enseñados.
pub(super) fn activity_lines(activity: &Value, more: &str) -> Vec<String> {
    let Some(items) = activity["items"].as_array() else {
        return vec!["  Actividad:   no disponible en este Core".into()];
    };
    if items.is_empty() {
        return vec!["  Actividad:   sin eventos todavía".into()];
    }
    let mut lines = vec!["  Actividad (UTC, lo último al final):".to_string()];
    if activity["has_more"] == true {
        lines.push(format!("    … lo anterior, con {more}"));
    }
    for item in items {
        let when = item["ts"]
            .as_u64()
            .map(|ms| timestamp_utc(ms as i64)[..16].replace('T', " "))
            .unwrap_or_else(|| "—".into());
        let sentence = item["text"].as_str().map(clean).unwrap_or_else(|| {
            format!(
                "Evento {} sin texto (seq {}).",
                field(item, "kind").unwrap_or_else(|| "desconocido".into()),
                item["seq"]
                    .as_u64()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "—".into())
            )
        });
        lines.extend(wrap(&format!("    {when} ·"), "      ", &sentence));
    }
    lines
}

/// Los errores de las lecturas vNext. Antes del corte, la forma 2 no existe: se pide la 1.
fn v2_failure(error: RpcFailure) -> Failure {
    match &error {
        RpcFailure::Rejected(m) if m.starts_with("core_model_inactive") => Failure::Version(
            "Este Core aún usa el modelo anterior: --schema 2 (modelo Task/Attempt) llega con el corte. Mientras, usa --json sin --schema (forma 1)."
                .into(),
        ),
        _ => crate::attempts::model_failure(error),
    }
}

/// Todas las Tasks de un Project con `task_list_v2` (LXO-119), descartadas incluidas, página a página.
fn project_tasks_v2(rpc: Rpc, project_id: &str) -> Result<Vec<Value>, Failure> {
    let mut out = vec![];
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut args =
            json!({ "project_id": project_id, "include_discarded": true, "limit": PAGE_LIMIT });
        if let Some(cursor) = &cursor {
            args["cursor"] = json!(cursor);
        }
        let data = rpc("task_list_v2", &args).map_err(v2_failure)?;
        let page = data["items"]
            .as_array()
            .filter(|_| data["v"].as_u64() == Some(CONTRACT_V2) && data["core_model"] == MODEL_V2)
            .ok_or_else(contract_error)?;
        if page
            .iter()
            .any(|t| !t["id"].is_string() || !t["state"].is_string())
        {
            return Err(contract_error());
        }
        // `tree` enlaza por `parent_id`; en vNext es `parent_task_id`.
        out.extend(page.iter().map(|t| {
            let mut t = t.clone();
            t["parent_id"] = t["parent_task_id"].clone();
            t
        }));
        match data["next_cursor"].as_str() {
            Some(next) => cursor = Some(next.to_string()),
            None if data["next_cursor"].is_null() => return Ok(out),
            None => return Err(contract_error()),
        }
    }
    Err(Failure::Internal(
        "El Core no terminó de paginar las tareas del proyecto.".into(),
    ))
}

/// Un Attempt nombrado por su id, sin lo de la ejecución: eso se pide con `lxo attempt show`.
fn attempt_ref(a: &Value) -> Value {
    if !a.is_object() {
        return Value::Null;
    }
    json!({ "attempt_id": text(&a["id"]), "n": a["n"].as_u64(), "status": text(&a["status"]) })
}

/// Allowlist de la Task vNext: intención y estado derivado; ninguna propiedad de ejecución (agente, rama,
/// worktree, fallo, PR). El Attempt actual va nombrado.
fn dto_v2(t: &Value) -> Value {
    json!({
        "task_id": text(&t["id"]),
        "title": text(&t["title"]),
        "project_id": text(&t["project_id"]),
        "run_id": text(&t["run_id"]),
        "parent_task_id": text(&t["parent_task_id"]),
        "depth": t["depth"].as_u64(),
        "intent": text(&t["intent"]),
        "state": text(&t["state"]),
        "origin": text(&t["origin"]),
        "created_at": t["created_at"].as_u64(),
        "updated_at": t["updated_at"].as_u64(),
        "attempt_count": t["attempt_count"].as_u64(),
        "current_attempt": attempt_ref(&t["current_attempt"]),
    })
}

/// `lxo tasks --json --schema 2`: `{v: 2, task_model, tasks, unassigned_tasks}`, en árbol como la forma 1.
fn list_v2(rpc: Rpc, filters: &Filters) -> Result<Value, Failure> {
    let overview = overview(rpc)?;
    let projects = match &filters.project {
        Some(wanted) => vec![overview.resolve(wanted)?],
        None => overview.ids(),
    };
    let mut tasks = vec![];
    for project in &projects {
        tasks.extend(project_tasks_v2(rpc, project)?);
    }
    let selected: Vec<Value> = tree(tasks)
        .iter()
        .map(|t| {
            let mut d = dto_v2(t);
            d["depth"] = t["depth"].clone();
            d
        })
        .filter(|d| {
            filters.run.as_deref().is_none_or(|r| d["run_id"] == r)
                && filters.state.as_deref().is_none_or(|s| d["state"] == s)
        })
        .collect();
    Ok(json!({
        "v": CONTRACT_V2,
        "task_model": MODEL_V2,
        "tasks": selected,
        "unassigned_tasks": overview.unassigned,
    }))
}

/// `lxo task show <task_id> --json --schema 2`: la Task, sus hijas y sus intentos **por id**, sin elegir ninguno.
/// Por id: el nombre se resuelve con la forma 1 (`lxo task show <nombre>`).
fn show_v2(rpc: Rpc, id: &str) -> Result<Value, Failure> {
    let data = match rpc("task_detail_v2", &json!({ "task_id": id })) {
        Ok(data) => data,
        Err(RpcFailure::Rejected(m)) if m.starts_with("model_not_found") => {
            return Err(Failure::NotFound(format!(
                "No hay ninguna tarea con id «{}». Con --schema 2 se busca por id: los ids salen en lxo tasks.",
                clean(id)
            )))
        }
        Err(error) => return Err(v2_failure(error)),
    };
    let t = &data["task"];
    if data["v"].as_u64() != Some(CONTRACT_V2)
        || data["core_model"] != MODEL_V2
        || !t["id"].is_string()
        || !t["attempts"].is_array()
    {
        return Err(contract_error());
    }
    let mut task = dto_v2(t);
    task["children_ids"] = json!(t["children"]
        .as_array()
        .into_iter()
        .flatten()
        .map(text)
        .filter(|c| !c.is_null())
        .collect::<Vec<_>>());
    let mut attempts: Vec<Value> = t["attempts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(attempt_ref)
        .collect();
    attempts.sort_by_key(|a| a["n"].as_u64().unwrap_or(0));
    task["attempts"] = json!(attempts);
    let id = t["id"].as_str().unwrap_or_default().to_string();
    Ok(json!({
        "v": CONTRACT_V2,
        "task_model": MODEL_V2,
        "task": task,
        "activity": activity(rpc, "task", &id)?,
    }))
}

/// Aviso de compatibilidad (LXO-124): tras el corte (`core_model` = `task_attempt_v1`) estas fichas son la vista
/// `legacy_task_v1` y lo de ejecución (agente, rama, worktree, fallo, PR) es del intento actual, campos en desuso
/// (`docs/core/QUERIES.md` § Compatibilidad). Da el aviso para stderr y, en la ficha (`task`), cuántos intentos
/// tiene. `None` antes del corte o si el Core no lo dice: los comandos siguen como antes.
fn legacy_notice(rpc: Rpc, task: Option<&str>) -> Option<(String, Option<usize>)> {
    let model = rpc("core_model", &json!({})).ok()?;
    if model["core_model"] != "task_attempt_v1" {
        return None;
    }
    let Some(id) = task else {
        return Some((
            "Aviso: el Core ya usa el modelo Task/Attempt. El agente y la rama de cada tarea son los de su intento actual (campos en desuso); cada ejecución, con lxo attempts --task <id>.".into(),
            None,
        ));
    };
    let n = rpc("attempts_by_task", &json!({ "task_id": id }))
        .ok()
        .and_then(|d| d["items"].as_array().map(Vec::len));
    let many = match n {
        Some(n) if n > 1 => format!(" y la tarea tiene {n} intentos"),
        _ => String::new(),
    };
    Some((
        format!(
            "Aviso: el Core ya usa el modelo Task/Attempt. El agente, la rama, el worktree, el fallo y el PR de esta ficha son los del intento actual (campos en desuso){many}; cada ejecución, con lxo attempts --task {}.",
            clean(id)
        ),
        n,
    ))
}

fn execute(request: Request, json: bool, schema: u64) -> Result<(), Failure> {
    let mut rpc = |cmd: &str, args: &Value| client_auth::rpc(cmd, args, &crate::cwd());
    match request {
        Request::Help => print!("{HELP}"),
        Request::List(filters) if schema == 2 => println!("{}", list_v2(&mut rpc, &filters)?),
        Request::Show(id) if schema == 2 => println!("{}", show_v2(&mut rpc, &id)?),
        Request::List(filters) => {
            let (mut data, overview) = list_data(&mut rpc, &filters)?;
            if json {
                println!("{data}");
            } else {
                if let Some(tasks) = data["tasks"].as_array_mut() {
                    overview.name(tasks);
                }
                println!("{}", list_text(&data, &filters));
                if let Some((notice, _)) = legacy_notice(&mut rpc, None) {
                    eprintln!("{notice}");
                }
            }
        }
        Request::Show(id) => {
            let (mut data, overview) = show_data(&mut rpc, &id)?;
            if json {
                println!("{data}");
            } else {
                overview.name(std::slice::from_mut(&mut data["task"]));
                let id = data["task"]["id"].as_str().unwrap_or_default().to_string();
                let notice = legacy_notice(&mut rpc, Some(&id));
                if let Some(n) = notice.as_ref().and_then(|(_, n)| *n) {
                    data["attempt_count"] = json!(n);
                }
                println!("{}", show_text(&data));
                if let Some((notice, _)) = notice {
                    eprintln!("{notice}");
                }
            }
        }
    }
    Ok(())
}

/// `--schema 1|2` (LXO-125): la forma del `--json`. 1 (por defecto mientras dure la ventana de compatibilidad) es
/// el modelo legacy; 2, el modelo Task/Attempt. Sin `--json` no hay forma que elegir.
fn schema(a: &Args, request: &Request) -> Result<u64, Failure> {
    let schema = match text_flag(a, "schema")?.as_deref() {
        None => 1,
        Some("1") => 1,
        Some("2") => 2,
        Some(_) => {
            return Err(usage(
                "--schema admite 1 (modelo legacy, por defecto) o 2 (modelo Task/Attempt).",
            ))
        }
    };
    if a.flags.contains_key("schema") && !a.b("json") {
        return Err(usage(
            "--schema elige la forma del --json: úsalo junto a --json.",
        ));
    }
    if let Request::List(f) = request {
        if schema == 2 && (f.status.is_some() || f.active || f.finished) {
            return Err(usage(format!(
                "--status, --active y --final filtran por el estado de la ejecución (modelo legacy). Con --schema 2 filtra por el estado de la tarea con --state ({}), o mira cada intento con lxo attempts --task <id>.",
                STATES.join(", ")
            )));
        }
        if schema == 1 && f.state.is_some() {
            return Err(usage(
                "--state es el estado de la tarea del modelo Task/Attempt: úsalo con --json --schema 2.",
            ));
        }
    }
    Ok(schema)
}

pub(super) fn run(a: &Args) -> std::process::ExitCode {
    let json = a.b("json");
    finish(
        parse(a).and_then(|request| {
            let schema = schema(a, &request)?;
            execute(request, json, schema)
        }),
        json,
    )
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

    /// Una Task como la devuelve `tasks_by_project`, más los campos de `task_detail`. El Core simulado quita
    /// los del detalle en la lista y deja `spec`/`requested_argv` para comprobar que lxo no los copia.
    fn core_task(
        id: &str,
        project: &str,
        parent: Option<&str>,
        created: u64,
        status: &str,
    ) -> Value {
        json!({
            "id": id, "run_id": "r1", "parent_id": parent, "root_id": "t1", "status": status,
            "title": format!("tarea {id}"), "provider": "claude", "model": "sonnet", "branch": null,
            "worktree": null, "external": false, "created_at": created, "updated_at": created + 60_000,
            "project_id": project, "child_ids": [], "phase": null, "messages": [], "cwd": "C:/r/api",
            "merged": false, "role": null, "base": null, "model_effective": null, "failure_reason": null,
            "pr_url": null, "review": null, "integration": null,
            "spec": "texto privado del encargo", "requested_argv": ["claude", "--secret-flag"]
        })
    }

    const DETAIL_ONLY: [&str; 14] = [
        "project_id",
        "child_ids",
        "phase",
        "messages",
        "cwd",
        "merged",
        "role",
        "base",
        "model_effective",
        "failure_reason",
        "pr_url",
        "review",
        "integration",
        "spec",
    ];

    /// p-api: raíz t1 (externa, en curso) → t2 (worktree propio, fallida) y t3 (checkout compartido,
    /// esperando). p-web: t9 terminada, de otro run. Más una Task sin proyecto (solo cuenta).
    fn fixture() -> Vec<Value> {
        let mut root = core_task("t1", "p-api", None, 1_000, "running");
        root["external"] = json!(true);
        root["child_ids"] = json!(["t2", "t3"]);
        root["phase"] = json!({ "name": "tests", "done": false, "note": "", "at": 2 });
        let mut wt = core_task("t2", "p-api", Some("t1"), 2_000, "failed");
        wt["branch"] = json!("lxo/t2");
        wt["base"] = json!("main");
        wt["worktree"] = json!("C:/r/api-wt/t2");
        wt["model_effective"] = json!("claude-sonnet-4");
        wt["failure_reason"] = json!("agent_idle_timeout");
        // t3 se creó a la vez que t2: a igualdad de fecha, por id.
        let shared = core_task("t3", "p-api", Some("t1"), 2_000, "waiting");
        let mut other = core_task("t9", "p-web", None, 5_000, "done");
        other["run_id"] = json!("r2");
        other["root_id"] = json!("t9");
        other["provider"] = Value::Null;
        other["model"] = Value::Null;
        vec![root, wt, shared, other]
    }

    fn activity_items() -> Value {
        // Como las da el Core con order=desc: lo más nuevo primero.
        json!([
            { "seq": 12, "ts": 1_760_000_120_000u64, "kind": "task.status_changed", "message_key": "activity.task.failed",
              "args": { "from": "running", "to": "failed", "cause": "agent_idle_timeout" }, "visual": "error" },
            { "seq": 11, "ts": 1_760_000_060_000u64, "kind": "task.teleported", "message_key": "activity.unknown",
              "args": { "reason": "unknown_kind" }, "visual": "info" },
            { "seq": 10, "ts": 1_760_000_000_000u64, "kind": "task.created", "message_key": "activity.task.created",
              "args": { "title": "tarea t2", "agent": "claude", "depth": 1, "external": false, "parent": "t1" }, "visual": "info" }
        ])
    }

    /// Core simulado: overview, `tasks_by_project` paginado de 2 en 2 (comprueba el cursor), `task_detail`
    /// y `activity_list`. `calls` guarda cada petición.
    fn core_with(
        tasks: Vec<Value>,
        calls: std::rc::Rc<std::cell::RefCell<Vec<(String, Value)>>>,
    ) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        move |cmd, args| {
            calls.borrow_mut().push((cmd.to_string(), args.clone()));
            match cmd {
                "projects_overview" => {
                    assert_eq!(args, &json!({ "archived": "include" }));
                    Ok(json!({ "v": 1, "projects": [
                        { "id": "p-api", "name": "api" }, { "id": "p-web", "name": "web" },
                        { "id": "p-a", "name": "dup" }, { "id": "p-b", "name": "Dup" }
                    ], "unassigned": { "tasks": 1 } }))
                }
                "tasks_by_project" => {
                    assert_eq!(
                        (args["status"].as_str(), args["limit"].as_u64()),
                        (Some("all"), Some(100))
                    );
                    let project = args["project_id"].as_str().unwrap();
                    // Orden del Core: created_at descendente, luego id.
                    let mut mine: Vec<Value> = tasks
                        .iter()
                        .filter(|t| t["project_id"] == project)
                        .cloned()
                        .collect();
                    mine.sort_by(|a, b| {
                        b["created_at"]
                            .as_u64()
                            .cmp(&a["created_at"].as_u64())
                            .then(a["id"].as_str().cmp(&b["id"].as_str()))
                    });
                    let start: usize = args["cursor"]
                        .as_str()
                        .map(|c| c.parse().unwrap())
                        .unwrap_or(0);
                    let page: Vec<Value> = mine
                        .iter()
                        .skip(start)
                        .take(2)
                        .map(|t| {
                            let mut t = t.clone();
                            for f in DETAIL_ONLY {
                                t.as_object_mut().unwrap().remove(f);
                            }
                            t
                        })
                        .collect();
                    let more = start + 2 < mine.len();
                    Ok(
                        json!({ "v": 1, "project_id": project, "filters": { "status": "all" }, "limit": 100,
                        "tasks": page, "has_more": more, "next_cursor": more.then(|| (start + 2).to_string()) }),
                    )
                }
                "task_detail" => {
                    let id = args["task_id"].as_str().unwrap();
                    match tasks
                        .iter()
                        .find(|t| t["id"] == id && t["project_id"] == args["project_id"])
                    {
                        Some(t) => Ok(json!({ "v": 1, "task": t })),
                        None => Err(RpcFailure::Rejected(format!(
                            "tasks_not_found: no existe la Task {id}"
                        ))),
                    }
                }
                "activity_list" => {
                    assert_eq!(
                        (
                            args["target_kind"].as_str(),
                            args["order"].as_str(),
                            args["limit"].as_u64()
                        ),
                        (Some("task"), Some("desc"), Some(10))
                    );
                    let items = if args["target_id"] == "t2" {
                        activity_items()
                    } else {
                        json!([])
                    };
                    Ok(
                        json!({ "v": 1, "projection": 1, "order": "desc", "items": items, "has_more": args["target_id"] == "t2",
                        "next_cursor": 10, "head_seq": 12, "limit": 10 }),
                    )
                }
                other => panic!("comando inesperado {other}"),
            }
        }
    }

    fn core(tasks: Vec<Value>) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        core_with(tasks, Default::default())
    }

    fn list(raw: &[&str]) -> Value {
        list_data(&mut core(fixture()), &filters(raw).unwrap())
            .unwrap()
            .0
    }

    fn show(id: &str) -> Value {
        show_data(&mut core(fixture()), id).unwrap().0
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
        assert_eq!(ids(&list(&["tasks"])), ["t1", "t2", "t3", "t9"]);
        assert_eq!(
            ids(&list(&["tasks", "--project", "api"])),
            ["t1", "t2", "t3"]
        );
        assert_eq!(
            ids(&list(&["tasks", "--project", "p-api", "--active"])),
            ["t1", "t3"]
        );
        assert_eq!(ids(&list(&["tasks", "--final"])), ["t2", "t9"]);
        assert_eq!(ids(&list(&["tasks", "--status", "waiting"])), ["t3"]);
        assert_eq!(ids(&list(&["tasks", "--run", "r2"])), ["t9"]);
    }

    #[test]
    fn lee_las_queries_de_lxo_91_pagina_a_pagina_y_no_la_lectura_legacy() {
        let calls: std::rc::Rc<std::cell::RefCell<Vec<(String, Value)>>> = Default::default();
        let (data, _) = list_data(
            &mut core_with(fixture(), calls.clone()),
            &Filters::default(),
        )
        .unwrap();
        assert_eq!(
            ids(&data),
            ["t1", "t2", "t3", "t9"],
            "tres Tasks de p-api en dos páginas"
        );
        let calls = calls.borrow();
        assert!(
            calls.iter().all(|(cmd, _)| cmd != "list" && cmd != "show"),
            "{calls:?}"
        );
        let pages: Vec<&Value> = calls
            .iter()
            .filter(|(c, a)| c == "tasks_by_project" && a["project_id"] == "p-api")
            .map(|(_, a)| a)
            .collect();
        assert_eq!(pages.len(), 2);
        assert_eq!(
            (pages[0].get("cursor"), pages[1]["cursor"].as_str()),
            (None, Some("2"))
        );
        // Con --project solo se lee ese Project.
        let calls: std::rc::Rc<std::cell::RefCell<Vec<(String, Value)>>> = Default::default();
        list_data(
            &mut core_with(fixture(), calls.clone()),
            &filters(&["tasks", "--project", "web"]).unwrap(),
        )
        .unwrap();
        assert!(calls
            .borrow()
            .iter()
            .filter(|(c, _)| c == "tasks_by_project")
            .all(|(_, a)| a["project_id"] == "p-web"));
    }

    #[test]
    fn las_tareas_sin_proyecto_se_cuentan_y_no_se_esconden() {
        let all = list(&["tasks"]);
        assert_eq!(all["unassigned_tasks"], 1);
        assert!(list_text(&all, &Filters::default()).ends_with(
            "\nSin proyecto: 1 tarea, que no sale aquí (el Core las lista por proyecto)."
        ));
        let api = filters(&["tasks", "--project", "api"]).unwrap();
        assert!(
            !list_text(&list(&["tasks", "--project", "api"]), &api).contains("Sin proyecto"),
            "con --project no aplica"
        );
        let empty = json!({ "v": 1, "task_model": "legacy", "tasks": [], "unassigned_tasks": 3 });
        assert_eq!(
            list_text(&empty, &Filters::default()),
            "Sin tareas. Aparecen al lanzar un run desde Lixbon o con lxo run create.\nSin proyecto: 3 tareas, que no salen aquí (el Core las lista por proyecto)."
        );
        let missing = show_data(&mut core(fixture()), "t404").unwrap_err();
        assert!(
            missing
                .message()
                .contains("Las tareas sin proyecto no se pueden consultar"),
            "{missing:?}"
        );
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
        let all = list(&["tasks"]);
        let task = |id: &str| {
            all["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == id)
                .unwrap()
                .clone()
        };
        let (root, wt, shared, other) = (task("t1"), task("t2"), task("t3"), task("t9"));
        assert_eq!(
            (
                root["root_id"].clone(),
                root["parent_id"].clone(),
                root["origin"].clone()
            ),
            (json!("t1"), Value::Null, json!("external"))
        );
        assert_eq!(
            (
                root["depth"].clone(),
                wt["depth"].clone(),
                other["depth"].clone()
            ),
            (json!(0), json!(1), json!(0))
        );
        assert_eq!(
            (
                wt["root_id"].clone(),
                wt["worktree"].clone(),
                wt["shared_checkout"].clone()
            ),
            (json!("t1"), json!("C:/r/api-wt/t2"), json!(false))
        );
        assert_eq!(
            (shared["shared_checkout"].clone(), shared["branch"].clone()),
            (json!(true), Value::Null)
        );
        assert_eq!(
            (other["provider"].clone(), other["model"].clone()),
            (Value::Null, Value::Null),
            "lo desconocido queda null"
        );
        assert_eq!(root["host"], Value::Null);
        // La lista no trae lo que solo da el detalle: queda null, no inventado.
        assert_eq!(
            (
                wt["phase"].clone(),
                wt["failure_reason"].clone(),
                wt["cwd"].clone()
            ),
            (Value::Null, Value::Null, Value::Null)
        );
        // El detalle sí: modelo efectivo, fallo, fase.
        let detail = show("t2");
        assert_eq!(
            detail["task"]["model"], "claude-sonnet-4",
            "el modelo efectivo manda sobre el pedido"
        );
        assert_eq!(
            (
                detail["task"]["final"].clone(),
                detail["task"]["failure_reason"].clone()
            ),
            (json!(true), json!("agent_idle_timeout"))
        );
        assert_eq!(
            show("t1")["task"]["phase"],
            json!({ "name": "tests", "done": false })
        );
        // Una Task cuyo padre está en otro Project sale como raíz del árbol leído.
        let orphan = core_task("t5", "p-api", Some("en-otro-proyecto"), 9, "running");
        assert_eq!(tree(vec![orphan])[0]["depth"], 0);
    }

    #[test]
    fn snapshot_json_contractual_sin_campos_internos() {
        let mut data = show("t2");
        data["activity"] = Value::Null;
        assert_eq!(
            data.to_string(),
            r#"{"activity":null,"children":[],"task":{"base":"main","branch":"lxo/t2","created_at":2000,"cwd":"C:/r/api","depth":1,"failure_reason":"agent_idle_timeout","final":true,"host":null,"id":"t2","merged":false,"model":"claude-sonnet-4","origin":"lixbon","parent_id":"t1","phase":null,"pr_url":null,"project_id":"p-api","provider":"claude","role":null,"root_id":"t1","run_id":"r1","shared_checkout":false,"status":"failed","title":"tarea t2","updated_at":62000,"worktree":"C:/r/api-wt/t2"},"task_model":"legacy","v":1}"#
        );
        let all = list(&["tasks"]).to_string() + &show("t1").to_string() + &show("t2").to_string();
        for private in [
            "texto privado",
            "secret-flag",
            "requested_argv",
            "spec",
            "messages",
            "Attempt",
            "attempt",
        ] {
            assert!(!all.contains(private), "el JSON no copia {private}");
        }
        assert_eq!(show("t1")["children"], json!(["t2", "t3"]));
    }

    #[test]
    fn la_actividad_viene_del_core_traducida_y_en_orden() {
        let activity = &show("t2")["activity"];
        let items = activity["items"].as_array().unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| i["seq"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            [10, 11, 12],
            "cronológico"
        );
        assert_eq!(
            items[0]["text"],
            "Se creó la tarea «tarea t2» para claude (depende de t1; profundidad 1)."
        );
        assert_eq!(
            items[1]["text"],
            Value::Null,
            "argumentos incompletos: sin frase inventada"
        );
        assert_eq!(items[2]["text"], "La tarea falló.");
        assert_eq!(activity["has_more"], true);
        let text = show_text(&show("t2"));
        assert!(text.contains("  Actividad (UTC, lo último al final):\n    … lo anterior, con lxo events --task t2\n"), "{text}");
        assert!(text.contains("    2025-10-09 08:53 · Se creó la tarea «tarea t2» para claude (depende de t1;\n      profundidad 1)."), "{text}");
        assert!(
            text.contains("    2025-10-09 08:54 · Evento task.teleported sin texto (seq 11)."),
            "{text}"
        );
        assert!(
            text.contains("    2025-10-09 08:55 · La tarea falló.\n  Seguir:"),
            "{text}"
        );
        assert!(show_text(&show("t3")).contains("  Actividad:   sin eventos todavía"));
        let mut no_activity = show("t3");
        no_activity["activity"] = Value::Null;
        assert!(show_text(&no_activity).contains("  Actividad:   no disponible en este Core"));
    }

    #[test]
    fn un_core_sin_activity_no_rompe_la_ficha() {
        let mut inner = core(fixture());
        let mut old = |cmd: &str, args: &Value| {
            if cmd == "activity_list" {
                return Err(RpcFailure::Rejected(
                    "Comando desconocido: activity_list".into(),
                ));
            }
            inner(cmd, args)
        };
        let (data, _) = show_data(&mut old, "t2").unwrap();
        assert_eq!(data["activity"], Value::Null);
        assert_eq!(data["task"]["status"], "failed");
    }

    #[test]
    fn tarea_inexistente_da_un_error_estable() {
        let missing = show_data(&mut core(fixture()), "t404").unwrap_err();
        assert_eq!(missing.code(), ("not_found", 6));
        assert!(
            missing
                .message()
                .starts_with("No hay ninguna tarea con id o nombre «t404» en los proyectos"),
            "{missing:?}"
        );
    }

    #[test]
    fn errores_del_core_y_contrato() {
        let mut down = |_: &str, _: &Value| -> Result<Value, RpcFailure> {
            Err(RpcFailure::Transport(
                client_auth::EventRequestFailure::Network("cerrado".into()),
            ))
        };
        assert_eq!(
            list_data(&mut down, &Filters::default())
                .unwrap_err()
                .code()
                .1,
            5
        );
        let rejected = |code: &'static str| {
            let mut inner = core(fixture());
            move |cmd: &str, args: &Value| {
                if cmd == "tasks_by_project" || cmd == "task_detail" {
                    return Err(RpcFailure::Rejected(format!("{code}: detalle")));
                }
                inner(cmd, args)
            }
        };
        let code_of = |code: &'static str| {
            list_data(&mut rejected(code), &Filters::default())
                .unwrap_err()
                .code()
                .1
        };
        assert_eq!(code_of("tasks_auth_required"), 3);
        assert_eq!(code_of("tasks_project_not_found"), 6);
        assert_eq!(code_of("tasks_unavailable"), 5);
        assert_eq!(code_of("tasks_invalid_request"), 4);
        assert_eq!(code_of("Comando desconocido"), 4);
        assert_eq!(code_of("tasks_read_failed"), 1);
        assert_eq!(
            show_data(&mut rejected("tasks_auth_required"), "t1")
                .unwrap_err()
                .code()
                .1,
            3
        );
        let agent =
            list_data(&mut rejected("tasks_auth_required"), &Filters::default()).unwrap_err();
        assert!(agent.message().contains("solo para personas"), "{agent:?}");
        let mut broken = |cmd: &str, _: &Value| match cmd {
            "projects_overview" => {
                Ok(json!({ "v": 1, "projects": [{ "id": "p" }], "unassigned": {} }))
            }
            _ => Ok(json!({ "v": 1, "tasks": [{ "id": 1 }], "has_more": false })),
        };
        assert_eq!(
            list_data(&mut broken, &Filters::default())
                .unwrap_err()
                .code()
                .1,
            4
        );
        let mut stuck = |cmd: &str, _: &Value| match cmd {
            "projects_overview" => {
                Ok(json!({ "v": 1, "projects": [{ "id": "p" }], "unassigned": {} }))
            }
            _ => Ok(json!({ "v": 1, "tasks": [], "has_more": true, "next_cursor": null })),
        };
        assert_eq!(
            list_data(&mut stuck, &Filters::default())
                .unwrap_err()
                .code()
                .1,
            4,
            "has_more sin cursor"
        );
    }

    #[test]
    fn snapshot_humano_en_arbol_y_estado_vacio() {
        let api = filters(&["tasks", "--project", "api"]).unwrap();
        assert_eq!(
            list_text(&list(&["tasks", "--project", "api"]), &api),
            "t1 · en curso · tarea t1\n  proyecto p-api · run r1 · claude (sonnet) · sin rama\n  \
             t2 · fallida · tarea t2\n    proyecto p-api · run r1 · claude (sonnet) · rama lxo/t2\n  \
             t3 · esperando respuesta · tarea t3\n    proyecto p-api · run r1 · claude (sonnet) · checkout compartido"
        );
        let empty = json!({ "v": 1, "task_model": "legacy", "tasks": [], "unassigned_tasks": 0 });
        assert!(list_text(&empty, &Filters::default()).starts_with("Sin tareas."));
        assert_eq!(
            list_text(&empty, &api),
            "Ninguna tarea cumple estos filtros."
        );
    }

    #[test]
    fn detalle_y_terminal_estrecha() {
        let text = show_text(&show("t2"));
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
        let root = show_text(&show("t1"));
        assert!(
            root.contains("en curso · fase «tests» en curso")
                && root.contains("Hijas:       t2, t3")
                && root.contains("coordinador externo"),
            "{root}"
        );
        let mut evil = fixture();
        evil[2]["title"] = json!("x\u{1b}[2Jy");
        let lines = list_text(
            &list_data(&mut core(evil), &Filters::default()).unwrap().0,
            &Filters::default(),
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
        let filters = filters(&["tasks", "--run", "r1"]).unwrap();
        let (mut data, overview) = list_data(&mut core(fixture()), &filters).unwrap();
        assert!(!data.to_string().contains("project_name"));
        overview.name(data["tasks"].as_array_mut().unwrap());
        assert!(list_text(&data, &filters)
            .starts_with("t1 · en curso · tarea t1\n  proyecto api · run r1"));
        let (mut detail, overview) = show_data(&mut core(fixture()), "t2").unwrap();
        overview.name(std::slice::from_mut(&mut detail["task"]));
        assert!(show_text(&detail).contains("  Proyecto:    api (p-api)"));
    }

    #[test]
    fn task_show_acepta_el_nombre_ademas_del_id() {
        let id_of = |wanted: &str| show(wanted)["task"]["id"].as_str().unwrap().to_string();
        assert_eq!(id_of("t2"), "t2", "primero por id");
        assert_eq!(id_of("tarea t3"), "t3", "título exacto");
        assert_eq!(id_of("TAREA T9"), "t9", "sin distinguir mayúsculas");
        assert_eq!(
            id_of("a t2"),
            "t2",
            "un trozo del título, si solo encaja una"
        );
        let many = show_data(&mut core(fixture()), "tarea").unwrap_err();
        assert_eq!(many.code().1, 2);
        assert!(
            many.message().starts_with("Hay 4 tareas que encajan con «tarea»; usa su id: t1 «tarea t1» (api), t2 «tarea t2» (api)"),
            "{many:?}"
        );
        let none = show_data(&mut core(fixture()), "no existe").unwrap_err();
        assert_eq!(none.code().1, 6);
        assert!(
            none.message().contains("con id o nombre «no existe»"),
            "{none:?}"
        );
        // La Activity es la de la Task encontrada, no la del texto pedido.
        assert_eq!(
            show("tarea t2")["activity"]["items"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }

    #[test]
    fn el_nombre_no_distingue_acentos() {
        let mut tasks = fixture();
        tasks[1]["title"] = json!("Pantalla de Atención");
        let id_of = |wanted: &str| {
            show_data(&mut core(tasks.clone()), wanted).unwrap().0["task"]["id"].clone()
        };
        assert_eq!(id_of("Pantalla de Atención"), "t2");
        assert_eq!(id_of("pantalla de atencion"), "t2", "sin tilde");
        assert_eq!(
            id_of("Pantalla de Atencio\u{301}n"),
            "t2",
            "acento combinado (tecla muerta)"
        );
        assert_eq!(
            id_of("  PANTALLA   de  ATENCIÓN "),
            "t2",
            "mayúsculas y espacios de más"
        );
        assert_eq!(fold("Ñandú Çà"), "nandu ca");
    }

    #[test]
    fn una_errata_en_show_sugiere_la_orden() {
        let typo = parse(&args(&["task", "sho", "x"])).err().unwrap();
        assert_eq!(typo.code().1, 2);
        assert!(
            typo.message().contains("¿querías lxo task show"),
            "{typo:?}"
        );
        assert!(parse(&args(&["task", "ver", "x"]))
            .err()
            .unwrap()
            .message()
            .starts_with("Uso: lxo task show"));
    }

    #[test]
    fn el_nombre_puede_llevar_espacios_y_comillas() {
        for raw in [
            &["task", "show", "Pantalla", "de", "Atención"][..],
            &["task", "show", "\"Pantalla", "de", "Atención\""],
            &["tasks", "show", "'Pantalla de Atención'"],
            &["task", "show", "Pantalla", "de", "Atención", "--json"],
        ] {
            assert!(
                matches!(parse(&args(raw)), Ok(Request::Show(w)) if w == "Pantalla de Atención"),
                "{raw:?}"
            );
        }
        assert_eq!(
            parse(&args(&["task", "show", "\"\""]))
                .err()
                .unwrap()
                .code()
                .1,
            2
        );
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

    /// LXO-124 · tras el corte, `lxo tasks` y `lxo task show` avisan de que lo de ejecución es del intento actual
    /// y remiten a `lxo attempts --task`; antes del corte, o con un Core que no conoce `core_model`, nada cambia.
    #[test]
    fn aviso_de_compatibilidad_solo_tras_el_corte() {
        let cut = |attempts: usize| {
            move |cmd: &str, args: &Value| match cmd {
                "core_model" => Ok(json!({ "core_model": "task_attempt_v1", "compat": ["legacy_task_v1"] })),
                "attempts_by_task" => {
                    assert_eq!(args, &json!({ "task_id": "t2" }));
                    Ok(json!({ "v": 1, "items": vec![json!({}); attempts] }))
                }
                other => panic!("{other}"),
            }
        };
        let (notice, n) = legacy_notice(&mut cut(3), Some("t2")).unwrap();
        assert_eq!(n, Some(3));
        assert!(notice.contains("intento actual (campos en desuso) y la tarea tiene 3 intentos"), "{notice}");
        assert!(notice.ends_with("lxo attempts --task t2."), "{notice}");
        let (one, _) = legacy_notice(&mut cut(1), Some("t2")).unwrap();
        assert!(!one.contains("intentos;"), "con uno no hace falta contarlo: {one}");
        let (list, n) = legacy_notice(&mut cut(0), None).unwrap();
        assert_eq!(n, None);
        assert!(list.contains("lxo attempts --task <id>"), "{list}");

        let mut legacy = |cmd: &str, _: &Value| match cmd {
            "core_model" => Ok(json!({ "core_model": "legacy", "compat": [], "queries": [] })),
            other => panic!("antes del corte no pide {other}"),
        };
        assert!(legacy_notice(&mut legacy, Some("t2")).is_none());
        let mut old = |_: &str, _: &Value| Err(RpcFailure::Rejected("Comando desconocido: core_model".into()));
        assert!(legacy_notice(&mut old, None).is_none());

        let mut data = show("t2");
        assert!(!show_text(&data).contains("Intentos:"), "sin el corte no hay línea de intentos");
        data["attempt_count"] = json!(3);
        assert!(show_text(&data).contains("  Intentos:    3 · cada uno con lxo attempts --task t2"));
    }

    const API_LIST: &str = include_str!("../../../../docs/core/fixtures/api/task_list_v2.json");
    const API_DETAIL: &str = include_str!("../../../../docs/core/fixtures/api/task_detail_v2.json");

    fn attempt_v2(task: &str, n: u64, status: &str) -> Value {
        json!({ "id": format!("{task}-a{n}"), "n": n, "status": status, "provider": "codex", "model": "gpt-5",
                "role": null, "external": false, "created_at": 1_792_000_100_000u64 + n, "started_at": null, "ended_at": null })
    }

    /// Core cortado simulado sobre las fixtures de la ADR (`fixtures/api/`), más t9 con dos intentos. Con `model`
    /// distinto de `task_attempt_v1`, las lecturas vNext responden `core_model_inactive`.
    fn core_v2(model: &'static str) -> impl FnMut(&str, &Value) -> Result<Value, RpcFailure> {
        move |cmd, args| {
            if model != MODEL_V2 && cmd != "projects_overview" {
                return Err(RpcFailure::Rejected(
                    "core_model_inactive: el Core aún sirve el modelo legacy; usa tasks_by_project y task_detail".into(),
                ));
            }
            let mut items = serde_json::from_str::<Value>(API_LIST).unwrap()["items"].as_array().unwrap().clone();
            items.push(json!({
                "id": "t9", "title": "reintentada", "project_id": "p-1", "run_id": "r9", "parent_task_id": null, "depth": 0,
                "intent": "open", "state": "in_progress", "origin": "lixbon", "created_at": 1_792_000_100_000u64,
                "updated_at": 1_792_000_200_000u64, "attempt_count": 2, "current_attempt": attempt_v2("t9", 2, "running"),
                "spec": "encargo privado"
            }));
            match cmd {
                "projects_overview" => Ok(json!({ "v": 1, "projects": [{ "id": "p-1", "name": "app" }], "unassigned": { "tasks": 0 } })),
                "task_list_v2" => {
                    assert_eq!((args["include_discarded"].as_bool(), args["limit"].as_u64()), (Some(true), Some(100)));
                    let start: usize = args["cursor"].as_str().map(|c| c.parse().unwrap()).unwrap_or(0);
                    let page: Vec<Value> = items.iter().skip(start).take(2).cloned().collect();
                    let next = (start + 2 < items.len()).then(|| (start + 2).to_string());
                    Ok(json!({ "v": 2, "core_model": MODEL_V2, "project_id": "p-1", "items": page, "next_cursor": next }))
                }
                "task_detail_v2" => match args["task_id"].as_str().unwrap() {
                    "t3" => Ok(serde_json::from_str(API_DETAIL).unwrap()),
                    "t9" => {
                        let mut t = items.last().unwrap().clone();
                        t["children"] = json!([]);
                        // Del Core, en otro orden: lxo los ordena por n.
                        t["attempts"] = json!([attempt_v2("t9", 2, "running"), attempt_v2("t9", 1, "failed")]);
                        t["thread"] = Value::Null;
                        Ok(json!({ "v": 2, "core_model": MODEL_V2, "task": t }))
                    }
                    id => Err(RpcFailure::Rejected(format!("model_not_found: no existe la Task {id}"))),
                },
                "activity_list" => Ok(json!({ "v": 1, "items": [], "has_more": false })),
                other => panic!("comando inesperado {other}"),
            }
        }
    }

    fn schema_of(raw: &[&str]) -> Result<u64, Failure> {
        let a = args(raw);
        schema(&a, &parse(&a)?)
    }

    #[test]
    fn la_forma_del_json_se_elige_con_schema_y_por_defecto_es_la_1() {
        assert_eq!(schema_of(&["tasks", "--json"]).unwrap(), 1, "sin --schema, la forma 1 (ventana de compatibilidad)");
        assert_eq!(schema_of(&["tasks", "--json", "--schema", "1"]).unwrap(), 1);
        assert_eq!(schema_of(&["task", "show", "t3", "--json", "--schema", "2"]).unwrap(), 2);
        assert_eq!(schema_of(&["tasks", "--json", "--schema", "2", "--state", "in_review", "--run", "r1"]).unwrap(), 2);
        for (raw, wanted) in [
            (&["tasks", "--json", "--schema", "3"][..], "--schema admite 1"),
            (&["tasks", "--schema", "2"][..], "úsalo junto a --json"),
            (&["tasks", "--json", "--schema", "2", "--status", "running"][..], "filtra por el estado de la tarea con --state"),
            (&["tasks", "--json", "--schema", "2", "--active"][..], "lxo attempts --task <id>"),
            (&["tasks", "--json", "--state", "open"][..], "úsalo con --json --schema 2"),
            (&["tasks", "--json", "--schema", "2", "--state", "rara"][..], "--state no reconoce"),
        ] {
            match schema_of(raw) {
                Err(Failure::Usage(m)) => assert!(m.contains(wanted), "{raw:?}: {m}"),
                other => panic!("{raw:?}: {other:?}"),
            }
        }
    }

    /// Las formas publicadas del `--json` de `lxo tasks` y `lxo task show`, legacy (1) y vNext (2).
    #[test]
    fn snapshots_json_legacy_y_vnext() {
        crate::snapshot("tasks.v1.json", &list(&[]));
        crate::snapshot("task_show.v1.json", &show("t2"));
        let v2 = list_v2(&mut core_v2(MODEL_V2), &Filters::default()).unwrap();
        crate::snapshot("tasks.v2.json", &v2);
        let detail = show_v2(&mut core_v2(MODEL_V2), "t3").unwrap();
        crate::snapshot("task_show.v2.json", &detail);
        // La forma 2 no lleva nada de la ejecución: eso es del Attempt (lxo attempt show).
        for doc in [&v2, &detail] {
            let text = doc.to_string();
            for legacy in ["\"provider\"", "\"branch\"", "\"worktree\"", "\"pr_url\"", "\"failure_reason\"", "\"status\":\"done\",\"final\""] {
                assert!(!text.contains(legacy), "{legacy} en la forma 2: {text}");
            }
            assert!(!text.contains("encargo privado") && !text.contains("Implementa /api/session"), "no copia el encargo");
            assert!(!text.contains("\"id\":"), "ids nombrados: task_id, attempt_id…");
        }
    }

    #[test]
    fn forma_2_en_arbol_paginada_y_con_filtros() {
        let all = list_v2(&mut core_v2(MODEL_V2), &Filters::default()).unwrap();
        let ids: Vec<&str> = all["tasks"].as_array().unwrap().iter().map(|t| t["task_id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["t2", "t3", "t4", "t5", "t9", "t17"], "raíz y sus hijas, por creación, de las tres páginas");
        assert_eq!((all["v"].clone(), all["task_model"].clone()), (json!(2), json!("task_attempt_v1")));
        let depth: Vec<u64> = all["tasks"].as_array().unwrap().iter().map(|t| t["depth"].as_u64().unwrap()).collect();
        assert_eq!(depth, [0, 1, 1, 1, 0, 0]);
        let filtered = list_v2(
            &mut core_v2(MODEL_V2),
            &Filters { state: Some("in_review".into()), ..Filters::default() },
        )
        .unwrap();
        let ids: Vec<&str> = filtered["tasks"].as_array().unwrap().iter().map(|t| t["task_id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["t2", "t5"]);
        assert_eq!(
            list_v2(&mut core_v2(MODEL_V2), &Filters { run: Some("r9".into()), ..Filters::default() }).unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    /// Invariante de LXO-125: con N intentos, la forma 2 los nombra a todos y no elige ninguno; el detalle de una
    /// ejecución se pide por su id (`lxo attempt show`, que rechaza el id de una Task).
    #[test]
    fn una_tarea_con_n_intentos_obliga_a_elegir_uno() {
        let doc = show_v2(&mut core_v2(MODEL_V2), "t9").unwrap();
        let task = &doc["task"];
        assert_eq!(
            task["attempts"],
            json!([
                { "attempt_id": "t9-a1", "n": 1, "status": "failed" },
                { "attempt_id": "t9-a2", "n": 2, "status": "running" }
            ])
        );
        assert_eq!((task["attempt_count"].clone(), task["current_attempt"]["attempt_id"].clone()), (json!(2), json!("t9-a2")));
        assert!(task.get("provider").is_none() && task.get("branch").is_none() && task.get("worktree").is_none());
        match show_v2(&mut core_v2(MODEL_V2), "reintentada") {
            Err(Failure::NotFound(m)) => assert!(m.contains("se busca por id"), "{m}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn forma_2_antes_del_corte_sale_con_4() {
        for result in [
            list_v2(&mut core_v2("legacy"), &Filters::default()),
            show_v2(&mut core_v2("legacy"), "t3"),
        ] {
            match result {
                Err(f @ Failure::Version(_)) => {
                    assert!(f.message().contains("--json sin --schema"), "{}", f.message());
                    assert_eq!(f.code().1, 4);
                }
                other => panic!("{other:?}"),
            }
        }
    }
}
