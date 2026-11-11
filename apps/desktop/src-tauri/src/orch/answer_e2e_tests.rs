//! LXO-247 · Responder a una petición del proveedor de extremo a extremo por la superficie de Desktop (`rpc_via(Ui, User)`, el mismo
//! camino que `orch_call` del ADE), con proveedores falsos. Cada prueba comprueba el desenlace DURABLE y lo que de verdad llegó al
//! adapter: el estado del Attempt, la Attention `approval`, el plazo y las llamadas. Contrato: `docs/core/RESPUESTAS.md`.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::adapter::fake::{FakeAdapter, Step};
use super::adapter::{AdapterError, Capability, CapabilityMatrix, CapabilityState, ProbeResult};
use super::adapter_launcher::AdapterLauncher;
use super::adapter_launcher_tests::{registry_of, repo_with_commit};
use super::attempt_e2e_tests::{wait_until, world, World};
use super::dispatch_tests::{event_count, row};
use super::events::Channel;
use super::initial_approval_tests::e2e::core_with_project_at;
use super::{Caller, Core};

/// Como `world`, pero con la matriz de capabilities y el plazo de espera que se pidan.
fn world_custom(matrix: CapabilityMatrix, ttl: Option<Duration>, script: Vec<Step>) -> World {
    let repo = repo_with_commit();
    let (core, _client, _ctx, project) = core_with_project_at(&repo.to_string_lossy());
    let adapter = Arc::new(FakeAdapter::with_probe("claude", ProbeResult::ready(Some("0.0.0-fake"), matrix)));
    adapter.set_script(script);
    let mut launcher = AdapterLauncher::new(&core, registry_of(adapter.clone()));
    if let Some(ttl) = ttl {
        launcher = launcher.with_approval_ttl(ttl);
    }
    core.install_launcher(Arc::new(launcher));
    core.provider_registry.probe_all();
    World { core, project, adapter }
}

/// Un Attempt que pide `peticiones` y espera: el turno se queda en un `Hold` hasta que la prueba lo suelte.
fn waiting_world(peticiones: Vec<Step>) -> (World, String) {
    let w = world("claude", None);
    let mut script = vec![Step::Bind("sess-ans")];
    script.extend(peticiones);
    script.extend([Step::Hold, Step::Complete(Some("hecho".into()))]);
    w.adapter.push_turn(script);
    let attempt = w.create("claude", "e2e-answer");
    w.approve(&attempt);
    wait_until("el Attempt espera una respuesta", || row(&w.core, &attempt).0 == "awaiting_terminal_approval");
    (w, attempt)
}

fn answer(w: &World, attempt: &str, request_id: &str, text: &str) -> Result<Value, String> {
    w.desktop("attempt_answer", json!({"attempt_id": attempt, "request_id": request_id, "answer": text}))
}

fn pending(w: &World, attempt: &str) -> Vec<Value> {
    w.desktop("attempt_pending_requests", json!({"attempt_id": attempt})).expect("pendientes")["requests"].as_array().cloned().unwrap_or_default()
}

fn status(w: &World, attempt: &str) -> String {
    row(&w.core, attempt).0
}

fn active_approvals(core: &Core) -> i64 {
    core.storage
        .with_store(|s| s.read(|c| Ok(c.query_row("SELECT count(*) FROM attention_items WHERE category = 'approval' AND status = 'active'", [], |r| r.get(0))?)))
        .unwrap()
        .unwrap()
}

fn delivered(w: &World, prefix: &str) -> Vec<String> {
    w.adapter.calls().into_iter().filter(|c| c.starts_with(prefix)).collect()
}

