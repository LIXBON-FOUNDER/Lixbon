//! LXO-232 · el runtime persiste y carga su estado desde las tablas Task/Attempt, sobre un Core REAL tras el corte:
//! `run_create`, `spawn`, `done`, `review`, `integrate`, `continue`, `release`, `remove_run` y reinicio, con un repositorio
//! git real y el lanzador simulado de las pruebas. Y una caída a mitad de una mutación (subproceso que muere en un punto
//! con nombre): ni dos autoridades ni datos a medias.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use serde_json::{json, Value};

use super::agentic_cut;
use super::boot_tests::{arranca, dirs, promovida, suelta};
use super::events::{Channel, MutationContext};
use super::fsio;
use super::host::RecordingHost;
use super::pty::pruebas;
use super::spawn_cleanup_tests::{fake, g, head, s, setup, Env};
use super::state::NewTask;
use super::store_boot::StorageStatus;
use super::{Caller, Core, Orch};

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

/// `(data, core)` de un `Env` (`dirs()` deja `orch/` y `core/` junto a `repos/`).
pub(super) fn carpetas(e: &Env) -> (PathBuf, PathBuf) {
    let base = e.repo.parent().unwrap().parent().unwrap();
    (base.join("orch"), base.join("core"))
}

pub(super) fn sql<T: rusqlite::types::FromSql>(core: &Core, q: &str) -> Vec<T> {
    core.storage
        .with_store(|s| s.read(|c| Ok(c.prepare(q)?.query_map([], |r| r.get::<_, T>(0))?.collect::<Result<Vec<_>, _>>()?)).unwrap())
        .unwrap()
}

pub(super) fn uno<T: rusqlite::types::FromSql>(core: &Core, q: &str) -> T {
    sql::<T>(core, q).into_iter().next().unwrap_or_else(|| panic!("sin filas: {q}"))
}

/// El estado en memoria sin el latido de actividad (efímero: no se persiste por sí solo).
fn foto(core: &Core) -> Value {
    let mut v = serde_json::to_value(&*core.lock()).unwrap();
    for r in v["runs"].as_object_mut().unwrap().values_mut() {
        r["last_activity"] = Value::Null;
    }
    v
}

fn legacy_rev(core: &Core) -> i64 {
    uno(core, "SELECT rev FROM legacy_state WHERE id = 1")
}

/// Para el Core de `e` y arranca otro sobre las mismas carpetas (el lanzador simulado, como `setup`).
pub(super) fn reinicia(e: Env) -> Env {
    let (data, core_dir) = carpetas(&e);
    let Env { _l, core, root, run, project, repo, .. } = e;
    core.shutdown();
    suelta(core, &core_dir);
    let mut orch = Orch::default();
    Arc::get_mut(&mut orch.0).unwrap().resolver = fake;
    let core = orch.0;
    let host = RecordingHost::new();
    core.init_in(host.clone(), &data, &core_dir).unwrap();
    core.settings.lock().unwrap().enabled = true;
    Env { _l, core, root, run, project, repo, host }
}

/// Corta la base del Core en marcha (pasos 3–5b) y reinicia: desde ahí el runtime vive en las tablas.
pub(super) fn corta_y_reinicia(e: Env) -> Env {
    let (data, core_dir) = carpetas(&e);
    let r = e.core.storage.with_store(|s| agentic_cut::run(s, &core_dir, &data, "t")).unwrap().unwrap();
    assert!(matches!(r, agentic_cut::CutReport::Applied { .. }), "{r:?}");
    let e = reinicia(e);
    assert!(e.core.storage.with_store(|s| s.runtime_on_tables().unwrap()).unwrap(), "tras el corte el runtime persiste en las tablas");
    e
}

pub(super) fn como(id: &str) -> Caller {
    Caller::Agent(Some(id.to_string()))
}

fn rama(core: &Core, id: &str) -> (String, String) {
    let t = core.lock().task(id).unwrap().clone();
    (t.worktree.expect("worktree"), t.branch.expect("rama"))
}

// ---------------------------------------------------------------------------------------------
// E2E
// ---------------------------------------------------------------------------------------------

