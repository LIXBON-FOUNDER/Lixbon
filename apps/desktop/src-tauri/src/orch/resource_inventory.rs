//! LXO-93 · inventario de recursos de solo lectura (`resource_inventory`): worktrees y ramas asociados al trabajo que
//! Lixbon conoce, y las discrepancias entre lo que el Core cree y lo que hay en disco y en git.
//!
//! **Detectar no es adoptar ni borrar.** Esta query no tiene ninguna acción: no crea, no borra, no adopta, no poda
//! y no cambia el índice de ningún repositorio (`resource_git.rs`). Un worktree que ninguna Task reclama nunca
//! recibe dueño. Una consulta de git que falla es `unknown`/`unavailable`, jamás `missing`: «falta» se dice solo
//! cuando el sistema de archivos lo afirma. Contrato y matriz estado físico <-> estado mostrado:
//! `docs/core/RESOURCES.md`.
//!
//! Orden de trabajo (como `snapshot.rs`): con el guard del estado tomado se copian las Tasks y se lee el registro de
//! proyectos; después, SIN ningún bloqueo del Core, se pregunta a git y al disco. Un git lento no frena a `lxo`.

use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Map, Value};

use super::events::{Actor, MutationContext};
use super::projects::{machine_id_read, norm_path};
use super::resource_git::{self as rgit, GitFail, Listed};
use super::state::Status;
use super::{git, Caller, Core};
use crate::store::{LocationRow, StoreResult};

const API_VERSION: u8 = 1;
const MAX_FILTER_CHARS: usize = 200;
const PARAMS: [&str; 2] = ["project_id", "probe"];

/// Todos los estados que puede mostrar un worktree. El contador por estado lleva siempre las seis claves.
const STATES: [&str; 6] = [
    "tracked",
    "missing_on_disk",
    "not_registered",
    "orphan_candidate",
    "external",
    "unknown",
];

fn invalid(message: impl Into<String>) -> String {
    format!("resource_inventory_invalid_request: {}", message.into())
}

/// Solo una Person autenticada: el inventario contiene rutas locales y un Agent solo ve su Task.
fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    let context = context.ok_or_else(|| {
        "resource_inventory_auth_required: la lectura requiere un cliente autenticado".to_string()
    })?;
    match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("resource_inventory_auth_required: solo una Person autenticada puede leer el inventario".into()),
    }
}

struct Params {
    project_id: Option<String>,
    probe: bool,
}

fn parse_params(args: &Value) -> Result<Params, String> {
    let empty = Map::new();
    let map = match args {
        Value::Null => &empty,
        Value::Object(map) => map,
        _ => return Err(invalid("los parámetros deben ser un objeto")),
    };
    if let Some(key) = map.keys().find(|key| !PARAMS.contains(&key.as_str())) {
        return Err(invalid(format!("parámetro desconocido: {key}")));
    }
    let project_id = match map.get("project_id").filter(|v| !v.is_null()) {
        None => None,
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() || s.chars().count() > MAX_FILTER_CHARS {
                return Err(invalid(format!(
                    "`project_id` debe contener de 1 a {MAX_FILTER_CHARS} caracteres"
                )));
            }
            Some(s.to_string())
        }
        Some(_) => return Err(invalid("`project_id` debe ser texto")),
    };
    let probe = match map.get("probe").filter(|v| !v.is_null()) {
        None => true,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(invalid("`probe` debe ser verdadero o falso")),
    };
    Ok(Params { project_id, probe })
}

/// Lo que el inventario necesita de una Task (copiado con el guard del estado y soltado enseguida).
struct TaskView {
    id: String,
    run: String,
    status: Status,
    project_id: Option<String>,
    repo: String,
    worktree: Option<String>,
    branch: Option<String>,
    base: Option<String>,
    merged: bool,
}

impl TaskView {
    fn owner(&self) -> Value {
        json!({ "task_id": self.id, "run_id": self.run, "status": status_code(self.status) })
    }
}

fn status_code(status: Status) -> Value {
    serde_json::to_value(status).unwrap_or(Value::Null)
}

/// Ruta para mostrar: git responde con `/` también en Windows.
fn display(path: &str) -> String {
    if cfg!(windows) {
        path.replace('/', "\\")
    } else {
        path.to_string()
    }
}

/// Lo único que decide «falta»: el sistema de archivos. Cualquier otro error (permisos, red) es `unknown`.
fn physical(path: &str) -> &'static str {
    match std::fs::metadata(path) {
        Ok(m) if m.is_dir() => "present",
        Ok(_) => "unknown",
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "missing",
        Err(_) => "unknown",
    }
}

