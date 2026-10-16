//! Operaciones que la interfaz invoca por IPC (integrar, revisar, diff, publicar).

use serde_json::{json, Value};
use super::events::MutationContext;
use super::{Core, git, integration, review};

/// Las operaciones de este archivo son comandos de la interfaz (Tauri): las provoca una PERSONA.
fn person_ui(core: &Core) -> Result<MutationContext, String> {
    core.desktop_mutation_context()
}

impl Core {
    /// Integración aprobada por la persona (comando Tauri `orch_integrate`).
    /// `accept_moved_target`: el `found_commit` que la persona vio y acepta.
    pub fn integrate_from_ui(&self, task: &str, confirm: bool, squash: bool, accept_moved_target: Option<&str>) -> Result<Value, String> {
        // `integrate` confirma su propio registro con `mutate` (ya no hay `commit` aquí).
        let res = integration::integrate(&self.acting(person_ui(self)?), true,
            &json!({ "task": task, "confirm": confirm, "squash": squash, "accept_moved_target": accept_moved_target }));
        res.map(|mut v| {
            if v["outcome"] == "merged" {
                v["hint"] = json!(self.close_hint(&self.lock(), task));
            }
            v
        })
    }

    /// Diff de revisión de una tarea (comando Tauri `orch_task_diff`).
    pub fn task_diff_from_ui(&self, task_id: &str) -> Result<Value, String> {
        review::task_diff(&self.acting(person_ui(self)?), task_id, review::DIFF_LIMIT)
    }

    /// Revisión de la persona (comando Tauri `orch_review_task`).
    pub fn review_from_ui(&self, task_id: &str, decision: &str, head_commit: &str, comment: Option<&str>, confirm: bool) -> Result<Value, String> {
        let out = review::review_task(&self.acting(person_ui(self)?), task_id, decision, head_commit, comment, confirm)?;
        if out["outcome"] == "recorded" {
            self.emit(review::EV_REVIEWED, &json!({ "task_id": task_id, "decision": decision, "head_commit": head_commit, "at": out["at"] }));
        }
        Ok(out)
    }

    /// Publicación de PR aprobada por la persona (comando Tauri `orch_publish_pr`).
    pub fn publish_pr_from_ui(&self, task: &str, confirm: bool) -> Result<Value, String> {
        integration::publish_pr(&self.acting(person_ui(self)?), true, &json!({ "task": task, "confirm": confirm }), &git::gh_pr)
    }
}
