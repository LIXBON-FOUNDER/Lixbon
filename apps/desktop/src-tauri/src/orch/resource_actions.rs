//! Resource Manager (LXO-149, épica F5): inspeccionar y limpiar con seguridad el worktree y la rama de una Task. Contrato: `docs/core/RESOURCES.md`
//! § Acciones.
//!
//! Tres comandos de una Person de Desktop sobre el worktree de UNA Task:
//!
//! | comando | qué hace | qué NO hace |
//! |---|---|---|
//! | `resource_inspect { task_id }` (lectura) | estado físico y de git, y qué acciones valen ahora, con su motivo | nada |
//! | `resource_clean { task_id, confirm }` | quita el worktree **limpio** de trabajo **integrado** y borra su rama con `branch -d` | nunca borra trabajo sin integrar ni usa `-D` |
//! | `resource_delete_worktree { task_id, confirm, discard_uncommitted? }` | quita la carpeta del worktree y **conserva la rama** | no pierde cambios sin commit sin `discard_uncommitted`; no borra la rama |
//!
//! # Reglas
//! * **Un estado desconocido no habilita nada destructivo**: si git no puede decir si hay cambios, o si está integrado, se rechaza (`unknown`).
//!   «Falta» solo se dice cuando el sistema de archivos lo afirma.
//! * **Sin proceso vivo**: una Task en marcha, o con un proceso en custodia, no se toca (`running`); parar y soltar es otro comando.
//! * **El Core tiene que poder registrar el cambio**: degradado o en solo lectura no se borra nada (`degraded`).
//! * **Idempotentes**: sin worktree ni rama que limpiar es `nothing_to_do`; un worktree que ya no está en disco solo se anota (`forgotten`), sin tocar git.
//! * **Efecto y estado, juntos**: lo borrado en disco se registra en UNA mutación (`mutate_after_effect`): `effect.observed` + el estado de la Task.
//!   Si ese registro falla, el efecto queda en el journal para reconciliar. Sin rutas en el evento.
//! * **Adoptar un worktree externo NO está aquí**: ver `docs/core/RESOURCES.md` § Adoptar.

use std::io::ErrorKind;
use std::path::Path;

use serde::Deserialize;
use serde_json::{json, Value};

