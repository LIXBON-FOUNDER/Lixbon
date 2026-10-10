//! Revisión por tarea: la persona mira el diff de la rama de una hija y lo
//! acepta o lo rechaza **sobre un commit concreto** (`head_commit`). Integrar
//! exige que la última revisión de la tarea sea `accepted` y sobre el HEAD
//! actual de la rama (ver `integration.rs`).
//!
//! Solo la interfaz llega aquí (`orch_task_diff`, `orch_review_task`): los
//! agentes no pueden revisar ni leer el diff por esta vía. Los rechazos para
//! `orch_call` y el servidor HTTP de `lxo` están en dos listas separadas:
//! decisiones humanas y lecturas cerradas por ahora.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

use super::git;
use super::integration::{AGENT_REJECT, PR_REJECT};
use super::state::{Decision, State};

/// Decisiones que solo toma una persona desde la interfaz.
pub const HUMAN_DECISION_CMDS: &[&str] = &["integrate", "pr", "review"];
/// Lecturas cerradas a los agentes por ahora (se pueden abrir sin tocar las decisiones).
pub const CLOSED_READ_CMDS: &[&str] = &["task_diff"];

pub const REVIEW_REJECT: &str = "Revisar una tarea (aceptar o rechazar su diff) lo hace una persona desde Lixbon: los agentes no pueden.";
pub const TASK_DIFF_CLOSED: &str = "El diff de revisión por tarea solo lo ve la persona en Lixbon. Usa `lxo diff <tarea>`.";
pub const NEED_CONFIRM_REVIEW: &str = "Revisar exige confirmación explícita de la persona (confirm: true)";
/// Tamaño máximo de los parches que devuelve `orch_task_diff` (suma de todos).
pub const DIFF_LIMIT: usize = 512 * 1024;
pub const EV_REVIEWED: &str = "orch-task-reviewed";

/// Motivo de rechazo si un agente (o `orch_call`) pide algo de las dos listas.
pub fn closed_to_agents(cmd: &str) -> Option<&'static str> {
    if HUMAN_DECISION_CMDS.contains(&cmd) {
        return Some(match cmd {
            "integrate" => AGENT_REJECT,
            "pr" => PR_REJECT,
            _ => REVIEW_REJECT,
        });
    }
    CLOSED_READ_CMDS.contains(&cmd).then_some(TASK_DIFF_CLOSED)
}

fn detail(d: &Decision) -> Value {
    d.detail_json.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null)
}

/// Última revisión de la tarea (la más reciente decide, no cualquier `accepted`).
pub fn last_review_decision(st: &State, task: &str) -> Option<(Value, u64, u64)> {
    st.decisions.iter().filter(|d| d.task == task && d.kind == "review").max_by_key(|d| d.id).map(|d| (detail(d), d.id, d.at))
}

pub fn last_review(st: &State, task: &str) -> Value {
    last_review_decision(st, task)
        .map(|(v, _, at)| json!({ "decision": v["decision"], "head_commit": v["head_commit"], "at": at }))
        .unwrap_or(Value::Null)
}

/// ¿La última revisión aceptó exactamente este commit?
pub fn accepted_for(st: &State, task: &str, head: &str) -> bool {
    last_review_decision(st, task).is_some_and(|(v, _, _)| v["decision"] == "accepted" && v["head_commit"] == head)
}

/// Commit actual de la rama (en el repo, válido desde cualquier worktree).
pub fn branch_head(repo: &str, branch: &str) -> Option<String> {
    git::run(repo, &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]).ok()
        .filter(|o| o.ok).map(|o| o.stdout.trim().to_string()).filter(|s| !s.is_empty())
}

/// Ramas y commits de un repo en una sola llamada (para la snapshot).
pub fn branch_heads(repo: &str) -> HashMap<String, String> {
    git::run(repo, &["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"]).ok()
        .filter(|o| o.ok)
        .map(|o| o.stdout.lines().filter_map(|l| l.rsplit_once(' ').map(|(b, c)| (b.to_string(), c.to_string()))).collect())
        .unwrap_or_default()
}

struct Target {
    repo: String,
    branch: String,
    base_commit: Option<String>,
    /// Rama destino: la que tiene ahora el checkout del padre (donde integraría orch_integrate).
    into_branch: Option<String>,
}