struct Scan {
    listed: Vec<Listed>,
    /// `None` si no se pudieron listar las ramas (el worktree sí se listó).
    branches: Option<BTreeSet<String>>,
}

fn scan_repo(path: &str) -> Result<Scan, GitFail> {
    let listed = rgit::worktree_list(path)?;
    Ok(Scan {
        listed,
        branches: rgit::local_branches(path).ok(),
    })
}

/// Un repositorio conocido: el checkout principal y todo lo que git y el Core saben de él.
struct Group {
    keys: BTreeSet<String>,
    display: String,
    project_id: Option<String>,
    scan: Result<Scan, GitFail>,
}

impl Group {
    fn scan_state(&self) -> &'static str {
        if self.scan.is_ok() {
            "ok"
        } else {
            "unavailable"
        }
    }

    /// Carpeta `<repo>.lixbon-wt`: donde Lixbon crea sus worktrees.
    fn lixbon_dir(&self) -> String {
        let probe = git::worktree_dir(&self.display, None, "x");
        probe
            .parent()
            .map(|p| norm_path(&p.to_string_lossy()))
            .unwrap_or_default()
    }

    fn branch_exists(&self, branch: &str) -> Option<bool> {
        self.scan
            .as_ref()
            .ok()
            .and_then(|s| s.branches.as_ref())
            .map(|b| b.contains(branch))
    }
}

fn state_label(merged: Option<bool>) -> &'static str {
    match merged {
        Some(true) => "merged",
        Some(false) => "unmerged",
        None => "unknown",
    }
}

fn target(machine: &Option<String>, group: &Group, field: &str, value: &str) -> Value {
    let mut t =
        json!({ "machine": machine, "project_id": group.project_id, "repo": group.display });
    t[field] = json!(value);
    t
}

/// Lo que se calcula sobre una rama de un repo: fusionada y destino.
struct Merge {
    label: &'static str,
    into: Option<String>,
}