// ── Responder ────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Un permiso: la persona lo ve pendiente, responde `allow`, el proveedor recibe la respuesta, el Attempt vuelve a `running`, la
/// Attention `approval` se resuelve y el Attempt termina bien (el plazo ya no cuenta).
#[test]
fn responder_un_permiso_lo_entrega_al_proveedor_y_el_attempt_vuelve_a_correr() {
    let (w, a1) = waiting_world(vec![Step::Permission { id: "p1", tool: "Bash" }]);
    assert_eq!(active_approvals(&w.core), 1, "la persona ve que algo espera");
    let listed = pending(&w, &a1);
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0]["request_id"].as_str(), listed[0]["kind"].as_str(), listed[0]["subject"].as_str()), (Some("p1"), Some("permission"), Some("Bash")));

    let done = answer(&w, &a1, "p1", "ALLOW").expect("responder");
    assert_eq!((done["status"].as_str(), done["request_id"].as_str(), done["kind"].as_str()), (Some("Answered"), Some("p1"), Some("permission")));
    assert_eq!(delivered(&w, "answer_text:"), vec!["answer_text:p1:allow".to_string()], "llegó `allow`, normalizado");
    assert_eq!(status(&w, &a1), "running", "ya no espera");
    assert_eq!(event_count(&w.core, &a1, "attempt.resumed"), 1, "queda constancia de que el Attempt volvió a correr");
    wait_until("la Attention approval se resuelve", || active_approvals(&w.core) == 0);
    assert!(pending(&w, &a1).is_empty());

    w.adapter.release_hold();
    w.settled(&a1, "done");
    assert_eq!(row(&w.core, &a1).2, None, "no falló por el plazo");
}

/// `deny` también se entrega, y la ejecución sigue: el proveedor decide qué hace con la negativa.
#[test]
fn negar_un_permiso_entrega_deny() {
    let (w, a1) = waiting_world(vec![Step::Permission { id: "p1", tool: "Bash" }]);
    answer(&w, &a1, "p1", "deny").expect("responder");
    assert_eq!(delivered(&w, "answer_text:"), vec!["answer_text:p1:deny".to_string()]);
    assert_eq!(status(&w, &a1), "running");
    w.adapter.release_hold();
    w.settled(&a1, "done");
}

/// Una pregunta se responde con texto libre.
#[test]
fn una_pregunta_se_responde_con_texto_libre() {
    let (w, a1) = waiting_world(vec![Step::Question { id: "q1", text: "¿sigo con la migración?".into() }]);
    let listed = pending(&w, &a1);
    assert_eq!((listed[0]["kind"].as_str(), listed[0]["subject"].as_str()), (Some("question"), Some("¿sigo con la migración?")));
    let done = answer(&w, &a1, "q1", "  sí, pero sin borrar nada  ").expect("responder");
    assert_eq!(done["kind"], "question");
    assert_eq!(delivered(&w, "answer_text:"), vec!["answer_text:q1:sí, pero sin borrar nada".to_string()]);
    assert_eq!(status(&w, &a1), "running");
    w.adapter.release_hold();
    w.settled(&a1, "done");
}

/// Con varias peticiones el Attempt sigue esperando hasta que se responde la ÚLTIMA: ni `running` con algo sin contestar ni el plazo apagado.
#[test]
fn con_varias_peticiones_el_attempt_vuelve_a_correr_solo_al_responder_la_ultima() {
    let (w, a1) = waiting_world(vec![Step::Permission { id: "p1", tool: "Bash" }, Step::Permission { id: "p2", tool: "Write" }]);
    wait_until("las dos peticiones están pendientes", || pending(&w, &a1).len() == 2);

    answer(&w, &a1, "p1", "allow").expect("primera");
    assert_eq!(status(&w, &a1), "awaiting_terminal_approval", "queda p2");
    assert_eq!(pending(&w, &a1).len(), 1);
    assert_eq!(active_approvals(&w.core), 1, "la Attention sigue activa");

    answer(&w, &a1, "p2", "deny").expect("segunda");
    assert_eq!(status(&w, &a1), "running");
    wait_until("la Attention se resuelve", || active_approvals(&w.core) == 0);
    w.adapter.release_hold();
    w.settled(&a1, "done");
}

// ── Idempotencia y rechazos ──────────────────────────────────────────────────────────────────────────────────────────

