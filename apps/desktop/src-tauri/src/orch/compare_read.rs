//! `attempt_compare` (LXO-146, épica F5): datos comparables entre 2–4 Attempts, con la procedencia de cada dato. Contrato: `docs/core/COMPARE.md`.
//!
//! Es una LECTURA: no escribe, no puntúa, no elige ganador y no integra. El cliente no agrega worktrees, pruebas ni artefactos por su
//! cuenta: lo que se compara sale de aquí, ya ordenado y acotado, y dice de dónde sale.
//!
//! # Qué se puede comparar
//! * Attempts de la **misma Task** (`same_task`), o
//! * Attempts de una **misma familia de Forks** (`fork_family`): el origen y los Forks que nacieron de él, o Forks hermanos. Un Fork es una
//!   Task nueva ([`FORK.md`](../../../../../../docs/core/FORK.md)), así que sin esto un Fork nunca se podría comparar con su origen.
//!
//! Cualquier otra combinación es `compare_not_comparable`.
//!
//! # Procedencia (`provenance`)
//! | valor | significa |
//! |---|---|
//! | `verified` | el Core lo observó o lo calculó él mismo: su reloj, sus registros, o git ejecutado por el Core sobre commits que no cambian |
//! | `agent_reported` | lo declaró el agente (el resumen, los artefactos que registró): el Core lo guarda pero no lo comprobó |
//! | `unknown` | no hay dato. `value` es `null` y `reason` dice por qué: **nunca** un cero, un `false` ni una lista vacía que parezca un resultado |
//!
//! Un dato del agente jamás sube a `verified` por sí solo. Las pruebas no se recogen todavía: siempre `unknown` (`not_collected`).
//!
//! # Determinismo y tamaño
//! Los Attempts salen en el orden pedido; los archivos, por ruta; los solapes, por ruta. Cada Attempt trae como mucho [`MAX_FILES`]
//! archivos (con el total y `truncated`), y los solapes se acotan a [`MAX_OVERLAPS`]. Nunca el diff: para el parche está la lectura de
//! revisión de siempre.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::events::MutationContext;
use super::model_read::{args_of, invalid, require_person, with_model};
use super::review;
use super::{Caller, Core};
use crate::store::{ArtifactRow, AttemptRow, ReviewRow, WorktreeRow};

const MIN_ATTEMPTS: usize = 2;
const MAX_ATTEMPTS: usize = 4;
const MAX_ID_CHARS: usize = 200;
/// Archivos que trae cada Attempt como mucho (el total va aparte).
pub(super) const MAX_FILES: usize = 200;
/// Solapes que se devuelven como mucho.
pub(super) const MAX_OVERLAPS: usize = 100;
const API: u8 = 1;

/// Todo lo que sale del almacén de un Attempt, ya en memoria: el almacén se suelta antes de ejecutar git.
pub(super) struct Loaded {
    pub(super) attempt: AttemptRow,
    pub(super) project_id: Option<String>,
    pub(super) is_current: bool,
    pub(super) worktree: Option<WorktreeRow>,
    pub(super) artifacts: Vec<ArtifactRow>,
    pub(super) review: Option<ReviewRow>,
    pub(super) fork_source: Option<String>,
}

pub(super) fn evidence(value: Value, provenance: &str) -> Value {
    json!({ "value": value, "provenance": provenance })
}

pub(super) fn unknown(reason: &str) -> Value {
    json!({ "value": null, "provenance": "unknown", "reason": reason })
}

/// Un dato opcional del Core: `verified` si está, `unknown` (con su motivo) si no.
pub(super) fn recorded(value: Option<Value>, reason: &str) -> Value {
    match value {
        Some(v) => evidence(v, "verified"),
        None => unknown(reason),
    }
}