pub(super) fn inventory(
    core: &Core,
    caller: &Caller,
    context: Option<&MutationContext>,
    args: &Value,
) -> Result<Value, String> {
    require_person(caller, context)?;
    let params = parse_params(args)?;

    // 1. Con el guard del estado tomado se copian las Tasks y se lee el registro (mismo orden que toda mutación).
    let (tasks, machine, locations) = {
        let state = core.lock();
        let tasks: Vec<TaskView> = state
            .tasks
            .values()
            .map(|t| TaskView {
                id: t.id.clone(),
                run: t.run.clone(),
                status: t.status,
                project_id: t.project_id.clone(),
                repo: t.repo.clone(),
                worktree: t.worktree.clone(),
                branch: t.branch.clone(),
                base: t.base.clone(),
                merged: t.merged,
            })
            .collect();
        let (machine, locations) = core
            .storage
            .read_store(|store| -> StoreResult<(Option<String>, Vec<LocationRow>)> { Ok((machine_id_read(store)?, store.project_locations(None)?)) })
            .ok_or_else(|| "resource_inventory_unavailable: el Core no tiene un almacén autoritativo disponible".to_string())?
            .map_err(|_| "resource_inventory_read_failed: no se pudo consultar el registro de proyectos".to_string())?;
        (tasks, machine, locations)
    };

    // 2. Repos conocidos de ESTA máquina: ubicaciones de proyectos y repos de las Tasks. Sin escáner global.
    let wanted = |project: &Option<String>| {
        params
            .project_id
            .as_ref()
            .is_none_or(|p| project.as_ref() == Some(p))
    };
    let mut candidates: BTreeMap<String, (String, Option<String>)> = BTreeMap::new();
    let mut other_machines: BTreeMap<(String, String, String), Value> = BTreeMap::new();
    for l in &locations {
        let project = Some(l.project_id.clone());
        if !wanted(&project) {
            continue;
        }
        if machine.as_ref() == Some(&l.machine) {
            let entry = candidates
                .entry(norm_path(&l.display_path))
                .or_insert_with(|| (l.display_path.clone(), None));
            entry.1 = entry.1.take().or(project);
        } else {
            other_machines.insert(
                (l.project_id.clone(), l.machine.clone(), norm_path(&l.display_path)),
                json!({ "project_id": l.project_id, "machine": l.machine, "path": l.display_path, "scan": "other_machine", "reason": "other_machine" }),
            );
        }
    }
    for t in &tasks {
        let key = norm_path(&t.repo);
        if key.is_empty() {
            continue;
        }
        let known = candidates.get(&key).and_then(|c| c.1.clone());
        let project = known.or_else(|| t.project_id.clone());
        if !wanted(&project) {
            continue;
        }
        let entry = candidates
            .entry(key)
            .or_insert_with(|| (t.repo.clone(), None));
        entry.1 = entry.1.take().or(project);
    }

    // 3. Preguntar a git y al disco (sin ningún bloqueo del Core) y agrupar por checkout principal.
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for (key, (path, project)) in candidates {
        let scan = scan_repo(&path);
        let main = scan
            .as_ref()
            .ok()
            .and_then(|s| s.listed.first())
            .filter(|w| !w.bare)
            .map(|w| (norm_path(&w.path), display(&w.path)));
        let (group_key, shown) = main.unwrap_or_else(|| (key.clone(), path.clone()));
        let group = groups.entry(group_key.clone()).or_insert_with(|| Group {
            keys: BTreeSet::new(),
            display: shown,
            project_id: None,
            scan,
        });
        group.keys.insert(key);
        group.keys.insert(group_key);
        group.project_id = group.project_id.take().or(project);
    }

    // 4. Reconciliar cada repo: Tasks <-> git <-> disco.
    let mut repos: Vec<Value> = Vec::new();
    let mut worktrees: Vec<Value> = Vec::new();
    let mut preserved: Vec<Value> = Vec::new();
    for group in groups.values() {
        let mut repo = json!({ "project_id": group.project_id, "machine": machine, "path": group.display, "scan": group.scan_state() });
        if let Err(fail) = &group.scan {
            repo["reason"] = json!(fail.code());
        }
        repos.push(repo);
        let default = OnceCell::new();
        let default_branch = || {
            default
                .get_or_init(|| rgit::default_branch(&group.display))
                .clone()
        };
        let merge_of =
            |task: Option<&TaskView>, branch: Option<&str>, exists: Option<bool>| -> Merge {
                let into = task.and_then(|t| t.base.clone()).or_else(default_branch);
                if !params.probe {
                    return Merge {
                        label: "skipped",
                        into,
                    };
                }
                if task.is_some_and(|t| t.merged) {
                    return Merge {
                        label: "merged",
                        into,
                    };
                }
                let verdict = match (branch, into.as_deref(), group.scan.is_ok(), exists) {
                    (Some(branch), Some(into), true, Some(true) | None) => {
                        rgit::is_ancestor(&group.display, branch, into)
                    }
                    _ => None,
                };
                Merge {
                    label: state_label(verdict),
                    into,
                }
            };

        let mine: Vec<&TaskView> = tasks
            .iter()
            .filter(|t| group.keys.contains(&norm_path(&t.repo)))
            .collect();
        let listed: Vec<&Listed> = group
            .scan
            .as_ref()
            .ok()
            .map(|s| s.listed.iter().skip(1).filter(|w| !w.bare).collect())
            .unwrap_or_default();
        let mut claimed: BTreeSet<String> = BTreeSet::new();

        // 4a. Worktrees que una Task dice tener.
        for t in mine.iter().filter(|t| t.worktree.is_some()) {
            let path = t.worktree.as_deref().unwrap_or_default();
            let key = norm_path(path);
            claimed.insert(key.clone());
            let found = listed.iter().find(|w| norm_path(&w.path) == key).copied();
            let disk = physical(path);
            let registered = group.scan.is_ok().then_some(found.is_some());
            let state = match (disk, registered) {
                ("missing", _) => "missing_on_disk",
                ("unknown", _) | (_, None) => "unknown",
                (_, Some(false)) => "not_registered",
                (_, Some(true)) => "tracked",
            };
            let branch = found
                .and_then(|w| w.branch.clone())
                .or_else(|| t.branch.clone());
            let exists = branch.as_deref().and_then(|b| group.branch_exists(b));
            let dirty = if !params.probe || disk != "present" || found.is_none() {
                "skipped"
            } else {
                match rgit::is_dirty(path) {
                    Some(true) => "dirty",
                    Some(false) => "clean",
                    None => "unknown",
                }
            };
            let merge = merge_of(Some(t), branch.as_deref(), exists);
            let needs_review = params
                .probe
                .then(|| merge.label == "unmerged" && exists == Some(true) && t.status.is_final());
            worktrees.push(json!({
                "target": target(&machine, group, "path", &found.map(|w| display(&w.path)).unwrap_or_else(|| path.to_string())),
                "state": state,
                "origin": "task",
                "physical": disk,
                "git": git_json(found, registered),
                "owner": t.owner(),
                "dirty": dirty,
                "merged": merge.label,
                "into": merge.into,
                "needs_review": needs_review,
            }));
        }

        // 4b. Worktrees que git lista y ninguna Task reclama: candidatos huérfanos o externos. Sin dueño.
        let lixbon_dir = group.lixbon_dir();
        for w in listed
            .iter()
            .filter(|w| !claimed.contains(&norm_path(&w.path)))
        {
            let key = norm_path(&w.path);
            let in_lixbon_dir =
                !lixbon_dir.is_empty() && key.starts_with(&format!("{lixbon_dir}/"));
            let disk = physical(&w.path);
            let state = match (disk, in_lixbon_dir) {
                ("missing", _) => "missing_on_disk",
                ("unknown", _) => "unknown",
                (_, true) => "orphan_candidate",
                (_, false) => "external",
            };
            let dirty = if !params.probe || disk != "present" {
                "skipped"
            } else {
                match rgit::is_dirty(&w.path) {
                    Some(true) => "dirty",
                    Some(false) => "clean",
                    None => "unknown",
                }
            };
            let exists = w.branch.as_deref().and_then(|b| group.branch_exists(b));
            let merge = merge_of(None, w.branch.as_deref(), exists);
            worktrees.push(json!({
                "target": target(&machine, group, "path", &display(&w.path)),
                "state": state,
                "origin": if in_lixbon_dir { "lixbon_dir" } else { "external" },
                "physical": disk,
                "git": git_json(Some(w), Some(true)),
                "owner": Value::Null,
                "dirty": dirty,
                "merged": merge.label,
                "into": merge.into,
                // No es trabajo de Lixbon: nunca cuenta como «rama por revisar».
                "needs_review": params.probe.then_some(false),
            }));
        }

        // 4c. Ramas que Lixbon creó y conservó tras liberar el worktree (con `base`: las raíces guardan la rama del
        // propio checkout y no cuentan). Una rama sin fusionar conservada es normal, no un error de integridad.
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for t in mine
            .iter()
            .filter(|t| t.worktree.is_none() && t.base.is_some())
        {
            let Some(branch) = t.branch.as_deref() else {
                continue;
            };
            if !seen.insert(branch.to_string()) {
                continue;
            }
            let exists = group.branch_exists(branch);
            let merge = merge_of(Some(t), Some(branch), exists);
            let needs_review = params
                .probe
                .then(|| exists == Some(true) && merge.label == "unmerged");
            preserved.push(json!({
                "target": target(&machine, group, "branch", branch),
                "branch_exists": exists,
                "owner": t.owner(),
                "merged": merge.label,
                "into": merge.into,
                "needs_review": needs_review,
            }));
        }
    }

    // 5. Orden determinista y avisos derivados del propio inventario (nunca de otra fuente).
    let sort_key = |v: &Value, field: &str| {
        (
            v["target"]["repo"]
                .as_str()
                .map(norm_path)
                .unwrap_or_default(),
            v["target"][field]
                .as_str()
                .map(norm_path)
                .unwrap_or_default(),
        )
    };
    worktrees.sort_by_key(|v| sort_key(v, "path"));
    preserved.sort_by_key(|v| sort_key(v, "branch"));
    repos.extend(other_machines.into_values());
    repos.sort_by_key(|v| {
        (
            v["path"].as_str().map(norm_path).unwrap_or_default(),
            v["machine"].as_str().unwrap_or_default().to_string(),
        )
    });

    let mut by_state = Map::new();
    for state in STATES {
        by_state.insert(
            state.to_string(),
            json!(worktrees.iter().filter(|w| w["state"] == state).count()),
        );
    }
    let to_review = params.probe.then(|| {
        worktrees
            .iter()
            .chain(preserved.iter())
            .filter(|v| v["needs_review"] == true)
            .count()
    });
    Ok(json!({
        "v": API_VERSION,
        "machine": machine,
        "filters": { "project_id": params.project_id, "probe": params.probe },
        "repos": repos,
        "worktrees": worktrees,
        "preserved_branches": preserved,
        "warnings": { "branches_to_review": to_review, "worktrees_by_state": by_state },
    }))
}

fn git_json(found: Option<&Listed>, registered: Option<bool>) -> Value {
    json!({
        "registered": registered,
        "branch": found.and_then(|w| w.branch.clone()),
        "detached": found.map(|w| w.detached),
        "locked": found.map(|w| w.locked),
        "prunable": found.map(|w| w.prunable),
    })
}
