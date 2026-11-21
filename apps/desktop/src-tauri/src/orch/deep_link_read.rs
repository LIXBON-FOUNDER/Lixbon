//! LXO-168 · resolución de enlaces `lixbon://` contra el Core: `deep_link_resolve` y `deep_link_generate`.
//!
//! Contrato: `docs/core/DEEP_LINKS.md`. La forma del enlace la valida `deep_link.rs` sin tocar nada; aquí se comprueba contra
//! el almacén que el destino existe, que sus entidades son coherentes entre sí y que la vista pedida está disponible.
//!
//! * Solo lectura y solo una Person autenticada, y la autorización va PRIMERO: quien no la tiene no averigua ni la forma
//!   que aceptamos ni si un Project existe. Un enlace no otorga permisos.
//! * Nunca abre ni resuelve una ruta: `file` se devuelve ya validado y relativo; leerlo es de quien abre, ya autorizado.
//! * Nunca sustituye en silencio una revisión por otra: si la del enlace no es la vigente, el resultado es `stale` con las
//!   dos a la vista y el cliente decide.

use serde_json::{json, Map, Value};

use super::deep_link::{self, DeepLink, LinkCode, LinkError, View, SCHEMA_VERSION};
use super::events::MutationContext;
use super::model_read::{args_of, invalid, require_person, with_model};
use super::{Caller, Core};
use crate::store::{ReviewStatus, Store, StoreResult, WorktreeRow, WorktreeState};

fn authorize(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    require_person(caller, context).map_err(|_| LinkError::new(LinkCode::Unauthorized, "solo una Person autenticada puede resolver enlaces").into_rpc())
}

fn not_found(m: &str) -> LinkError {
    LinkError::new(LinkCode::NotFound, m)
}

/// Lo que se leyó del almacén y hace falta para decidir la revisión, fuera del candado de lectura.
struct Facts {
    /// Rama viva del Attempt si su Worktree está en esta máquina: `(repo, rama)`.
    live_branch: Option<(String, String)>,
    /// La última revisión registrada: su HEAD vigente (el observado si quedó obsoleta).
    recorded_head: Option<String>,
}

/// `deep_link_resolve { url }`.
pub(super) fn resolve(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    authorize(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["url"], &empty)?;
    let url = match map.get("url") {
        Some(Value::String(u)) => u,
        Some(_) => return Err(invalid("`url` debe ser texto")),
        None => return Err(invalid("falta `url`")),
    };
    let link = deep_link::parse(url).map_err(LinkError::into_rpc)?;
    resolve_link(core, &link)
}

/// `deep_link_generate { project_id, task_id?, attempt_id?, view?, file?, line?, revision? }`: el enlace canónico de una entidad.
/// Pasa por la misma resolución, así que no emite un enlace a algo inexistente, incoherente o no disponible.
pub(super) fn generate(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    authorize(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["project_id", "task_id", "attempt_id", "view", "file", "line", "revision"], &empty)?;
    let text = |name: &str| -> Result<Option<String>, String> {
        match map.get(name) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(v)) => Ok(Some(v.clone())),
            Some(_) => Err(invalid(format!("`{name}` debe ser texto"))),
        }
    };
    let view = match text("view")? {
        None => None,
        Some(v) => Some(View::from_name(&v).ok_or_else(|| LinkError::new(LinkCode::Malformed, "vista desconocida").into_rpc())?),
    };
    let line = match map.get("line") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64().and_then(|n| u32::try_from(n).ok()).ok_or_else(|| invalid("`line` debe ser un entero positivo"))?),
    };
    let link = DeepLink {
        project_id: text("project_id")?.ok_or_else(|| invalid("falta `project_id`"))?,
        task_id: text("task_id")?,
        attempt_id: text("attempt_id")?,
        view,
        file: text("file")?,
        line,
        revision: text("revision")?.map(|r| r.to_ascii_lowercase()),
    };
    link.validate().map_err(LinkError::into_rpc)?;
    resolve_link(core, &link)
}

impl Core {
    /// Resuelve un enlace ya construido contra el Core (LXO-171: Delegate valida su origen con las mismas reglas que `deep_link_resolve`).
    pub(super) fn deep_link_resolve_link(&self, link: &DeepLink) -> Result<Value, String> {
        resolve_link(self, link)
    }
}