fn ids_of(map: &Map<String, Value>) -> Result<Vec<String>, String> {
    let list = match map.get("attempt_ids") {
        Some(Value::Array(list)) => list,
        Some(_) => return Err(invalid("`attempt_ids` debe ser una lista de ids de Attempt")),
        None => return Err(invalid("falta `attempt_ids`")),
    };
    if !(MIN_ATTEMPTS..=MAX_ATTEMPTS).contains(&list.len()) {
        return Err(invalid(format!("se comparan de {MIN_ATTEMPTS} a {MAX_ATTEMPTS} Attempts (llegaron {})", list.len())));
    }
    let mut ids: Vec<String> = Vec::with_capacity(list.len());
    for v in list {
        let id = match v {
            Value::String(s) if !s.trim().is_empty() && s.chars().count() <= MAX_ID_CHARS => s.trim().to_string(),
            _ => return Err(invalid(format!("cada id de Attempt debe ser texto de 1 a {MAX_ID_CHARS} caracteres"))),
        };
        if ids.contains(&id) {
            return Err(invalid(format!("el Attempt {id} está repetido")));
        }
        ids.push(id);
    }
    Ok(ids)
}

/// ¿Qué los une? `same_task`, o `fork_family` (con la raíz común); `None` si nada.
fn relation(items: &[Loaded]) -> Option<(&'static str, String)> {
    let first_task = &items[0].attempt.task_id;
    if items.iter().all(|i| &i.attempt.task_id == first_task) {
        return Some(("same_task", first_task.clone()));
    }
    // La raíz de un Attempt es su origen si nació de un Fork, y él mismo si no.
    let root = |i: &Loaded| i.fork_source.clone().unwrap_or_else(|| i.attempt.id.clone());
    let first_root = root(&items[0]);
    items.iter().all(|i| root(i) == first_root).then_some(("fork_family", first_root))
}

/// Qué commits se miran y de dónde salen: el de la revisión (`review`, inmutable) o el HEAD vivo del Attempt actual (`live_branch`).
pub(super) struct Range {
    pub(super) base: Option<String>,
    pub(super) head: String,
    pub(super) source: &'static str,
}

pub(super) fn range_of(core: &Core, context: &MutationContext, item: &Loaded) -> Result<Range, &'static str> {
    if let Some(r) = &item.review {
        return Ok(Range { base: r.base_commit.clone(), head: r.head_commit.clone(), source: "review" });
    }
    if item.worktree.is_none() {
        return Err("no_worktree");
    }
    if !item.is_current {
        // La rama de la Task es la del Attempt actual: un Attempt anterior ya no tiene una rama propia que leer.
        return Err("not_current_attempt");
    }
    match review::live_range(&core.acting(context.clone()), &item.attempt.task_id) {
        Ok((base, head, source)) => Ok(Range { base: Some(base), head, source: if source == "recorded" { "live_branch" } else { "live_branch_merge_base" } }),
        Err(_) => Err("branch_unavailable"),
    }
}

pub(super) type Files = Vec<(String, Option<u64>, Option<u64>)>;

/// Los archivos cambiados de un Attempt (o por qué no se sabe). `Ok((archivos, total))`.
pub(super) fn changed_files(core: &Core, range: &Range, task_id: &str) -> Result<(Files, usize), &'static str> {
    let base = range.base.as_deref().ok_or("no_base")?;
    let repo = core.lock().tasks.get(task_id).map(|t| t.repo.clone()).filter(|r| !r.is_empty()).ok_or("repo_unavailable")?;
    review::numstat_between(&repo, base, &range.head, MAX_FILES).map_err(|_| "git_unavailable")
}

pub(super) fn sum(files: &Files, pick: impl Fn(&(String, Option<u64>, Option<u64>)) -> Option<u64>) -> Option<u64> {
    // Un archivo binario no tiene cuentas: la suma de lo que sí se sabe sería una cifra falsa, así que no se da.
    files.iter().map(pick).sum::<Option<u64>>()
}

/// Un Attempt adoptado lo dice en su `timing` (`adopted: true`) para que `null` no se lea como un dato perdido; los demás no cambian.
fn adopted_timing(mut timing: Value, adopted: bool) -> Value {
    if adopted {
        timing["adopted"] = json!(true);
    }
    timing
}