fn target(state: &Mutex<State>, id: &str) -> Result<Target, String> {
    let (repo, branch, base_commit, parent_dir, base) = {
        let st = state.lock().unwrap_or_else(|e| e.into_inner());
        let t = st.tasks.get(id).ok_or_else(|| format!("not_found: no existe la tarea {id}"))?;
        let branch = t.branch.clone().ok_or_else(|| format!("no_branch: {id} no tiene rama propia (se lanzó sin worktree)"))?;
        let parent_dir = t.parent.as_ref().and_then(|p| st.tasks.get(p)).map(|p| p.cwd.clone());
        (t.repo.clone(), branch, t.base_commit.clone(), parent_dir, t.base.clone())
    };
    let into_branch = parent_dir.as_deref().and_then(git::current_branch).or(base);
    Ok(Target { repo, branch, base_commit, into_branch })
}

fn resolve_base(t: &Target) -> Result<(String, &'static str), String> {
    if let Some(b) = &t.base_commit {
        return Ok((b.clone(), "recorded"));
    }
    let into = t.into_branch.as_deref().ok_or_else(|| format!("Sin base para revisar {}: no hay base_commit registrado ni rama destino", t.branch))?;
    let o = git::run(&t.repo, &["merge-base", into, &t.branch])?;
    let mb = o.stdout.trim().to_string();
    if o.ok && !mb.is_empty() {
        Ok((mb, "merge_base"))
    } else {
        Err(format!("Sin base para revisar {}: no hay base_commit registrado ni merge-base con {into}", t.branch))
    }
}

fn git_ok(repo: &str, args: &[&str]) -> Result<String, String> {
    let o = git::run(repo, args)?;
    if o.ok { Ok(o.stdout) } else { Err(format!("git {}: {}", args.join(" "), o.stderr)) }
}

/// Diff de la rama de la tarea contra su base, archivo por archivo. Los parches
/// se cortan al llegar a `limit` bytes en total y se marca `truncated`.
pub fn task_diff(state: &Mutex<State>, id: &str, limit: usize) -> Result<Value, String> {
    let t = target(state, id)?;
    let head = branch_head(&t.repo, &t.branch).ok_or_else(|| format!("La rama {} ya no existe", t.branch))?;
    let (base, source) = resolve_base(&t)?;
    let q = ["-c", "core.quotepath=false", "diff", "--no-renames"];
    let names = git_ok(&t.repo, &[&q[..], &["--name-status", &base, &head]].concat())?;
    let stats = git_ok(&t.repo, &[&q[..], &["--numstat", &base, &head]].concat())?;
    let nums: HashMap<String, (Option<u64>, Option<u64>)> = stats.lines().filter_map(|l| {
        let mut p = l.splitn(3, '\t');
        let (a, d, path) = (p.next()?, p.next()?, p.next()?);
        Some((path.to_string(), (a.parse().ok(), d.parse().ok())))
    }).collect();
    let (mut used, mut truncated, mut files) = (0usize, false, vec![]);
    for line in names.lines().filter(|l| !l.trim().is_empty()) {
        let Some((status, path)) = line.split_once('\t') else { continue };
        let (additions, deletions) = nums.get(path).cloned().unwrap_or((None, None));
        let patch = if truncated {
            None
        } else {
            let mut p = git_ok(&t.repo, &[&q[..], &[base.as_str(), head.as_str(), "--", path]].concat())?;
            if used + p.len() > limit {
                truncated = true;
                let mut cut = limit.saturating_sub(used);
                while !p.is_char_boundary(cut) {
                    cut -= 1;
                }
                p.truncate(cut);
                used = limit;
                (!p.is_empty()).then_some(p)
            } else {
                used += p.len();
                Some(p)
            }
        };
        files.push(json!({ "path": path, "status": status, "additions": additions, "deletions": deletions, "patch": patch }));
    }
    Ok(json!({
        "task_id": id, "branch": t.branch, "base_commit": base, "base_source": source, "head_commit": head,
        "files": files, "truncated": truncated, "limit_bytes": limit,
    }))
}

