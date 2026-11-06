//! Adoptar un worktree externo (LXO-149/157, épica F5). Contrato: `docs/core/RESOURCES.md` § Adoptar.
//!
//! Un worktree que Lixbon no creó (hecho a mano, por otra herramienta) no tiene dueño: «un recurso externo no se vuelve propio sin un comando de
//! adopción». Adoptarlo lo convierte en el **primer Attempt, ya terminado**, de una Task que no tenía ninguna ejecución: así se puede REVISAR
//! e integrar como cualquier otro, sin inventar un historial que no ocurrió (no hay `attempt.started` ni `attempt.completed`; proveedor `external`; el
//! Attempt lleva `adopted_at`: migración 024).
//!
//! ```text
//! resource_adopt_preview { project_id, path }                      lectura: qué es, qué Tasks pueden recibirlo y por qué no se puede
//! resource_adopt { project_id, path, task_id, confirm }            la decisión de una Person de Desktop
//! ```
//!
//! # Reglas (todas se comprueban en el Core, nunca en la interfaz, y ANTES de escribir)
//! * **Limpio**: un worktree con cambios sin commit NO se adopta (`adopt_dirty`); uno cuyo estado no se puede comprobar tampoco (`adopt_unknown`). Lo
//!   que se adopta es trabajo comprometido: el Proof Pack y la revisión sobre un HEAD fijo no tienen sentido con cambios sueltos.
//! * **Es lo que git dice que es**: un worktree del repositorio del Project, ni el checkout principal, ni uno sin rama (HEAD desacoplado), ni uno cuya
//!   carpeta ya no está, ni uno que otra Task ya posee o cuya rama ya es de otra Task.
//! * **La Task es de ese Project y no tiene ejecución** (`not_started`, sin worktree): el proyector del runtime solo admite el ALTA de un worktree en
//!   una Task, nunca cambiarlo ni recuperar uno quitado. Por eso no se adopta «dentro» de una Task que ya corrió.
//! * **La base** es la rama por defecto del repositorio y el commit base su `merge-base` con la rama adoptada (sin ellos no hay qué revisar: `adopt_no_base`).
//! * **Repetir es idempotente**: adoptar de nuevo el mismo worktree en la misma Task devuelve `AlreadyAdopted` sin tocar nada.
//! * **No toca git ni el disco**: adoptar es una decisión del Core sobre sus tablas, una sola mutación con su Event `attempt.adopted` (sin rutas).

use serde::Deserialize;
use serde_json::{json, Value};

use super::events::MutationContext;
use super::model_read::{invalid, require_person};
use super::mutation::Health;
use super::projects::norm_path;
use super::resource_git as rgit;
use super::state::Status;
use super::tx_ops::AdoptRequest;
use super::{Caller, Core};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PreviewInput {
    pub project_id: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AdoptInput {
    pub project_id: String,
    pub path: String,
    pub task_id: String,
    #[serde(default)]
    pub confirm: bool,
}

/// Por qué no se puede adoptar (código estable).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Block {
    pub code: &'static str,
    pub message: String,
}

fn block(code: &'static str, message: impl Into<String>) -> Block {
    Block { code, message: message.into() }
}

/// Lo que git dice del worktree candidato, ya comprobado.
struct Candidate {
    path: String,
    /// El repositorio del Project contra el que se comprobó todo; la Task que lo recibe debe ser de ESE repositorio.
    repo: String,
    branch: String,
    base: String,
    base_commit: String,
}

/// Una ruta: hasta 1024 caracteres (el límite de `worktrees.path`), no los 200 de un identificador.
fn path_of(value: &str) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() || v.chars().count() > 1024 {
        return Err(invalid("`path` debe contener de 1 a 1024 caracteres"));
    }
    Ok(v.to_string())
}

fn id_of(value: &str, what: &str) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() || v.chars().count() > 200 {
        return Err(invalid(format!("`{what}` debe contener de 1 a 200 caracteres")));
    }
    Ok(v.to_string())
}

