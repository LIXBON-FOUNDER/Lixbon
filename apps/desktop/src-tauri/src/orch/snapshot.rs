//! Estado para la interfaz (`Core::snapshot`) y lo que la acompaña.

use std::collections::{BTreeMap, HashMap};
use serde_json::{json, Value};
use super::{Core, integrate_target, lxo_path, review, roles};
use super::state::State;

impl Core {
    /// Estado para la interfaz. Con el lock del estado solo se copian datos; git
    /// (`for-each-ref` y la rama del padre para `integrate_into`) corre después,
    /// sin lock, para que una consulta lenta no frene a lxo ni a los agentes.
    pub fn snapshot(&self) -> Value {
        let (mut out, git_in) = {
            let st = self.lock();
            let live = self.live_ids();
            let server = self.server.lock().ok().and_then(|s| s.as_ref().map(|h| h.port));
            let start = st.messages.len().saturating_sub(400);
            let out = json!({
                "settings": self.settings(),
                "roles": roles::describe(&self.settings().roles)["roles"],
                "server": server,
                "lxo": lxo_path(),
                "lxo_exists": lxo_path().is_file(),
                "runs": st.runs,
                "tasks": tasks_with_integration(&st),
                "messages": &st.messages[start..],
                "live": live,
            });
            (out, SnapshotGit::copy(&st))
        };
        #[cfg(test)]
        {
            let hook = self.snapshot_git_hook.lock().unwrap().clone();
            if let Some((tx, barrier)) = hook {
                let _ = tx.send(());
                barrier.wait();
            }
        }
        let (heads, into) = git_in.run();
        if let Some(tasks) = out["tasks"].as_object_mut() {
            for (id, t) in tasks.iter_mut() {
                t["head_commit"] = heads.get(id).cloned().map(Value::String).unwrap_or(Value::Null);
            }
        }
        // Por tarea con rama sin integrar: dónde la integraría orch_integrate.
        out["integrate_into"] = json!(into);
        out
    }
}

/// Lo que necesita git para la snapshot, copiado con el lock tomado.
pub(super) struct SnapshotGit {
    /// (tarea, repo, rama) de cada tarea con rama.
    branches: Vec<(String, String, String)>,
    /// (tarea, carpeta del padre) de cada hija con rama sin integrar.
    parents: Vec<(String, String)>,
}

impl SnapshotGit {
    fn copy(st: &State) -> Self {
        let branches = st.tasks.values().filter_map(|t| Some((t.id.clone(), t.repo.clone(), t.branch.clone()?))).collect();
        let parents = st.tasks.values().filter(|t| t.branch.is_some() && !t.merged)
            .filter_map(|t| Some((t.id.clone(), st.tasks.get(t.parent.as_ref()?)?.cwd.clone()))).collect();
        SnapshotGit { branches, parents }
    }

    /// Sin lock: un `git for-each-ref` por repo y una consulta de rama por carpeta de padre.
    fn run(self) -> (HashMap<String, String>, BTreeMap<String, Value>) {
        let mut by_repo: HashMap<String, HashMap<String, String>> = HashMap::new();
        let mut heads = HashMap::new();
        for (id, repo, branch) in self.branches {
            let refs = by_repo.entry(repo.clone()).or_insert_with(|| review::branch_heads(&repo));
            if let Some(c) = refs.get(&branch) {
                heads.insert(id, c.clone());
            }
        }
        let mut by_dir: HashMap<String, Value> = HashMap::new();
        let into = self.parents.into_iter()
            .map(|(id, dir)| (id, by_dir.entry(dir.clone()).or_insert_with(|| integrate_target(&dir)).clone()))
            .collect();
        (heads, into)
    }
}

/// Última integración de la tarea (decisión `merge` más reciente) o `null`.
pub(super) fn last_integration(st: &State, id: &str) -> Value {
    st.decisions.iter().filter(|d| d.task == id && d.kind == "merge").max_by_key(|d| (d.at, d.id)).map(|d| {
        let v: Value = d.detail_json.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null);
        json!({ "outcome": v["outcome"], "result_commit": v.get("result_commit").cloned().unwrap_or(Value::Null), "at": d.at })
    }).unwrap_or(Value::Null)
}

/// Las tareas de la snapshot con `last_integration` (sin la lista de decisiones).
pub(super) fn tasks_with_integration(st: &State) -> Value {
    let mut tasks = serde_json::to_value(&st.tasks).unwrap_or(Value::Null);
    if let Some(map) = tasks.as_object_mut() {
        for (id, t) in map.iter_mut() {
            t["last_integration"] = last_integration(st, id);
            t["last_review"] = review::last_review(st, id);
            // head_commit se rellena después, fuera del lock (Core::snapshot).
            t["head_commit"] = Value::Null;
        }
    }
    tasks
}

impl State {
    pub fn children_open(&self, id: &str) -> Vec<String> {
        self.children(id).into_iter().filter(|t| !t.status.is_final()).map(|t| t.id.clone()).collect()
    }
}
