//! LXO-144 · Steer y Stop & Send de extremo a extremo por la superficie de Desktop (`rpc_via(Ui, User)`, el mismo camino que `orch_call`
//! del ADE), con proveedores falsos: uno que lo ofrece todo, otro sin `steer` y otro sin `resume`. Cada prueba comprueba el desenlace
//! DURABLE: los Events (el par `attempt.instruction_requested` -> `attempt.instruction_result`, unido por `request_id`), el estado del
//! Attempt y lo que de verdad llegó al adapter. Contrato: `docs/core/STEER.md`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::adapter::fake::{FakeAdapter, Step};
use super::adapter::{AdapterError, Capability, CapabilityMatrix, CapabilityState, ProbeResult};
use super::adapter_launcher::AdapterLauncher;
use super::adapter_launcher_tests::{registry_of, repo_with_commit};
use super::attempt_e2e_tests::{attention, kinds, wait_until, world, World};
use super::dispatch_tests::{event_count, row};
use super::initial_approval_tests::e2e::core_with_project_at;
use super::{Caller, Core};

/// Como `world`, pero con la matriz de capabilities que se pida (un proveedor sin `steer`, sin `resume`…).
fn world_without(capability: Capability, script: Vec<Step>) -> World {
    let repo = repo_with_commit();
    let (core, _client, _ctx, project) = core_with_project_at(&repo.to_string_lossy());
    let matrix = CapabilityMatrix::all_available().with(capability, CapabilityState::Unsupported);
    let adapter = Arc::new(FakeAdapter::with_probe("claude", ProbeResult::ready(Some("0.0.0-fake"), matrix)));
    adapter.set_script(script);
    core.install_launcher(Arc::new(AdapterLauncher::new(&core, registry_of(adapter.clone()))));
    core.provider_registry.probe_all();
    World { core, project, adapter }
}

/// Los payloads de los Events de ese kind del Attempt, en orden.
fn payloads(core: &Core, attempt: &str, kind: &str) -> Vec<Value> {
    let rows: Vec<String> = core
        .storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT payload FROM events WHERE kind = ?1 AND entity_id = ?2 ORDER BY seq")?;
                let rows = stmt.query_map([kind, attempt], |r| r.get::<_, String>(0))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?)
            })
        })
        .unwrap()
        .unwrap();
    rows.iter().map(|p| serde_json::from_str(p).unwrap()).collect()
}

fn instruction_events(core: &Core, attempt: &str) -> usize {
    (event_count(core, attempt, "attempt.instruction_requested") + event_count(core, attempt, "attempt.instruction_result")) as usize
}

/// El Attempt corre con su ejecución viva y la sesión declarada.
fn running(w: &World, attempt: &str) -> String {
    wait_until("el Attempt corre", || row(&w.core, attempt).0 == "running");
    let task = attempt.rsplit_once("-a").unwrap().0.to_string();
    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    task
}

fn bound(w: &World, task: &str) {
    wait_until("el proveedor declara su sesión", || w.core.lock().tasks.get(task).is_some_and(|t| t.session_ref.is_some()));
}

fn stop(w: &World, task: &str) {
    w.desktop("stop", json!({"task": task})).expect("stop");
}

fn steer(w: &World, attempt: &str, request_id: &str, body: &str) -> Result<Value, String> {
    w.desktop("attempt_steer", json!({"attempt_id": attempt, "request_id": request_id, "body": body}))
}

fn stop_and_send(w: &World, attempt: &str, request_id: &str, body: &str) -> Result<Value, String> {
    w.desktop("attempt_stop_and_send", json!({"attempt_id": attempt, "request_id": request_id, "body": body}))
}