/// Comprueba el worktree contra git y contra el estado del Core. Devuelve el candidato o la razón por la que no se puede adoptar.
fn examine(core: &Core, project_id: &str, raw_path: &str) -> Result<Result<Candidate, Block>, String> {
    let repo = core.project_launch_location(project_id).map_err(|e| format!("adopt_project_unavailable: {e}"))?.to_string_lossy().into_owned();
    let listed = match rgit::worktree_list(&repo) {
        Ok(list) => list,
        Err(_) => return Ok(Err(block("adopt_unknown", "git no pudo listar los worktrees del Project: no se adopta sin poder comprobarlo"))),
    };
    let want = norm_path(raw_path);
    let Some((index, found)) = listed.iter().enumerate().find(|(_, w)| norm_path(&w.path) == want) else {
        return Ok(Err(block("adopt_not_a_worktree", "esa carpeta no es un worktree de este Project según git")));
    };
    if index == 0 {
        return Ok(Err(block("adopt_main_checkout", "es el checkout principal del Project, no un worktree adicional")));
    }
    if found.bare || found.prunable || !std::path::Path::new(&found.path).is_dir() {
        return Ok(Err(block("adopt_missing", "la carpeta del worktree ya no está en disco")));
    }
    if found.locked {
        return Ok(Err(block("adopt_locked", "el worktree está bloqueado (`git worktree lock`): quien lo bloqueó lo quiere conservar, y Lixbon no podría liberarlo")));
    }
    let Some(branch) = found.branch.clone().filter(|_| !found.detached) else {
        return Ok(Err(block("adopt_detached", "el worktree no tiene una rama (HEAD desacoplado): no hay qué revisar ni integrar")));
    };
    // Otra Task ya lo posee, o ya usa esa rama.
    let owned = {
        let st = core.lock();
        st.tasks.values().any(|t| t.worktree.as_deref().is_some_and(|w| norm_path(w) == want))
    };
    if owned {
        return Ok(Err(block("adopt_already_owned", "una Task ya posee este worktree")));
    }
    if core.lock().tasks.values().any(|t| t.branch.as_deref() == Some(branch.as_str())) {
        return Ok(Err(block("adopt_branch_taken", "otra Task ya usa esta rama")));
    }
    match rgit::is_dirty(&found.path) {
        Some(false) => {}
        Some(true) => return Ok(Err(block("adopt_dirty", "el worktree tiene cambios sin commit: confirma o descártalos antes de adoptarlo"))),
        None => return Ok(Err(block("adopt_unknown", "no se pudo comprobar si el worktree tiene cambios sin commit: no se adopta a ciegas"))),
    }
    let Some(base) = rgit::default_branch(&repo) else {
        return Ok(Err(block("adopt_no_base", "no se pudo determinar la rama base del repositorio")));
    };
    if base == branch {
        return Ok(Err(block("adopt_is_base", "la rama del worktree es la rama base: no hay trabajo propio que adoptar")));
    }
    let Some(base_commit) = rgit::merge_base(&repo, &base, &branch) else {
        return Ok(Err(block("adopt_no_base", "la rama no comparte historia con la base: no hay diferencia que revisar")));
    };
    // Una rama sin un commit propio (recién creada, o ya dentro de la base) no tiene trabajo que revisar ni integrar.
    match rgit::own_commits(&repo, &base, &branch) {
        Some(0) => return Ok(Err(block("adopt_no_changes", "la rama no tiene commits propios respecto a la base: no hay trabajo que revisar"))),
        Some(_) => {}
        None => return Ok(Err(block("adopt_unknown", "no se pudo comparar la rama con la base: no se adopta a ciegas"))),
    }
    Ok(Ok(Candidate { path: found.path.clone(), repo, branch, base, base_commit }))
}

/// Las Tasks del Project que pueden recibir el worktree: sin ejecución, sin worktree y con repositorio. Por título, de la más reciente a la más antigua.
fn eligible(core: &Core, project_id: &str, repo: &str) -> Vec<Value> {
    let want = norm_path(repo);
    let st = core.lock();
    let mut tasks: Vec<_> = st
        .tasks
        .values()
        .filter(|t| t.project_id.as_deref() == Some(project_id) && t.status == Status::NotStarted && !st.attempt_n.contains_key(&t.id) && t.worktree.is_none() && t.branch.is_none() && !t.repo.trim().is_empty() && norm_path(&t.repo) == want && st.runs.get(&t.run).is_some_and(|r| !r.closed))
        .collect();
    tasks.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.id.cmp(&b.id)));
    tasks.into_iter().map(|t| json!({ "task_id": t.id, "title": t.title })).collect()
}

fn blocked_json(b: &Block) -> Value {
    json!({ "ok": false, "code": b.code, "message": b.message })
}

