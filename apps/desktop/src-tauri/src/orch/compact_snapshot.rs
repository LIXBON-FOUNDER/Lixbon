//! LXO-94 · snapshot compacta de solo lectura (`compact_snapshot`) para clientes ligeros.
//!
//! Una sola query de arranque para Mobile, el resumen del CLI y la rehidratación rápida: Projects con su
//! resumen, Tasks activas mínimas, Attention (contadores y los elementos más urgentes) y los metadatos del
//! Core, más el cursor del Event Log desde el que el cliente sigue. Es una vista derivada de las mismas
//! fuentes que `projects_overview`, `tasks_by_project` y `attention_list`: no es una segunda base ni una
//! autoridad que el cliente deba guardar.
//!
//! Consistencia: con el guard del estado tomado (como `mutate` al persistir) se leen en UNA instantánea de
//! SQLite el registro, la Attention y el `head_seq` del Event Log. Así las Tasks, la Attention y el cursor son
//! del mismo punto del Core: lo que pase después llega por `events` con `cursor = cursor.events`.
//!
//! Tamaño: cada lista tiene un tope fijo y cada texto libre un máximo de caracteres; lo que no cabe se marca
//! (`truncated`, `total`), nunca se aparenta completo. Contrato y presupuesto: `docs/core/QUERIES.md`.

use serde_json::{json, Map, Value};

use super::events::{Actor, MutationContext};
use super::mutation::Health;
use super::projects_overview::{aggregate_status, task_counts};
use super::state::{now_ms, Task};
use super::{Caller, Core};
use crate::store::{AttentionCategory, AttentionRow, ProjectRow, Store, StoreResult};

/// Versión del esquema de la snapshot. Cambia solo si se rompe la forma; los campos nuevos no la suben.
pub(super) const SNAPSHOT_VERSION: u8 = 1;
/// Topes de cada lista. Con estos valores la respuesta cabe en [`MAX_SNAPSHOT_BYTES`] (hay una prueba).
pub(super) const MAX_PROJECTS: usize = 50;
pub(super) const MAX_ACTIVE_TASKS: usize = 50;
pub(super) const DEFAULT_ATTENTION_ITEMS: usize = 5;
pub(super) const MAX_ATTENTION_ITEMS: usize = 20;
/// Máximo de caracteres de los textos libres (título de Task, nombre de Project).
pub(super) const MAX_TEXT_CHARS: usize = 120;
/// Presupuesto documentado del JSON serializado en el peor caso que permiten los topes (todos los textos con
/// caracteres de 4 bytes). Un workspace grande típico ocupa bastante menos (medido en las pruebas).
pub(super) const MAX_SNAPSHOT_BYTES: usize = 128 * 1024;
const PARAMS: [&str; 1] = ["attention_items"];

fn invalid(message: impl Into<String>) -> String {
    format!("compact_snapshot_invalid_request: {}", message.into())
}

/// Solo una Person autenticada: un Agent ve únicamente su Task y el token legacy no autentica esta API.
fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    let context = context.ok_or_else(|| {
        "compact_snapshot_auth_required: la lectura requiere un cliente autenticado".to_string()
    })?;
    match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("compact_snapshot_auth_required: solo una Person autenticada puede leer la snapshot".into()),
    }
}

fn parse_attention_items(args: &Value) -> Result<usize, String> {
    let empty = Map::new();
    let map = match args {
        Value::Null => &empty,
        Value::Object(map) => map,
        _ => return Err(invalid("los parámetros deben ser un objeto")),
    };
    if let Some(key) = map.keys().find(|key| !PARAMS.contains(&key.as_str())) {
        return Err(invalid(format!("parámetro desconocido: {key}")));
    }
    match map.get("attention_items").filter(|v| !v.is_null()) {
        None => Ok(DEFAULT_ATTENTION_ITEMS),
        Some(v) => v
            .as_u64()
            .filter(|n| *n <= MAX_ATTENTION_ITEMS as u64)
            .map(|n| n as usize)
            .ok_or_else(|| invalid(format!("`attention_items` debe ser un entero entre 0 y {MAX_ATTENTION_ITEMS}"))),
    }
}

/// Texto libre para un resumen: los caracteres de control pasan a espacio (no se imprimen y JSON los
/// escaparía a 6 bytes) y se recorta a [`MAX_TEXT_CHARS`] caracteres; si se recorta, acaba en `…`.
pub(super) fn clip(text: &str) -> String {
    let clean = |c: char| if c.is_control() { ' ' } else { c };
    if text.chars().count() <= MAX_TEXT_CHARS {
        return text.chars().map(clean).collect();
    }
    let mut out: String = text.chars().take(MAX_TEXT_CHARS - 1).map(clean).collect();
    out.push('…');
    out
}

/// Lo que se lee de SQLite en una sola instantánea.
struct Stored {
    projects: Vec<ProjectRow>,
    attention: Vec<(Option<String>, AttentionCategory, u64)>,
    top: Vec<AttentionRow>,
    head_seq: i64,
    machine_id: Option<String>,
}

fn read_stored(store: &Store, top: usize) -> StoreResult<Stored> {
    store.read_snapshot(|store| {
        Ok(Stored {
            projects: store.projects(false)?,
            attention: store.attention_active_counts()?,
            top: store.attention_active_top(top)?,
            head_seq: store.events_head()?,
            // Solo se lee: si aún no existe, la snapshot no lo crea.
            machine_id: store.meta("machine_id")?,
        })
    })
}

