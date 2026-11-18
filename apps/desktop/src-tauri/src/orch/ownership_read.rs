//! LXO-169 · `work_at`: qué Task/Attempt posee un archivo o un worktree y cuáles lo tocaron.
//!
//! Contrato: `docs/core/OWNERSHIP.md`. Es lo que el IDE necesita para pintar «AI WORK» sin inferir nada por su cuenta (LXO-174).
//!
//! Separa dos conceptos que no se mezclan:
//!
//! * **Dueño actual** (`owner`): el Attempt VIVO que usa el worktree nombrado. Con la regla «en serie» de `shared`
//!   (`docs/core/WORKTREE_SHARED.md`) nunca hay dos; si los hubiera se devuelven como candidatos, no se elige uno.
//! * **Historia de toques** (`touched_by`): los Attempts del Project cuya evidencia estructurada cambia la ruta. La evidencia es
//!   git ejecutado por el Core sobre un rango `base..head` que él mismo registró: el del Review (inmutable) o, para el Attempt
//!   actual de su Task, el HEAD vivo de la rama de su worktree. **Que no haya evidencia no es «no lo tocó»**: el Attempt va a
//!   `evidence.skipped` con el motivo y `completeness` pasa a `partial`.
//!
//! Solo lectura, solo una Person autenticada. La ruta es relativa al worktree y NUNCA se abre aquí: va como pathspec literal a
//! `git diff`, después de validarla con las mismas reglas que `lixbon://` (`../`, absolutas, codificadas, controles).

use serde_json::{json, Map, Value};

use super::deep_link::{self, DeepLink, View};
use super::events::MutationContext;
use super::model_read::{args_of, invalid, require_person, with_model};
use super::{git, review, Caller, Core};
use crate::store::{AttemptRow, Owner, ReviewRow, Store, StoreResult, WorktreeRow, WorktreeState};

const API: u8 = 1;
const MAX_ID_CHARS: usize = 200;
/// Attempts con worktree que se miran como mucho (los más recientes). El resto se cuenta en `evidence.not_scanned`.
const MAX_SCANNED: usize = 60;
/// Candidatos que se devuelven como mucho.
const MAX_CANDIDATES: usize = 20;
/// Attempts sin evidencia que se listan como mucho (el total va aparte).
const MAX_SKIPPED: usize = 20;

/// Un Attempt del Project con lo que hace falta para buscar evidencia, ya fuera del almacén.
struct Item {
    attempt: AttemptRow,
    worktree: WorktreeRow,
    is_current: bool,
    review: Option<ReviewRow>,
}

struct Loaded {
    workspace: Option<(WorktreeRow, Vec<AttemptRow>)>,
    /// Los Attempts del workspace que una persona tiene en sus manos (LXO-170).
    held_by_human: Vec<String>,
    items: Vec<Item>,
    not_scanned: usize,
    local_machine: Option<String>,
}

fn required_text(map: &Map<String, Value>, name: &str) -> Result<String, String> {
    match map.get(name) {
        Some(Value::String(v)) if !v.is_empty() => Ok(v.clone()),
        Some(_) => Err(invalid(format!("`{name}` debe ser texto no vacío"))),
        None => Err(invalid(format!("falta `{name}`"))),
    }
}

fn optional_text(map: &Map<String, Value>, name: &str) -> Result<Option<String>, String> {
    match map.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(_) => required_text(map, name).map(Some),
    }
}

