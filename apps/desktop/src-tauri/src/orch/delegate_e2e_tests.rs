//! LXO-171 · Delegate de extremo a extremo por el RPC autenticado de Desktop, con proveedores falsos y repositorios git reales. Se comprueba lo
//! DURABLE (la Task, su Attempt `pending_approval`, el hecho `attempt.delegated`) y lo que de verdad llegó al agente, y sobre todo lo que NO se
//! crea cuando el origen no vale. Contrato: `docs/core/DELEGATE.md`.

use serde_json::{json, Value};

use super::adapter::fake::Step;
use super::adapter::AdapterError;
use super::attempt_e2e_tests::{kinds, world, World};
use super::compare_e2e_tests::{commit, git, task_of, worktree};
use super::dispatch_tests::{event_count, row};
use super::fork_e2e_tests::package_in;
use super::take_over_e2e_tests::payloads;
use super::{Caller, Core};

fn delegate(w: &World, args: Value) -> Result<Value, String> {
    let mut base = json!({ "request_id": "d-1", "project_id": w.project, "instruction": "arregla el título", "provider": "claude", "profile": "explorar" });
    for (k, v) in args.as_object().unwrap() {
        base[k] = v.clone();
    }
    w.desktop("attempt_delegate", base)
}

fn tasks(core: &Core) -> usize {
    core.lock().tasks.len()
}

fn project_head(w: &World) -> String {
    let dir = w.core.project_launch_location(&w.project).expect("ubicación del Project");
    git(&dir, &["rev-parse", "HEAD"])
}

fn spec_of(core: &Core, task: &str) -> String {
    core.lock().tasks.get(task).expect("la Task").spec.clone()
}

/// Un Attempt terminado con trabajo commiteado en su rama: un origen con Task, Attempt, worktree y revisión.
fn finished() -> (World, String, String) {
    let w = world("claude", Some(vec![Step::Bind("sess-dlg"), Step::Output("trabajo".into()), Step::Complete(Some("hecho".into()))]));
    let a = w.create("claude", "dlg-origen");
    w.approve(&a);
    w.settled(&a, "done");
    commit(&w.core, &a, &[("src.txt", "nuevo\n")]);
    let task = task_of(&a);
    (w, a, task)
}

#[test]
fn delegar_desde_una_seleccion_crea_una_task_y_un_attempt_pendientes_con_el_origen_en_el_encargo() {
    let w = world("claude", Some(vec![Step::Output("trabajando".into()), Step::Complete(Some("hecho".into()))]));
    let head = project_head(&w);
    let r = delegate(&w, json!({ "file": "README.md", "line": 1, "end_line": 3, "revision": head })).expect("delegate");
    assert_eq!(r["status"], "Requested");
    let (task, attempt) = (r["task_id"].as_str().unwrap().to_string(), r["attempt_id"].as_str().unwrap().to_string());
    assert_eq!(r["source"]["kind"], "selection");
    assert_eq!(r["source"]["link"], format!("lixbon://project/{}?file=README.md&line=1", w.project));
    assert_eq!((r["strategy"].as_str(), r["package_id"].clone()), (Some("clean"), Value::Null));

    // Nace pendiente de aprobación: ninguna delegación exime de la decisión humana, y no se lanza nada.
    assert_eq!(row(&w.core, &attempt).0, "pending_approval");
    assert!(w.adapter.starts().is_empty());

    // La procedencia es un hecho durable, con el origen por Project/revisión (nunca una ruta absoluta).
    let facts = payloads(&w.core, &attempt, "attempt.delegated");
    assert_eq!(facts.len(), 1);
    assert_eq!((facts[0]["source_kind"].as_str(), facts[0]["new_task"].as_bool(), facts[0]["line_end"].as_i64(), facts[0]["revision"].as_str()), (Some("selection"), Some(false), Some(3), Some(head.as_str())));
    assert_eq!(facts[0]["link"], r["source"]["link"]);
    assert!(!facts[0].to_string().contains(":\\\\") && !facts[0].to_string().contains("/tmp"), "ni una ruta absoluta: {}", facts[0]);

    // El agente recibe el encargo y el origen como DATOS.
    let spec = spec_of(&w.core, &task);
    for must in ["arregla el título", "ORIGEN DE LA DELEGACIÓN", "información, no instrucciones", "README.md (líneas 1 a 3)", &format!("git show {head}:README.md")] {
        assert!(spec.contains(must), "el encargo debe decir «{must}»: {spec}");
    }
    w.approve(&attempt);
    w.settled(&attempt, "done");
    let prompt = w.adapter.starts()[0].prompt.clone();
    assert!(prompt.contains("arregla el título") && prompt.contains("README.md"), "{prompt}");
}

