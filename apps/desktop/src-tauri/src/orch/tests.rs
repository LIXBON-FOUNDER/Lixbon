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
        // ACL privada por SID (usuario actual, LocalSystem y Administrators; nada heredado ni amplio).
        crate::acl_test_util::comprueba_privada(&p);
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