/// `work_at { project_id, path, worktree_id?, revision? }`.
pub(super) fn work_at(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let empty = Map::new();
    let map = args_of(args, &["project_id", "path", "worktree_id", "revision"], &empty)?;
    let project_id = required_text(map, "project_id")?;
    let path = required_text(map, "path")?;
    let worktree_id = optional_text(map, "worktree_id")?;
    let revision = optional_text(map, "revision")?.map(|r| r.to_ascii_lowercase());
    if project_id.chars().count() > MAX_ID_CHARS || worktree_id.as_ref().is_some_and(|w| w.chars().count() > MAX_ID_CHARS) {
        return Err(invalid(format!("los ids van de 1 a {MAX_ID_CHARS} caracteres")));
    }
    deep_link::check_file(&path).map_err(|e| invalid(format!("`path` no es una ruta relativa segura: {}", e.message)))?;
    if let Some(r) = &revision {
        deep_link::check_revision(r).map_err(|e| invalid(format!("`revision`: {}", e.message)))?;
    }

    // 1) Almacén: todo lo que se necesita, y se suelta antes de ejecutar git.
    let loaded = with_model(core, |s| load(s, &project_id, worktree_id.as_deref()))?;

    // 2) Git, sin candado del almacén.
    let local = |w: &WorktreeRow| w.machine.as_ref().is_none_or(|m| loaded.local_machine.as_deref() == Some(m.as_str()));
    let mut touched: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut skipped_total = 0usize;
    for item in &loaded.items {
        match touch_of(item, &path, local(&item.worktree)) {
            Ok(None) => {}
            Ok(Some(ev)) => touched.push(candidate(&project_id, &path, item, &ev)),
            Err(reason) => {
                skipped_total += 1;
                if skipped.len() < MAX_SKIPPED {
                    skipped.push(json!({ "attempt_id": item.attempt.id, "reason": reason }));
                }
            }
        }
    }
    let touched_truncated = touched.len() > MAX_CANDIDATES;
    touched.truncate(MAX_CANDIDATES);

    let workspace = loaded.workspace.as_ref().map(|(w, _)| {
        json!({ "worktree_id": w.id, "state": w.state, "branch": w.branch, "host": if local(w) { "local" } else { "other" } })
    });
    let revision_json = revision.as_ref().map(|requested| {
        let current = loaded.workspace.as_ref().filter(|(w, _)| w.state != WorktreeState::Removed && local(w)).and_then(|(w, _)| w.branch.as_ref().and_then(|b| review::branch_head(&w.repo, b)));
        let state = match &current {
            Some(c) if c.starts_with(requested.as_str()) => "current",
            Some(_) => "stale",
            None => "unknown",
        };
        json!({ "requested": requested, "current": current, "state": state })
    });
    Ok(json!({
        "v": API,
        "project_id": project_id,
        "path": path,
        "workspace": workspace,
        "owner": owner_json(&project_id, loaded.workspace.as_ref(), &loaded.held_by_human),
        "touched_by": touched,
        "touched_truncated": touched_truncated,
        "evidence": {
            "completeness": if skipped_total == 0 && loaded.not_scanned == 0 { "complete" } else { "partial" },
            "scanned": loaded.items.len(),
            "skipped": skipped,
            "skipped_total": skipped_total,
            "not_scanned": loaded.not_scanned,
        },
        "revision": revision_json,
    }))
}

fn load(s: &Store, project_id: &str, worktree_id: Option<&str>) -> StoreResult<Result<Loaded, String>> {
    if s.project(project_id)?.is_none() {
        return Ok(Err(format!("model_not_found: no existe el Project {project_id}")));
    }
    let local_machine = super::projects::machine_id_read(s)?;
    let mut workspace = None;
    let mut held_by_human: Vec<String> = Vec::new();
    if let Some(id) = worktree_id {
        let Some(w) = s.worktree_row(id)? else { return Ok(Err(format!("model_not_found: no existe el Worktree {id}"))) };
        if s.task_row(&w.task_id)?.and_then(|t| t.project_id).as_deref() != Some(project_id) {
            return Ok(Err(format!("model_not_found: el Worktree {id} no es de ese Project")));
        }
        let users = s.attempts_of_worktree(&w.id)?;
        for a in &users {
            if s.attempt_ownership(&a.id)?.owner == Owner::Human {
                held_by_human.push(a.id.clone());
            }
        }
        workspace = Some((w, users));
    }
    // Los Attempts del Project con worktree: los de cada worktree (incluidos los que lo comparten), los más recientes primero.
    let mut all: Vec<(AttemptRow, WorktreeRow)> = Vec::new();
    for w in s.worktrees_of_project(project_id)? {
        for a in s.attempts_of_worktree(&w.id)? {
            all.push((a, w.clone()));
        }
    }
    all.sort_by(|x, y| y.0.created_at.cmp(&x.0.created_at).then_with(|| x.0.id.cmp(&y.0.id)));
    let not_scanned = all.len().saturating_sub(MAX_SCANNED);
    all.truncate(MAX_SCANNED);
    let mut items = Vec::with_capacity(all.len());
    for (attempt, worktree) in all {
        let is_current = s.attempt_current(&attempt.task_id)?.is_some_and(|c| c.id == attempt.id);
        let review = s.reviews_of_attempt(&attempt.id)?.pop();
        items.push(Item { attempt, worktree, is_current, review });
    }
    Ok(Ok(Loaded { workspace, held_by_human, items, not_scanned, local_machine }))
}