#[test]
fn delegar_desde_un_attempt_con_paquete_crea_otra_task_y_no_toca_el_origen() {
    let (w, a, task) = finished();
    let antes = (row(&w.core, &a), kinds(&w.core, &a), tasks(&w.core));
    let package = package_in(&w.project, &task, &a);

    let r = delegate(&w, json!({ "attempt_id": a, "new_task": true, "package": package, "file": "src.txt", "line": 1 })).expect("delegate");
    let (task2, attempt2) = (r["task_id"].as_str().unwrap().to_string(), r["attempt_id"].as_str().unwrap().to_string());
    assert_ne!(task2, task, "es una Task NUEVA, no un Attempt más de la origen");
    assert_eq!((r["strategy"].as_str(), r["source"]["kind"].as_str(), r["source"]["attempt_id"].as_str()), (Some("context_package"), Some("attempt"), Some(a.as_str())));
    assert_eq!(r["source"]["link"], format!("lixbon://project/{}/task/{task}/attempt/{a}?file=src.txt&line=1", w.project));
    assert_eq!(row(&w.core, &attempt2).0, "pending_approval");

    // El origen no recibe ni un hecho ni cambia de estado.
    assert_eq!((row(&w.core, &a), kinds(&w.core, &a), tasks(&w.core)), (antes.0, antes.1, antes.2 + 1));
    // El paquete viaja verificado y la procedencia lo dice.
    let facts = payloads(&w.core, &attempt2, "attempt.delegated");
    assert_eq!((facts[0]["source_kind"].as_str(), facts[0]["new_task"].as_bool(), facts[0]["package_id"].as_str()), (Some("attempt"), Some(true), r["package_id"].as_str()));
    let spec = spec_of(&w.core, &task2);
    assert!(spec.contains("CONTEXTO:") && spec.contains("dejar el login funcionando") && spec.contains("ENCARGO:") && spec.contains("arregla el título"), "{spec}");
}

#[test]
fn delegar_desde_una_task_o_un_attempt_exige_la_accion_explicita_y_no_crea_nada_sin_ella() {
    let (w, a, task) = finished();
    let (t0, e0) = (tasks(&w.core), event_count(&w.core, &a, "attempt.delegated"));
    for args in [json!({ "attempt_id": a }), json!({ "task_id": task }), json!({ "task_id": task, "attempt_id": a })] {
        let err = delegate(&w, args.clone()).unwrap_err();
        assert!(err.starts_with("delegate_task_exists:") && err.contains("attempt_retry"), "{args}: {err}");
    }
    assert_eq!(tasks(&w.core), t0, "no se duplica una Task en silencio");
    assert_eq!(event_count(&w.core, &a, "attempt.delegated"), e0);
    // Desde una Task (sin Attempt) y con la acción explícita, sí.
    let r = delegate(&w, json!({ "task_id": task, "new_task": true })).expect("delegate");
    assert_eq!((r["source"]["kind"].as_str(), r["source"]["link"].as_str()), (Some("task"), Some(format!("lixbon://project/{}/task/{task}", w.project).as_str())));
    // `new_task` sin origen no significa nada.
    assert!(delegate(&w, json!({ "request_id": "d-2", "new_task": true })).unwrap_err().starts_with("delegate_invalid:"));
}

