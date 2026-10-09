//! Integración como paso aparte, aprobada por una persona.
//!
//! Ningún agente integra: `lxo merge` se rechaza y la única vía es la orden
//! `integrate` del host, que solo acepta la interfaz (Caller::User) con una
//! confirmación explícita. Usa `git::merge` tal cual y deja el resultado, con
//! conflicto o sin él, como decisión (`State.decisions`, misma forma que la
//! tabla `decisions` del diseño SQLite).

use std::sync::Mutex;

/// Una integración a la vez: un doble clic o una llamada repetida espera a la
/// primera y luego ve la tarea ya integrada.
static INTEGRATING: Mutex<()> = Mutex::new(());

use serde_json::{json, Value};

use super::git;
use super::state::{State, Task};

pub const AGENT_REJECT: &str = "La integración la aprueba una persona desde Lixbon: los agentes no pueden fusionar ramas. \
Deja la rama lista, explica en tu informe qué hay que integrar y avisa al usuario.";

pub const NEED_CONFIRM: &str = "Integrar exige confirmación explícita de la persona (confirm: true)";

/// Punto de extensión para reglas de integración automática: **apagado y sin
/// lógica**. Queda fuera de esta etapa; nada lo llama para integrar.
#[allow(dead_code)]
pub const AUTO_INTEGRATION_ENABLED: bool = false;

/// Regla automática (futura). Hoy nunca propone integrar.
#[allow(dead_code)]
pub fn auto_integration_rule(_task: &Task) -> bool {
    false
}

fn bool_arg(args: &Value, k: &str) -> bool {
    args.get(k).and_then(Value::as_bool).unwrap_or(false)
}

