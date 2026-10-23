//! LXO-233 · con el runtime sobre las tablas, los hechos de ejecución son `attempt.*` (ADR D9): nunca a la vez que
//! `task.status_changed`. Su Attention apunta al Attempt y la levantada sobre la Task antes del corte se respeta hasta
//! resolverse (D10). Sobre un Core REAL tras el corte, con git real y el lanzador simulado.

use serde_json::json;

use super::attention_read_tests::{persona, rpc};
use super::pty::pruebas;
use super::runtime_tables_tests::{como, con_hija, corta_y_reinicia, sql};
use super::spawn_cleanup_tests::{desde, head, kinds, pl, setup};
use super::state::Status;
use crate::store::EventRow;

fn ejecucion(evs: &[EventRow]) -> Vec<String> {
    evs.iter()
        .filter(|e| e.kind.starts_with("attempt.") || e.kind == "task.status_changed")
        .map(|e| match e.kind.as_str() {
            "attempt.waiting" => format!("{}:{}@{}", e.kind, pl(e)["state"].as_str().unwrap_or_default(), e.entity_id),
            _ => format!("{}@{}", e.kind, e.entity_id),
        })
        .collect()
}

/// Attention activa: `categoría target_kind target_id`.
fn activas(core: &super::Core) -> Vec<String> {
    sql(core, "SELECT category || ' ' || target_kind || ' ' || target_id FROM attention_items WHERE status = 'active' ORDER BY 1")
}

#[test]
fn tras_el_corte_cada_cambio_de_ejecucion_es_un_attempt_y_nunca_un_task_status_changed() {
    let (e, hija) = con_hija("ev-ciclo");
    let antes = head(&e.core);
    let term = pruebas::lanza(&pruebas::carpeta(&format!("ev-{hija}")), false).expect("terminal real");
    e.core.register_term(&hija, term).unwrap();
    let q = e.core.rpc(como(&hija), "", "ask", &json!({ "question": "¿sigo?" })).unwrap()["question"].as_u64().unwrap();
    e.core.rpc(como(&e.root), "", "reply", &json!({ "question": q, "answer": "sí" })).unwrap();
    e.core.mutate(|tx| tx.await_terminal_approval(&hija, 9_999_999_999_999).map(|_| ())).unwrap();
    e.core.mutate(|tx| tx.ask(&hija, "¿y ahora?").map(|_| ())).unwrap();
    e.core.rpc(como(&hija), "", "done", &json!({ "summary": "hecho", "report_text": "# Uno\n" })).unwrap();
    e.core.rpc(como(&e.root), "", "continue", &json!({ "task": hija, "spec": "otra vuelta" })).unwrap();
    e.core.rpc(como(&hija), "", "done", &json!({ "summary": "", "failed": true, "report_text": "# Dos\n" })).unwrap();
    let evs = desde(&e.core, antes);
    let (a1, a2) = (format!("{hija}-a1"), format!("{hija}-a2"));
    assert_eq!(
        ejecucion(&evs),
        [
            format!("attempt.waiting:waiting@{a1}"),
            format!("attempt.resumed@{a1}"),
            format!("attempt.waiting:awaiting_terminal_approval@{a1}"),
            // De esperar en la terminal a esperar una respuesta se pasa por `running`, como en las tablas.
            format!("attempt.resumed@{a1}"),
            format!("attempt.waiting:waiting@{a1}"),
            format!("attempt.completed@{a1}"),
            // El seguimiento nace como el Attempt 2 y arranca: el 1 no se reabre.
            format!("attempt.requested@{a2}"),
            format!("attempt.started@{a2}"),
            format!("attempt.failed@{a2}"),
        ],
        "sin un solo task.status_changed: un mismo hecho no aparece en los dos modelos"
    );
    let falla = evs.iter().find(|ev| ev.kind == "attempt.failed").unwrap();
    assert_eq!(pl(falla), json!({ "task": hija, "n": 2, "reason": "agent_reported", "has_summary": false }));
    assert_eq!((falla.run_id.as_deref(), falla.project_id.as_deref()), (Some(e.run.as_str()), Some(e.project.as_str())), "Run y Project de su Task");
    // Lo que no es un estado de ejecución sigue en la Task.
    for k in ["task.question", "task.reply"] {
        assert!(kinds(&evs).contains(&k), "{k} sigue siendo un hecho de la Task");
    }
    // Los hechos y las tablas cuentan lo mismo.
    assert_eq!(sql::<String>(&e.core, &format!("SELECT status FROM attempts WHERE task_id = '{hija}' ORDER BY n")), vec!["done", "failed"]);
}

#[test]
fn una_task_nueva_trae_su_attempt_1_y_el_cierre_de_un_run_detiene_los_suyos() {
    let e = corta_y_reinicia(setup("ev-nace"));
    let antes = head(&e.core);
    let pid = e.spawn(false);
    e.aprobar(&pid);
    let hija = e.hijas().into_iter().next().unwrap();
    let evs = desde(&e.core, antes);
    let creada = evs.iter().position(|ev| ev.kind == "task.created").expect("task.created");
    let pedido = evs.iter().position(|ev| ev.kind == "attempt.requested").expect("attempt.requested");
    assert!(creada < pedido, "primero la Task, después su Attempt");
    assert_eq!(pl(&evs[pedido]), json!({ "task": hija, "n": 1, "provider": "claude", "profile": "delegar_con_revision", "external": false, "approval_required": false }));
    assert_eq!(ejecucion(&evs), [format!("attempt.requested@{hija}-a1"), format!("attempt.started@{hija}-a1")]);

    let antes = head(&e.core);
    e.core.rpc(como(&e.root), "", "run_close", &json!({ "force": true })).unwrap();
    let evs = desde(&e.core, antes);
    let parada = evs.iter().find(|ev| ev.kind == "attempt.stopped" && ev.entity_id == format!("{hija}-a1")).expect("la hija se detiene");
    assert_eq!(pl(parada), json!({ "task": hija, "n": 1, "from": "running", "cause": "run_closed" }));
    assert!(!kinds(&evs).contains(&"task.status_changed"));
}

