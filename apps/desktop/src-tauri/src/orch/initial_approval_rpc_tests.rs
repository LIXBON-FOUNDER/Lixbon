//! El RPC `attempt_approve` / `attempt_reject` (LXO-141, fase 2c-2) por la frontera autenticada real, con un Core, SQLite y
//! clientes registrados. Cada prueba comprueba lo durable (filas y eventos), no solo la respuesta.

use serde_json::{json, Value};

use super::events::Channel;
use super::initial_approval_tests::e2e::{core_with_pending_attempt, make_deadline_due};
use super::state::Status;
use super::Core;
use crate::store::{AuthenticatedClient, ClientClaims, ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity};

/// El secreto de la Person que registra la fixture de las pruebas de 2a.
const PERSON_SECRET: &str = "e2e-person-secret-0123456789abcdef";

fn person(core: &Core) -> AuthenticatedClient {
    core.authenticate_client(PERSON_SECRET).unwrap().unwrap()
}

/// Registra otro cliente (otra superficie o principal) y lo autentica.
fn other_client(core: &Core, surface: ClientSurface, principal: ClientPrincipal, secret: &str) -> AuthenticatedClient {
    core.storage
        .with_store(|store| {
            let registration = ClientRegistration::new(surface, DeviceIdentity::new(format!("install-{secret}"), None).unwrap()).unwrap();
            store.register_client(&registration, &ClientCredential::new(principal, secret).unwrap(), 10_001).unwrap();
        })
        .unwrap();
    core.authenticate_client(secret).unwrap().unwrap()
}

fn call(core: &std::sync::Arc<Core>, client: &AuthenticatedClient, channel: Channel, cmd: &str, args: Value) -> Result<Value, String> {
    core.rpc_authenticated_via(client, &ClientClaims::default(), channel, "", cmd, &args)
}

fn attempt_status(core: &Core, attempt: &str) -> String {
    core.storage.with_store(|store| store.read(|c| Ok(c.query_row("SELECT status FROM attempts WHERE id = ?1", [attempt], |r| r.get::<_, String>(0))?))).unwrap().unwrap()
}

fn event_count(core: &Core, attempt: &str, kind: &str) -> i64 {
    core.storage
        .with_store(|store| store.read(|c| Ok(c.query_row("SELECT count(*) FROM events WHERE kind = ?1 AND entity_id = ?2", [kind, attempt], |r| r.get(0))?)))
        .unwrap()
        .unwrap()
}

/// (actor_kind, actor_id, channel, client_id, payload) del único evento de ese tipo.
fn decision_event(core: &Core, attempt: &str, kind: &str) -> (String, Option<String>, Option<String>, Option<String>, Value) {
    core.storage
        .with_store(|store| {
            store.read(|c| {
                Ok(c.query_row("SELECT actor_kind, actor_id, channel, client_id, payload FROM events WHERE kind = ?1 AND entity_id = ?2", [kind, attempt], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, serde_json::from_str::<Value>(&r.get::<_, String>(4)?).unwrap()))
                })?)
            })
        })
        .unwrap()
        .unwrap()
}

#[test]
fn una_person_en_desktop_aprueba_y_repetirlo_es_un_replay_sin_escribir() {
    let (core, _ctx, task, attempt) = core_with_pending_attempt();
    let desktop = person(&core);

    let first = call(&core, &desktop, Channel::Ui, "attempt_approve", json!({"attempt_id": attempt})).unwrap();
    assert_eq!(first, json!({"status": "Approved", "decision": null, "attempt_id": attempt}));
    assert_eq!(attempt_status(&core, &attempt), "starting");
    assert_eq!(core.lock().tasks[&task].status, Status::Starting);
    let (actor_kind, actor_id, channel, client_id, payload) = decision_event(&core, &attempt, "attempt.approved");
    assert_eq!((actor_kind.as_str(), actor_id.as_deref(), channel.as_deref()), ("person", Some("e2e-person"), Some("ui")));
    assert!(client_id.is_some_and(|c| !c.is_empty()), "la decisión queda atribuida al cliente de la Person");
    assert_eq!(payload, json!({"task": task, "n": 1}));

    // La aprobación pone al Attempt en la cola del despachador, sin lanzar nada.
    assert_eq!(core.approved_dispatch_candidates(8).unwrap(), vec![attempt.clone()]);

    let rev = core.storage.with_store(|s| s.runtime_rev().unwrap()).unwrap();
    let again = call(&core, &desktop, Channel::Ui, "attempt_approve", json!({"attempt_id": attempt})).unwrap();
    assert_eq!(again, json!({"status": "Replayed", "decision": "approved", "attempt_id": attempt}));
    assert_eq!(event_count(&core, &attempt, "attempt.approved"), 1);
    assert_eq!(core.storage.with_store(|s| s.runtime_rev().unwrap()).unwrap(), rev, "un replay no escribe ni sube la revisión");

    let opposite = call(&core, &desktop, Channel::Ui, "attempt_reject", json!({"attempt_id": attempt})).unwrap_err();
    assert!(opposite.contains("ya fue aprobado"), "{opposite}");
    assert_eq!(attempt_status(&core, &attempt), "starting");
}