/// `resource_adopt_preview`: qué es el worktree y a qué Tasks se puede adoptar. Solo lectura, de cualquier Person autenticada (como `resource_inventory`); adoptar es solo de Desktop.
pub(super) fn preview(core: &Core, caller: &Caller, context: Option<&MutationContext>, input: &PreviewInput) -> Result<Value, String> {
    require_person(caller, context)?;
    let project_id = id_of(&input.project_id, "project_id")?;
    let path = path_of(&input.path)?;
    let healthy = matches!(core.health(), Health::Normal);
    let candidate = examine(core, &project_id, &path)?;
    let tasks = match core.project_launch_location(&project_id) {
        Ok(repo) => eligible(core, &project_id, &repo.to_string_lossy()),
        Err(_) => vec![],
    };
    let adoptable = match &candidate {
        Err(b) => blocked_json(b),
        Ok(_) if !healthy => json!({ "ok": false, "code": "adopt_degraded", "message": "el Core está en solo lectura: no puede registrar la adopción" }),
        Ok(_) if tasks.is_empty() => json!({ "ok": false, "code": "adopt_no_task", "message": "no hay una Task sin ejecución en este Project que reciba el worktree: crea una primero" }),
        Ok(_) => json!({ "ok": true }),
    };
    let (branch, base) = match &candidate {
        Ok(c) => (json!(c.branch), json!(c.base)),
        Err(_) => (Value::Null, Value::Null),
    };
    Ok(json!({
        "v": 1,
        "project_id": project_id,
        "path": path,
        "branch": branch,
        "base": base,
        "health": { "writable": healthy },
        "tasks": tasks,
        "adopt": adoptable,
    }))
}

/// `resource_adopt`: la decisión de una Person de Desktop. Todo se comprueba antes de escribir; una sola mutación.
pub(super) fn adopt(core: &Core, context: &MutationContext, input: &AdoptInput) -> Result<Value, String> {
    if !context.is_person() || context.client_id.as_deref().is_none_or(str::is_empty) || !matches!(context.actor, super::events::Actor::PersonId(_)) {
        return Err("adoptar un worktree requiere una Person autenticada".into());
    }
    if !input.confirm {
        return Err("Adoptar un worktree exige confirmación explícita de la persona (confirm: true)".into());
    }
    let project_id = id_of(&input.project_id, "project_id")?;
    let task_id = id_of(&input.task_id, "task_id")?;
    let path = path_of(&input.path)?;
    if let Health::DegradedReadOnly(why) = core.health() {
        return Err(format!("adopt_degraded: el Core está en solo lectura ({why}): no puede registrar la adopción"));
    }
    // La Task es de este Project. Si ya adoptó ESTE worktree, repetir no hace nada.
    {
        let st = core.lock();
        let task = st.tasks.get(&task_id).ok_or_else(|| format!("adopt_task_not_found: no existe la Task {task_id}"))?;
        if task.project_id.as_deref() != Some(project_id.as_str()) {
            return Err("adopt_task_not_eligible: la Task es de otro Project".into());
        }
        if task.adopted && task.worktree.as_deref().is_some_and(|w| norm_path(w) == norm_path(&path)) {
            return Ok(json!({ "status": "AlreadyAdopted", "task_id": task_id, "attempt_id": format!("{task_id}-a1") }));
        }
    }
    let candidate = match examine(core, &project_id, &path)? {
        Ok(c) => c,
        Err(b) => return Err(format!("{}: {}", b.code, b.message)),
    };
    let request = AdoptRequest {
        worktree: candidate.path.clone(),
        repo: candidate.repo.clone(),
        branch: candidate.branch.clone(),
        base: candidate.base.clone(),
        base_commit: Some(candidate.base_commit.clone()),
        summary: format!("Trabajo externo adoptado de la rama {}.", candidate.branch),
    };
    let attempt_id = match core.mutate_as(context, |tx| tx.adopt_worktree(&task_id, &request)) {
        Ok(id) => id,
        Err(e) => {
            // Otra adopción de ESTE mismo worktree en ESTA Task pudo ganar entre la comprobación y la mutación: repetir no hace nada.
            let already = {
                let st = core.lock();
                st.tasks.get(&task_id).is_some_and(|t| t.adopted && t.worktree.as_deref().is_some_and(|w| norm_path(w) == norm_path(&path)))
            };
            if already {
                return Ok(json!({ "status": "AlreadyAdopted", "task_id": task_id, "attempt_id": format!("{task_id}-a1") }));
            }
            return Err(e.to_string());
        }
    };
    Ok(json!({
        "status": "Adopted",
        "task_id": task_id,
        "attempt_id": attempt_id,
        "branch": candidate.branch,
        "base": candidate.base,
    }))
}