// ── Steer ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Un adapter con `steer`: la instrucción llega al turno EN CURSO (no a la cola, no se reanuda nada) y quedan los dos Events,
/// unidos por `request_id`, sin el texto de la instrucción.
#[test]
fn steer_con_capability_inyecta_en_el_turno_en_curso_y_deja_el_par_de_events() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-st"), Step::Output("trabajando".into()), Step::Hold, Step::Complete(Some("hecho".into()))]);
    let a1 = w.create("claude", "e2e-steer-ok");
    w.approve(&a1);
    running(&w, &a1);

    let done = steer(&w, &a1, "s-1", "usa la rama develop").expect("steer");
    assert_eq!((done["status"].as_str(), done["mode"].as_str(), done["request_id"].as_str()), (Some("Delivered"), Some("steer"), Some("s-1")));
    assert!(w.adapter.calls().contains(&"steer:usa la rama develop".to_string()), "el adapter recibió el steer");
    assert!(w.adapter.resumes().is_empty(), "Steer no reanuda nada: es el mismo turno");
    assert!(!w.adapter.calls().iter().any(|c| c == "interrupt"), "Steer no interrumpe");
    assert_eq!(event_count(&w.core, &a1, "attempt.queued"), 0, "Steer no pasa por la cola");

    let requested = payloads(&w.core, &a1, "attempt.instruction_requested");
    let result = payloads(&w.core, &a1, "attempt.instruction_result");
    assert_eq!((requested.len(), result.len()), (1, 1));
    assert_eq!((requested[0]["request_id"].as_str(), requested[0]["mode"].as_str(), requested[0]["chars"].as_i64()), (Some("s-1"), Some("steer"), Some(19)));
    assert_eq!((result[0]["request_id"].as_str(), result[0]["mode"].as_str(), result[0]["outcome"].as_str()), (Some("s-1"), Some("steer"), Some("delivered")));
    assert!(result[0].get("reason").is_none());
    let order = kinds(&w.core, &a1);
    let (r, s) = (order.iter().position(|k| k == "attempt.instruction_requested").unwrap(), order.iter().position(|k| k == "attempt.instruction_result").unwrap());
    assert!(r < s, "primero se pide, luego se cuenta el resultado: {order:?}");
    for kind in ["attempt.instruction_requested", "attempt.instruction_result"] {
        assert!(!payloads(&w.core, &a1, kind)[0].to_string().contains("develop"), "el texto de la instrucción no entra en ningún Event");
    }

    w.adapter.release_hold();
    w.settled(&a1, "done");
    assert_eq!(event_count(&w.core, &a1, "attempt.started"), 1, "el mismo Attempt y el mismo turno");
}

/// Repetir la petición (un reintento del cliente) devuelve lo que ya pasó sin volver a llamar al proveedor; otra instrucción con la misma
/// clave es un conflicto. La instrucción llegó UNA vez.
#[test]
fn steer_repetido_es_idempotente_y_no_duplica_la_instruccion() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-id"), Step::Hold, Step::Complete(None)]);
    let a1 = w.create("claude", "e2e-steer-idem");
    w.approve(&a1);
    let task = running(&w, &a1);

    steer(&w, &a1, "s-1", "primera").expect("steer");
    let again = steer(&w, &a1, "s-1", "primera").expect("la repetición");
    assert_eq!((again["status"].as_str(), again["request_id"].as_str()), (Some("Replayed"), Some("s-1")));
    assert!(steer(&w, &a1, "s-1", "otra distinta").unwrap_err().contains("request_conflict"));

    assert_eq!(w.adapter.calls().iter().filter(|c| c.starts_with("steer:")).count(), 1, "el adapter recibió UNA instrucción");
    assert_eq!(instruction_events(&w.core, &a1), 2, "un par de Events, no dos");
    // Una clave nueva es otra instrucción.
    steer(&w, &a1, "s-2", "segunda").expect("otra clave");
    assert_eq!(w.adapter.calls().iter().filter(|c| c.starts_with("steer:")).count(), 2);
    w.adapter.release_hold();
    let _ = task;
    w.settled(&a1, "done");
}

/// Un proveedor sin `steer`: error `steer_unsupported`, NADA se escribe y NO cae a la cola, a reanudar ni a interrumpir (invariante 1).
#[test]
fn steer_sin_la_capability_es_un_error_y_no_cae_a_la_cola_ni_a_stop() {
    let w = world_without(Capability::Steer, vec![Step::Bind("sess-ns"), Step::Output("trabajando".into()), Step::Wait]);
    let a1 = w.create("claude", "e2e-steer-sin");
    w.approve(&a1);
    let task = running(&w, &a1);

    let err = steer(&w, &a1, "s-1", "cambia de plan").unwrap_err();
    assert!(err.contains("unsupported/steer_unsupported"), "{err}");
    assert_eq!(instruction_events(&w.core, &a1), 0, "una petición rechazada no deja Events");
    let calls = w.adapter.calls();
    assert!(!calls.iter().any(|c| c.starts_with("steer") || c == "interrupt" || c == "resume"), "no cayó a otra semántica: {calls:?}");
    assert_eq!(event_count(&w.core, &a1, "attempt.queued"), 0);
    // La clave sigue libre: nada se atendió.
    assert!(steer(&w, &a1, "s-1", "cambia de plan").unwrap_err().contains("steer_unsupported"));
    stop(&w, &task);
}

