//! LXO-90 · overview multiproyecto de solo lectura (`projects_overview`).
//!
//! La clave de todo es `project_id`: la ubicación (máquina y ruta) viaja como metadato y nunca agrupa.
//! Los contadores salen de las mismas fuentes que las consultas de detalle: las tasks del `State`
//! (`active`, `failed`) y la Attention activa de SQLite (la que lista `attention_list`). Se leen con el
//! guard del estado tomado, en el orden estado -> almacén de toda mutación: ninguna mutación puede
//! quedar a medias entre las dos fuentes. No toca el disco ni escribe nada. Contrato: `docs/core/QUERIES.md`.

use std::collections::{BTreeMap, HashMap};

use serde_json::{json, Map, Value};

use super::events::{Actor, MutationContext};
use super::state::State;
use super::{Caller, Core};
use crate::store::{AttentionCategory, LocationRow, ProjectRow, Store, StoreResult};

const API_VERSION: u8 = 1;
const MAX_FILTER_CHARS: usize = 200;
const PARAMS: [&str; 2] = ["archived", "machine"];

/// Qué hacer con los proyectos archivados. Por defecto no salen de la vista, pero siguen en el registro.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Archived {
    Exclude,
    Include,
    Only,
}

impl Archived {
    fn as_str(self) -> &'static str {
        match self {
            Archived::Exclude => "exclude",
            Archived::Include => "include",
            Archived::Only => "only",
        }
    }

    fn keeps(self, archived: bool) -> bool {
        match self {
            Archived::Exclude => !archived,
            Archived::Include => true,
            Archived::Only => archived,
        }
    }
}

struct Params {
    archived: Archived,
    machine: Option<String>,
}

#[derive(Default, Clone, Copy)]
struct TaskCounts {
    total: u64,
    active: u64,
    failed: u64,
}

fn invalid(message: impl Into<String>) -> String {
    format!("projects_overview_invalid_request: {}", message.into())
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
    let archived = match map.get("archived").filter(|v| !v.is_null()) {
        None => Archived::Exclude,
        Some(Value::String(s)) if s == "exclude" => Archived::Exclude,
        Some(Value::String(s)) if s == "include" => Archived::Include,
        Some(Value::String(s)) if s == "only" => Archived::Only,
        Some(_) => return Err(invalid("`archived` debe ser `exclude`, `include` o `only`")),
    };
    let machine = match map.get("machine").filter(|v| !v.is_null()) {
        None => None,
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() || s.chars().count() > MAX_FILTER_CHARS {
                return Err(invalid(format!(
                    "`machine` debe contener de 1 a {MAX_FILTER_CHARS} caracteres"
                )));
            }
            Some(s.to_string())
        }
        Some(_) => return Err(invalid("`machine` debe ser texto")),
    };
    Ok(Params { archived, machine })
}

/// Solo una Person autenticada: un Agent ve únicamente su Task y el token legacy no autentica esta API.
fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    let context = context.ok_or_else(|| {
        "projects_overview_auth_required: la lectura requiere un cliente autenticado".to_string()
    })?;
    match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err(
            "projects_overview_auth_required: solo una Person autenticada puede leer el overview"
                .into(),
        ),
    }
}

fn task_counts(state: &State) -> (HashMap<String, TaskCounts>, TaskCounts) {
    let mut by_project: HashMap<String, TaskCounts> = HashMap::new();
    let mut unassigned = TaskCounts::default();
    for task in state.tasks.values() {
        let counts = match &task.project_id {
            Some(id) => by_project.entry(id.clone()).or_default(),
            None => &mut unassigned,
        };
        counts.total += 1;
        if !task.status.is_final() {
            counts.active += 1;
        }
        if task.status == super::state::Status::Failed {
            counts.failed += 1;
        }
    }
    (by_project, unassigned)
}

/// Lo que se lee del almacén en una sola pasada: proyectos, ubicaciones y Attention activa.
struct Stored {
    projects: Vec<ProjectRow>,
    locations: HashMap<String, Vec<LocationRow>>,
    attention: HashMap<Option<String>, BTreeMap<&'static str, u64>>,
}