/// Las siete categorías siempre presentes (con 0): la forma no depende de los datos.
fn by_category(rows: &[(Option<String>, AttentionCategory, u64)], keep: impl Fn(&Option<String>) -> bool) -> (u64, Value) {
    let mut categories = Map::new();
    let mut total = 0;
    for category in AttentionCategory::ALL {
        let n: u64 = rows.iter().filter(|(p, c, _)| *c == category && keep(p)).map(|(_, _, n)| n).sum();
        total += n;
        categories.insert(category.as_str().to_string(), json!(n));
    }
    (total, Value::Object(categories))
}

/// Prioridad para recortar Projects: primero los que piden algo (fallos, Attention, trabajo en curso).
fn status_rank(status: &str) -> u8 {
    match status {
        "failed" => 0,
        "attention" => 1,
        "active" => 2,
        _ => 3,
    }
}

fn task_json(task: &Task, root: Option<&str>) -> Value {
    json!({
        "id": task.id,
        "project_id": task.project_id,
        "run_id": task.run,
        "parent_id": task.parent,
        "root_id": root,
        "status": task.status,
        "title": clip(&task.title),
        "provider": task.agent,
        "origin": if task.external { "external" } else { "lixbon" },
        "updated_at": task.updated,
    })
}

fn attention_item(row: &AttentionRow) -> Value {
    // Allowlist mínima del DTO de `attention_list`: sin `subject`, `facts` ni ids de correlación.
    json!({
        "id": row.id,
        "category": row.category.as_str(),
        "severity": row.severity.as_str(),
        "target_kind": row.target.kind.as_str(),
        "target_id": row.target.id,
        "project_id": row.project_id,
        "created_at": row.created_at,
    })
}

pub(super) fn snapshot(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let attention_items = parse_attention_items(args)?;

    // Guard del estado tomado mientras se lee SQLite: `mutate` persiste estado y eventos con él tomado, así que
    // Tasks, Attention y `head_seq` son del mismo punto. Los hechos que `record_facts` añade sin el guard solo
    // tocan SQLite, y SQLite se lee en una única instantánea.
    let state = core.lock();
    let (counts, unassigned) = task_counts(&state);
    let mut active: Vec<&Task> = state.tasks.values().filter(|t| !t.status.is_final()).collect();
    active.sort_by(|a, b| (b.updated as u64).cmp(&(a.updated as u64)).then_with(|| a.id.cmp(&b.id)));
    let active_total = active.len();
    let tasks: Vec<Value> = active
        .iter()
        .take(MAX_ACTIVE_TASKS)
        .map(|t| task_json(t, state.runs.get(&t.run).map(|r| r.root.as_str())))
        .collect();
    let stored = core
        .storage
        .read_store(|store| read_stored(store, attention_items))
        .ok_or_else(|| "compact_snapshot_unavailable: el Core no tiene un almacén autoritativo disponible".to_string())?
        .map_err(|_| "compact_snapshot_read_failed: no se pudo leer el estado del Core".to_string())?;
    drop(state);

    let mut projects: Vec<(u8, &ProjectRow, Value)> = stored
        .projects
        .iter()
        .map(|p| {
            let c = counts.get(&p.id).copied().unwrap_or_default();
            let (attention_total, _) = by_category(&stored.attention, |id| id.as_deref() == Some(p.id.as_str()));
            let status = aggregate_status(&c, attention_total);
            let item = json!({
                "id": p.id,
                "name": clip(&p.name),
                "status": status,
                "active": c.active,
                "failed": c.failed,
                "attention": attention_total,
            });
            (status_rank(status), p, item)
        })
        .collect();
    // Orden: prioridad del estado, nombre en minúsculas y `project_id`. Es el orden de recorte.
    projects.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.name.to_lowercase().cmp(&b.1.name.to_lowercase()))
            .then_with(|| a.1.id.cmp(&b.1.id))
    });
    let projects_total = projects.len();
    let project_items: Vec<Value> = projects.into_iter().take(MAX_PROJECTS).map(|(_, _, v)| v).collect();

    let (attention_total, attention_categories) = by_category(&stored.attention, |_| true);
    let (unassigned_attention, _) = by_category(&stored.attention, |id| id.is_none());
    let top: Vec<Value> = stored.top.iter().map(attention_item).collect();

    Ok(json!({
        "snapshot_version": SNAPSHOT_VERSION,
        "generated_at": now_ms(),
        "core": {
            "version": env!("CARGO_PKG_VERSION"),
            "health": match core.health() { Health::Normal => "ok", Health::DegradedReadOnly(_) => "read_only" },
            "machine_id": stored.machine_id,
        },
        "cursor": { "events": stored.head_seq },
        "projects": {
            "total": projects_total,
            "truncated": projects_total > project_items.len(),
            "items": project_items,
        },
        "active_tasks": {
            "total": active_total,
            "truncated": active_total > tasks.len(),
            "items": tasks,
        },
        "attention": {
            "total": attention_total,
            "by_category": attention_categories,
            "truncated": (attention_total as usize) > top.len(),
            "items": top,
        },
        "unassigned": {
            "active": unassigned.active,
            "failed": unassigned.failed,
            "attention": unassigned_attention,
        },
        "limits": {
            "projects": MAX_PROJECTS,
            "active_tasks": MAX_ACTIVE_TASKS,
            "attention_items": attention_items,
            "text_chars": MAX_TEXT_CHARS,
        },
    }))
}
