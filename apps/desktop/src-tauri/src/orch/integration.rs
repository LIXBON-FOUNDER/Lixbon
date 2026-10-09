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

pub const PR_REJECT: &str = "Publicar un PR lo aprueba una persona desde Lixbon: los agentes no pueden hacer push ni abrir PRs. \
Deja la rama lista y propón en tu informe que se publique.";

pub const NEED_CONFIRM_PR: &str = "Publicar el PR exige confirmación explícita de la persona (confirm: true)";

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
    let (branch, into, title, expected) = {
        let st = state.lock().unwrap_or_else(|e| e.into_inner());
        let t = st.task(&id)?;
        let branch = t.branch.clone().ok_or_else(|| format!("{id} no tiene rama propia: no hay nada que integrar"))?;
        if t.merged {
            // Idempotente: no integra otra vez ni crea otra decisión.
            let prev = st.decisions.iter().rev().find(|d| d.task == id && d.kind == "merge" && outcome_of(d) == "merged").map(|d| d.id);
            return Ok(json!({ "task": id, "outcome": "already_merged", "decision": prev, "branch": branch }));
        }
        let parent = t.parent.as_ref().and_then(|p| st.tasks.get(p)).ok_or("La tarea raíz no se integra en nadie")?;
        if !t.status.is_final() && !bool_arg(args, "force") {
            return Err(format!("{id} aún está en marcha: espera a que entregue o usa force"));
        }
        (branch, parent.cwd.clone(), t.title.clone(), expected_target(&st, t, &parent.cwd))
    };
    let found = git::head(&into);
    let mut st_rec = |detail: Value| {
        let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
        st.record_decision(&id, "merge", "human", &detail)
    };
    // El destino solo puede haberse movido por orch_integrate: si no, se avisa y no se integra.
    if let Some(exp) = expected.as_ref().filter(|e| found.as_ref() != Some(*e)) {
        let detail = json!({ "outcome": "target_moved", "branch": branch, "into": into, "squash": squash,
            "expected_commit": exp, "found_commit": found });
        let decision = st_rec(detail);
        return Ok(json!({ "task": id, "outcome": "target_moved", "decision": decision, "branch": branch, "into": into,
            "expected_commit": exp, "found_commit": found,
            "message": "La rama destino cambió fuera de Lixbon (commit, merge o reset manual): revisa el destino antes de integrar. No se integró." }));
    }
    let res = git::merge(&into, &branch, &format!("lxo: integra {id} · {title}"), squash);
    let result = res.as_ref().ok().and_then(|_| git::head(&into));
    let (outcome, conflicts, message) = match &res {
        Ok(out) => ("merged", Value::Null, out.clone()),
        Err(e) if e.starts_with("Conflictos") => {
            let files: Vec<&str> = e.lines().skip(1).filter(|l| !l.trim().is_empty()).collect();
            ("conflict", json!(files), e.clone())
        }
        Err(e) => ("error", Value::Null, e.clone()),
    };
    let detail = json!({
        "outcome": outcome, "branch": branch, "into": into, "squash": squash,
        "base_commit": found, "result_commit": result, "conflicts": conflicts,
        "base_check": if expected.is_some() { "ok" } else { "sin_referencia" },
    });
    let decision = st_rec(detail);
    if outcome == "merged" {
        state.lock().unwrap_or_else(|e| e.into_inner()).task_mut(&id)?.merged = true;
    }
    Ok(json!({ "task": id, "decision": decision, "outcome": outcome, "branch": branch, "into": into,
        "base_commit": found, "result_commit": result, "conflicts": conflicts, "message": message }))
}

fn outcome_of(d: &super::state::Decision) -> String {
    d.detail_json.as_deref().and_then(|j| serde_json::from_str::<Value>(j).ok())
        .and_then(|v| v["outcome"].as_str().map(String::from)).unwrap_or_default()
}