fn read_stored(store: &Store) -> StoreResult<Stored> {
    let projects = store.projects(true)?;
    let mut locations: HashMap<String, Vec<LocationRow>> = HashMap::new();
    for location in store.project_locations(None)? {
        locations
            .entry(location.project_id.clone())
            .or_default()
            .push(location);
    }
    let mut attention: HashMap<Option<String>, BTreeMap<&'static str, u64>> = HashMap::new();
    for (project, category, n) in store.attention_active_counts()? {
        *attention
            .entry(project)
            .or_default()
            .entry(category.as_str())
            .or_default() += n;
    }
    Ok(Stored {
        projects,
        locations,
        attention,
    })
}

/// Las siete categorías siempre presentes (con 0): la forma de la respuesta no depende de los datos.
fn attention_json(by_category: Option<&BTreeMap<&'static str, u64>>) -> Value {
    let mut categories = Map::new();
    let mut total = 0;
    for category in AttentionCategory::ALL {
        let n = by_category
            .and_then(|m| m.get(category.as_str()))
            .copied()
            .unwrap_or(0);
        total += n;
        categories.insert(category.as_str().to_string(), json!(n));
    }
    json!({ "total": total, "by_category": categories })
}

/// Estado agregado en un código estable (la interfaz lo traduce). Prioridad: `failed` > `attention` > `active` > `idle`.
fn aggregate_status(counts: &TaskCounts, attention_total: u64) -> &'static str {
    if counts.failed > 0 {
        "failed"
    } else if attention_total > 0 {
        "attention"
    } else if counts.active > 0 {
        "active"
    } else {
        "idle"
    }
}

fn location_json(l: &LocationRow) -> Value {
    json!({
        "machine": l.machine,
        "path": l.display_path,
        "primary": l.primary,
        "state": if l.missing { "missing" } else { "ok" },
        "last_seen": l.last_seen,
    })
}

pub(super) fn overview(
    core: &Core,
    caller: &Caller,
    context: Option<&MutationContext>,
    args: &Value,
) -> Result<Value, String> {
    require_person(caller, context)?;
    let params = parse_params(args)?;

    // El guard del estado se mantiene mientras se lee SQLite: `mutate` hace lo mismo al persistir, así que las
    // tasks y la Attention que se cuentan son de la misma versión del Core.
    let state = core.lock();
    let (tasks, unassigned_tasks) = task_counts(&state);
    let stored = core
        .storage
        .read_store(read_stored)
        .ok_or_else(|| {
            "projects_overview_unavailable: el Core no tiene un almacén autoritativo disponible"
                .to_string()
        })?
        .map_err(|_| {
            "projects_overview_read_failed: no se pudo consultar el registro de proyectos"
                .to_string()
        })?;
    drop(state);

    let mut projects: Vec<&ProjectRow> = stored
        .projects
        .iter()
        .filter(|p| params.archived.keeps(p.archived))
        .filter(|p| match &params.machine {
            None => true,
            Some(machine) => stored
                .locations
                .get(&p.id)
                .is_some_and(|ls| ls.iter().any(|l| &l.machine == machine)),
        })
        .collect();
    // Orden documentado: nombre en minúsculas y, a igualdad, `project_id`.
    projects.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });

    let items: Vec<Value> = projects
        .iter()
        .map(|p| {
            let counts = tasks.get(&p.id).copied().unwrap_or_default();
            let by_category = stored.attention.get(&Some(p.id.clone()));
            let attention = attention_json(by_category);
            let attention_total = attention["total"].as_u64().unwrap_or(0);
            json!({
                "id": p.id,
                "name": p.name,
                "state": if p.archived { "archived" } else { "active" },
                "status": aggregate_status(&counts, attention_total),
                "counts": {
                    "tasks": counts.total,
                    "active": counts.active,
                    "failed": counts.failed,
                    "attention": attention,
                },
                "locations": stored.locations.get(&p.id).map(|ls| ls.iter().map(location_json).collect::<Vec<_>>()).unwrap_or_default(),
            })
        })
        .collect();

    Ok(json!({
        "v": API_VERSION,
        "filters": { "archived": params.archived.as_str(), "machine": params.machine },
        "total": items.len(),
        "projects": items,
        "unassigned": {
            "tasks": unassigned_tasks.total,
            "active": unassigned_tasks.active,
            "failed": unassigned_tasks.failed,
            "attention": attention_json(stored.attention.get(&None)),
        },
    }))
}