fn resolve_link(core: &Core, link: &DeepLink) -> Result<Value, String> {
    let canonical = link.to_url().map_err(LinkError::into_rpc)?;
    // Primera lectura: existencia, coherencia y disponibilidad. Devuelve lo necesario para la revisión.
    let facts = with_model(core, |s| check_entities(s, link).map(|r| r.map_err(LinkError::into_rpc)))?;
    let revision = match &link.revision {
        None => json!({ "requested": null, "current": null, "state": "not_requested" }),
        Some(requested) => {
            let current = current_revision(&facts);
            let state = match &current {
                Some(c) if c.starts_with(requested.as_str()) => "current",
                Some(_) => "stale",
                None => "unknown",
            };
            json!({ "requested": requested, "current": current, "state": state })
        }
    };
    let stale = matches!(revision["state"].as_str(), Some("stale" | "unknown"));
    Ok(json!({
        "v": SCHEMA_VERSION,
        "status": if stale { "stale" } else { "ready" },
        "code": if stale { json!(LinkCode::Stale.as_str()) } else { Value::Null },
        "canonical": canonical,
        "target": {
            "project_id": link.project_id, "task_id": link.task_id, "attempt_id": link.attempt_id,
            "view": link.view.map(View::as_str), "file": link.file, "line": link.line, "revision": link.revision,
        },
        "revision": revision,
    }))
}

/// El HEAD vigente: la rama viva si el Worktree está aquí y la rama existe; si no, lo último que el Core registró.
fn current_revision(facts: &Facts) -> Option<String> {
    facts
        .live_branch
        .as_ref()
        .and_then(|(repo, branch)| super::review::branch_head(repo, branch))
        .or_else(|| facts.recorded_head.clone())
}

fn check_entities(s: &Store, link: &DeepLink) -> StoreResult<Result<Facts, LinkError>> {
    let no_facts = Facts { live_branch: None, recorded_head: None };
    let Some(project) = s.project(&link.project_id)? else { return Ok(Err(not_found("el Project no existe en este Core"))) };
    let mut task = None;
    if let Some(task_id) = &link.task_id {
        let Some(t) = s.task_row(task_id)? else { return Ok(Err(not_found("la Task no existe en este Core"))) };
        if t.project_id.as_deref() != Some(project.id.as_str()) {
            return Ok(Err(LinkError::new(LinkCode::TargetMismatch, "la Task no es de ese Project")));
        }
        task = Some(t);
    }
    let Some(attempt_id) = &link.attempt_id else {
        // Sin Attempt, `file` se abre en la ubicación del Project: tiene que haber una en esta máquina.
        if link.file.is_some() && !project_has_local_location(s, &project.id)? {
            return Ok(Err(LinkError::new(LinkCode::HostUnavailable, "el Project no tiene ubicación en esta máquina")));
        }
        return Ok(Ok(no_facts));
    };
    let Some(attempt) = s.attempt_row(attempt_id)? else { return Ok(Err(not_found("el Attempt no existe en este Core"))) };
    if task.as_ref().is_none_or(|t| t.id != attempt.task_id) {
        return Ok(Err(LinkError::new(LinkCode::TargetMismatch, "el Attempt no es de esa Task")));
    }
    let worktree = s.worktree_of_attempt(attempt_id)?;
    let reviews = s.reviews_of_attempt(attempt_id)?;
    match link.view {
        Some(View::Review) if reviews.is_empty() => return Ok(Err(not_found("el Attempt aún no tiene una Review"))),
        Some(View::Artifact) if s.artifacts_of_attempt(attempt_id)?.is_empty() => return Ok(Err(not_found("el Attempt no tiene Artifacts"))),
        _ => {}
    }
    // El diff y cualquier archivo salen del Worktree del Attempt: tiene que existir y estar en esta máquina.
    let needs_worktree = link.view == Some(View::Diff) || link.file.is_some();
    if needs_worktree {
        let Some(w) = &worktree else { return Ok(Err(not_found("el Attempt no tiene Worktree"))) };
        if w.state == WorktreeState::Removed || w.path.is_none() {
            return Ok(Err(not_found("el Worktree del Attempt ya no existe")));
        }
        if !worktree_is_local(s, w)? {
            return Ok(Err(LinkError::new(LinkCode::HostUnavailable, "el Worktree del Attempt está en otra máquina")));
        }
    }
    let live_branch = match (&worktree, link.revision.is_some()) {
        (Some(w), true) if w.state != WorktreeState::Removed && worktree_is_local(s, w)? => w.branch.clone().map(|branch| (w.repo.clone(), branch)),
        _ => None,
    };
    let recorded_head = reviews.last().map(|r| if r.status == ReviewStatus::Stale { r.observed_head.clone().unwrap_or_else(|| r.head_commit.clone()) } else { r.head_commit.clone() });
    Ok(Ok(Facts { live_branch, recorded_head }))
}

/// ¿Está el Worktree en esta máquina? Sin máquina registrada (legado) no se bloquea: no hay dato para negarlo.
fn worktree_is_local(s: &Store, w: &WorktreeRow) -> StoreResult<bool> {
    let Some(machine) = &w.machine else { return Ok(true) };
    Ok(super::projects::machine_id_read(s)?.as_deref() == Some(machine.as_str()))
}