/// Repetir la respuesta (un reintento del cliente) devuelve lo que ya pasó sin volver a llamar al proveedor; otra respuesta a la misma
/// petición es un conflicto. El proveedor la recibió UNA vez.
#[test]
fn repetir_la_respuesta_es_idempotente_y_otra_respuesta_es_un_conflicto() {
    let (w, a1) = waiting_world(vec![Step::Permission { id: "p1", tool: "Bash" }]);
    answer(&w, &a1, "p1", "allow").expect("primera");
    let again = answer(&w, &a1, "p1", "allow").expect("repetida");
    assert_eq!(again["status"], "Replayed");
    let conflict = answer(&w, &a1, "p1", "deny").unwrap_err();
    assert!(conflict.contains("request_conflict"), "{conflict}");
    assert_eq!(delivered(&w, "answer:"), vec!["answer:p1".to_string()], "el proveedor recibió UNA respuesta");
    w.adapter.release_hold();
    w.settled(&a1, "done");
}

/// Una respuesta inválida no toca nada: la petición sigue pendiente, el proveedor no recibe nada y la correcta funciona después.
#[test]
fn una_respuesta_invalida_no_toca_nada_y_la_peticion_sigue_pendiente() {
    let (w, a1) = waiting_world(vec![Step::Permission { id: "p1", tool: "Bash" }]);
    for mala in ["quizás", "", "allow please"] {
        let e = answer(&w, &a1, "p1", mala).unwrap_err();
        assert!(e.contains("invalid_answer"), "{mala:?}: {e}");
    }
    assert!(delivered(&w, "answer:").is_empty(), "nada llegó al proveedor");
    assert_eq!((status(&w, &a1).as_str(), pending(&w, &a1).len()), ("awaiting_terminal_approval", 1));
    answer(&w, &a1, "p1", "allow").expect("la respuesta válida funciona después");
    w.adapter.release_hold();
    w.settled(&a1, "done");
}

/// Una petición que no existe, o de un Attempt que no está esperando, es un error claro y no toca nada.
#[test]
fn una_peticion_desconocida_es_un_error_claro() {
    let (w, a1) = waiting_world(vec![Step::Permission { id: "p1", tool: "Bash" }]);
    let e = answer(&w, &a1, "no-existe", "allow").unwrap_err();
    assert!(e.contains("request_unknown"), "{e}");
    let e = answer(&w, "e2e-nada-a1", "p1", "allow").unwrap_err();
    assert!(e.contains("attempt_missing"), "{e}");
    assert_eq!(status(&w, &a1), "awaiting_terminal_approval");
    assert!(delivered(&w, "answer:").is_empty());
}

/// Si el proveedor rechaza la respuesta, la petición SIGUE pendiente (el Attempt sigue esperando) y se puede volver a intentar.
#[test]
fn si_el_proveedor_rechaza_la_respuesta_la_peticion_sigue_pendiente() {
    let (w, a1) = waiting_world(vec![Step::Permission { id: "p1", tool: "Bash" }]);
    w.adapter.fail_answer_with(Some(AdapterError::provider("la CLI no aceptó la respuesta")));
    let e = answer(&w, &a1, "p1", "allow").unwrap_err();
    assert!(e.contains("answer_failed"), "{e}");
    assert_eq!((status(&w, &a1).as_str(), pending(&w, &a1).len()), ("awaiting_terminal_approval", 1), "nada cambió");

    w.adapter.fail_answer_with(None);
    answer(&w, &a1, "p1", "allow").expect("reintento");
    assert_eq!(status(&w, &a1), "running");
    w.adapter.release_hold();
    w.settled(&a1, "done");
}