#[test]
fn tras_el_corte_el_runtime_persiste_en_las_tablas_y_un_reinicio_carga_lo_mismo() {
    let e = setup("rt-e2e");
    let (data, _) = carpetas(&e);
    let antes = foto(&e.core);
    let e = corta_y_reinicia(e);
    let congelada = legacy_rev(&e.core);
    let espejo = std::fs::read(data.join("state.json")).unwrap();
    assert_eq!(foto(&e.core), antes, "el estado cargado de las tablas es el de antes del corte");
    let cwd = s(&e.repo);

    // run_create: un Run nuevo con su raíz (persona desde la interfaz, en el mismo repositorio).
    let r2 = e.core.rpc_via(Channel::Ui, Caller::User, &cwd, "run_create", &json!({ "objective": "segundo run" })).unwrap();
    let (run2, root2) = (r2["run"].as_str().unwrap().to_string(), r2["task"].as_str().unwrap().to_string());
    assert_eq!(uno::<String>(&e.core, &format!("SELECT status FROM attempts WHERE id = '{root2}-a1'")), "running");
    assert_eq!(uno::<String>(&e.core, &format!("SELECT origin FROM tasks WHERE id = '{root2}'")), "core", "con Project es una Task del Core");

    // spawn: pendiente → la persona aprueba → Task + Attempt + Worktree, en marcha.
    let pid = e.spawn(false);
    e.aprobar(&pid);
    let hija = e.hijas().into_iter().next().expect("la hija nació");
    let (wt, branch) = rama(&e.core, &hija);
    assert_eq!(uno::<String>(&e.core, &format!("SELECT worktree_id FROM attempts WHERE id = '{hija}-a1'")), format!("wt-{hija}-a1"));
    assert_eq!(uno::<String>(&e.core, &format!("SELECT state FROM worktrees WHERE task_id = '{hija}'")), "active");
    let term = pruebas::lanza(&pruebas::carpeta(&format!("rt-{hija}")), false).expect("terminal real");
    e.core.register_term(&hija, term).unwrap();

    // La hija trabaja: una fase y un commit en su rama, y entrega con lxo done.
    e.core.rpc(como(&hija), "", "phase", &json!({ "name": "explorar", "done": true, "note": "listo" })).unwrap();
    std::fs::write(Path::new(&wt).join("b.txt"), "trabajo\n").unwrap();
    g(Path::new(&wt), &["add", "."]);
    g(Path::new(&wt), &["commit", "-qm", "trabajo"]);
    let done = e.core.rpc(como(&hija), "", "done", &json!({ "summary": "hecho", "report_text": "# Informe\n\nhecho\n" })).unwrap();
    assert_eq!(done["status"], "done");
    let largo = e.core.rpc(como(&root2), "", "done", &json!({ "summary": "x".repeat(2001) })).unwrap_err();
    assert!(largo.contains("2000"), "{largo}");

    // review + integrate sobre el HEAD de la rama.
    let head_commit = super::review::branch_head(&cwd, &branch).unwrap();
    assert_eq!(e.core.review_from_ui(&hija, "accepted", &head_commit, None, true).unwrap()["outcome"], "recorded");
    assert_eq!(e.core.integrate_from_ui(&hija, true, false, None).unwrap()["outcome"], "merged");
    assert_eq!(uno::<i64>(&e.core, &format!("SELECT integrated FROM attempts WHERE id = '{hija}-a1'")), 1);
    assert_eq!(uno::<String>(&e.core, &format!("SELECT verdict || '/' || status || '/' || attempt_id FROM reviews")), format!("accepted/active/{hija}-a1"));

    // continue: un seguimiento es el Attempt 2, con su encargo, el mismo Worktree y las fases de antes a la vista.
    e.core.rpc(como(&e.root), "", "continue", &json!({ "task": hija, "spec": "otra vuelta" })).unwrap();
    let a2: (String, String, String) = e
        .core
        .storage
        .with_store(|s| s.read(|c| Ok(c.query_row(&format!("SELECT status, instruction, worktree_id FROM attempts WHERE id = '{hija}-a2'"), [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?)).unwrap())
        .unwrap();
    assert_eq!(a2, ("running".into(), "otra vuelta".into(), format!("wt-{hija}-a1")));
    assert_eq!(uno::<String>(&e.core, &format!("SELECT status FROM attempts WHERE id = '{hija}-a1'")), "done", "el Attempt anterior no se reabre");
    assert_eq!(e.core.lock().task(&hija).unwrap().phases.len(), 1);
    e.core.rpc(como(&hija), "", "done", &json!({ "summary": "segunda", "report_text": "# Dos\n" })).unwrap();

    // release: se mata la terminal, se quita el Worktree (la rama se conserva: el seguimiento no está integrado).
    let rel = e.core.rpc(como(&e.root), "", "release", &json!({ "task": hija })).unwrap();
    assert_eq!(rel["worktree_removed"], true);
    assert_eq!(uno::<String>(&e.core, &format!("SELECT state || '/' || branch_kept FROM worktrees WHERE task_id = '{hija}'")), "removed/1");
    assert_eq!(e.core.lock().task(&hija).unwrap().cwd, cwd, "la Task vuelve a su repositorio");

    // Una decisión del segundo Run (la última) se va con él: su id no se reutiliza después.
    let revision = |_: &str| json!({ "decision": "rejected", "base_commit": null, "base_source": null, "head_commit": head_commit, "comment": null });
    let retirada = e.core.mutate_as(&MutationContext::person(Channel::Ui), |tx| tx.record_decision(&root2, "review", "human", &revision(&root2))).unwrap();
    // remove_run: el segundo Run desaparece del estado; en las tablas queda descartado (la historia no se borra).
    e.core.rpc_via(Channel::Ui, Caller::User, "", "remove_run", &json!({ "run": run2 })).unwrap();
    assert!(!e.core.lock().runs.contains_key(&run2));
    assert_eq!(uno::<String>(&e.core, &format!("SELECT intent FROM tasks WHERE id = '{root2}'")), "discarded");
    assert_eq!(uno::<String>(&e.core, &format!("SELECT status FROM attempts WHERE id = '{root2}-a1'")), "stopped");

    // Las tablas tienen la historia; legacy_state y state.json no se han vuelto a escribir.
    assert_eq!(sql::<String>(&e.core, &format!("SELECT kind FROM artifacts WHERE attempt_id LIKE '{hija}-%' ORDER BY attempt_id, kind")), vec!["report", "report"]);
    assert_eq!(sql::<String>(&e.core, &format!("SELECT kind || ':' || attempt_id FROM decisions WHERE task_id = '{hija}' ORDER BY id")), vec![format!("review:{hija}-a1"), format!("merge:{hija}-a1")]);
    assert!(uno::<i64>(&e.core, &format!("SELECT count(*) FROM thread_messages WHERE thread_id = 'th-{hija}'")) >= 2, "las fases y entregas llegan al coordinador por el Thread");
    assert_eq!(legacy_rev(&e.core), congelada, "legacy_state está congelado");
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), espejo, "state.json ya no se escribe (ADR D4)");

    // Reinicio: el estado cargado es el que había en memoria.
    let antes = foto(&e.core);
    let e = reinicia(e);
    assert!(matches!(e.core.storage_status(), StorageStatus::Ready(_)));
    assert_eq!(foto(&e.core), antes, "el reinicio carga de las tablas exactamente el estado confirmado");
    assert_eq!(legacy_rev(&e.core), congelada);

    // Y sigue funcionando: una decisión nueva no reutiliza el id de la que se retiró con su Run.
    assert!(e.core.lock().decisions.iter().all(|d| d.id < retirada), "la retirada ya no está en memoria");
    let nueva = e.core.mutate_as(&MutationContext::person(Channel::Ui), |tx| tx.record_decision(&hija, "review", "human", &revision(&hija))).unwrap();
    assert_eq!(nueva, retirada + 1);
    assert_eq!(uno::<String>(&e.core, &format!("SELECT attempt_id FROM decisions WHERE id = {nueva}")), format!("{hija}-a2"), "va al Attempt actual");
}