/// El proveedor rechaza el steer: el resultado es `failed` con su motivo, el error lo dice y repetirlo con la misma clave no insiste.
#[test]
fn steer_rechazado_por_el_proveedor_se_registra_como_failed_y_no_se_reintenta() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-sf"), Step::Hold, Step::Complete(None)]);
    let a1 = w.create("claude", "e2e-steer-falla");
    w.approve(&a1);
    running(&w, &a1);
    w.adapter.fail_steer_with(Some(AdapterError::provider("el proveedor no pudo recibirlo")));

    let err = steer(&w, &a1, "s-1", "inténtalo").unwrap_err();
    assert!(err.contains("steer_failed"), "{err}");
    let result = payloads(&w.core, &a1, "attempt.instruction_result");
    assert_eq!((result[0]["outcome"].as_str(), result[0]["reason"].as_str()), (Some("failed"), Some("adapter_error")));
    assert!(steer(&w, &a1, "s-1", "inténtalo").unwrap_err().contains("steer_failed"), "la misma clave repite el mismo fallo");
    assert_eq!(w.adapter.calls().iter().filter(|c| c.starts_with("steer:")).count(), 1, "no se reintentó contra el proveedor");
    assert_eq!(instruction_events(&w.core, &a1), 2);
    w.adapter.release_hold();
    w.settled(&a1, "done");
}

/// Un Attempt terminado no admite Steer ni Stop & Send; uno que espera una respuesta tampoco (eso es un `answer`).
#[test]
fn un_attempt_terminado_o_a_la_espera_de_una_respuesta_no_admite_instrucciones() {
    let w = world("claude", Some(vec![Step::Bind("sess-fin"), Step::Complete(Some("ok".into()))]));
    let a1 = w.create("claude", "e2e-steer-final");
    w.approve(&a1);
    w.settled(&a1, "done");
    for err in [steer(&w, &a1, "s-1", "tarde").unwrap_err(), stop_and_send(&w, &a1, "s-2", "tarde").unwrap_err()] {
        assert!(err.contains("invalid/attempt_final"), "{err}");
    }
    assert_eq!(instruction_events(&w.core, &a1), 0);

    let w = world("claude", Some(vec![Step::Bind("sess-perm"), Step::Permission { id: "p1", tool: "Bash" }, Step::Wait]));
    let a2 = w.create("claude", "e2e-steer-espera");
    w.approve(&a2);
    let task = a2.rsplit_once("-a").unwrap().0.to_string();
    wait_until("el Attempt espera la aprobación", || row(&w.core, &a2).0 == "awaiting_terminal_approval");
    for err in [steer(&w, &a2, "s-1", "ahora").unwrap_err(), stop_and_send(&w, &a2, "s-2", "ahora").unwrap_err()] {
        assert!(err.contains("busy/not_running"), "{err}");
    }
    assert_eq!(instruction_events(&w.core, &a2), 0);
    assert!(!w.adapter.calls().iter().any(|c| c.starts_with("steer") || c == "interrupt"));
    wait_until("la ejecución está registrada", || w.core.has_term(&task));
    stop(&w, &task);
}

// ── Stop & Send ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// El camino feliz: se interrumpe el turno, el adapter CONFIRMA el stop (su `events` vuelve) y solo entonces se envía la instrucción
/// reanudando la sesión; el Attempt sigue vivo y termina bien con el turno nuevo.
#[test]
fn stop_and_send_interrumpe_espera_la_confirmacion_y_envia_como_turno_nuevo() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-ss"), Step::Output("trabajando".into()), Step::Wait]);
    w.adapter.push_turn(vec![Step::Output("rehago".into()), Step::Complete(Some("rehecho".into()))]);
    let a1 = w.create("claude", "e2e-ss-ok");
    w.approve(&a1);
    let task = running(&w, &a1);
    bound(&w, &task);

    let done = stop_and_send(&w, &a1, "x-1", "para y rehaz el informe").expect("stop_and_send");
    assert_eq!((done["status"].as_str(), done["mode"].as_str()), (Some("Delivered"), Some("stop_and_send")));
    w.settled(&a1, "done");

    let calls = w.adapter.calls();
    let (interrupt, resume) = (calls.iter().position(|c| c == "interrupt").unwrap(), calls.iter().position(|c| c == "resume").unwrap());
    assert!(interrupt < resume, "el stop se pide antes de enviar: {calls:?}");
    let resumes = w.adapter.resumes();
    assert_eq!(resumes.len(), 1);
    assert_eq!((resumes[0].prompt.as_deref(), resumes[0].provider_ref.expose()), (Some("para y rehaz el informe"), "sess-ss"));
    assert!(!calls.iter().any(|c| c.starts_with("steer")), "Stop & Send no es Steer");
    assert_eq!(w.adapter.starts().len(), 1);
    // El mismo Attempt sigue: un solo comienzo, ningún cierre por la interrupción, termina con el turno nuevo.
    assert_eq!((event_count(&w.core, &a1, "attempt.started"), event_count(&w.core, &a1, "attempt.exited"), event_count(&w.core, &a1, "attempt.completed")), (1, 0, 1));
    let result = payloads(&w.core, &a1, "attempt.instruction_result");
    assert_eq!((result[0]["request_id"].as_str(), result[0]["mode"].as_str(), result[0]["outcome"].as_str()), (Some("x-1"), Some("stop_and_send"), Some("delivered")));
    // Repetirlo no interrumpe ni envía otra vez.
    let again = stop_and_send(&w, &a1, "x-1", "para y rehaz el informe");
    assert_eq!(again.unwrap()["status"], "Replayed");
    assert_eq!((w.adapter.resumes().len(), w.adapter.calls().iter().filter(|c| *c == "interrupt").count()), (1, 1));
}