fn attempt_view(core: &Core, context: &MutationContext, item: &Loaded) -> (Value, Option<Files>) {
    let a = &item.attempt;
    // Un Attempt adoptado no tiene una duración: su `started_at`/`ended_at` es el instante de la adopción, no una ejecución.
    // Si no se puede leer, mejor SIN duración que una inventada: se trata como adoptado.
    let adopted = match core.storage.read_store(|s| s.attempt_adopted_at(&a.id)) {
        Some(Ok(at)) => at.is_some(),
        Some(Err(_)) => true,
        None => false,
    };
    let (started_at, ended_at) = if adopted { (None, None) } else { (a.started_at, a.ended_at) };
    let duration = match (started_at, ended_at) {
        (Some(s), Some(e)) if e >= s => Some(e - s),
        _ => None,
    };
    let range = range_of(core, context, item);
    let (revision, changes, files) = match &range {
        Err(reason) => (
            json!({ "source": null, "base_commit": unknown(reason), "head_commit": unknown(reason) }),
            json!({ "files": unknown(reason), "additions": unknown(reason), "deletions": unknown(reason), "list": [], "truncated": false, "total_files": null }),
            None,
        ),
        Ok(range) => {
            let revision = json!({
                "source": range.source,
                "base_commit": recorded(range.base.clone().map(Value::from), "no_base"),
                "head_commit": evidence(json!(range.head), "verified"),
            });
            match changed_files(core, range, &a.task_id) {
                Err(reason) => (
                    revision,
                    json!({ "files": unknown(reason), "additions": unknown(reason), "deletions": unknown(reason), "list": [], "truncated": false, "total_files": null }),
                    None,
                ),
                Ok((files, total)) => {
                    let truncated = total > files.len();
                    // Con la lista recortada las sumas no valen: solo se dan si se vio todo.
                    let (adds, dels) = if truncated { (None, None) } else { (sum(&files, |f| f.1), sum(&files, |f| f.2)) };
                    let changes = json!({
                        "files": evidence(json!(total), "verified"),
                        "additions": recorded(adds.map(Value::from), if truncated { "truncated" } else { "binary_files" }),
                        "deletions": recorded(dels.map(Value::from), if truncated { "truncated" } else { "binary_files" }),
                        "list": files.iter().map(|(path, add, del)| json!({ "path": path, "additions": add, "deletions": del })).collect::<Vec<_>>(),
                        "truncated": truncated,
                        "total_files": total,
                    });
                    (revision, changes, Some(files))
                }
            }
        }
    };
    // El resumen de un Attempt adoptado lo escribe el Core al adoptar (no un agente): consta, no se reporta.
    let summary = if a.summary.trim().is_empty() { unknown("no_summary") } else { evidence(json!(a.summary), if adopted { "verified" } else { "agent_reported" }) };
    // Lo que el agente registró no lo comprobó el Core: `agent_reported`. Sin ninguno no hay dato, no «cero artefactos».
    let artifacts = if item.artifacts.is_empty() {
        json!({ "provenance": "unknown", "reason": "none_recorded", "items": [] })
    } else {
        json!({
            "provenance": "agent_reported",
            "items": item.artifacts.iter().map(|x| json!({ "id": x.id, "kind": x.kind, "uri": x.uri, "sha256": x.sha256, "bytes": x.bytes })).collect::<Vec<_>>(),
        })
    };
    let review_view = match &item.review {
        None => unknown("not_reviewed"),
        Some(r) => evidence(
            json!({ "verdict": r.verdict, "status": r.status, "head_commit": r.head_commit, "base_commit": r.base_commit, "at": r.at, "closed_at": r.closed_at, "observed_head": r.observed_head }),
            "verified",
        ),
    };
    let view = json!({
        "attempt_id": a.id,
        "task_id": a.task_id,
        "n": a.n,
        "project_id": item.project_id,
        "is_current": item.is_current,
        "forked_from": item.fork_source,
        "selection": evidence(json!({ "provider": a.provider, "model": a.model, "effort": a.effort, "role": a.role, "profile": a.profile, "external": a.external }), "verified"),
        "status": evidence(json!({ "status": a.status, "failure_reason": a.failure_reason }), "verified"),
        "timing": evidence(adopted_timing(json!({ "created_at": a.created_at, "started_at": started_at, "ended_at": ended_at, "duration_ms": duration }), adopted), "verified"),
        "host": recorded(item.worktree.as_ref().map(|w| json!(w.machine)), "no_worktree"),
        "worktree": recorded(item.worktree.as_ref().map(|w| json!({ "id": w.id, "branch": w.branch, "base_branch": w.base_branch, "state": w.state })), "no_worktree"),
        "revision": revision,
        "changes": changes,
        "summary": summary,
        "artifacts": artifacts,
        "tests": unknown("not_collected"),
        "review": review_view,
    });
    (view, files)
}

