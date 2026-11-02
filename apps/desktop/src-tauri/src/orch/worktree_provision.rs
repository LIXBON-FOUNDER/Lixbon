//! Worktree del Attempt (LXO-246, PR A): crearlo, registrarlo y deshacerlo, sin tocar a ningún proveedor.
//!
//! Lo usará el `Launcher` real en `prepare` (antes de `attempt.started`), y por eso no depende de ningún adapter: es solo
//! git y el registro en el Core. La estrategia es **`new`**: cada Attempt tiene su carpeta y su rama; compartir la carpeta del
//! Project (`shared`) queda para otra fase.
//!
//! ```text
//! provision_worktree(intent)
//!   1. comprobar el Core y resolver el repositorio y la base      <- sin escribir nada
//!   2. git worktree add -b lx/<run>/<attempt> <repo>.lixbon-wt/<attempt> <base>
//!        falla -> `Failed`; no se posee nada, así que no se borra nada
//!   3. registrar el Worktree en UNA mutación (`mutate_after_effect`): Task.worktree / branch / base / base_commit / cwd
//!        falla -> se deshace lo que ESTA llamada creó y es `Failed`
//! release_worktree(wt)                                              <- git worktree remove, branch -d (nunca -D), registro
//! ```
//!
//! # Invariantes
//! * **Solo se borra lo que este módulo creó.** Una carpeta o una rama que ya existían hacen fallar la creación y quedan
//!   intactas: los nombres son deterministas (`lx/<run>/<attempt>`) y un reintento tras una caída encontraría restos que no
//!   debe pisar (los limpia la reconciliación de arranque, no esta llamada).
//! * La rama se borra con `branch -d`, nunca `-D`: si tiene trabajo sin integrar, se conserva.
//! * No se aplica ningún plan de entorno (`worktree_env`): ese plan es lo que una persona aprobó para una hija, y el primer
//!   Attempt no tiene una aprobación equivalente. Sin enlaces ni copias.
//! * Con el Core en solo lectura no se crea ni se borra nada: no se podría registrar.
//!
//! **Inerte**: nada en producción lo llama todavía.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el Launcher real (LXO-246)

use std::path::PathBuf;

use serde_json::json;

use super::dispatch::{DispatchIntent, PrepareError};
use super::events::MutationContext;
use super::mutation::{Effect, Health, StateAccess};
use super::{git, Core};

/// Lo que esta llamada creó y, por tanto, puede deshacer.
#[derive(Debug)]
pub(super) struct ProvisionedWorktree {
    pub(super) dir: PathBuf,
    pub(super) branch: String,
    pub(super) base: String,
    /// El checkout principal del repositorio (donde se ejecuta git).
    repo_root: String,
    task: String,
    /// El `cwd` que tenía la Task antes de registrar el Worktree: al quitarlo, vuelve a él.
    previous_cwd: String,
}

/// Un componente seguro para una rama o una carpeta: ids del Core, sin separadores ni `..`.
fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && !value.starts_with(['.', '-'])
        && !value.contains("..")
        && !value.ends_with(".lock")
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Rama y nombre de carpeta del Attempt. Deterministas: el mismo Attempt siempre pide los mismos.
pub(super) fn names(intent: &DispatchIntent) -> Result<(String, String), PrepareError> {
    if !safe_component(&intent.run_id) || !safe_component(&intent.attempt_id) {
        return Err(PrepareError::Failed(format!("los ids {} / {} no sirven para nombrar una rama ni una carpeta", intent.run_id, intent.attempt_id)));
    }
    Ok((format!("lx/{}/{}", intent.run_id, intent.attempt_id), intent.attempt_id.clone()))
}