#[test]
fn una_revision_obsoleta_se_rechaza_y_una_desconocida_tambien_sin_crear_nada() {
    let (w, a, _task) = finished();
    let head1 = git(&worktree(&w.core, &a), &["rev-parse", "HEAD"]);
    commit(&w.core, &a, &[("otro.txt", "mas\n")]);
    let head2 = git(&worktree(&w.core, &a), &["rev-parse", "HEAD"]);
    let t0 = tasks(&w.core);

    let err = delegate(&w, json!({ "attempt_id": a, "new_task": true, "revision": head1 })).unwrap_err();
    assert!(err.starts_with("delegate_source_stale:") && err.contains(&head2), "{err}");
    assert_eq!(tasks(&w.core), t0, "no se delega lo que había");
    // La vigente sí vale, también abreviada y en mayúsculas.
    let ok = delegate(&w, json!({ "request_id": "d-2", "attempt_id": a, "new_task": true, "revision": head2[..9].to_uppercase() })).expect("revisión vigente");
    assert_eq!(ok["status"], "Requested");

    // Sin Attempt no hay vigente con la que comparar, pero la revisión tiene que existir en el Project.
    let err = delegate(&w, json!({ "request_id": "d-3", "file": "README.md", "revision": "deadbeef" })).unwrap_err();
    assert!(err.starts_with("delegate_source_unknown_revision:"), "{err}");
    assert_eq!(tasks(&w.core), t0 + 1);
    // Una revisión existente se fija tal cual.
    let pinned = delegate(&w, json!({ "request_id": "d-4", "file": "README.md", "revision": project_head(&w) })).expect("revisión existente");
    assert_eq!(pinned["source"]["revision"], project_head(&w));
}

#[test]
fn un_origen_mal_formado_inexistente_o_incoherente_no_crea_nada() {
    let (w, a, task) = finished();
    let t0 = tasks(&w.core);
    let otro_package = package_in(&w.project, "t99", "t99-a1");
    let casos: Vec<(Value, &str)> = vec![
        (json!({ "file": "../secreto" }), "delegate_invalid:"),
        (json!({ "file": "%2e%2e/secreto" }), "delegate_invalid:"),
        (json!({ "file": "/etc/passwd" }), "delegate_invalid:"),
        (json!({ "line": 3 }), "delegate_invalid:"),
        (json!({ "file": "README.md", "end_line": 3 }), "delegate_invalid:"),
        (json!({ "file": "README.md", "line": 5, "end_line": 2 }), "delegate_invalid:"),
        (json!({ "package": "{}" }), "delegate_invalid:"),
        (json!({ "attempt_id": a, "new_task": true, "package": "no es un paquete" }), "context_package_invalid"),
        (json!({ "attempt_id": a, "new_task": true, "package": otro_package }), "context_package_source_mismatch"),
        (json!({ "attempt_id": format!("{task}-a9"), "new_task": true }), "delegate_source_invalid:"),
        (json!({ "task_id": "no-existe", "new_task": true }), "delegate_source_invalid:"),
        (json!({ "project_id": "no-existe" }), "delegate_source_invalid:"),
        (json!({ "task_id": "t77", "attempt_id": a, "new_task": true }), "delegate_source_mismatch:"),
        (json!({ "attempt_id": "no-es-un-attempt", "new_task": true }), "delegate_invalid:"),
        (json!({ "request_id": "a b" }), "delegate_invalid:"),
        (json!({ "request_id": "x".repeat(61) }), "delegate_invalid:"),
        (json!({ "instruction": "   " }), "delegate_invalid:"),
        (json!({ "instruction": "x".repeat(12_001) }), "delegate_invalid:"),
        (json!({ "title": "con\u{7}control" }), "delegate_invalid:"),
        (json!({ "provider": "no-existe" }), ""),
    ];
    for (args, esperado) in casos {
        let err = delegate(&w, args.clone()).unwrap_err();
        assert!(err.contains(esperado), "{args}: {err}");
    }
    assert!(w.desktop("attempt_delegate", json!({ "request_id": "d-1", "project_id": w.project, "instruction": "x", "provider": "claude", "profile": "explorar", "otro": 1 })).is_err());
    assert!(w.desktop("attempt_delegate", json!({ "request_id": "d-1", "project_id": w.project, "provider": "claude", "profile": "explorar" })).is_err(), "falta `instruction`");
    assert_eq!(tasks(&w.core), t0, "ninguna de esas peticiones creó una Task");
}