/// Los archivos que tocó más de un Attempt, por ruta. `complete` es falso si alguna lista se recortó o no se pudo leer: entonces puede haber
/// más solapes de los que se ven.
fn overlaps(per_attempt: &[(String, Option<Files>, bool)]) -> Value {
    let mut by_path: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut complete = true;
    for (id, files, truncated) in per_attempt {
        match files {
            None => complete = false,
            Some(files) => {
                complete &= !truncated;
                for (path, _, _) in files {
                    by_path.entry(path.as_str()).or_default().push(id.as_str());
                }
            }
        }
    }
    let shared: Vec<(&str, Vec<&str>)> = by_path.into_iter().filter(|(_, ids)| ids.len() > 1).collect();
    let cut = shared.len() > MAX_OVERLAPS;
    json!({
        "complete": complete && !cut,
        "total": shared.len(),
        "items": shared.iter().take(MAX_OVERLAPS).map(|(path, ids)| json!({ "path": path, "attempt_ids": ids })).collect::<Vec<_>>(),
    })
}

/// Lo que el almacén sabe de un Attempt, en memoria: el almacén se suelta antes de ejecutar git. Lo comparten Compare y el Proof Pack.
pub(super) fn load_one(s: &crate::store::Store, id: &str, fork_source: Option<String>) -> crate::store::StoreResult<Result<Loaded, String>> {
    let Some(attempt) = s.attempt_row(id)? else { return Ok(Err(format!("model_not_found: no existe el Attempt {id}"))) };
    let project_id = s.task_row(&attempt.task_id)?.and_then(|t| t.project_id);
    let is_current = s.attempt_current(&attempt.task_id)?.map(|c| c.n) == Some(attempt.n);
    Ok(Ok(Loaded {
        worktree: s.worktree_of_attempt(id)?,
        artifacts: s.artifacts_of_attempt(id)?,
        review: s.reviews_of_attempt(id)?.pop(),
        fork_source,
        attempt,
        project_id,
        is_current,
    }))
}

/// `attempt_compare` · `{ attempt_ids: [2–4 ids] }`. Solo lectura, solo una Person de Desktop.
pub(super) fn compare(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    let context = context.ok_or_else(|| "model_auth_required: solo una Person autenticada puede comparar Attempts".to_string())?;
    let empty = Map::new();
    let map = args_of(args, &["attempt_ids"], &empty)?;
    let ids = ids_of(map)?;

    let items: Vec<Loaded> = with_model(core, |s| {
        let sources = s.fork_sources(&ids)?;
        let mut items = Vec::with_capacity(ids.len());
        for id in &ids {
            match load_one(s, id, sources.get(id).cloned().flatten())? {
                Ok(item) => items.push(item),
                Err(e) => return Ok(Err(e)),
            }
        }
        Ok(Ok(items))
    })?;

    let Some((kind, root)) = relation(&items) else {
        return Err("compare_not_comparable: solo se comparan Attempts de la misma Task o de la misma familia de Forks (un origen y los Forks que nacieron de él)".into());
    };
    if items.iter().any(|i| i.project_id != items[0].project_id) {
        return Err("compare_not_comparable: los Attempts son de Projects distintos".into());
    }

    let mut attempts = Vec::with_capacity(items.len());
    let mut per_attempt = Vec::with_capacity(items.len());
    for item in &items {
        let (view, files) = attempt_view(core, context, item);
        let truncated = view["changes"]["truncated"].as_bool().unwrap_or(false);
        per_attempt.push((item.attempt.id.clone(), files, truncated));
        attempts.push(view);
    }
    Ok(json!({
        "v": API,
        "relation": { "kind": kind, "root": root },
        "attempts": attempts,
        "overlaps": overlaps(&per_attempt),
        "limits": { "max_attempts": MAX_ATTEMPTS, "max_files_per_attempt": MAX_FILES, "max_overlaps": MAX_OVERLAPS },
    }))
}