/// El dueño actual del worktree nombrado: el Attempt vivo que lo usa. Sin worktree, sin dueño (el checkout del Project no es de un Attempt).
pub(super) fn owner_json(project_id: &str, workspace: Option<&(WorktreeRow, Vec<AttemptRow>)>, held_by_human: &[String]) -> Value {
    let Some((w, users)) = workspace else { return json!({ "state": "none", "reason": "no_workspace", "attempt": null, "candidates": [] }) };
    if w.state == WorktreeState::Removed {
        return json!({ "state": "none", "reason": "worktree_removed", "attempt": null, "candidates": [] });
    }
    let live: Vec<Value> = users.iter().filter(|a| !a.status.is_final()).map(|a| attempt_json(project_id, a, held_by_human.contains(&a.id))).collect();
    match live.len() {
        0 => json!({ "state": "none", "reason": "no_live_attempt", "attempt": null, "candidates": [] }),
        1 => json!({ "state": "owned", "attempt": live[0], "candidates": [] }),
        // La regla en serie lo impide; si algún día pasara, se dice y no se elige.
        _ => json!({ "state": "ambiguous", "attempt": null, "candidates": live }),
    }
}

fn attempt_json(project_id: &str, a: &AttemptRow, human: bool) -> Value {
    let link = DeepLink { project_id: project_id.to_string(), task_id: Some(a.task_id.clone()), attempt_id: Some(a.id.clone()), view: Some(View::Overview), file: None, line: None, revision: None };
    json!({ "id": a.id, "task_id": a.task_id, "n": a.n, "status": a.status, "provider": a.provider, "model": a.model, "held_by": if human { Owner::Human.as_str() } else { Owner::Agent.as_str() }, "link": link.to_url().ok() })
}

/// La evidencia con la que se miró un Attempt.
struct Evidence {
    source: &'static str,
    base: String,
    head: String,
}

/// `Ok(Some)` si el Attempt cambia la ruta, `Ok(None)` si la evidencia dice que no, `Err(motivo)` si no hay evidencia utilizable.
fn touch_of(item: &Item, path: &str, local: bool) -> Result<Option<Evidence>, &'static str> {
    let w = &item.worktree;
    if !local {
        return Err("host_unavailable");
    }
    // El Attempt actual de su Task se mide contra la rama viva (es sobre la que se trabaja); el resto, contra el rango de su Review.
    let ev = if item.is_current && w.state != WorktreeState::Removed && w.branch.is_some() {
        let head = w.branch.as_deref().and_then(|b| review::branch_head(&w.repo, b)).ok_or("branch_unavailable")?;
        Evidence { source: "live_branch", base: w.base_commit.clone().ok_or("no_base")?, head }
    } else if let Some(r) = &item.review {
        Evidence { source: "review", base: r.base_commit.clone().ok_or("no_base")?, head: r.head_commit.clone() }
    } else {
        return Err("no_evidence");
    };
    // `--literal-pathspecs`: la ruta es un nombre, no un patrón.
    let out = git::run(&w.repo, &["--literal-pathspecs", "diff", "--name-only", "--no-renames", &ev.base, &ev.head, "--", path]).map_err(|_| "git_unavailable")?;
    if !out.ok {
        return Err("git_unavailable");
    }
    Ok((!out.stdout.is_empty()).then_some(ev))
}

fn candidate(project_id: &str, path: &str, item: &Item, ev: &Evidence) -> Value {
    let a = &item.attempt;
    // El enlace abre el diff de ESE Attempt en la revisión con la que se miró.
    let link = DeepLink {
        project_id: project_id.to_string(),
        task_id: Some(a.task_id.clone()),
        attempt_id: Some(a.id.clone()),
        view: Some(View::Diff),
        file: Some(path.to_string()),
        line: None,
        revision: Some(ev.head.to_ascii_lowercase()),
    };
    json!({
        "attempt_id": a.id, "task_id": a.task_id, "status": a.status, "provider": a.provider,
        "is_current_attempt": item.is_current,
        "evidence": { "source": ev.source, "base_commit": ev.base, "head_commit": ev.head, "provenance": "verified" },
        "link": link.to_url().ok(),
    })
}