fn project_has_local_location(s: &Store, project_id: &str) -> StoreResult<bool> {
    let Some(me) = super::projects::machine_id_read(s)? else { return Ok(false) };
    Ok(s.project_locations(Some(project_id))?.iter().any(|l| l.machine == me))
}

/// Desktop workspace location, resolved from an explicit Attempt, never from a URL path.
/// Authorization, host and state checks precede touching the filesystem. A relative file may
/// be opened only if its canonical path stays inside the canonical worktree (including symlinks).
pub(super) fn workspace(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    authorize(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["attempt_id", "file"], &empty)?;
    let id = map.get("attempt_id").and_then(Value::as_str).ok_or_else(|| invalid("falta attempt_id"))?;
    let file = match map.get("file") {
        None | Some(Value::Null) => None,
        Some(Value::String(f)) => { deep_link::check_file(f).map_err(LinkError::into_rpc)?; Some(f.as_str()) },
        _ => return Err(invalid("file debe ser texto")),
    };
    let (project, task, w) = with_model(core, |s| {
        let Some(a) = s.attempt_row(id)? else { return Ok(Err(not_found("el Attempt no existe").into_rpc())) };
        let Some(t) = s.task_row(&a.task_id)? else { return Ok(Err(not_found("la Task no existe").into_rpc())) };
        let Some(w) = s.worktree_of_attempt(id)? else { return Ok(Err(not_found("el Attempt no tiene worktree").into_rpc())) };
        if w.state == WorktreeState::Removed || w.path.is_none() {
            return Ok(Err(not_found("el worktree ya no está disponible").into_rpc()));
        }
        if !worktree_is_local(s, &w)? {
            return Ok(Err(LinkError::new(LinkCode::HostUnavailable, "el worktree está en otra máquina").into_rpc()));
        }
        Ok(Ok((t.project_id, a.task_id, w)))
    })?;
    let root = std::fs::canonicalize(w.path.as_deref().unwrap_or_default()).map_err(|_| not_found("el worktree no está en disco").into_rpc())?;
    if !root.is_dir() { return Err(not_found("el worktree no es un directorio").into_rpc()); }
    let path = file.map(|f| {
        let path = std::fs::canonicalize(root.join(f)).map_err(|_| not_found("el archivo no está disponible").into_rpc())?;
        if !path.starts_with(&root) || !path.is_file() {
            return Err(LinkError::new(LinkCode::Unauthorized, "el archivo sale del worktree o no es un archivo").into_rpc());
        }
        Ok(path.to_string_lossy().into_owned())
    }).transpose()?;
    let revision = w.branch.as_deref().and_then(|b| super::review::branch_head(&w.repo, b));
    Ok(json!({"v":1, "project_id": project, "task_id":task, "attempt_id":id,
        "worktree_id":w.id, "root":root.to_string_lossy(), "file":path,
        "branch":w.branch, "host":w.machine, "revision":revision}))
}

pub(super) fn project_workspace(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    authorize(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["project_id", "file"], &empty)?;
    let project = map.get("project_id").and_then(Value::as_str).ok_or_else(|| invalid("falta project_id"))?;
    let file = match map.get("file") {
        None | Some(Value::Null) => None,
        Some(Value::String(f)) => { deep_link::check_file(f).map_err(LinkError::into_rpc)?; Some(f.as_str()) },
        _ => return Err(invalid("file debe ser texto")),
    };
    let location = with_model(core, |s| {
        if s.project(project)?.is_none() { return Ok(Err(not_found("el Project no existe").into_rpc())); }
        let me = super::projects::machine_id_read(s)?;
        let local = s.project_locations(Some(project))?.into_iter().find(|l| Some(&l.machine) == me.as_ref() && l.primary);
        Ok(local.ok_or_else(|| LinkError::new(LinkCode::HostUnavailable, "el Project no tiene ubicación primaria local").into_rpc()))
    })?;
    let root = std::fs::canonicalize(location.path).map_err(|_| not_found("la ubicación no está disponible").into_rpc())?;
    let path = file.map(|f| {
        let p = std::fs::canonicalize(root.join(f)).map_err(|_| not_found("el archivo no está disponible").into_rpc())?;
        if !p.starts_with(&root) || !p.is_file() { return Err(LinkError::new(LinkCode::Unauthorized, "el archivo sale del Project").into_rpc()); }
        Ok(p.to_string_lossy().into_owned())
    }).transpose()?;
    Ok(json!({"v":1, "project_id": project, "root":root.to_string_lossy(), "file":path}))
}