use super::events::{Actor, MutationContext};
use super::mutation::{Effect, Health, StateAccess};
use super::model_read::{invalid, require_person};
use super::resource_git as rgit;
use super::{git, review, Caller, Core};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InspectInput {
    pub task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CleanInput {
    pub task_id: String,
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DeleteInput {
    pub task_id: String,
    #[serde(default)]
    pub confirm: bool,
    /// Descartar los cambios sin commit del worktree. Sin esto, un worktree sucio no se quita.
    #[serde(default)]
    pub discard_uncommitted: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Disk {
    None,
    Present,
    Missing,
    Unknown,
}

impl Disk {
    fn code(self) -> &'static str {
        match self {
            Disk::None => "none",
            Disk::Present => "present",
            Disk::Missing => "missing",
            Disk::Unknown => "unknown",
        }
    }
}

/// Lo que se sabe del worktree y de la rama de una Task, leído sin ningún bloqueo del Core mientras corre git.
struct Facts {
    task_id: String,
    repo: String,
    worktree: Option<String>,
    branch: Option<String>,
    base: Option<String>,
    integrated_flag: bool,
    task_final: bool,
    running: bool,
    /// Un Attempt VIVO de OTRA Task que comparte el worktree de esta (LXO-248): mientras exista, no se limpia ni se borra nada.
    shared_by: Option<String>,
    /// No se pudo averiguar si alguien más usa el worktree: por seguridad no se toca.
    shared_unknown: bool,
    disk: Disk,
    dirty: Option<bool>,
    branch_exists: Option<bool>,
    merged_by_git: Option<bool>,
    healthy: bool,
}

impl Facts {
    /// ¿Está integrado el trabajo de la rama? `Some(true)` por la decisión de Lixbon (también un squash) o porque git dice que es ancestro de la base.
    fn integrated(&self) -> Option<bool> {
        if self.integrated_flag || self.merged_by_git == Some(true) {
            return Some(true);
        }
        self.merged_by_git
    }
}

fn gather(core: &Core, task_id: &str) -> Result<Facts, String> {
    let (repo, worktree, branch, base, merged, final_) = {
        let st = core.lock();
        let t = st.tasks.get(task_id).ok_or_else(|| format!("resource_not_found: no existe la Task {task_id}"))?;
        (t.repo.clone(), t.worktree.clone(), t.branch.clone(), t.base.clone(), t.merged, t.status.is_final())
    };
    let disk = match worktree.as_deref() {
        None => Disk::None,
        Some(path) => match std::fs::metadata(Path::new(path)) {
            Ok(m) if m.is_dir() => Disk::Present,
            Ok(_) => Disk::Unknown,
            Err(e) if e.kind() == ErrorKind::NotFound => Disk::Missing,
            Err(_) => Disk::Unknown,
        },
    };
    let dirty = match (disk, worktree.as_deref()) {
        (Disk::Present, Some(path)) => rgit::is_dirty(path),
        _ => None,
    };
    let branch_exists = branch.as_deref().and_then(|b| (!repo.is_empty()).then(|| review::branch_head(&repo, b).is_some()));
    let merged_by_git = match (branch.as_deref(), base.as_deref(), branch_exists) {
        (Some(b), Some(base), Some(true)) if !repo.is_empty() => rgit::is_ancestor(&repo, b, base),
        _ => None,
    };
    // Un Attempt de otra Task puede estar trabajando en el worktree de ESTA (compartido). Un fallo al leerlo no se interpreta como «nadie»: se
    // trata como `unknown` más abajo.
    let shared_by = match core.task_worktree_record(task_id) {
        Ok(Some((worktree_id, _))) => core
            .worktree_store(|st| st.attempts_of_worktree(&worktree_id))
            .and_then(|r| r.ok())
            .map(|attempts| attempts.into_iter().find(|a| a.task_id != task_id && !a.status.is_final()).map(|a| a.id)),
        Ok(None) => Some(None),
        Err(_) => None,
    };
    Ok(Facts {
        task_id: task_id.to_string(),
        repo,
        worktree,
        branch,
        base,
        integrated_flag: merged,
        task_final: final_,
        // Un proceso de un adapter que no se pudo cerrar con prueba (supervisor) también cuenta como «en marcha»: no se toca su worktree.
        running: core.has_term(task_id) || super::adapter::supervisor::task_in_custody(task_id),
        shared_by: shared_by.clone().flatten(),
        shared_unknown: shared_by.is_none(),
        disk,
        dirty,
        branch_exists,
        merged_by_git,
        healthy: matches!(core.health(), Health::Normal),
    })
}

fn ok() -> Value {
    json!({ "ok": true })
}

fn blocked(reason: &str) -> Value {
    json!({ "ok": false, "reason": reason })
}

/// Lo que impide actuar sobre ESTA Task, sea cual sea la acción (`None`: nada).
fn common_block(f: &Facts) -> Option<&'static str> {
    if !f.healthy {
        return Some("degraded");
    }
    // LXO-248: otro Attempt vivo trabaja en este worktree (compartido), o no se pudo comprobar: no se borra nada.
    if f.shared_by.is_some() {
        return Some("shared_in_use");
    }
    if f.shared_unknown {
        return Some("unknown");
    }
    if !f.task_final || f.running {
        return Some("running");
    }
    None
}

/// `resource_clean`: ¿se puede, y si no por qué? `Ok(())` incluye el caso idempotente y el de un worktree que ya no está.
fn clean_check(f: &Facts) -> Result<(), &'static str> {
    if let Some(r) = common_block(f) {
        return Err(r);
    }
    match f.disk {
        Disk::Unknown => return Err("unknown"),
        Disk::Present => match f.dirty {
            Some(false) => {}
            Some(true) => return Err("dirty"),
            None => return Err("unknown"),
        },
        Disk::None | Disk::Missing => {}
    }
    // Con una rama, solo se limpia lo integrado; sin saberlo, no se toca.
    if f.branch.is_some() && f.branch_exists != Some(false) {
        match f.integrated() {
            Some(true) => {}
            Some(false) => return Err("not_merged"),
            None => return Err("unknown"),
        }
    }
    Ok(())
}