#[test]
fn al_arrancar_los_attempts_huerfanos_pasan_a_exited_y_los_externos_no() {
    let e = setup("rt-huerfanos");
    let e = corta_y_reinicia(e);
    let pid = e.spawn(false);
    e.aprobar(&pid);
    let hija = e.hijas().into_iter().next().unwrap();
    assert_eq!(e.core.lock().task(&hija).unwrap().status, super::state::Status::Running);
    let e = reinicia(e);
    assert_eq!(e.core.lock().task(&hija).unwrap().status, super::state::Status::Exited);
    assert_eq!(uno::<String>(&e.core, &format!("SELECT status FROM attempts WHERE id = '{hija}-a1'")), "exited");
    assert!(uno::<Option<i64>>(&e.core, &format!("SELECT ended_at FROM attempts WHERE id = '{hija}-a1'")).is_some());
    assert_eq!(uno::<String>(&e.core, &format!("SELECT status FROM attempts WHERE id = '{}-a1'", e.root)), "running", "el coordinador externo no es un huérfano");
}

#[test]
fn una_mutacion_que_las_tablas_no_representan_no_se_confirma_y_no_deja_rastro() {
    let e = setup("rt-rechazo");
    let e = corta_y_reinicia(e);
    let (rev0, ev0) = (e.core.storage.confirmed_rev().unwrap(), head(&e.core));
    // La selección de un Attempt (su agente) es identidad: cambiarla en memoria no tiene representación.
    let root = e.root.clone();
    let r = e.core.mutate(|tx| {
        tx.task_mut(&root)?.agent = "otro".into();
        tx.post(&root, &root, super::state::Kind::Note, "nota", None)?;
        Ok(())
    });
    assert!(matches!(&r, Err(super::mutation::MutateError::Rejected(m)) if m.contains("selección")), "{r:?}");
    assert_eq!(e.core.health(), super::mutation::Health::Normal, "se rechaza la mutación, no se degrada el Core");
    assert_eq!(e.core.lock().task(&root).unwrap().agent, "coordinador", "la memoria no cambió");
    assert_eq!((e.core.storage.confirmed_rev().unwrap(), head(&e.core)), (rev0, ev0), "ni revisión ni eventos");
    assert_eq!(uno::<i64>(&e.core, "SELECT count(*) FROM thread_messages"), 0, "ni el mensaje de la misma mutación");
    // Y la siguiente mutación representable se confirma.
    e.core.mutate(|tx| tx.post(&root, &root, super::state::Kind::Note, "nota", None).map(|_| ())).unwrap();
    assert_eq!(uno::<i64>(&e.core, "SELECT count(*) FROM thread_messages"), 1);
}

