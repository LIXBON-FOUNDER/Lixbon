//! Cierre de tareas y runs: liberar worktrees y soltar hijas.

use serde_json::{json, Value};
use super::{CLOSE_REMINDER, Caller, Core, git};
use super::events::MutationContext;
use super::mutation::{Effect, StateAccess};
use super::state::{State, Status};

impl Core {
    pub(super) fn release(&self, ctx: &MutationContext, caller: &Caller, id: &str, force: bool) -> Result<Value, String> {
        let (repo, worktree, branch, merged, open) = {
            let st = self.lock();
            Self::check_manages(&st, caller, id)?;
            let t = st.task(id)?;
            (t.repo.clone(), t.worktree.clone(), t.branch.clone(), t.merged, !t.status.is_final())
        };
        if open && !force {
            return Err(format!("{id} sigue en marcha: detenla antes (lxo stop) o usa --force"));
        }
        self.kill_term(id);
        if let Some(wt) = &worktree {
            git::remove_worktree(&repo, wt, force).map_err(|e| format!("{e}\nSi hay cambios sin guardar que quieres descartar, usa --force"))?;
        }
        let branch_deleted = merged && branch.as_ref().is_some_and(|br| git::delete_branch(&repo, br).is_ok());
        // El worktree y la rama ya se borraron: el registro es UNA mutación posterior.
        let effect = Effect::new("release", "git_worktree_removed").task(id).repo(&repo)
            .expected(json!({ "record": "tarea liberada (stopped) y worktree/rama anotados" }))
            .observed(json!({ "worktree": worktree, "branch": branch, "branch_deleted": branch_deleted }));
        let hint = self.acting(ctx.clone()).mutate_after_effect(effect, |st| {
            if open {
                let _ = st.close(id, Status::Stopped, "liberada por su coordinador");
            }
            let t = st.task_mut(id)?;
            t.worktree = None;
            t.cwd = repo;
            Ok(self.close_hint(st, id))
        })?;
        Ok(json!({ "task": id, "worktree_removed": worktree.is_some(), "branch_deleted": branch_deleted, "hint": hint }))
    }

    pub(super) fn close_hint(&self, st: &State, task: &str) -> Option<&'static str> {
        let run = &st.tasks.get(task)?.run;
        let open = st.runs.get(run).is_some_and(|r| !r.closed);
        (open && st.run_wrapped_up(run)).then_some(CLOSE_REMINDER)
    }

    pub(super) fn ensure_launchable(&self, id: &str) -> Result<(), String> {
        let st = self.lock();
        let t = st.task(id)?;
        if t.status.is_final() || st.runs.get(&t.run).is_none_or(|r| r.closed) {
            return Err("El run se cerró mientras se preparaba la tarea: no se lanzó".into());
        }
        Ok(())
    }

    pub(super) fn discard_worktree(&self, id: &str) {
        let Some((repo, wt, branch)) = self.lock().tasks.get(id).and_then(|t| Some((t.repo.clone(), t.worktree.clone()?, t.branch.clone()))) else { return };
        if git::remove_worktree(&repo, &wt, true).is_ok() {
            if let Some(b) = branch {
                let _ = git::delete_branch(&repo, &b);
            }
        }
    }

    pub(super) fn close_run(&self, ctx: &MutationContext, run: &str, force: bool) -> Result<Value, String> {
        // Primero se persiste el cierre del run; después los efectos (matar terminales,
        // liberar worktrees), que registran cada uno su resultado.
        let (stopped, ids) = self.mutate_as(ctx, |st| {
            let (stopped, msgs) = st.close_run(run, force)?;
            st.notify(&msgs);
            let ids: Vec<String> = st.tasks.values().filter(|t| t.run == run).map(|t| t.id.clone()).collect();
            Ok((stopped, ids))
        })?;
        let terminals: Vec<&String> = ids.iter().filter(|id| self.kill_term(id)).collect();
        let (released, kept) = self.free_worktrees(ctx, run, force);
        Ok(json!({ "run": run, "stopped": stopped, "terminals": terminals, "released": released, "kept": kept }))
    }

    /// Libera los worktrees del run cuyas ramas ya están en la del coordinador; las
    /// demás se conservan. Con `force` también se liberan los limpios sin fusionar; los
    /// worktrees con cambios sin commit se conservan siempre y nunca se borra una rama sin fusionar.
    pub(super) fn free_worktrees(&self, ctx: &MutationContext, run: &str, force: bool) -> (Vec<Value>, Vec<Value>) {
        let (tasks, into) = {
            let st = self.lock();
            let root = st.runs.get(run).and_then(|r| st.tasks.get(&r.root));
            let into = root.and_then(|r| git::current_branch(&r.cwd).or_else(|| r.branch.clone()));
            (st.tasks.values().filter(|t| t.run == run && t.worktree.is_some()).cloned().collect::<Vec<_>>(), into)
        };
        let (mut released, mut kept) = (vec![], vec![]);
        for t in tasks {
            let Some(wt) = t.worktree.clone() else { continue };
            let merged = t.merged || t.branch.as_deref().zip(into.as_deref()).is_some_and(|(b, i)| git::is_merged(&t.repo, b, i));
            if !merged && !force {
                kept.push(json!({ "task": t.id, "branch": t.branch, "reason": "rama sin fusionar" }));
                continue;
            }
            if git::is_dirty(&wt) {
                kept.push(json!({ "task": t.id, "branch": t.branch, "reason": "cambios sin commit" }));
                continue;
            }
            if let Err(e) = git::remove_worktree(&t.repo, &wt, false) {
                kept.push(json!({ "task": t.id, "branch": t.branch, "reason": e.lines().next().unwrap_or_default() }));
                continue;
            }
            let branch_deleted = merged && t.branch.as_ref().is_some_and(|b| git::delete_branch(&t.repo, b).is_ok());
            let effect = Effect::new("close_idle_runs", "git_worktree_removed").task(&t.id).repo(&t.repo)
                .expected(json!({ "record": "worktree liberado en la tarea" }))
                .observed(json!({ "worktree": wt, "branch": t.branch, "branch_deleted": branch_deleted }));
            // El worktree ya no existe: si el registro falla queda anotado, y se sigue informando.
            let _ = self.acting(ctx.clone()).mutate_after_effect(effect, |st| {
                if let Ok(task) = st.task_mut(&t.id) {
                    task.worktree = None;
                    task.cwd = t.repo.clone();
                }
                Ok(())
            });
            released.push(json!({ "task": t.id, "branch": t.branch, "branch_deleted": branch_deleted }));
        }
        (released, kept)
    }
}