/// Integra la rama de una tarea en el checkout de su padre. Registra la
/// decisión aunque haya conflicto o error de git (y entonces devuelve Err). Quien
/// llama hace `commit` del estado en ambos casos.
pub fn integrate(state: &Mutex<State>, from_user: bool, args: &Value) -> Result<Value, String> {
    if !from_user {
        return Err(AGENT_REJECT.into());
    }
    let id = args.get("task").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if id.is_empty() {
        return Err("Falta la tarea a integrar".into());
    }
    if !bool_arg(args, "confirm") {
        return Err(NEED_CONFIRM.into());
    }
    let squash = bool_arg(args, "squash");
    let _one = INTEGRATING.lock().unwrap_or_else(|e| e.into_inner());
    let (branch, into, title) = {
        let st = state.lock().unwrap_or_else(|e| e.into_inner());
        let t = st.task(&id)?;
        let branch = t.branch.clone().ok_or_else(|| format!("{id} no tiene rama propia: no hay nada que integrar"))?;
        if t.merged {
            // Idempotente: no integra otra vez ni crea otra decisión.
            let prev = st.decisions.iter().rev().find(|d| d.task == id && d.kind == "merge"
                && d.detail_json.as_deref().is_some_and(|j| j.contains("\"outcome\":\"merged\""))).map(|d| d.id);
            return Ok(json!({ "task": id, "outcome": "already_merged", "decision": prev, "branch": branch }));
        }
        let parent = t.parent.as_ref().and_then(|p| st.tasks.get(p)).ok_or("La tarea raíz no se integra en nadie")?;
        if !t.status.is_final() && !bool_arg(args, "force") {
            return Err(format!("{id} aún está en marcha: espera a que entregue o usa force"));
        }
        (branch, parent.cwd.clone(), t.title.clone())
    };
    let base = git::head(&into);
    let res = git::merge(&into, &branch, &format!("lxo: integra {id} · {title}"), squash);
    let result = res.as_ref().ok().and_then(|_| git::head(&into));
    let (outcome, conflict, output) = match &res {
        Ok(out) => ("merged", Value::Null, out.clone()),
        Err(e) if e.starts_with("Conflictos") => {
            let files: Vec<&str> = e.lines().skip(1).filter(|l| !l.trim().is_empty()).collect();
            ("conflict", json!(files), e.clone())
        }
        Err(e) => ("error", Value::Null, e.clone()),
    };
    let detail = json!({
        "outcome": outcome, "branch": branch, "into": into, "squash": squash,
        "base_commit": base, "result_commit": result, "conflict": conflict,
    });
    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
    let decision = st.record_decision(&id, "merge", "human", &detail);
    match res {
        Ok(_) => {
            st.task_mut(&id)?.merged = true;
            Ok(json!({ "task": id, "decision": decision, "outcome": outcome, "branch": branch, "into": into,
                "base_commit": base, "result_commit": result, "output": output }))
        }
        Err(e) => Err(format!("{e}\n(decisión #{decision} registrada: {outcome})")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orch::state::{NewTask, Status};
    use std::path::Path;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let o = Command::new("git").args(args).current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t")
            .output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    /// Repo con rama `lx/t` que cambia `a.txt`; si `conflict`, master también lo cambia.
    fn setup(name: &str, conflict: bool) -> (Mutex<State>, String, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("lxo-integra-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "master"]);
        git(&dir, &["config", "user.name", "t"]);
        git(&dir, &["config", "user.email", "t@t"]);
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "base"]);
        git(&dir, &["checkout", "-qb", "lx/t"]);
        std::fs::write(dir.join("a.txt"), "rama\n").unwrap();
        git(&dir, &["commit", "-qam", "rama"]);
        git(&dir, &["checkout", "-q", "master"]);
        if conflict {
            std::fs::write(dir.join("a.txt"), "master\n").unwrap();
            git(&dir, &["commit", "-qam", "master"]);
        }
        let cwd = dir.to_string_lossy().into_owned();
        let nt = |title: &str, branch: Option<&str>| NewTask {
            agent: "claude".into(), model: None, effort: None, role: None, title: title.into(), spec: String::new(),
            repo: cwd.clone(), cwd: cwd.clone(), branch: branch.map(String::from), base: None, worktree: None, external: false,
        };
        let mut st = State::default();
        let (_, root) = st.create_run("obj", nt("raíz", None));
        let id = st.add_child(&root, 2, nt("hija", Some("lx/t"))).unwrap();
        st.done(&id, true, "ok", vec![], None).unwrap();
        (Mutex::new(st), id, dir)
    }

    #[test]
    fn un_agente_no_puede_integrar() {
        let (st, id, dir) = setup("agente", false);
        let before = git(&dir, &["rev-parse", "HEAD"]);
        let e = integrate(&st, false, &json!({ "task": id, "confirm": true })).unwrap_err();
        assert_eq!(e, AGENT_REJECT);
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), before);
        let s = st.lock().unwrap();
        assert!(!s.task(&id).unwrap().merged && s.decisions.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sin_confirmacion_se_rechaza() {
        let (st, id, dir) = setup("confirma", false);
        let before = git(&dir, &["rev-parse", "HEAD"]);
        for args in [json!({ "task": id }), json!({ "task": id, "confirm": false }), json!({ "task": id, "confirm": "sí" })] {
            assert_eq!(integrate(&st, true, &args).unwrap_err(), NEED_CONFIRM);
        }
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), before);
        assert!(st.lock().unwrap().decisions.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn con_confirmacion_integra_con_git_y_registra_la_decision() {
        let (st, id, dir) = setup("ok", false);
        let base = git(&dir, &["rev-parse", "HEAD"]);
        let out = integrate(&st, true, &json!({ "task": id, "confirm": true })).unwrap();
        let result = git(&dir, &["rev-parse", "HEAD"]);
        assert_ne!(base, result);
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "rama\n");
        // Merge --no-ff de git::merge: dos padres, el segundo es la rama.
        assert_eq!(git(&dir, &["rev-parse", "HEAD^2"]), git(&dir, &["rev-parse", "lx/t"]));
        assert_eq!((out["outcome"].as_str(), out["result_commit"].as_str()), (Some("merged"), Some(result.as_str())));
        let s = st.lock().unwrap();
        assert!(s.task(&id).unwrap().merged);
        let d = &s.decisions[0];
        assert_eq!((d.id, d.task.as_str(), d.kind.as_str(), d.actor.as_str()), (1, id.as_str(), "merge", "human"));
        assert!(d.at > 0);
        let detail: Value = serde_json::from_str(d.detail_json.as_deref().unwrap()).unwrap();
        assert_eq!(detail["base_commit"], base.as_str());
        assert_eq!(detail["result_commit"], result.as_str());
        assert!(detail["conflict"].is_null());
        // Forma de la tabla decisions, en state.json.
        let v = serde_json::to_value(d).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort();
        assert_eq!(keys, ["actor", "at", "detail_json", "id", "kind", "task"]);
        drop(s);
        // Llamada repetida (doble clic): no integra otra vez ni registra otra decisión.
        let again = integrate(&st, true, &json!({ "task": id, "confirm": true })).unwrap();
        assert_eq!((again["outcome"].as_str(), again["decision"].as_u64()), (Some("already_merged"), Some(1)));
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), result);
        assert_eq!(st.lock().unwrap().decisions.len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn doble_clic_simultaneo_integra_una_vez() {
        let (st, id, dir) = setup("dobleclic", false);
        let st = std::sync::Arc::new(st);
        let hs: Vec<_> = (0..2).map(|_| {
            let (st, id) = (st.clone(), id.clone());
            std::thread::spawn(move || integrate(&st, true, &json!({ "task": id, "confirm": true })).unwrap())
        }).collect();
        let outs: Vec<String> = hs.into_iter().map(|h| h.join().unwrap()["outcome"].as_str().unwrap().to_string()).collect();
        let mut sorted = outs.clone();
        sorted.sort();
        assert_eq!(sorted, ["already_merged", "merged"]);
        assert_eq!(st.lock().unwrap().decisions.len(), 1);
        assert_eq!(git(&dir, &["rev-list", "--merges", "--count", "HEAD"]), "1");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn conflicto_queda_registrado_sin_integrar() {
        let (st, id, dir) = setup("conflicto", true);
        let base = git(&dir, &["rev-parse", "HEAD"]);
        let e = integrate(&st, true, &json!({ "task": id, "confirm": true })).unwrap_err();
        assert!(e.starts_with("Conflictos") && e.contains("decisión #1"));
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), base);
        assert_eq!(git(&dir, &["status", "--porcelain"]), "");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "master\n");
        let s = st.lock().unwrap();
        assert!(!s.task(&id).unwrap().merged);
        let detail: Value = serde_json::from_str(s.decisions[0].detail_json.as_deref().unwrap()).unwrap();
        assert_eq!(detail["outcome"], "conflict");
        assert_eq!(detail["conflict"], json!(["a.txt"]));
        assert_eq!(detail["base_commit"], base.as_str());
        assert!(detail["result_commit"].is_null());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn tarea_en_marcha_y_regla_automatica_apagada() {
        let (st, id, dir) = setup("marcha", false);
        st.lock().unwrap().task_mut(&id).unwrap().status = Status::Running;
        assert!(integrate(&st, true, &json!({ "task": id, "confirm": true })).unwrap_err().contains("en marcha"));
        let s = st.lock().unwrap();
        assert!(!AUTO_INTEGRATION_ENABLED);
        assert!(!auto_integration_rule(s.task(&id).unwrap()));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn state_json_viejo_sin_decisions_se_lee() {
        let s: State = serde_json::from_str(r#"{"runs":{},"tasks":{},"messages":[],"seq":3}"#).unwrap();
        assert!(s.decisions.is_empty());
    }
}