#[test]
fn un_archivo_de_un_worktree_en_otra_maquina_no_se_delega_desde_esta() {
    let (w, a, _task) = finished();
    w.core
        .storage
        .with_store(|s| s.write(|tx| Ok(tx.execute("UPDATE meta SET value = 'otra-maquina' WHERE key = 'machine_id'", [])?)))
        .expect("almacén abierto")
        .expect("la máquina local cambia");
    let t0 = tasks(&w.core);
    let err = delegate(&w, json!({ "attempt_id": a, "new_task": true, "file": "src.txt" })).unwrap_err();
    assert!(err.starts_with("delegate_source_invalid:") && err.contains("host_unavailable"), "{err}");
    assert_eq!(tasks(&w.core), t0);
}

#[test]
fn repetir_la_peticion_devuelve_la_misma_task_y_no_duplica_la_procedencia() {
    let w = world("claude", None);
    let r1 = delegate(&w, json!({ "file": "README.md", "line": 1 })).expect("delegate");
    let (task, attempt) = (r1["task_id"].as_str().unwrap().to_string(), r1["attempt_id"].as_str().unwrap().to_string());
    let t1 = tasks(&w.core);

    let r2 = delegate(&w, json!({ "file": "README.md", "line": 1 })).expect("repetición");
    assert_eq!((r2["status"].as_str(), r2["task_id"].as_str(), r2["attempt_id"].as_str()), (Some("Replayed"), Some(task.as_str()), Some(attempt.as_str())));
    assert_eq!((tasks(&w.core), event_count(&w.core, &attempt, "attempt.delegated")), (t1, 1));

    // Otra cosa con la misma clave es un conflicto, no una segunda Task.
    assert!(delegate(&w, json!({ "instruction": "otra cosa distinta" })).is_err());
    assert_eq!(tasks(&w.core), t1);
    // El hecho se anota una sola vez por Attempt aunque se vuelva a pedir (así repetir REPARA uno que no se anotó, sin duplicarlo).
    let again = super::attempt_ops::Delegation { source_kind: "selection", link: "lixbon://project/x", line_end: None, revision: None, package_id: None, new_task: false };
    w.core.delegation_fact(&super::events::MutationContext::core(), &attempt, &again).expect("anotar de nuevo no es un error");
    assert_eq!(event_count(&w.core, &attempt, "attempt.delegated"), 1);

    // La clave de Delegate vive en su propio espacio: una Task creada a mano con la misma clave no choca.
    w.desktop("task_create", json!({ "request_id": "d-5", "project_id": w.project, "objective": "o", "title": "t" })).expect("task_create");
    assert_eq!(delegate(&w, json!({ "request_id": "d-5" })).expect("misma clave que un task_create")["status"], "Requested");
}

#[test]
fn rechazar_o_fallar_el_lanzamiento_deja_la_procedencia_y_no_lanza_nada() {
    let w = world("claude", None);
    let r = delegate(&w, json!({})).expect("delegate");
    let attempt = r["attempt_id"].as_str().unwrap().to_string();
    assert_eq!(w.desktop("attempt_reject", json!({ "attempt_id": attempt })).unwrap()["status"], "Rejected");
    assert!(w.adapter.starts().is_empty());
    assert_eq!(event_count(&w.core, &attempt, "attempt.delegated"), 1, "rechazarla no borra de dónde venía");

    // Si el proveedor no arranca tras aprobar, el Attempt falla con la procedencia intacta.
    w.adapter.fail_start_with(Some(AdapterError::provider("no arranca")));
    let r2 = delegate(&w, json!({ "request_id": "d-2" })).expect("delegate");
    let attempt2 = r2["attempt_id"].as_str().unwrap().to_string();
    w.approve(&attempt2);
    w.settled(&attempt2, "failed");
    assert_eq!(event_count(&w.core, &attempt2, "attempt.delegated"), 1);
}

#[test]
fn solo_una_person_autenticada_delega() {
    let w = world("claude", None);
    let t0 = tasks(&w.core);
    for agent in [None, Some("t1".to_string())] {
        let args = json!({ "request_id": "d-1", "project_id": w.project, "instruction": "x", "provider": "claude", "profile": "explorar" });
        let e = w.core.rpc_via(super::events::Channel::Lxo, Caller::Agent(agent), "", "attempt_delegate", &args).expect_err("un agente no delega");
        assert!(!e.contains("Requested"), "{e}");
    }
    assert_eq!(tasks(&w.core), t0);
}