/// `resource_delete_worktree`: `Ok(descarta)`: `descarta` es que se perderían cambios sin commit (exige `discard_uncommitted`).
fn delete_check(f: &Facts) -> Result<bool, &'static str> {
    if let Some(r) = common_block(f) {
        return Err(r);
    }
    match f.disk {
        Disk::Unknown => Err("unknown"),
        Disk::Present => match f.dirty {
            Some(dirty) => Ok(dirty),
            None => Err("unknown"),
        },
        Disk::None | Disk::Missing => Ok(false),
    }
}

fn nothing_to_do(f: &Facts) -> bool {
    f.worktree.is_none() && f.branch.as_ref().is_none_or(|_| f.branch_exists == Some(false))
}

fn merged_label(f: &Facts) -> Value {
    match (f.branch.as_ref(), f.integrated()) {
        (None, _) => Value::Null,
        (Some(_), Some(true)) => json!("integrated"),
        (Some(_), Some(false)) => json!("not_merged"),
        (Some(_), None) => json!("unknown"),
    }
}

/// `resource_inspect`. Solo lectura, solo una Person de Desktop.
pub(super) fn inspect(core: &Core, caller: &Caller, context: Option<&MutationContext>, input: &InspectInput) -> Result<Value, String> {
    require_person(caller, context)?;
    let id = input.task_id.trim();
    if id.is_empty() || id.chars().count() > 200 {
        return Err(invalid("`task_id` debe contener de 1 a 200 caracteres"));
    }
    let f = gather(core, id)?;
    let clean = if nothing_to_do(&f) { blocked("nothing_to_do") } else { clean_check(&f).map_or_else(|r| blocked(r), |()| ok()) };
    let delete = if f.worktree.is_none() {
        blocked("no_worktree")
    } else {
        match delete_check(&f) {
            Ok(discards) => json!({ "ok": true, "discards_uncommitted": discards }),
            Err(r) => blocked(r),
        }
    };
    Ok(json!({
        "v": 1,
        "task_id": f.task_id,
        "worktree": { "path": f.worktree, "state": f.disk.code(), "dirty": f.dirty },
        "branch": { "name": f.branch, "exists": f.branch_exists, "base": f.base, "merged": merged_label(&f) },
        "process": { "running": f.running || !f.task_final },
        // LXO-248: el Attempt vivo de OTRA Task que trabaja en este worktree (compartido), si lo hay: por eso `clean`/`delete_worktree` dicen `shared_in_use`.
        "shared": { "by": f.shared_by },
        "health": { "writable": f.healthy },
        "actions": { "clean": clean, "delete_worktree": delete },
    }))
}

fn guard(core: &Core, context: &MutationContext, task_id: &str, confirm: bool) -> Result<Facts, String> {
    if !context.is_person() || !matches!(context.actor, Actor::PersonId(_)) || context.client_id.as_deref().is_none_or(str::is_empty) {
        return Err("limpiar recursos requiere una Person autenticada".into());
    }
    if !confirm {
        return Err("Limpiar un worktree exige confirmación explícita de la persona (confirm: true)".into());
    }
    let id = task_id.trim();
    if id.is_empty() || id.chars().count() > 200 {
        return Err("Falta la Task".into());
    }
    gather(core, id)
}

/// Quita la carpeta del worktree (sin `--force` salvo que se descarten cambios) y devuelve si se quitó. Un fallo de git lo conserva TODO.
fn remove_dir(f: &Facts, force: bool) -> Result<bool, String> {
    match (f.disk, f.worktree.as_deref()) {
        (Disk::Present, Some(path)) => git::remove_worktree(&f.repo, path, force).map(|()| true).map_err(|e| format!("resource_git_failed: {e}")),
        _ => Ok(false),
    }
}