#[test]
fn una_caida_a_mitad_de_una_mutacion_no_deja_dos_autoridades_ni_datos_a_medias() {
    for punto in ["runtime_in_tx", "runtime_events_in_tx"] {
        let (_l, data, core_dir) = dirs();
        promovida(&data, &core_dir, "previa");
        {
            let (c, _h, r) = arranca(&data, &core_dir);
            r.unwrap();
            c.storage.with_store(|s| agentic_cut::run(s, &core_dir, &data, "t")).unwrap().unwrap();
            suelta(c, &core_dir);
        }
        let (rev0, legacy0, espejo0, tareas0) = {
            let (c, _h, r) = arranca(&data, &core_dir);
            r.unwrap();
            let v = (c.storage.confirmed_rev().unwrap(), legacy_rev(&c), std::fs::read(data.join("state.json")).unwrap(), c.lock().tasks.len());
            suelta(c, &core_dir);
            v
        };
        muere_en(&data, punto);
        let (c, _h, r) = arranca(&data, &core_dir);
        r.unwrap();
        assert_eq!(c.storage.confirmed_rev().unwrap(), rev0, "{punto}: la mutación no se confirmó");
        assert_eq!(c.lock().tasks.len(), tareas0, "{punto}: ni la Task ni el Run a medias");
        assert_eq!(uno::<i64>(&c, "SELECT count(*) FROM tasks"), tareas0 as i64);
        assert_eq!(uno::<i64>(&c, "SELECT count(*) FROM events WHERE kind = 'run.created'"), 0, "{punto}: ni sus eventos");
        assert_eq!(legacy_rev(&c), legacy0, "{punto}: legacy_state sigue congelado: una sola autoridad");
        assert_eq!(std::fs::read(data.join("state.json")).unwrap(), espejo0, "{punto}: state.json no vuelve a escribirse");
        // Y la siguiente mutación se confirma con normalidad.
        c.mutate(|tx| {
            tx.create_run("tras la caída", nt("tras la caída"));
            Ok(())
        })
        .unwrap();
        assert_eq!(c.storage.confirmed_rev().unwrap(), Some(rev0.unwrap() + 1));
        suelta(c, &core_dir);
    }
}