/// Un proveedor sin la capability `answer`: error explícito y nada escrito; la petición sigue pendiente.
#[test]
fn sin_la_capability_answer_es_un_error_y_no_se_toca_nada() {
    let matrix = CapabilityMatrix::all_available().with(Capability::Answer, CapabilityState::Unsupported);
    let w = world_custom(matrix, None, vec![Step::Bind("sess-na"), Step::Permission { id: "p1", tool: "Bash" }, Step::Hold, Step::Complete(None)]);
    let a1 = w.create("claude", "e2e-answer-na");
    w.approve(&a1);
    wait_until("el Attempt espera", || status(&w, &a1) == "awaiting_terminal_approval");

    let e = answer(&w, &a1, "p1", "allow").unwrap_err();
    assert!(e.contains("answer_unsupported"), "{e}");
    assert!(delivered(&w, "answer:").is_empty(), "no se intentó nada");
    assert_eq!((status(&w, &a1).as_str(), pending(&w, &a1).len()), ("awaiting_terminal_approval", 1));
    w.adapter.release_hold();
}

/// El plazo sigue siendo el límite: pasado, la ejecución se cancela y una respuesta tardía es un error, no una resurrección.
#[test]
fn una_respuesta_tardia_tras_vencer_el_plazo_no_resucita_el_attempt() {
    let w = world_custom(CapabilityMatrix::all_available(), Some(Duration::from_millis(400)), vec![Step::Bind("sess-late"), Step::Permission { id: "p1", tool: "Bash" }, Step::Wait]);
    let a1 = w.create("claude", "e2e-answer-late");
    w.approve(&a1);
    wait_until("vence el plazo", || status(&w, &a1) == "failed");
    w.settled(&a1, "failed");
    assert_eq!(row(&w.core, &a1).2.as_deref(), Some("terminal_approval_timeout"));

    let e = answer(&w, &a1, "p1", "allow").unwrap_err();
    assert!(e.contains("attempt_final"), "{e}");
    assert!(delivered(&w, "answer:").is_empty(), "no se le dijo nada a un proveedor que ya se canceló");
    assert_eq!(status(&w, &a1), "failed", "no resucita");
}

/// Responder a tiempo apaga el plazo: aunque pase más tiempo que el TTL, el Attempt no falla por vencimiento.
#[test]
fn responder_a_tiempo_apaga_el_plazo() {
    let w = world_custom(CapabilityMatrix::all_available(), Some(Duration::from_millis(1500)), vec![Step::Bind("sess-ttl"), Step::Permission { id: "p1", tool: "Bash" }, Step::Hold, Step::Complete(Some("hecho".into()))]);
    let a1 = w.create("claude", "e2e-answer-ttl");
    w.approve(&a1);
    wait_until("el Attempt espera", || status(&w, &a1) == "awaiting_terminal_approval");
    answer(&w, &a1, "p1", "allow").expect("responder");
    std::thread::sleep(Duration::from_millis(2500)); // más que el TTL
    assert_eq!(status(&w, &a1), "running", "el plazo ya no cuenta: nadie lo cancela");
    w.adapter.release_hold();
    w.settled(&a1, "done");
    assert_eq!(row(&w.core, &a1).2, None);
}

// ── Quién ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Solo una Person de Desktop responde: ni un agente ni el CLI lo hacen por ella.
#[test]
fn solo_una_person_de_desktop_puede_responder() {
    let (w, a1) = waiting_world(vec![Step::Permission { id: "p1", tool: "Bash" }]);
    let task = a1.rsplit_once("-a").unwrap().0.to_string();
    let args = json!({"attempt_id": a1, "request_id": "p1", "answer": "allow"});
    let as_agent = w.core.rpc_via(Channel::Ui, Caller::Agent(Some(task)), "", "attempt_answer", &args);
    assert!(as_agent.is_err(), "un agente no responde por la persona: {as_agent:?}");
    let listing = w.core.rpc_via(Channel::Ui, Caller::Agent(None), "", "attempt_pending_requests", &json!({"attempt_id": a1}));
    assert!(listing.is_err(), "ni lee lo pendiente");
    assert!(delivered(&w, "answer:").is_empty());
    assert_eq!(status(&w, &a1), "awaiting_terminal_approval");
    assert_eq!(event_count(&w.core, &a1, "attempt.resumed"), 0);
}