/// Revisión de la persona sobre `head_commit`. Si la rama ya no está en ese
/// commit devuelve `head_moved` y no registra nada.
pub fn review_task(state: &Mutex<State>, id: &str, decision: &str, head_commit: &str, comment: Option<&str>, confirm: bool) -> Result<Value, String> {
    if !confirm {
        return Err(NEED_CONFIRM_REVIEW.into());
    }
    if !["accepted", "rejected"].contains(&decision) {
        return Err(format!("decision debe ser accepted o rejected (llegó {decision:?})"));
    }
    let t = target(state, id)?;
    let found = branch_head(&t.repo, &t.branch);
    if found.as_deref() != Some(head_commit.trim()) {
        return Ok(json!({ "task_id": id, "outcome": "head_moved", "expected_commit": head_commit, "found_commit": found }));
    }
    let (base, source) = match resolve_base(&t) {
        Ok((b, s)) => (Some(b), Some(s)),
        Err(_) => (None, None),
    };
    let comment = comment.map(str::trim).filter(|c| !c.is_empty());
    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
    let did = st.record_decision(id, "review", "human", &json!({
        "decision": decision, "base_commit": base, "base_source": source, "head_commit": head_commit, "comment": comment,
    }));
    let at = st.decisions.iter().find(|d| d.id == did).map(|d| d.at).unwrap_or_default();
    Ok(json!({ "task_id": id, "outcome": "recorded", "decision": decision, "decision_id": did, "head_commit": head_commit,
        "base_commit": base, "base_source": source, "comment": comment, "at": at }))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::orch::state::NewTask;
    use std::path::{Path, PathBuf};

    fn git(dir: &Path, args: &[&str]) -> String {
        let o = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    /// Repo con master y rama `lx/t` (modifica a.txt, añade b.txt). Devuelve el estado, la hija, la carpeta y el commit base.
    pub(crate) fn setup(name: &str) -> (Mutex<State>, String, PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("lxo-revision-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for a in [&["init", "-q", "-b", "master"][..], &["config", "user.name", "t"], &["config", "user.email", "t@t"], &["config", "core.autocrlf", "false"]] { git(&dir, a); }
        std::fs::write(dir.join("a.txt"), "uno\ndos\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "base"]);
        let base = git(&dir, &["rev-parse", "HEAD"]);
        git(&dir, &["checkout", "-qb", "lx/t"]);
        std::fs::write(dir.join("a.txt"), "uno\nDOS\ntres\n").unwrap();
        std::fs::write(dir.join("b.txt"), "nuevo\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "rama"]);
        git(&dir, &["checkout", "-q", "master"]);
        let cwd = dir.to_string_lossy().into_owned();
        let nt = |branch: Option<&str>| NewTask { agent: "claude".into(), model: None, effort: None, role: None, title: "x".into(), spec: String::new(),
            repo: cwd.clone(), cwd: cwd.clone(), branch: branch.map(String::from), base: None, worktree: None, external: false };
        let mut st = State::default();
        let (_, root) = st.create_run("obj", nt(None));
        let id = st.add_child(&root, 2, nt(Some("lx/t"))).unwrap();
        st.done(&id, true, "ok", vec![], None).unwrap();
        st.task_mut(&id).unwrap().base_commit = Some(base.clone());
        (Mutex::new(st), id, dir, base)
    }

    fn head(dir: &Path) -> String { git(dir, &["rev-parse", "lx/t"]) }

    #[test]
    fn diff_con_base_registrada() {
        let (st, id, dir, base) = setup("registrada");
        let d = task_diff(&st, &id, DIFF_LIMIT).unwrap();
        assert_eq!((d["base_commit"].as_str(), d["base_source"].as_str()), (Some(base.as_str()), Some("recorded")));
        assert_eq!(d["head_commit"].as_str(), Some(head(&dir).as_str()));
        assert_eq!(d["truncated"], false);
        let files = d["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        let a = files.iter().find(|f| f["path"] == "a.txt").unwrap();
        assert_eq!((a["status"].as_str(), a["additions"].as_u64(), a["deletions"].as_u64()), (Some("M"), Some(2), Some(1)));
        assert!(a["patch"].as_str().unwrap().contains("+DOS"));
        let b = files.iter().find(|f| f["path"] == "b.txt").unwrap();
        assert_eq!((b["status"].as_str(), b["additions"].as_u64()), (Some("A"), Some(1)));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sin_base_registrada_usa_merge_base() {
        let (st, id, dir, base) = setup("mergebase");
        // master avanza después de abrir la rama: merge-base sigue siendo la base.
        std::fs::write(dir.join("c.txt"), "m\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "master avanza"]);
        st.lock().unwrap().task_mut(&id).unwrap().base_commit = None;
        let d = task_diff(&st, &id, DIFF_LIMIT).unwrap();
        assert_eq!((d["base_commit"].as_str(), d["base_source"].as_str()), (Some(base.as_str()), Some("merge_base")));
        assert_eq!(d["files"].as_array().unwrap().len(), 2, "c.txt de master no entra");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sin_base_ni_merge_base_es_error_claro() {
        let (st, id, dir, _) = setup("sinbase");
        // Rama huérfana: no comparte historia con master.
        git(&dir, &["checkout", "-q", "--orphan", "lx/o"]);
        git(&dir, &["rm", "-rfq", "."]);
        std::fs::write(dir.join("z.txt"), "z\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "huérfana"]);
        git(&dir, &["checkout", "-q", "master"]);
        {
            let mut s = st.lock().unwrap();
            let t = s.task_mut(&id).unwrap();
            t.base_commit = None;
            t.branch = Some("lx/o".into());
        }
        let e = task_diff(&st, &id, DIFF_LIMIT).unwrap_err();
        assert!(e.starts_with("Sin base para revisar lx/o"), "{e}");
        assert!(task_diff(&st, "t-no-existe", DIFF_LIMIT).unwrap_err().starts_with("not_found"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn diff_grande_se_trunca() {
        let (st, id, dir, _) = setup("trunca");
        let d = task_diff(&st, &id, 40).unwrap();
        assert_eq!(d["truncated"], true);
        let total: usize = d["files"].as_array().unwrap().iter().filter_map(|f| f["patch"].as_str()).map(str::len).sum();
        assert!(total <= 40, "{total}");
        assert_eq!(d["files"].as_array().unwrap().len(), 2, "la lista de archivos sigue completa");
        assert_eq!(task_diff(&st, &id, DIFF_LIMIT).unwrap()["truncated"], false);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn head_que_no_coincide_no_registra() {
        let (st, id, dir, _) = setup("head");
        let old = head(&dir);
        git(&dir, &["checkout", "-q", "lx/t"]);
        std::fs::write(dir.join("b.txt"), "otra\n").unwrap();
        git(&dir, &["commit", "-qam", "nuevo commit"]);
        git(&dir, &["checkout", "-q", "master"]);
        let now = head(&dir);
        let out = review_task(&st, &id, "accepted", &old, None, true).unwrap();
        assert_eq!((out["outcome"].as_str(), out["found_commit"].as_str()), (Some("head_moved"), Some(now.as_str())));
        assert!(st.lock().unwrap().decisions.is_empty());
        assert!(review_task(&st, &id, "accepted", &now, None, false).is_err());
        assert!(review_task(&st, &id, "quizas", &now, None, true).is_err());
        assert!(st.lock().unwrap().decisions.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn aceptar_y_rechazar_una_fila_por_decision_y_last_review() {
        let (st, id, dir, base) = setup("decide");
        let h = head(&dir);
        assert_eq!(last_review(&st.lock().unwrap(), &id), Value::Null);
        let a = review_task(&st, &id, "accepted", &h, Some("bien"), true).unwrap();
        assert_eq!(a["outcome"], "recorded");
        assert!(accepted_for(&st.lock().unwrap(), &id, &h));
        let r = review_task(&st, &id, "rejected", &h, Some("  "), true).unwrap();
        assert_eq!(r["outcome"], "recorded");
        let s = st.lock().unwrap();
        let rows: Vec<&Decision> = s.decisions.iter().filter(|d| d.kind == "review").collect();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|d| d.actor == "human" && d.task == id));
        let v = detail(rows[0]);
        assert_eq!(v, json!({ "decision": "accepted", "base_commit": base, "base_source": "recorded", "head_commit": h, "comment": "bien" }));
        assert_eq!(detail(rows[1])["comment"], Value::Null);
        // Decide la última: rechazada, aunque antes hubo una aceptada sobre el mismo commit.
        let lr = last_review(&s, &id);
        assert_eq!((lr["decision"].as_str(), lr["head_commit"].as_str()), (Some("rejected"), Some(h.as_str())));
        assert!(lr["at"].as_u64().is_some());
        assert!(!accepted_for(&s, &id, &h));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn listas_de_rechazo_separadas() {
        for c in HUMAN_DECISION_CMDS {
            assert!(closed_to_agents(c).is_some_and(|m| m != TASK_DIFF_CLOSED), "{c}");
        }
        assert_eq!(closed_to_agents("review"), Some(REVIEW_REJECT));
        for c in CLOSED_READ_CMDS {
            assert_eq!(closed_to_agents(c), Some(TASK_DIFF_CLOSED));
        }
        assert!(HUMAN_DECISION_CMDS.iter().all(|c| !CLOSED_READ_CMDS.contains(c)));
        assert_eq!(closed_to_agents("status"), None);
    }
}