/// Commit en el que debería estar el destino. Criterio: el `result_commit` de la
/// última integración hecha por `orch_integrate` en ese mismo destino desde que se
/// creó la tarea; si no hubo ninguna, el commit del destino al crear la tarea
/// (`base_commit`). `None` (tareas de antes de este cambio): no hay referencia.
fn expected_target(st: &State, t: &Task, into: &str) -> Option<String> {
    let last = st.decisions.iter().rev().find_map(|d| {
        if d.kind != "merge" || d.at < t.created {
            return None;
        }
        let v: Value = serde_json::from_str(d.detail_json.as_deref()?).ok()?;
        (v["outcome"] == "merged" && v["into"] == into).then(|| v["result_commit"].as_str().map(String::from)).flatten()
    });
    last.or_else(|| t.base_commit.clone())
}

/// Crea el PR (en la app, `git::gh_pr`; en pruebas, un gh simulado).
pub type CreatePr<'a> = &'a dyn Fn(&str, &str, &str, &str, &str) -> Result<String, String>;

fn first_url(text: &str) -> Option<String> {
    text.split_whitespace().find(|w| w.starts_with("https://")).map(|w| w.trim_end_matches(['.', ',', ')']).to_string())
}

/// Publica la rama de una tarea (`git push -u origin <rama>` + `gh pr create`),
/// aprobado por la persona. Idempotente: si la tarea ya tiene PR, o gh dice que
/// ya existe, no crea otro. Cada llamada confirmada deja una decisión `pr`.
pub fn publish_pr(state: &Mutex<State>, from_user: bool, args: &Value, create: CreatePr) -> Result<Value, String> {
    if !from_user {
        return Err(PR_REJECT.into());
    }
    let id = args.get("task").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if id.is_empty() {
        return Err("Falta la tarea a publicar".into());
    }
    if !bool_arg(args, "confirm") {
        return Err(NEED_CONFIRM_PR.into());
    }
    let _one = INTEGRATING.lock().unwrap_or_else(|e| e.into_inner());
    let (branch, base, dir, title, summary, existing) = {
        let st = state.lock().unwrap_or_else(|e| e.into_inner());
        let t = st.task(&id)?;
        let branch = t.branch.clone().ok_or_else(|| format!("{id} no tiene rama propia: no hay nada que publicar"))?;
        (branch, t.base.clone().unwrap_or_else(|| "HEAD".into()), t.cwd.clone(), t.title.clone(), t.summary.clone(), t.pr_url.clone())
    };
    let remote = git::remote_url(&dir);
    let (outcome, url, err) = match existing {
        Some(u) => ("already_exists", Some(u), None),
        None => {
            let res = git::push(&dir, &branch).and_then(|_| create(&dir, &base, &branch, &title,
                &format!("{summary}\n\n_Tarea {id} del orquestador de Lixbon._")));
            match res {
                Ok(u) => ("created", Some(u), None),
                Err(e) if e.contains("already exists") => ("already_exists", first_url(&e), None),
                Err(e) => ("error", None, Some(e)),
            }
        }
    };
    let detail = json!({ "outcome": outcome, "branch": branch, "remote": remote, "pr_url": url });
    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
    let decision = st.record_decision(&id, "pr", "human", &detail);
    match err {
        None => {
            if url.is_some() {
                st.task_mut(&id)?.pr_url = url.clone();
            }
            Ok(json!({ "task": id, "decision": decision, "outcome": outcome, "branch": branch, "remote": remote, "pr_url": url }))
        }
        Some(e) => Err(format!("{e}\n(decisión #{decision} registrada: error)")),
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
        st.task_mut(&id).unwrap().base_commit = Some(git(&dir, &["rev-parse", "HEAD"]));
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
        assert!(detail["conflicts"].is_null());
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
        let out = integrate(&st, true, &json!({ "task": id, "confirm": true })).unwrap();
        assert_eq!((out["outcome"].as_str(), out["decision"].as_u64()), (Some("conflict"), Some(1)));
        assert_eq!(out["conflicts"], json!(["a.txt"]));
        assert_eq!((out["branch"].as_str(), out["into"].as_str()), (Some("lx/t"), dir.to_str()));
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), base);
        assert_eq!(git(&dir, &["status", "--porcelain"]), "");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "master\n");
        let s = st.lock().unwrap();
        assert!(!s.task(&id).unwrap().merged);
        let detail: Value = serde_json::from_str(s.decisions[0].detail_json.as_deref().unwrap()).unwrap();
        assert_eq!(detail["outcome"], "conflict");
        assert_eq!(detail["conflicts"], json!(["a.txt"]));
        assert_eq!(detail["base_commit"], base.as_str());
        assert!(detail["result_commit"].is_null());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn destino_movido_por_fuera_no_integra_y_lo_registra() {
        let (st, id, dir) = setup("movido", false);
        let expected = git(&dir, &["rev-parse", "HEAD"]);
        std::fs::write(dir.join("b.txt"), "manual\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "commit manual en el destino"]);
        let found = git(&dir, &["rev-parse", "HEAD"]);
        let out = integrate(&st, true, &json!({ "task": id, "confirm": true })).unwrap();
        assert_eq!(out["outcome"], "target_moved");
        assert_eq!((out["expected_commit"].as_str(), out["found_commit"].as_str()), (Some(expected.as_str()), Some(found.as_str())));
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), found);
        let s = st.lock().unwrap();
        assert!(!s.task(&id).unwrap().merged);
        let d = &s.decisions[0];
        assert_eq!((d.kind.as_str(), d.actor.as_str()), ("merge", "human"));
        let detail: Value = serde_json::from_str(d.detail_json.as_deref().unwrap()).unwrap();
        assert_eq!(detail["outcome"], "target_moved");
        assert_eq!((detail["expected_commit"].as_str(), detail["found_commit"].as_str()), (Some(expected.as_str()), Some(found.as_str())));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn integrar_dos_hermanas_seguidas_no_es_destino_movido() {
        // La segunda espera el result_commit de la primera, no su base_commit.
        let (st, id, dir) = setup("hermanas", false);
        git(&dir, &["checkout", "-qb", "lx/u", "HEAD"]);
        std::fs::write(dir.join("c.txt"), "u\n").unwrap();
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-qm", "u"]);
        git(&dir, &["checkout", "-q", "master"]);
        let id2 = {
            let mut s = st.lock().unwrap();
            let parent = s.task(&id).unwrap().parent.clone().unwrap();
            let mut nt2 = NewTask { agent: "claude".into(), model: None, effort: None, role: None, title: "otra".into(), spec: String::new(),
                repo: dir.to_string_lossy().into_owned(), cwd: dir.to_string_lossy().into_owned(), branch: Some("lx/u".into()), base: None, worktree: None, external: false };
            nt2.title = "otra".into();
            let id2 = s.add_child(&parent, 2, nt2).unwrap();
            s.done(&id2, true, "ok", vec![], None).unwrap();
            s.task_mut(&id2).unwrap().base_commit = Some(git(&dir, &["rev-parse", "HEAD"]));
            s.task_mut(&id2).unwrap().created = 0;
            id2
        };
        assert_eq!(integrate(&st, true, &json!({ "task": id, "confirm": true })).unwrap()["outcome"], "merged");
        let out = integrate(&st, true, &json!({ "task": id2, "confirm": true })).unwrap();
        assert_eq!(out["outcome"], "merged", "{out}");
        assert_eq!(st.lock().unwrap().decisions.len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sin_base_commit_integra_y_lo_anota() {
        let (st, id, dir) = setup("sinref", false);
        st.lock().unwrap().task_mut(&id).unwrap().base_commit = None;
        assert_eq!(integrate(&st, true, &json!({ "task": id, "confirm": true })).unwrap()["outcome"], "merged");
        let detail: Value = serde_json::from_str(st.lock().unwrap().decisions[0].detail_json.as_deref().unwrap()).unwrap();
        assert_eq!(detail["base_check"], "sin_referencia");
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

    /// Remoto bare local como origin (sin red).
    fn with_remote(dir: &Path) -> std::path::PathBuf {
        let bare = dir.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&bare);
        git(dir, &["init", "-q", "--bare", bare.to_str().unwrap()]);
        git(dir, &["remote", "add", "origin", bare.to_str().unwrap()]);
        bare
    }

    fn detail(st: &Mutex<State>, i: usize) -> Value {
        serde_json::from_str(st.lock().unwrap().decisions[i].detail_json.as_deref().unwrap()).unwrap()
    }

    #[test]
    fn pr_un_agente_no_puede_y_sin_confirmacion_se_rechaza() {
        let (st, id, dir) = setup("pr-rechazo", false);
        let calls = std::cell::Cell::new(0);
        let gh = |_: &str, _: &str, _: &str, _: &str, _: &str| { calls.set(calls.get() + 1); Ok("https://x/pull/1".to_string()) };
        assert_eq!(publish_pr(&st, false, &json!({ "task": id, "confirm": true }), &gh).unwrap_err(), PR_REJECT);
        assert_eq!(publish_pr(&st, true, &json!({ "task": id }), &gh).unwrap_err(), NEED_CONFIRM_PR);
        assert_eq!(calls.get(), 0);
        assert!(st.lock().unwrap().decisions.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pr_con_confirmacion_hace_push_y_registra_y_es_idempotente() {
        let (st, id, dir) = setup("pr-ok", false);
        let bare = with_remote(&dir);
        let calls = std::cell::Cell::new(0);
        let gh = |d: &str, base: &str, branch: &str, _: &str, _: &str| {
            calls.set(calls.get() + 1);
            assert_eq!((d, base, branch), (dir.to_str().unwrap(), "HEAD", "lx/t"));
            Ok("https://github.com/o/r/pull/7".to_string())
        };
        let out = publish_pr(&st, true, &json!({ "task": id, "confirm": true }), &gh).unwrap();
        assert_eq!((out["outcome"].as_str(), out["pr_url"].as_str()), (Some("created"), Some("https://github.com/o/r/pull/7")));
        // El push llegó al remoto bare.
        assert_eq!(git(&bare, &["rev-parse", "lx/t"]), git(&dir, &["rev-parse", "lx/t"]));
        let d = detail(&st, 0);
        assert_eq!(d, json!({ "outcome": "created", "branch": "lx/t", "remote": bare.to_str().unwrap(), "pr_url": "https://github.com/o/r/pull/7" }));
        { let s = st.lock().unwrap(); assert_eq!((s.decisions[0].kind.as_str(), s.decisions[0].actor.as_str()), ("pr", "human")); }
        // Repetida: no vuelve a crear, deja constancia already_exists.
        let again = publish_pr(&st, true, &json!({ "task": id, "confirm": true }), &gh).unwrap();
        assert_eq!(again["outcome"], "already_exists");
        assert_eq!(calls.get(), 1);
        assert_eq!(detail(&st, 1)["outcome"], "already_exists");
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(bare);
    }

    #[test]
    fn pr_que_gh_dice_ya_existe_y_error_de_push() {
        let (st, id, dir) = setup("pr-existe", false);
        let bare = with_remote(&dir);
        let gh = |_: &str, _: &str, _: &str, _: &str, _: &str| -> Result<String, String> {
            Err("gh pr create: a pull request for branch \"lx/t\" into branch \"master\" already exists:\nhttps://github.com/o/r/pull/3".into())
        };
        let out = publish_pr(&st, true, &json!({ "task": id, "confirm": true }), &gh).unwrap();
        assert_eq!((out["outcome"].as_str(), out["pr_url"].as_str()), (Some("already_exists"), Some("https://github.com/o/r/pull/3")));
        assert_eq!(st.lock().unwrap().task(&id).unwrap().pr_url.as_deref(), Some("https://github.com/o/r/pull/3"));
        // Sin remoto: push falla → error registrado, sin PR.
        let (st2, id2, dir2) = setup("pr-error", false);
        let ok_gh = |_: &str, _: &str, _: &str, _: &str, _: &str| Ok("https://x".to_string());
        let e = publish_pr(&st2, true, &json!({ "task": id2, "confirm": true }), &ok_gh).unwrap_err();
        assert!(e.contains("decisión #1 registrada: error"));
        assert_eq!(detail(&st2, 0), json!({ "outcome": "error", "branch": "lx/t", "remote": null, "pr_url": null }));
        assert!(st2.lock().unwrap().task(&id2).unwrap().pr_url.is_none());
        for d in [dir, bare, dir2] { let _ = std::fs::remove_dir_all(d); }
    }

    #[test]
    fn state_json_viejo_sin_decisions_se_lee() {
        let s: State = serde_json::from_str(r#"{"runs":{},"tasks":{},"messages":[],"seq":3}"#).unwrap();
        assert!(s.decisions.is_empty());
    }
}