#[test]
fn rechazar_detiene_el_attempt_y_no_entra_en_la_cola_de_despacho() {
    let (core, _ctx, task, attempt) = core_with_pending_attempt();
    let desktop = person(&core);

    let rejected = call(&core, &desktop, Channel::Ui, "attempt_reject", json!({"attempt_id": attempt})).unwrap();
    assert_eq!(rejected, json!({"status": "Rejected", "decision": null, "attempt_id": attempt}));
    assert_eq!(attempt_status(&core, &attempt), "stopped");
    assert_eq!(core.lock().tasks[&task].status, Status::Stopped);
    assert_eq!(event_count(&core, &attempt, "attempt.rejected"), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.approved"), 0);
    assert!(core.approved_dispatch_candidates(8).unwrap().is_empty());

    let again = call(&core, &desktop, Channel::Ui, "attempt_reject", json!({"attempt_id": attempt})).unwrap();
    assert_eq!(again, json!({"status": "Replayed", "decision": "rejected", "attempt_id": attempt}));
    assert_eq!(event_count(&core, &attempt, "attempt.rejected"), 1);
    let opposite = call(&core, &desktop, Channel::Ui, "attempt_approve", json!({"attempt_id": attempt})).unwrap_err();
    assert!(opposite.contains("ya fue rechazado"), "{opposite}");
}

#[test]
fn aprobar_con_el_plazo_vencido_no_aprueba_y_deja_el_attempt_expirado() {
    let (core, _ctx, task, attempt) = core_with_pending_attempt();
    let desktop = person(&core);
    make_deadline_due(&core, &attempt);

    let late = call(&core, &desktop, Channel::Ui, "attempt_approve", json!({"attempt_id": attempt})).unwrap();
    assert_eq!(late, json!({"status": "Expired", "decision": null, "attempt_id": attempt}));
    assert_eq!(attempt_status(&core, &attempt), "stopped");
    assert_eq!(core.lock().tasks[&task].status, Status::Stopped);
    assert_eq!(event_count(&core, &attempt, "attempt.approved"), 0, "una aprobación tardía no deja un hecho de aprobación");
    let (actor_kind, _, channel, _, payload) = decision_event(&core, &attempt, "attempt.rejected");
    assert_eq!((actor_kind.as_str(), channel.as_deref()), ("system", Some("core")));
    assert_eq!(payload["cause"], "approval_timeout");
    assert!(core.approved_dispatch_candidates(8).unwrap().is_empty());

    // Rechazar tarde también informa la expiración, no una decisión de la Person.
    let (core, _ctx, _task, attempt) = core_with_pending_attempt();
    let desktop = person(&core);
    make_deadline_due(&core, &attempt);
    let late = call(&core, &desktop, Channel::Ui, "attempt_reject", json!({"attempt_id": attempt})).unwrap();
    assert_eq!(late["status"], "Expired");
    assert_eq!(event_count(&core, &attempt, "attempt.rejected"), 1);
}

#[test]
fn solo_una_person_de_desktop_decide_y_el_resto_no_cambia_nada() {
    let (core, _ctx, task, attempt) = core_with_pending_attempt();
    let cli = other_client(&core, ClientSurface::Cli, ClientPrincipal::Person("cli-person".into()), "cli-person-secret-0123456789abcdef-xyz");
    let agent = other_client(&core, ClientSurface::Cli, ClientPrincipal::Agent(task.clone()), "agent-secret-0123456789abcdef-xyzxyz");

    for cmd in ["attempt_approve", "attempt_reject"] {
        let by_cli = call(&core, &cli, Channel::Lxo, cmd, json!({"attempt_id": attempt})).unwrap_err();
        assert!(by_cli.contains("Acción no permitida"), "{cmd}: la Person del CLI no decide: {by_cli}");
        let by_agent = call(&core, &agent, Channel::Lxo, cmd, json!({"attempt_id": attempt})).unwrap_err();
        assert!(by_agent.contains("Acción no permitida"), "{cmd}: un agente nunca decide: {by_agent}");
    }
    assert_eq!(attempt_status(&core, &attempt), "pending_approval");
    assert_eq!(core.lock().tasks[&task].status, Status::PendingApproval);
    assert_eq!(event_count(&core, &attempt, "attempt.approved") + event_count(&core, &attempt, "attempt.rejected"), 0);
}

#[test]
fn una_entrada_invalida_o_un_attempt_inexistente_se_rechazan_sin_tocar_nada() {
    let (core, _ctx, task, attempt) = core_with_pending_attempt();
    let desktop = person(&core);
    let rev = core.storage.with_store(|s| s.runtime_rev().unwrap()).unwrap();

    let extra = call(&core, &desktop, Channel::Ui, "attempt_approve", json!({"attempt_id": attempt, "deadline": 9_999_999_999_999_i64})).unwrap_err();
    assert!(extra.contains("inválida"), "el cliente no puede aportar un plazo: {extra}");
    let missing_id = call(&core, &desktop, Channel::Ui, "attempt_approve", json!({"task_id": task})).unwrap_err();
    assert!(missing_id.contains("inválida"), "{missing_id}");
    let bad_id = call(&core, &desktop, Channel::Ui, "attempt_approve", json!({"attempt_id": format!("{task}-a01")})).unwrap_err();
    assert!(bad_id.contains("id de Attempt válido"), "{bad_id}");
    let unknown = call(&core, &desktop, Channel::Ui, "attempt_approve", json!({"attempt_id": "no-existe-a1"})).unwrap_err();
    assert!(unknown.contains("no existe el Attempt"), "{unknown}");
    // Otro Attempt de la misma Task que no es el actual.
    let stale = call(&core, &desktop, Channel::Ui, "attempt_approve", json!({"attempt_id": format!("{task}-a2")})).unwrap_err();
    assert!(stale.contains("no existe el Attempt"), "{stale}");

    assert_eq!(attempt_status(&core, &attempt), "pending_approval");
    assert_eq!(core.storage.with_store(|s| s.runtime_rev().unwrap()).unwrap(), rev);
}