/// Registra lo ocurrido: con efecto externo, `effect.observed` + estado en UNA mutación; sin él, una mutación normal.
fn register(core: &Core, context: &MutationContext, f: &Facts, operation: &'static str, removed: bool, branch_deleted: bool) -> Result<(), String> {
    let acting = core.acting(context.clone());
    let id = f.task_id.clone();
    let branch = f.branch.clone();
    let repo = f.repo.clone();
    let had_worktree = f.worktree.is_some();
    let apply = move |tx: &mut super::mutation::Tx| -> Result<(), String> {
        let t = tx.task_mut(&id)?;
        if had_worktree {
            t.worktree = None;
            t.cwd = repo.clone();
        }
        // La rama solo deja de constar si `branch -d` la borró de verdad: si no, sigue siendo suya.
        if branch_deleted && t.branch == branch {
            t.branch = None;
        }
        Ok(())
    };
    if removed || branch_deleted {
        let effect = Effect::new(operation, "git_worktree_removed")
            .task(&f.task_id)
            .repo(&f.repo)
            .expected(json!({ "record": "worktree retirado del estado", "branch_deleted": branch_deleted }))
            .observed(json!({ "worktree_removed": removed, "branch": f.branch, "branch_deleted": branch_deleted }));
        acting.mutate_after_effect(effect, apply)
    } else {
        acting.mutate(apply)
    }
}

/// `resource_clean`: quita el worktree limpio de trabajo integrado y borra su rama con `branch -d`.
pub(super) fn clean(core: &Core, context: &MutationContext, input: &CleanInput) -> Result<Value, String> {
    let f = guard(core, context, &input.task_id, input.confirm)?;
    if nothing_to_do(&f) {
        return Ok(json!({ "task_id": f.task_id, "outcome": "nothing_to_do", "worktree_removed": false, "branch_deleted": false }));
    }
    clean_check(&f).map_err(|r| format!("resource_blocked: {r}"))?;
    let removed = remove_dir(&f, false)?;
    // `branch -d` solo borra lo que git ve integrado: un squash que Lixbon integró se queda (se dice), nunca se fuerza.
    let branch_deleted = f.branch.as_deref().is_some_and(|b| f.branch_exists != Some(false) && git::delete_branch(&f.repo, b).is_ok());
    register(core, context, &f, "resource_clean", removed, branch_deleted)?;
    let outcome = if removed { "cleaned" } else { "forgotten" };
    Ok(json!({
        "task_id": f.task_id,
        "outcome": outcome,
        "worktree_removed": removed,
        "branch_deleted": branch_deleted,
        "branch_kept": f.branch.is_some() && !branch_deleted && f.branch_exists != Some(false),
    }))
}

