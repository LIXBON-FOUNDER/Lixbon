use super::*;
use std::path::Path;
use state::NewTask;

#[test]
fn el_archivo_de_descubrimiento_solo_lo_lee_su_propietario() {
    let dir = std::env::temp_dir().join(format!("lixbon-priv-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let p = dir.join("orch.json");
    write_private_json(&p, &json!({ "token": "secreto" })).unwrap();
    assert!(std::fs::read_to_string(&p).unwrap().contains("secreto"));
    assert!(!p.with_extension("tmp").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
    }
    #[cfg(windows)]
    {
        let out = std::process::Command::new("icacls").arg(&p).output().unwrap();
        let acl = String::from_utf8_lossy(&out.stdout).to_string();
        assert_eq!(acl.matches(":(").count(), 1, "solo el propietario debe figurar en la ACL:\n{acl}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn el_servidor_de_lxo_no_conoce_la_integracion() {
    // server.rs despacha todo por Core::rpc con Caller::Agent; orch_call de la UI
    // usa el mismo rpc. Ninguno de los dos puede integrar.
    let core = Orch::default().0;
    core.settings.lock().unwrap().enabled = true;
    for caller in [Caller::Agent(None), Caller::Agent(Some("t1".into())), Caller::User] {
        let e = core.rpc(caller, "", "integrate", &json!({ "task": "t1", "confirm": true })).unwrap_err();
        assert_eq!(e, integration::AGENT_REJECT);
    }
    let e = core.rpc(Caller::Agent(None), "", "merge", &json!({ "task": "t1" })).unwrap_err();
    assert_eq!(e, integration::AGENT_REJECT);
    for caller in [Caller::Agent(Some("t1".into())), Caller::User] {
        assert_eq!(core.rpc(caller, "", "pr", &json!({ "task": "t1" })).unwrap_err(), integration::PR_REJECT);
    }
    for c in ["publish_pr", "orch_publish_pr"] {
        assert_eq!(core.rpc(Caller::Agent(None), "", c, &json!({})).unwrap_err(), format!("Comando desconocido: {c}"));
    }
    assert!(!include_str!("server.rs").contains("integrate") && !include_str!("server.rs").contains("publish"));
}

/// Invoca orch_integrate por el IPC de Tauri (MockRuntime), con el JSON que
/// mandaría la webview, para comprobar cómo llegan los argumentos.
#[test]
fn la_webview_envia_accept_moved_target_en_snake_case() {
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;

    let git = |dir: &Path, args: &[&str]| {
        let o = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(o.status.success(), "{args:?}");
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    };
    let dir = std::env::temp_dir().join(format!("lxo-ipc-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    for a in [&["init", "-q", "-b", "master"][..], &["config", "user.name", "t"], &["config", "user.email", "t@t"]] { git(&dir, a); }
    std::fs::write(dir.join("a.txt"), "base\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-qm", "base"]);
    let base = git(&dir, &["rev-parse", "HEAD"]);
    git(&dir, &["checkout", "-qb", "lx/t"]);
    std::fs::write(dir.join("b.txt"), "rama\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-qm", "rama"]);
    git(&dir, &["checkout", "-q", "master"]);
    std::fs::write(dir.join("c.txt"), "manual\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-qm", "manual"]);
    let moved = git(&dir, &["rev-parse", "HEAD"]);

    let orch = Orch::default();
    let id = {
        let cwd = dir.to_string_lossy().into_owned();
        let nt = |branch: Option<&str>| NewTask { agent: "claude".into(), model: None, effort: None, role: None, title: "x".into(),
            spec: String::new(), repo: cwd.clone(), cwd: cwd.clone(), branch: branch.map(String::from), base: None, worktree: None, external: false };
        let mut st = orch.0.lock_unpersisted();
        let (_, root) = st.create_run("obj", nt(None));
        let id = st.add_child(&root, 2, nt(Some("lx/t"))).unwrap();
        st.done(&id, true, "ok", vec![], None).unwrap();
        st.task_mut(&id).unwrap().base_commit = Some(base.clone());
        id
    };
    // Integrar exige la revisión aceptada sobre el HEAD de la rama (review.rs).
    orch.0.lock_unpersisted().record_decision(&id, "review", "human", &json!({ "decision": "accepted", "head_commit": git(&dir, &["rev-parse", "lx/t"]) }));
    let app = mock_builder().manage(orch).invoke_handler(tauri::generate_handler![orch_integrate, orch_publish_pr])
        .build(mock_context(noop_assets())).unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let invoke = |body: Value| {
        get_ipc_response(&webview, InvokeRequest {
            cmd: "orch_integrate".into(), callback: CallbackFn(0), error: CallbackFn(1),
            url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(), body: InvokeBody::Json(body),
            headers: Default::default(), invoke_key: INVOKE_KEY.to_string(),
        }).map(|r| r.deserialize::<Value>().unwrap())
    };
    // En camelCase (lo que Tauri esperaría por defecto) el campo ya no se reconoce:
    // llega como None y el destino movido no se acepta.
    let out = invoke(json!({ "task": id, "confirm": true, "acceptMovedTarget": moved })).unwrap();
    assert_eq!(out["outcome"], "target_moved");
    // En snake_case llega y se integra contra el commit aceptado.
    let out = invoke(json!({ "task": id, "confirm": true, "accept_moved_target": moved })).unwrap();
    assert_eq!((out["outcome"].as_str(), out["accepted_moved_target"].as_bool()), (Some("merged"), Some(true)), "{out}");
    assert_eq!(git(&dir, &["rev-parse", "HEAD^1"]), moved);
    // Sin confirm (campo obligatorio) Tauri rechaza la llamada antes de llegar al host.
    assert!(invoke(json!({ "task": id })).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

/// Las dos listas de rechazo, cada una por separado, por orch_call (User) y
/// por el camino del servidor HTTP (Caller::Agent, mismo Core::rpc).
#[test]
fn revisar_y_diff_de_revision_no_llegan_por_orch_call_ni_http() {
    let core = Orch::default().0;
    core.settings.lock().unwrap().enabled = true;
    let callers = || [Caller::Agent(None), Caller::Agent(Some("t1".into())), Caller::User];
    for c in review::HUMAN_DECISION_CMDS {
        for caller in callers() {
            let e = core.rpc(caller, "", c, &json!({ "task": "t1", "task_id": "t1", "confirm": true })).unwrap_err();
            assert!([integration::AGENT_REJECT, integration::PR_REJECT, review::REVIEW_REJECT].contains(&e.as_str()), "{c}: {e}");
        }
    }
    assert_eq!(core.rpc(Caller::User, "", "review", &json!({})).unwrap_err(), review::REVIEW_REJECT);
    for c in review::CLOSED_READ_CMDS {
        for caller in callers() {
            assert_eq!(core.rpc(caller, "", c, &json!({ "task_id": "t1" })).unwrap_err(), review::TASK_DIFF_CLOSED);
        }
    }
    for c in ["orch_review_task", "orch_task_diff", "review_task"] {
        assert_eq!(core.rpc(Caller::User, "", c, &json!({})).unwrap_err(), format!("Comando desconocido: {c}"));
    }
    let server = include_str!("server.rs");
    assert!(server.contains("closed_to_agents"));
    assert!(!server.contains("review_task") && !server.contains("task_diff_from_ui"));
}

/// orch_task_diff y orch_review_task por el IPC de Tauri, en snake_case.
#[test]
fn la_webview_envia_task_id_y_head_commit_en_snake_case() {
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY};
    use tauri::webview::InvokeRequest;
    let (st, id, dir, _) = review::tests::setup("ipc");
    let orch = Orch::default();
    *orch.0.lock_unpersisted() = st.into_inner().unwrap();
    let core = orch.0.clone();
    let host = host::RecordingHost::new();
    core.set_host(host.clone());
    let app = mock_builder().manage(orch).invoke_handler(tauri::generate_handler![orch_task_diff, orch_review_task])
        .build(mock_context(noop_assets())).unwrap();
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
    let invoke = |cmd: &str, body: Value| {
        get_ipc_response(&webview, InvokeRequest {
            cmd: cmd.into(), callback: CallbackFn(0), error: CallbackFn(1),
            url: if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" }.parse().unwrap(), body: InvokeBody::Json(body),
            headers: Default::default(), invoke_key: INVOKE_KEY.to_string(),
        }).map(|r| r.deserialize::<Value>().unwrap())
    };
    assert!(invoke("orch_task_diff", json!({ "taskId": id })).is_err());
    let d = invoke("orch_task_diff", json!({ "task_id": id })).unwrap();
    let h = d["head_commit"].as_str().unwrap().to_string();
    assert_eq!(d["base_source"], "recorded");
    let nf = invoke("orch_task_diff", json!({ "task_id": "nadie" })).unwrap_err();
    assert!(format!("{nf:?}").contains("not_found"), "{nf:?}");
    assert!(invoke("orch_review_task", json!({ "taskId": id, "decision": "accepted", "headCommit": h, "confirm": true })).is_err());
    assert!(invoke("orch_review_task", json!({ "task_id": id, "decision": "accepted", "head_commit": h })).is_err(), "confirm obligatorio");
    let out = invoke("orch_review_task", json!({ "task_id": id, "decision": "accepted", "head_commit": h, "comment": "ok", "confirm": true })).unwrap();
    assert_eq!(out["outcome"], "recorded");
    let ev: Vec<_> = host.events().into_iter().filter(|(n, _)| n == review::EV_REVIEWED).collect();
    assert_eq!(ev.len(), 1);
    assert_eq!(ev[0].1, json!({ "task_id": id, "decision": "accepted", "head_commit": h, "at": out["at"] }));
    let snap = core.snapshot();
    assert_eq!(snap["tasks"][&id]["last_review"]["decision"], "accepted");
    assert_eq!(snap["tasks"][&id]["head_commit"].as_str(), Some(h.as_str()));
    let root = core.lock().task(&id).unwrap().parent.clone().unwrap();
    assert_eq!(snap["tasks"][&root]["head_commit"], Value::Null);
    assert_eq!(snap["tasks"][&root]["last_review"], Value::Null);
    let moved = invoke("orch_review_task", json!({ "task_id": id, "decision": "rejected", "head_commit": "0000", "confirm": true })).unwrap();
    assert_eq!((moved["outcome"].as_str(), moved["found_commit"].as_str()), (Some("head_moved"), Some(h.as_str())));
    assert_eq!(host.events_named(review::EV_REVIEWED).len(), 1);
    let _ = std::fs::remove_dir_all(dir);
}

/// git corre sin el lock del estado. Determinista: la snapshot avisa al
/// arrancar su fase git y espera; la prueba hace try_lock() justo ahí (tiene
/// que funcionar) y recién entonces la deja seguir.
#[test]
fn la_snapshot_no_corre_git_con_el_lock_tomado() {
    let (st, id, dir, _) = review::tests::setup("lock-snapshot");
    let core = Orch::default().0;
    *core.lock_unpersisted() = st.into_inner().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    *core.snapshot_git_hook.lock().unwrap() = Some((tx, barrier.clone()));
    let worker = {
        let core = core.clone();
        std::thread::spawn(move || core.snapshot())
    };
    rx.recv().expect("la snapshot no llegó a la fase git");
    assert!(core.state_is_free(), "el lock del estado sigue tomado en la fase git");
    barrier.wait();
    let snap = worker.join().unwrap();
    *core.snapshot_git_hook.lock().unwrap() = None;
    assert!(snap["tasks"][&id]["head_commit"].as_str().is_some_and(|h| h.len() == 40));
    assert!(snap["integrate_into"][&id]["branch"].as_str() == Some("master"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn la_snapshot_trae_la_ultima_integracion_de_cada_tarea() {
    let orch = Orch::default();
    let id = {
        let nt = || NewTask { agent: "claude".into(), model: None, effort: None, role: None, title: "x".into(), spec: String::new(),
            repo: ".".into(), cwd: ".".into(), branch: None, base: None, worktree: None, external: false };
        let mut st = orch.0.lock_unpersisted();
        let (_, root) = st.create_run("obj", nt());
        st.add_child(&root, 2, nt()).unwrap()
    };
    let li = |o: &Orch| o.0.snapshot()["tasks"][&id]["last_integration"].clone();
    assert_eq!(li(&orch), Value::Null);
    orch.0.lock_unpersisted().record_decision(&id, "merge", "human", &json!({ "outcome": "conflict", "conflict": ["a.txt"] }));
    assert_eq!((li(&orch)["outcome"].as_str(), li(&orch)["result_commit"].clone()), (Some("conflict"), Value::Null));
    std::thread::sleep(Duration::from_millis(5));
    orch.0.lock_unpersisted().record_decision(&id, "merge", "human", &json!({ "outcome": "merged", "result_commit": "abc123" }));
    orch.0.lock_unpersisted().record_decision(&id, "spawn", "human", &json!({ "outcome": "approved" }));
    let v = li(&orch);
    assert_eq!((v["outcome"].as_str(), v["result_commit"].as_str()), (Some("merged"), Some("abc123")));
    assert!(v["at"].as_u64().is_some());
    assert!(orch.0.snapshot().get("decisions").is_none());
}

#[test]
fn la_decision_persiste_en_state_json_y_sobrevive_recarga() {
    let dir = std::env::temp_dir().join(format!("lxo-decisiones-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("state.json");
    let mut st = State::default();
    let id = st.record_decision("t2", "merge", "human", &json!({ "outcome": "conflict", "conflict": ["a.txt"] }));
    write_json(&path, &st).unwrap();
    let back: State = read_json(&path).unwrap();
    assert_eq!(back.decisions, st.decisions);
    assert_eq!(back.decisions[0].id, id);
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(raw["decisions"][0]["actor"], "human");
    let _ = std::fs::remove_dir_all(dir);
}

/// Frontera del host: el dominio de `orch/` no importa Tauri. Solo el adaptador
/// (`tauri_host.rs`), los comandos IPC (`commands.rs`) y el código de pruebas lo
/// conocen. Si esta prueba falla, la dependencia nueva debe pasar por `Host`
/// (ver `host.rs`) en vez de importarse en el dominio.
#[test]
fn el_dominio_del_core_no_importa_tauri() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    let permitidos = ["tauri_host.rs", "commands.rs", "tests.rs"];
    let mut revisados = 0;
    for entrada in std::fs::read_dir(&dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre.ends_with("_tests.rs") || permitidos.contains(&nombre.as_str()) {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        // El código de pruebas de cada archivo (módulo `tests` en línea) puede usar el mock de Tauri.
        let dominio = texto.split("mod tests {").next().unwrap();
        for (n, l) in dominio.lines().enumerate() {
            let l = l.trim_start();
            if l.starts_with("//") {
                continue;
            }
            for prohibido in ["tauri::", "tauri_plugin", "AppHandle"] {
                assert!(!l.contains(prohibido), "{nombre}:{}: el dominio no puede depender de Tauri ({prohibido}); usa `Host`", n + 1);
            }
        }
        revisados += 1;
    }
    assert!(revisados >= 20, "la prueba debe revisar los módulos del dominio, revisó {revisados}");
}

// ---- C1: el Core y el almacén SQLite ----
//
// Cada prueba usa carpetas propias (`orch/` para state.json y `core/` para el
// almacén): nunca el ~/.lixbon real ni la carpeta temporal compartida.

use super::host::RecordingHost;
use super::store_boot::{OpenStoreError, StorageStatus};
use crate::store::{ImportOutcome, SnapshotCheck};

static N_C1: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Borra la carpeta de la prueba al salir (declararla ANTES que los Core: se suelta la última).
struct LimpiaC1(std::path::PathBuf);

impl Drop for LimpiaC1 {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `(limpieza, data, core)`: `data` = `.lixbon/orch` de la prueba y `core` = `.lixbon/core`.
fn dirs_c1() -> (LimpiaC1, std::path::PathBuf, std::path::PathBuf) {
    let n = N_C1.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let base = std::env::temp_dir().join(format!("lixbon-c1-{}-{n}-{nanos}", std::process::id()));
    let (data, core) = (base.join("orch"), base.join("core"));
    std::fs::create_dir_all(&data).unwrap();
    (LimpiaC1(base), data, core)
}

fn nueva_tarea(core: &Core, external: bool) -> String {
    core.lock_unpersisted()
        .create_run("obj", NewTask {
            agent: "coordinador".into(), model: None, effort: None, role: None, title: "t".into(), spec: "s".into(),
            repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external,
        })
        .1
}

/// Deja en `data/state.json` el estado actual de `core` (como lo dejaría una sesión anterior).
fn escribe_state_de(core: &Core, data: &Path) {
    write_json(&data.join("state.json"), &*core.lock()).unwrap();
}

fn snapshot_en_el_almacen(core: &Core) -> (i64, String, Option<String>) {
    core.storage
        .with_store(|s| {
            let fila = s.legacy_state().unwrap().unwrap();
            (fila.rev, fila.doc, s.meta("legacy_import_sha256").unwrap())
        })
        .expect("el almacén debería estar abierto")
}

#[test]
fn open_store_abre_el_almacen_e_importa_el_estado_adoptado() {
    let (_limpia, data, core_dir) = dirs_c1();
    let core = Orch::default().0;
    nueva_tarea(&core, false);
    escribe_state_de(&core, &data);
    let rep = core.open_store(&core_dir, &data.join("state.json")).unwrap();
    assert!(matches!(rep.import, ImportOutcome::Imported { .. }), "{:?}", rep.import);
    assert_eq!(rep.matches_adopted, Some(true), "la instantánea es el estado que adoptó el Core");
    assert!(matches!(rep.snapshot, SnapshotCheck::Verified { rev: 1, .. }));
    assert_eq!(core.storage_status(), StorageStatus::Ready(rep));
    assert!(core_dir.join("lixbon.db").exists() && core_dir.join("core.lock").exists());
    assert!(
        matches!(core.open_store(&core_dir, &data.join("state.json")), Err(OpenStoreError::AlreadyOpened)),
        "un mismo Core no abre el almacén dos veces"
    );
}

#[test]
fn init_deja_la_instantanea_igual_al_state_json_que_reescribe() {
    let (_limpia, data, core_dir) = dirs_c1();
    // Una sesión anterior dejó una tarea en marcha.
    let previa = Orch::default().0;
    nueva_tarea(&previa, false);
    escribe_state_de(&previa, &data);
    assert!(read_json::<State>(&data.join("state.json")).unwrap().tasks.values().any(|t| !t.status.is_final()));

    let core = Orch::default().0;
    let host = RecordingHost::new();
    core.init_in(host.clone(), &data, &core_dir).unwrap();

    // Orden: leer -> orphan_all -> reescribir -> abrir almacén -> importar.
    let reescrito = std::fs::read_to_string(data.join("state.json")).unwrap();
    assert!(core.lock().tasks.values().all(|t| t.status.is_final()), "orphan_all() se aplicó");
    let (rev, doc, _) = snapshot_en_el_almacen(&core);
    assert_eq!((rev, doc.as_str()), (1, reescrito.as_str()), "la instantánea es el state.json ya reescrito");
    match core.storage_status() {
        StorageStatus::Ready(r) => assert_eq!(r.matches_adopted, Some(true)),
        otro => panic!("se esperaba Ready y salió {otro:?}"),
    }
    assert!(host.notifications().is_empty());
}

#[test]
fn un_segundo_core_con_el_bloqueo_ocupado_no_arranca_ni_toca_state_json() {
    let (_limpia, data, core_dir) = dirs_c1();
    let titular = Orch::default().0;
    titular.acquire_instance_lock(&core_dir).unwrap();
    nueva_tarea(&titular, false);
    escribe_state_de(&titular, &data);
    let antes = std::fs::read(data.join("state.json")).unwrap();

    let segundo = Orch::default().0;
    let host = RecordingHost::new();
    let err = segundo.init_in(host.clone(), &data, &core_dir).unwrap_err();
    assert!(err.contains("otra instancia"), "{err}");
    assert!(std::fs::read(data.join("state.json")).unwrap() == antes, "state.json cambió: hubo orphan_all o reescritura");
    assert!(segundo.lock().tasks.is_empty(), "ni siquiera cargó el estado");
    assert_eq!(segundo.storage_status(), StorageStatus::NotOpened);
    assert!(!core_dir.join("lixbon.db").exists(), "no creó la base");
    assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon no puede iniciar"));
    match segundo.acquire_instance_lock(&core_dir) {
        Err(e @ OpenStoreError::AlreadyLocked { .. }) => assert!(e.is_blocking()),
        otro => panic!("se esperaba AlreadyLocked y salió {otro:?}"),
    }
    drop(titular);
    segundo.acquire_instance_lock(&core_dir).expect("liberado el titular, el segundo ya puede");
}

#[test]
fn una_base_corrupta_degrada_pero_el_core_conserva_el_bloqueo() {
    let (_limpia, data, core_dir) = dirs_c1();
    std::fs::create_dir_all(&core_dir).unwrap();
    std::fs::write(core_dir.join("lixbon.db"), vec![b'x'; 4096]).unwrap();
    let previa = Orch::default().0;
    nueva_tarea(&previa, false);
    escribe_state_de(&previa, &data);

    let core = Orch::default().0;
    core.init_in(RecordingHost::new(), &data, &core_dir).expect("un fallo recuperable no impide arrancar");
    match core.storage_status() {
        StorageStatus::Degraded(m) => assert!(m.contains("dañada"), "{m}"),
        otro => panic!("se esperaba Degraded y salió {otro:?}"),
    }
    // Sigue operando con state.json como antes de C1.
    assert!(core.lock().tasks.values().all(|t| t.status.is_final()));
    assert!(read_json::<State>(&data.join("state.json")).unwrap().tasks.values().all(|t| t.status.is_final()));
    // Y la exclusión mutua se mantiene aunque la base no sirva.
    let otro = Orch::default().0;
    assert!(matches!(otro.acquire_instance_lock(&core_dir), Err(OpenStoreError::AlreadyLocked { .. })));
    let antes = std::fs::read(data.join("state.json")).unwrap();
    assert!(otro.init_in(RecordingHost::new(), &data, &core_dir).is_err());
    assert!(std::fs::read(data.join("state.json")).unwrap() == antes, "el segundo Core no debe tocar state.json");
}

#[test]
fn una_base_de_version_futura_impide_arrancar_y_no_se_toca() {
    let (_limpia, data, core_dir) = dirs_c1();
    std::fs::create_dir_all(&core_dir).unwrap();
    {
        let c = rusqlite::Connection::open(core_dir.join("lixbon.db")).unwrap();
        c.execute_batch("CREATE TABLE futuro (x INTEGER); PRAGMA user_version = 99;").unwrap();
    }
    // Una sesión anterior dejó una tarea en marcha: un Core incompatible no debe tocarla.
    let previa = Orch::default().0;
    nueva_tarea(&previa, false);
    escribe_state_de(&previa, &data);
    let antes = std::fs::read(data.join("state.json")).unwrap();

    let core = Orch::default().0;
    let host = RecordingHost::new();
    let err = core.init_in(host.clone(), &data, &core_dir).unwrap_err();
    assert!(err.contains("versión más nueva"), "{err}");
    assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon no puede iniciar"));
    assert!(std::fs::read(data.join("state.json")).unwrap() == antes, "un Core incompatible no modifica state.json");
    assert!(core.lock().tasks.is_empty(), "ni siquiera adoptó el estado");
    assert_eq!(core.storage_status(), StorageStatus::NotOpened);
    let c = rusqlite::Connection::open_with_flags(core_dir.join("lixbon.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let v: i64 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
    let tablas: i64 = c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name = 'schema_migrations'", [], |r| r.get(0)).unwrap();
    assert_eq!((v, tablas), (99, 0), "la base futura no se modificó");
}

#[test]
fn una_migracion_editada_impide_arrancar_sin_tocar_state_json() {
    let (_limpia, data, core_dir) = dirs_c1();
    // Una base creada por este binario, con el texto de la migración 001 "cambiado" a posteriori.
    drop(crate::store::Store::open(&core_dir, "t").unwrap());
    {
        let c = rusqlite::Connection::open(core_dir.join("lixbon.db")).unwrap();
        c.execute("UPDATE schema_migrations SET checksum = 'otro' WHERE version = 1", []).unwrap();
    }
    let previa = Orch::default().0;
    nueva_tarea(&previa, false);
    escribe_state_de(&previa, &data);
    let antes = std::fs::read(data.join("state.json")).unwrap();

    let core = Orch::default().0;
    let err = core.init_in(RecordingHost::new(), &data, &core_dir).unwrap_err();
    assert!(err.contains("ha cambiado"), "{err}");
    assert!(std::fs::read(data.join("state.json")).unwrap() == antes, "state.json intacto");
    assert!(core.lock().tasks.is_empty());
    assert_eq!(core.storage_status(), StorageStatus::NotOpened);
}

#[test]
fn los_errores_de_esquema_son_bloqueantes_y_los_de_disco_no() {
    use crate::store::StoreError as E;
    let casos: Vec<(E, bool)> = vec![
        (E::AlreadyRunning { lock_path: "x".into() }, true),
        (E::DatabaseNewer { db_version: 9, binary_version: 1 }, true),
        (E::UnknownMigration { version: 9, name: "x".into() }, true),
        (E::ChecksumMismatch { version: 1, name: "x".into() }, true),
        (E::OutOfOrderMigration { pending: 2, applied: 3 }, true),
        (E::InvalidMigrationList("x".into()), true),
        (E::Corrupt { path: "x".into(), detail: "x".into() }, false),
        (E::Io { context: "x".into(), source: std::io::Error::other("disco lleno") }, false),
        (E::Backup("x".into()), false),
        (E::WalUnavailable { got: "delete".into() }, false),
        (E::InvalidDocument("x".into()), false),
        (E::MigrationFailed { version: 1, name: "x".into(), detail: "x".into() }, false),
    ];
    for (e, bloqueante) in casos {
        let texto = format!("{e:?}");
        assert_eq!(OpenStoreError::from(e).is_blocking(), bloqueante, "{texto}");
    }
    // Sin `core.lock` no hay garantía de un único escritor: también es bloqueante.
    assert!(OpenStoreError::LockUnavailable { detail: "x".into() }.is_blocking());
    assert!(!OpenStoreError::AlreadyOpened.is_blocking());
}

#[test]
fn sin_poder_crear_core_lock_el_core_no_arranca() {
    let (_limpia, data, core_dir) = dirs_c1();
    // La «carpeta» del almacén es un archivo: core.lock no se puede crear.
    std::fs::write(&core_dir, b"soy un archivo, no una carpeta").unwrap();
    let previa = Orch::default().0;
    nueva_tarea(&previa, false);
    escribe_state_de(&previa, &data);
    let antes = std::fs::read(data.join("state.json")).unwrap();

    let core = Orch::default().0;
    let host = RecordingHost::new();
    match core.acquire_instance_lock(&core_dir) {
        Err(e @ OpenStoreError::LockUnavailable { .. }) => assert!(e.is_blocking()),
        otro => panic!("se esperaba LockUnavailable y salió {otro:?}"),
    }
    let err = core.init_in(host.clone(), &data, &core_dir).unwrap_err();
    assert!(err.contains("bloqueo"), "{err}");
    assert!(host.notifications().iter().any(|(t, _)| t == "Lixbon no puede iniciar"));
    // Sin garantía de un único escritor, no se toca nada.
    assert!(std::fs::read(data.join("state.json")).unwrap() == antes, "state.json intacto");
    assert!(core.lock().tasks.is_empty());
    assert_eq!(core.storage_status(), StorageStatus::NotOpened);
}

#[test]
fn commit_sigue_escribiendo_state_json_y_no_toca_la_instantanea() {
    let (_limpia, data, core_dir) = dirs_c1();
    super::fsio::set_test_data_dir(&data); // commit() escribe en data_dir(): aquí, la carpeta de esta prueba
    let core = Orch::default().0;
    nueva_tarea(&core, false);
    escribe_state_de(&core, &data);
    core.open_store(&core_dir, &data.join("state.json")).unwrap();
    let (rev0, doc0, sha0) = snapshot_en_el_almacen(&core);
    assert_eq!(rev0, 1);

    // El estado cambia por la frontera de mutación (persiste en state.json como siempre).
    core.mutate(|st| {
        st.create_run("obj", NewTask {
            agent: "coordinador".into(), model: None, effort: None, role: None, title: "t".into(), spec: "s".into(),
            repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: false,
        });
        Ok(())
    })
    .unwrap();
    let en_disco: Value = serde_json::from_str(&std::fs::read_to_string(data.join("state.json")).unwrap()).unwrap();
    assert_eq!(en_disco, serde_json::to_value(&*core.lock()).unwrap(), "state.json refleja el estado nuevo");
    assert_eq!(en_disco["runs"].as_object().unwrap().len(), 2);

    let (rev1, doc1, sha1) = snapshot_en_el_almacen(&core);
    assert_eq!((rev1, doc1, sha1), (rev0, doc0, sha0), "legacy_state no se tocó: sigue siendo la instantánea");
    assert!(matches!(core.storage.with_store(|s| crate::store::verify_snapshot(s).unwrap()).unwrap(), SnapshotCheck::Verified { rev: 1, .. }));
}

#[test]
fn las_pruebas_nunca_usan_la_carpeta_real_del_core() {
    let real = skill::home().unwrap_or_default().join(".lixbon");
    assert!(!super::core_dir().starts_with(&real) && !super::data_dir().starts_with(&real));
    assert!(super::core_dir().starts_with(std::env::temp_dir()));
}

/// Opt-in, no forma parte de la suite normal: `LIXBON_REAL_STATE_PATH=<ruta a un
/// state.json> cargo test importa_un_state_json_real -- --ignored --nocapture`.
/// Solo LEE el archivo: la instantánea se importa desde una copia temporal.
#[test]
#[ignore = "opt-in: define LIXBON_REAL_STATE_PATH con la ruta de un state.json real"]
fn importa_un_state_json_real_en_solo_lectura() {
    let Some(ruta) = std::env::var_os("LIXBON_REAL_STATE_PATH") else {
        eprintln!("LIXBON_REAL_STATE_PATH no está definida: nada que comprobar");
        return;
    };
    let ruta = std::path::PathBuf::from(ruta);
    let antes = std::fs::read(&ruta).unwrap();
    let (_limpia, data, core_dir) = dirs_c1();
    let mut st: State = read_json(&ruta).expect("el archivo no se deserializa como State");
    let (tareas, runs) = (st.tasks.len(), st.runs.len());
    st.orphan_all();
    write_json(&data.join("state.json"), &st).unwrap(); // lo que reescribiría `init`
    let core = Orch::default().0;
    core.adopt_state(&super::lifecycle::BootProof::for_tests(), st);
    let t = std::time::Instant::now();
    let rep = core.open_store(&core_dir, &data.join("state.json")).unwrap();
    eprintln!("{} bytes de estado real ({tareas} tareas, {runs} runs) importados en {:?}: {:?}", std::fs::metadata(data.join("state.json")).unwrap().len(), t.elapsed(), rep);
    assert_eq!(rep.matches_adopted, Some(true));
    assert_eq!(std::fs::read(&ruta).unwrap(), antes, "el archivo real no se modificó");
}