/// El proveedor rechaza el stop: NO se presenta como éxito, no se envía nada y el Attempt sigue corriendo.
#[test]
fn un_stop_rechazado_no_envia_nada_y_se_registra_como_stop_failed() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-sf"), Step::Hold, Step::Complete(Some("sigue".into()))]);
    let a1 = w.create("claude", "e2e-ss-stop-falla");
    w.approve(&a1);
    let task = running(&w, &a1);
    bound(&w, &task);
    w.adapter.fail_interrupt_with(Some(AdapterError::provider("no se pudo interrumpir")));

    let err = stop_and_send(&w, &a1, "x-1", "cámbialo").unwrap_err();
    assert!(err.contains("failed/stop_failed"), "{err}");
    let result = payloads(&w.core, &a1, "attempt.instruction_result");
    assert_eq!((result[0]["outcome"].as_str(), result[0]["reason"].as_str()), (Some("stop_failed"), Some("adapter_error")));
    assert!(w.adapter.resumes().is_empty(), "sin stop confirmado no se envía nada");
    assert_eq!(row(&w.core, &a1).0, "running", "el Attempt sigue vivo");
    w.adapter.release_hold();
    w.settled(&a1, "done");
    assert!(w.adapter.resumes().is_empty());
}

/// El stop se pidió pero el proveedor no lo confirma a tiempo: `stop_timeout`, nada se envía —ni siquiera si el stop llega tarde— y
/// la instrucción pendiente queda retirada.
#[test]
fn un_stop_que_no_se_confirma_a_tiempo_es_stop_timeout_y_un_stop_tardio_no_envia() {
    let w = world("claude", None);
    // `Hold` no reacciona a la interrupción: el stop se acepta pero el turno no acaba.
    w.adapter.push_turn(vec![Step::Bind("sess-to"), Step::Hold, Step::Complete(Some("terminó solo".into()))]);
    let a1 = w.create("claude", "e2e-ss-timeout");
    w.approve(&a1);
    let task = running(&w, &a1);
    bound(&w, &task);
    w.core.instructions.set_stop_wait(Duration::from_millis(300));

    let err = stop_and_send(&w, &a1, "x-1", "demasiado tarde").unwrap_err();
    assert!(err.contains("failed/stop_timeout"), "{err}");
    let result = payloads(&w.core, &a1, "attempt.instruction_result");
    assert_eq!(result[0]["outcome"], "stop_timeout");
    // Ahora el turno acaba por su cuenta: la instrucción retirada NO se envía.
    w.adapter.release_hold();
    w.settled(&a1, "done");
    assert!(w.adapter.resumes().is_empty(), "un stop tardío no envía lo que ya se dio por no confirmado");
}

/// El stop se confirmó pero la instrucción no llegó: el resultado es `failed` con su motivo (no `delivered`) y el Attempt, interrumpido,
/// termina `exited`: la persona lo ve y decide.
#[test]
fn si_la_instruccion_no_llega_tras_el_stop_el_resultado_es_failed_y_no_delivered() {
    let w = world("claude", None);
    w.adapter.push_turn(vec![Step::Bind("sess-sendf"), Step::Wait]);
    let a1 = w.create("claude", "e2e-ss-send-falla");
    w.approve(&a1);
    let task = running(&w, &a1);
    bound(&w, &task);
    w.adapter.fail_resume_with(Some(AdapterError::provider("el proveedor se cayó al reanudar")));

    let err = stop_and_send(&w, &a1, "x-1", "esto no llegará").unwrap_err();
    assert!(err.contains("failed/send_failed"), "{err}");
    let result = payloads(&w.core, &a1, "attempt.instruction_result");
    assert_eq!((result[0]["outcome"].as_str(), result[0]["reason"].as_str()), (Some("failed"), Some("adapter_error")));
    assert_eq!(event_count(&w.core, &a1, "attempt.instruction_result"), 1);
    w.settled(&a1, "exited");
    assert!(w.adapter.resumes().is_empty());
}