#[test]
fn el_fallo_es_del_attempt_y_retirar_la_task_cierra_lo_suyo() {
    let (e, hija) = con_hija("ev-fallo");
    e.core.mutate(|tx| tx.fail_with(&hija, "agent_idle_timeout", "sin señales").map(|_| ())).unwrap();
    assert_eq!(activas(&e.core), [format!("failed attempt {hija}-a1")], "el fallo apunta al Attempt, no a la Task");
    // Un seguimiento no se lleva el fallo del intento 1 (cada Attempt tiene su Attention, LXO-119).
    let term = pruebas::lanza(&pruebas::carpeta(&format!("ev-f-{hija}")), false).expect("terminal real");
    e.core.register_term(&hija, term).unwrap();
    e.core.rpc(como(&e.root), "", "continue", &json!({ "task": hija, "spec": "reintenta" })).unwrap();
    assert_eq!(activas(&e.core), [format!("failed attempt {hija}-a1")]);
    // El intento 2 falla con lo suyo.
    e.core.mutate(|tx| tx.fail_with(&hija, "agent_idle_timeout", "otra vez").map(|_| ())).unwrap();
    assert_eq!(activas(&e.core), [format!("failed attempt {hija}-a1"), format!("failed attempt {hija}-a2")]);
}

#[test]
fn una_limpieza_de_lanzamiento_detiene_el_attempt_y_task_removed_lleva_su_numero() {
    let e = corta_y_reinicia(setup("ev-limpieza"));
    let pid = e.spawn(false);
    e.hook(|_core, _id, step| if step == super::spawn::SpawnStep::InLaunch { Err("launch inyectado".into()) } else { Ok(()) });
    let antes = head(&e.core);
    assert_eq!(e.aprobar(&pid)["outcome"], "launch_failed");
    let evs = desde(&e.core, antes);
    let quitada = evs.iter().find(|ev| ev.kind == "task.removed").expect("task.removed");
    assert_eq!(pl(quitada), json!({ "cause": "launch_failed", "attempt": 1 }));
    let parada = evs.iter().position(|ev| ev.kind == "attempt.stopped").expect("su Attempt se detiene");
    assert!(parada < evs.iter().position(|ev| ev.kind == "task.removed").unwrap());
    assert!(!kinds(&evs).contains(&"task.status_changed"));
}

#[test]
fn la_espera_en_la_terminal_levantada_antes_del_corte_se_resuelve_con_los_hechos_del_attempt_d10() {
    // Antes del corte: la espera es Attention sobre la Task (task.status_changed).
    let e = setup("ev-d10");
    let pid = e.spawn(false);
    e.aprobar(&pid);
    let hija = e.hijas().into_iter().next().unwrap();
    e.core.mutate(|tx| tx.await_terminal_approval(&hija, 9_999_999_999_999).map(|_| ())).unwrap();
    assert_eq!(activas(&e.core), [format!("approval task {hija}")]);
    // El corte y el arranque: la hija huérfana sale (attempt.exited) y la espera de antes se resuelve.
    let e = corta_y_reinicia(e);
    assert_eq!(e.core.lock().task(&hija).unwrap().status, Status::Exited);
    assert!(activas(&e.core).is_empty(), "{:?}", activas(&e.core));
    let ultimo = sql::<String>(&e.core, "SELECT kind FROM events WHERE entity_kind = 'attempt' ORDER BY seq DESC LIMIT 1");
    assert_eq!(ultimo, ["attempt.exited"]);
}

#[test]
fn sin_el_corte_todo_sigue_siendo_task_status_changed() {
    let e = setup("ev-legacy");
    let antes = head(&e.core);
    let pid = e.spawn(false);
    e.aprobar(&pid);
    let evs = desde(&e.core, antes);
    assert!(kinds(&evs).contains(&"task.status_changed"));
    assert!(!kinds(&evs).iter().any(|k| k.starts_with("attempt.")), "sin las tablas no hay attempt.*");
    let hija = e.hijas().into_iter().next().unwrap();
    assert_eq!(e.core.lock().task(&hija).unwrap().status, Status::Running);
}

#[test]
fn la_activity_de_un_attempt_tiene_su_clave_y_su_texto() {
    let (e, hija) = con_hija("ev-activity");
    e.core.rpc(como(&hija), "", "done", &json!({ "summary": "hecho", "report_text": "# Uno\n" })).unwrap();
    let a1 = format!("{hija}-a1");
    let claves: Vec<String> = sql(&e.core, &format!("SELECT kind FROM events WHERE entity_kind = 'attempt' AND entity_id = '{a1}' ORDER BY seq"));
    assert_eq!(claves, ["attempt.requested", "attempt.started", "attempt.completed"]);
    let me = persona(&e.core, "person-ev", "install-person-ev", "person-ev-secret-0123456789abcdef");
    let act = rpc(&e.core, &me, "activity_list", json!({ "target_kind": "attempt", "target_id": a1 })).unwrap();
    let items = act["items"].as_array().expect("activity_list devuelve items");
    let mensajes: Vec<&str> = items.iter().map(|i| i["message_key"].as_str().unwrap()).collect();
    assert_eq!(mensajes, ["activity.attempt.requested", "activity.attempt.started", "activity.attempt.completed"]);
}