/// `resource_delete_worktree`: quita la carpeta y conserva la rama.
pub(super) fn delete_worktree(core: &Core, context: &MutationContext, input: &DeleteInput) -> Result<Value, String> {
    let f = guard(core, context, &input.task_id, input.confirm)?;
    if f.worktree.is_none() {
        return Ok(json!({ "task_id": f.task_id, "outcome": "nothing_to_do", "worktree_removed": false, "branch_deleted": false }));
    }
    let discards = delete_check(&f).map_err(|r| format!("resource_blocked: {r}"))?;
    if discards && !input.discard_uncommitted {
        return Err("resource_blocked: dirty: el worktree tiene cambios sin commit; descartarlos exige discard_uncommitted: true".into());
    }
    let removed = remove_dir(&f, discards)?;
    register(core, context, &f, "resource_delete_worktree", removed, false)?;
    Ok(json!({
        "task_id": f.task_id,
        "outcome": if removed { "deleted" } else { "forgotten" },
        "worktree_removed": removed,
        "branch_deleted": false,
        "branch_kept": f.branch.is_some(),
        "discarded_uncommitted": removed && discards,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> Facts {
        Facts {
            task_id: "t1".into(),
            repo: "r".into(),
            worktree: Some("w".into()),
            branch: Some("lx/r/t1-a1".into()),
            base: Some("main".into()),
            integrated_flag: true,
            task_final: true,
            running: false,
            shared_by: None,
            shared_unknown: false,
            disk: Disk::Present,
            dirty: Some(false),
            branch_exists: Some(true),
            merged_by_git: Some(true),
            healthy: true,
        }
    }

    #[test]
    fn lo_integrado_y_limpio_se_limpia_y_nada_mas() {
        assert_eq!(clean_check(&facts()), Ok(()));
        assert_eq!(delete_check(&facts()), Ok(false));
    }

    /// LXO-248: con otro Attempt vivo trabajando en el worktree (compartido), o sin poder comprobarlo, no se limpia ni se borra nada.
    #[test]
    fn un_worktree_que_otro_attempt_vivo_comparte_no_se_limpia_ni_se_borra() {
        let compartido = Facts { shared_by: Some("t4-a1".into()), ..facts() };
        assert_eq!((clean_check(&compartido), delete_check(&compartido)), (Err("shared_in_use"), Err("shared_in_use")));
        let sin_saber = Facts { shared_unknown: true, ..facts() };
        assert_eq!((clean_check(&sin_saber), delete_check(&sin_saber)), (Err("unknown"), Err("unknown")));
        // Sin nadie más, nada cambia.
        assert_eq!(clean_check(&facts()), Ok(()));
    }

    #[test]
    fn un_estado_desconocido_nunca_habilita_lo_destructivo() {
        let unknown_dirty = Facts { dirty: None, ..facts() };
        assert_eq!(clean_check(&unknown_dirty), Err("unknown"));
        assert_eq!(delete_check(&unknown_dirty), Err("unknown"));
        let unknown_disk = Facts { disk: Disk::Unknown, ..facts() };
        assert_eq!((clean_check(&unknown_disk), delete_check(&unknown_disk)), (Err("unknown"), Err("unknown")));
        // Sin saber si está integrado (git no lo dijo y Lixbon no lo integró), no se borra la rama.
        let unknown_merge = Facts { integrated_flag: false, merged_by_git: None, ..facts() };
        assert_eq!(clean_check(&unknown_merge), Err("unknown"));
    }

    #[test]
    fn lo_sin_integrar_o_sucio_se_rechaza_y_lo_integrado_por_lixbon_cuenta_aunque_git_no_lo_vea_ancestro() {
        assert_eq!(clean_check(&Facts { integrated_flag: false, merged_by_git: Some(false), ..facts() }), Err("not_merged"));
        assert_eq!(clean_check(&Facts { dirty: Some(true), ..facts() }), Err("dirty"));
        // Un squash que Lixbon integró no es ancestro de la base: cuenta como integrado por la decisión.
        assert_eq!(clean_check(&Facts { integrated_flag: true, merged_by_git: Some(false), ..facts() }), Ok(()));
        // Descartar cambios sin commit lo pide quien llama: aquí solo se dice que se perderían.
        assert_eq!(delete_check(&Facts { dirty: Some(true), ..facts() }), Ok(true));
    }

    #[test]
    fn una_tarea_en_marcha_o_un_core_degradado_bloquean_todo() {
        for f in [Facts { task_final: false, ..facts() }, Facts { running: true, ..facts() }] {
            assert_eq!((clean_check(&f), delete_check(&f)), (Err("running"), Err("running")));
        }
        let degraded = Facts { healthy: false, ..facts() };
        assert_eq!((clean_check(&degraded), delete_check(&degraded)), (Err("degraded"), Err("degraded")));
    }

    #[test]
    fn un_worktree_que_ya_no_esta_en_disco_solo_se_anota() {
        let missing = Facts { disk: Disk::Missing, dirty: None, ..facts() };
        assert_eq!((clean_check(&missing), delete_check(&missing)), (Ok(()), Ok(false)));
        assert!(!nothing_to_do(&missing));
        assert!(nothing_to_do(&Facts { worktree: None, disk: Disk::None, branch: None, ..facts() }));
        assert!(!nothing_to_do(&Facts { worktree: None, disk: Disk::None, ..facts() }), "queda una rama integrada por borrar");
    }
}