/// Sin `resume` no se puede enviar tras parar: se rechaza ANTES de interrumpir nada (parar sin poder enviar perdería la instrucción).
#[test]
fn stop_and_send_sin_resume_se_rechaza_antes_de_interrumpir() {
    let w = world_without(Capability::Resume, vec![Step::Bind("sess-nr"), Step::Output("trabajando".into()), Step::Wait]);
    let a1 = w.create("claude", "e2e-ss-sin-resume");
    w.approve(&a1);
    let task = running(&w, &a1);
    bound(&w, &task);

    let err = stop_and_send(&w, &a1, "x-1", "cambia").unwrap_err();
    assert!(err.contains("unsupported/stop_send_unsupported"), "{err}");
    assert!(!w.adapter.calls().iter().any(|c| c == "interrupt"), "no se interrumpió nada");
    assert_eq!(instruction_events(&w.core, &a1), 0);
    assert_eq!(row(&w.core, &a1).0, "running");
    stop(&w, &task);
}

/// Sin sesión declarada por el proveedor no hay a qué reanudar: se rechaza antes de interrumpir.
#[test]
fn stop_and_send_sin_sesion_declarada_se_rechaza_antes_de_interrumpir() {
    let w = world("claude", Some(vec![Step::Output("trabajando".into()), Step::Wait]));
    let a1 = w.create("claude", "e2e-ss-sin-sesion");
    w.approve(&a1);
    let task = running(&w, &a1);

    let err = stop_and_send(&w, &a1, "x-1", "cambia").unwrap_err();
    assert!(err.contains("session_missing"), "{err}");
    assert!(!w.adapter.calls().iter().any(|c| c == "interrupt"));
    assert_eq!(instruction_events(&w.core, &a1), 0);
    stop(&w, &task);
}

// ── Quién y qué ──────────────────────────────────────────────────────────────────────────────────────────────────────

/// Actor y entrada: un agente no instruye por este RPC, el Attempt tiene que existir, la clave y el texto se validan y no hay campos
/// libres. Nada de lo rechazado escribe.
#[test]
fn el_rpc_rechaza_lo_que_no_debe_y_no_escribe() {
    let w = world("claude", Some(vec![Step::Bind("sess-rc"), Step::Output("trabajando".into()), Step::Wait]));
    let a1 = w.create("claude", "e2e-steer-rechazos");
    w.approve(&a1);
    let task = running(&w, &a1);
    let args = |extra: (&str, Value)| {
        let mut v = json!({"attempt_id": a1, "request_id": "s-1", "body": "x"});
        v[extra.0] = extra.1;
        v
    };

    for cmd in ["attempt_steer", "attempt_stop_and_send"] {
        assert!(w.core.rpc(Caller::Agent(Some(task.clone())), "", cmd, &args(("body", json!("x")))).is_err(), "{cmd}: un agente no instruye por este RPC");
        assert!(w.desktop(cmd, json!({"attempt_id": "nadie-a1", "request_id": "s-1", "body": "x"})).unwrap_err().contains("attempt_missing"));
        assert!(w.desktop(cmd, args(("request_id", json!("con espacios")))).unwrap_err().contains("invalid_request"));
        assert!(w.desktop(cmd, args(("body", json!("   ")))).unwrap_err().contains("invalid_request"), "una instrucción vacía no se envía");
        assert!(w.desktop(cmd, args(("body", json!("x".repeat(20_001))))).unwrap_err().contains("invalid_request"), "el texto está acotado");
        assert!(w.desktop(cmd, args(("author", json!("agent")))).is_err(), "el autor sale de la identidad autenticada, no del cliente");
        assert!(w.desktop(cmd, json!({"attempt_id": a1, "body": "x"})).is_err(), "la clave de idempotencia es obligatoria");
    }
    assert_eq!(instruction_events(&w.core, &a1), 0, "ninguna petición rechazada escribe");
    assert!(!attention(&w.core, &a1).iter().any(|(c, s)| c == "failed" && s == "active"));
    stop(&w, &task);
}