fn nt(title: &str) -> NewTask {
    NewTask {
        agent: "coordinador".into(), model: None, effort: None, role: None, title: title.into(), spec: "s".into(), repo: "r".into(),
        cwd: "c".into(), branch: None, base: None, worktree: None, external: true,
    }
}

/// Hijo del arnés: arranca sobre la base cortada y muere a mitad de una mutación (`LIXBON_CRASH_AT`).
#[test]
#[ignore = "lo lanza el arnés como subproceso con LIXBON_CRASH_AT"]
fn hijo_del_arnes_tablas() {
    let Some(base) = std::env::var_os("LIXBON_CRASH_DIR") else { return };
    let base = PathBuf::from(base);
    let (data, core) = (base.join("orch"), base.join("core"));
    fsio::set_test_data_dir(&data);
    let c = Orch::default().0;
    c.init_in(RecordingHost::new(), &data, &core).unwrap();
    let _ = c.mutate(|tx| {
        tx.create_run("a medias", nt("a medias"));
        Ok(())
    });
}

fn muere_en(data: &Path, punto: &str) {
    let base = data.parent().unwrap();
    let estado = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "orch::runtime_tables_tests::hijo_del_arnes_tablas", "--ignored", "--nocapture", "--test-threads=1"])
        .env("LIXBON_CRASH_DIR", base)
        .env("LIXBON_CRASH_AT", punto)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("no se pudo lanzar el hijo del arnés");
    assert!(!estado.success(), "el hijo debía morir en «{punto}»");
}

// ---------------------------------------------------------------------------------------------
// Casos del mapeo que el E2E no recorre
// ---------------------------------------------------------------------------------------------

/// Una Task con su Run, lista para mutar sobre las tablas.
pub(super) fn con_hija(nombre: &str) -> (Env, String) {
    let e = corta_y_reinicia(setup(nombre));
    let pid = e.spawn(false);
    e.aprobar(&pid);
    let hija = e.hijas().into_iter().next().unwrap();
    (e, hija)
}

#[test]
fn la_sesion_y_el_modelo_declarados_tras_salir_el_proceso_se_guardan_y_la_rama_borrada_despues_tambien() {
    let (e, hija) = con_hija("rt-tardio");
    let cwd = s(&e.repo);
    e.core.mutate(|tx| tx.close(&hija, super::state::Status::Exited, "salió").map(|_| ())).unwrap();
    // Codex declara su sesión y su modelo en el rollout, que se lee después de salir.
    e.core
        .mutate(|tx| {
            let t = tx.task_mut(&hija)?;
            t.session_ref = Some("rollout-x.jsonl".into());
            t.session_match = Some("session_id".into());
            t.model_effective = Some("gpt-x".into());
            t.model_source = Some("session_declared".into());
            Ok(())
        })
        .unwrap();
    assert_eq!(uno::<String>(&e.core, &format!("SELECT status FROM provider_sessions WHERE task_id = '{hija}'")), "idle", "nace en espera: su Attempt ya terminó");
    assert_eq!(uno::<String>(&e.core, &format!("SELECT model_effective FROM attempts WHERE id = '{hija}-a1'")), "gpt-x");
    // Una integración tras salir (la rama de una tarea sin informe) y, después, liberar y borrar la rama.
    e.core.mutate(|tx| { tx.task_mut(&hija)?.merged = true; Ok(()) }).unwrap();
    e.core.rpc(como(&e.root), "", "release", &json!({ "task": hija })).unwrap();
    assert_eq!(uno::<String>(&e.core, &format!("SELECT state || '/' || branch_kept || '/' || removed_reason FROM worktrees WHERE task_id = '{hija}'")), "removed/0/integrated");
    assert!(e.core.lock().task(&hija).unwrap().branch.is_none(), "git branch -d la borró");
    let antes = foto(&e.core);
    let e = reinicia(e);
    assert_eq!(foto(&e.core), antes);
    assert_eq!(e.core.lock().task(&hija).unwrap().cwd, cwd);
}