impl Core {
    /// Crea el worktree del Attempt y lo registra. Un `Err` no deja nada creado por esta llamada.
    pub(super) fn provision_worktree(&self, intent: &DispatchIntent) -> Result<ProvisionedWorktree, PrepareError> {
        if !matches!(self.health(), Health::Normal) {
            return Err(PrepareError::Unavailable("el Core no está en estado normal: no se puede registrar un worktree".into()));
        }
        let (branch, name) = names(intent)?;
        let given = intent.repo.to_string_lossy().into_owned();
        let repo_root = git::main_root(&given)
            .or_else(|| git::toplevel(&given))
            .ok_or_else(|| PrepareError::Unavailable(format!("{given} no es un repositorio git")))?;
        let base_commit = git::head(&repo_root).ok_or_else(|| PrepareError::Unavailable(format!("el repositorio {repo_root} todavía no tiene ningún commit")))?;
        let base = git::current_branch(&repo_root).unwrap_or_else(|| "HEAD".into());
        let dir = git::worktree_dir(&repo_root, None, &name);
        let previous_cwd = self.lock().tasks.get(&intent.task_id).map(|t| t.cwd.clone()).ok_or_else(|| PrepareError::Failed(format!("la Task {} no existe en el estado", intent.task_id)))?;

        // A partir de aquí esta llamada es dueña del worktree y de la rama (y solo de ellos). Si `add_worktree` falla
        // —p. ej. «ya existe la carpeta»— no da propiedad sobre esa ruta, que nunca se borra.
        git::add_worktree(&repo_root, &dir, &branch, &base).map_err(PrepareError::Failed)?;
        let owned = ProvisionedWorktree { dir: dir.clone(), branch: branch.clone(), base: base.clone(), repo_root: repo_root.clone(), task: intent.task_id.clone(), previous_cwd };

        let dir_text = dir.to_string_lossy().into_owned();
        let effect = Effect::new("spawn", "git_worktree").task(&intent.task_id).repo(&repo_root)
            .expected(json!({ "record": "worktree del Attempt" }))
            .observed(json!({ "worktree": dir_text, "branch": branch, "base": base }));
        let task = intent.task_id.clone();
        let registered = self.acting(MutationContext::core()).mutate_after_effect(effect, |tx| {
            let t = tx.task_mut(&task)?;
            t.worktree = Some(dir_text.clone());
            t.cwd = dir_text.clone();
            t.branch = Some(branch.clone());
            t.base = Some(base.clone());
            t.base_commit = Some(base_commit.clone());
            Ok(())
        });
        if let Err(why) = registered {
            // El worktree existe en disco y el Core no lo conoce: se deshace lo que esta llamada acaba de crear.
            let _ = git::remove_worktree(&repo_root, &dir_text, true);
            let _ = git::delete_branch(&repo_root, &branch);
            return Err(PrepareError::Failed(format!("no se pudo registrar el worktree: {why}")));
        }
        Ok(owned)
    }

    /// Deshace el worktree creado por [`Core::provision_worktree`]: quita la carpeta, intenta `branch -d` y lo registra. Si no se
    /// puede quitar la carpeta (o registrar), se conserva todo y es un `Err`: el estado no afirma lo que ya no existe.
    pub(super) fn release_worktree(&self, wt: &ProvisionedWorktree) -> Result<(), String> {
        if !matches!(self.health(), Health::Normal) {
            return Err("el Core no está en estado normal: no se borra nada que no se pueda registrar".into());
        }
        let dir = wt.dir.to_string_lossy().into_owned();
        git::remove_worktree(&wt.repo_root, &dir, true).inspect_err(|e| eprintln!("[core] git no pudo quitar un worktree: {e}"))?;
        let branch_deleted = git::delete_branch(&wt.repo_root, &wt.branch).is_ok();
        let effect = Effect::new("spawn_cleanup", "git_worktree_removed").task(&wt.task).repo(&wt.repo_root)
            .expected(json!({ "record": "worktree del Attempt retirado" }))
            .observed(json!({ "worktree": dir, "worktree_removed": true, "branch": wt.branch, "branch_deleted": branch_deleted }));
        self.acting(MutationContext::core()).mutate_after_effect(effect, |tx| {
            let t = tx.task_mut(&wt.task)?;
            if t.worktree.is_some() {
                t.worktree = None;
                t.cwd = wt.previous_cwd.clone();
            }
            // La rama solo deja de constar si `branch -d` la borró de verdad: si no, sigue siendo suya.
            if branch_deleted && t.branch.as_deref() == Some(wt.branch.as_str()) {
                t.branch = None;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(run: &str, attempt: &str) -> DispatchIntent {
        DispatchIntent {
            attempt_id: attempt.into(),
            task_id: "t1".into(),
            run_id: run.into(),
            project_id: "p1".into(),
            provider: "claude".into(),
            model: None,
            effort: None,
            profile: "explorar".into(),
            prompt: "haz algo".into(),
            repo: PathBuf::from("C:/repo"),
        }
    }

    #[test]
    fn la_rama_y_la_carpeta_salen_de_los_ids_y_son_deterministas() {
        let (branch, name) = names(&intent("r1", "t2-a1")).unwrap();
        assert_eq!((branch.as_str(), name.as_str()), ("lx/r1/t2-a1", "t2-a1"));
        assert_eq!(names(&intent("r1", "t2-a1")).unwrap(), (branch, name), "el mismo Attempt pide siempre lo mismo");
    }

    #[test]
    fn un_id_que_no_sirve_para_nombrar_se_rechaza_sin_tocar_git() {
        for bad in ["", "../x", "a/b", "a b", ".oculto", "-opcion", "a..b", "x.lock", "ñ", "a\\b", &"x".repeat(129)] {
            assert!(matches!(names(&intent("r1", bad)), Err(PrepareError::Failed(_))), "attempt {bad:?}");
            assert!(matches!(names(&intent(bad, "t2-a1")), Err(PrepareError::Failed(_))), "run {bad:?}");
        }
    }
}