#[test]
fn una_sesion_atada_por_carpeta_y_hora_no_es_un_vinculo_d3() {
    let (e, hija) = con_hija("rt-d3");
    e.core
        .mutate(|tx| {
            let t = tx.task_mut(&hija)?;
            t.session_ref = Some("rollout-y.jsonl".into());
            t.session_match = Some("cwd_time".into());
            t.model_source = Some("session_declared".into());
            Ok(())
        })
        .unwrap();
    assert_eq!(uno::<i64>(&e.core, "SELECT count(*) FROM provider_sessions"), 0);
    assert_eq!(uno::<String>(&e.core, &format!("SELECT model_source FROM attempts WHERE id = '{hija}-a1'")), "unknown");
    let e = reinicia(e);
    let t = e.core.lock().task(&hija).unwrap().clone();
    assert_eq!((t.session_ref, t.session_match, t.model_source.as_deref()), (None, None, Some("unknown")), "lo mismo que hace el corte (D3)");
}

#[test]
fn preguntas_respuestas_esperas_y_bloqueos_de_entorno_van_a_sus_tablas() {
    let (e, hija) = con_hija("rt-esperas");
    let q = e.core.rpc(como(&hija), "", "ask", &json!({ "question": "¿sigo?" })).unwrap()["question"].as_u64().unwrap();
    assert_eq!(uno::<String>(&e.core, &format!("SELECT status FROM attempts WHERE id = '{hija}-a1'")), "waiting");
    e.core.mutate(|tx| tx.await_terminal_approval(&hija, 9_999_999_999_999).map(|_| ())).unwrap();
    assert_eq!(uno::<String>(&e.core, &format!("SELECT status FROM attempts WHERE id = '{hija}-a1'")), "awaiting_terminal_approval");
    e.core.rpc(como(&e.root), "", "reply", &json!({ "question": q, "answer": "sí" })).unwrap();
    assert_eq!(uno::<String>(&e.core, &format!("SELECT status FROM attempts WHERE id = '{hija}-a1'")), "running");
    e.core.mutate(|tx| tx.ask(&hija, "¿y ahora?").map(|_| ())).unwrap();
    e.core.mutate(|tx| tx.await_terminal_approval(&hija, 9_999_999_999_999).map(|_| ())).unwrap();
    // De esperar en la terminal a esperar una respuesta se pasa por `running` (el ciclo de vida no tiene ese par).
    e.core.mutate(|tx| tx.ask(&hija, "¿otra?").map(|_| ())).unwrap();
    assert_eq!(uno::<String>(&e.core, &format!("SELECT status FROM attempts WHERE id = '{hija}-a1'")), "waiting");
    e.core.mutate(|tx| { tx.set_env_block("claude", "explorar", super::agents::EnvBlock::CliMissing); Ok(()) }).unwrap();
    assert_eq!(uno::<String>(&e.core, "SELECT scope || ':' || cause FROM env_blocks"), "claude/explorar:cli_missing");
    let leidos: Vec<i64> = sql(&e.core, "SELECT read FROM thread_messages ORDER BY id");
    assert!(!leidos.is_empty());
    let antes = foto(&e.core);
    let e = reinicia(e);
    // El reinicio deja huérfana a la hija (exited); el resto es lo confirmado.
    let mut despues = foto(&e.core);
    let mut esperado = antes;
    for v in [&mut despues, &mut esperado] {
        v["tasks"][&hija]["status"] = Value::Null;
        v["tasks"][&hija]["updated"] = Value::Null;
        v["tasks"][&hija]["approval_deadline"] = Value::Null;
        v["messages"].as_array_mut().unwrap().retain(|m| m["kind"] != "exited");
        v["seq"] = Value::Null;
    }
    assert_eq!(despues, esperado);
}
