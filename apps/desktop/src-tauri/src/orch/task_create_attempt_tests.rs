//! `task_create` con `attempt` (LXO-141, fase 2c-3) por la frontera autenticada real: Core, SQLite, un `Launcher` falso y los
//! proveedores falsos del registro de pruebas. Cada prueba comprueba lo durable (filas, eventos, claim), no solo la respuesta.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::adapter::{CapabilityMatrix, Capability, CapabilityState, Environment, ProviderEntry};
use super::dispatch_tests::{calls, event_count, launcher, row, Calls, FakeLauncher};
use super::dispatch::StartOutcome;
use super::events::Channel;
use super::initial_approval_tests::e2e::core_with_project;
use super::provider_registry::{start_preflight, ProviderLookup};
use super::state::Status;
use super::task_create_api::ATTEMPT_NOT_AVAILABLE;
use super::Core;
use crate::store::{AuthenticatedClient, ClientClaims};

fn create(core: &Arc<Core>, client: &AuthenticatedClient, project: &str, request_id: &str, attempt: Value) -> Result<Value, String> {
    let mut args = json!({"request_id": request_id, "project_id": project, "objective": "o", "title": "t", "spec": "haz algo"});
    if !attempt.is_null() {
        args["attempt"] = attempt;
    }
    core.rpc_authenticated_via(client, &ClientClaims::default(), Channel::Ui, "", "task_create", &args)
}

fn decide(core: &Arc<Core>, client: &AuthenticatedClient, cmd: &str, attempt: &str) -> Result<Value, String> {
    core.rpc_authenticated_via(client, &ClientClaims::default(), Channel::Ui, "", cmd, &json!({"attempt_id": attempt}))
}

fn selection() -> Value {
    json!({"provider": "claude", "model": "m-1", "effort": "high", "profile": "explorar"})
}

/// Instala un lanzador falso y deja sondeados los proveedores falsos del registro de pruebas.
fn with_launcher(core: &Arc<Core>, start: StartOutcome) -> (Arc<FakeLauncher>, Calls) {
    let (fake, log) = launcher(Ok(()), start);
    let fake = Arc::new(fake);
    core.install_launcher(fake.clone());
    core.provider_registry.probe_all();
    (fake, log)
}

fn rev(core: &Core) -> i64 {
    core.storage.with_store(|s| s.runtime_rev().unwrap()).unwrap()
}

/// Espera (con límite) a que se cumpla una condición durable: el despachador corre en su propio hilo.
fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < end, "no se cumplió a tiempo: {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn sin_lanzador_instalado_un_attempt_se_rechaza_sin_escribir_nada() {
    let (core, client, _ctx, project) = core_with_project();
    core.provider_registry.probe_all();
    let before = rev(&core);

    let rejected = create(&core, &client, &project, "sin-lanzador", selection()).unwrap_err();
    assert_eq!(rejected, ATTEMPT_NOT_AVAILABLE);
    assert!(core.lock().tasks.is_empty(), "no se creó ninguna Task");
    assert_eq!(rev(&core), before, "ni se tocó el ledger ni la revisión");

    // La intención sola sigue funcionando sin lanzador.
    let intent = create(&core, &client, &project, "solo-intencion", Value::Null).unwrap();
    assert_eq!(intent["status"], "Committed");
    assert_eq!(intent["attempt_id"], Value::Null);
}

#[test]
fn con_lanzador_se_crea_la_task_con_su_primer_attempt_pendiente_de_aprobacion() {
    let (core, client, _ctx, project) = core_with_project();
    let (_fake, log) = with_launcher(&core, StartOutcome::Running);

    let created = create(&core, &client, &project, "con-attempt", selection()).unwrap();
    assert_eq!(created["status"], "Committed");
    let task = created["task_id"].as_str().unwrap().to_string();
    let attempt = created["attempt_id"].as_str().unwrap().to_string();
    assert_eq!(attempt, format!("{task}-a1"));

    assert_eq!(core.lock().tasks[&task].status, Status::PendingApproval);
    // El cliente no mandó `repo`: la Task guarda la ubicación VERIFICADA del Project (con un `repo` vacío no se podría
    // registrar el Worktree del Attempt, y la Task no lo cambia después).
    assert_eq!(core.lock().tasks[&task].repo, ".");
    let (status, claim, failure) = row(&core, &attempt);
    assert_eq!((status.as_str(), claim.as_str(), failure), ("pending_approval", "none", None));
    let (provider, model, effort, profile, external, deadline): (String, Option<String>, Option<String>, Option<String>, i64, Option<i64>) = core
        .storage
        .with_store(|s| {
            s.read(|c| {
                Ok(c.query_row(
                    "SELECT provider, model, effort, profile, external, initial_approval_deadline FROM attempts WHERE id = ?1",
                    [&attempt],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
                )?)
            })
        })
        .unwrap()
        .unwrap();
    assert_eq!((provider.as_str(), model.as_deref(), effort.as_deref(), profile.as_deref(), external), ("claude", Some("m-1"), Some("high"), Some("explorar"), 0));
    assert!(deadline.is_some_and(|d| d > 0), "el plazo durable de 30 min lo fija el servidor");
    assert_eq!(event_count(&core, &attempt, "attempt.requested"), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.approved"), 0);
    assert!(calls(&log).is_empty(), "crear no lanza nada: falta la decisión humana");
    assert!(core.approved_dispatch_candidates(8).unwrap().is_empty());

    // Un reintento del cliente es el mismo resultado, sin escribir ni duplicar.
    let before = rev(&core);
    let again = create(&core, &client, &project, "con-attempt", selection()).unwrap();
    assert_eq!(again, json!({"status": "Replayed", "run_id": created["run_id"], "task_id": task, "attempt_id": attempt}));
    assert_eq!(rev(&core), before);
    assert_eq!(event_count(&core, &attempt, "attempt.requested"), 1);
    assert_eq!(core.lock().tasks.len(), 1);

    // El mismo request_id con otra selección es un conflicto, también sin efectos.
    let other = json!({"provider": "codex", "profile": "explorar"});
    let conflict = create(&core, &client, &project, "con-attempt", other).unwrap_err();
    assert!(conflict.contains("otro payload"), "{conflict}");
    assert_eq!(core.lock().tasks.len(), 1);
    assert_eq!(rev(&core), before);
}

#[test]
fn un_proveedor_desconocido_o_sin_capability_se_rechaza_antes_de_escribir() {
    let (core, client, _ctx, project) = core_with_project();
    let (_fake, _log) = with_launcher(&core, StartOutcome::Running);
    let before = rev(&core);

    let unknown = create(&core, &client, &project, "desconocido", json!({"provider": "no-existe", "profile": "explorar"})).unwrap_err();
    assert!(unknown.starts_with("provider_unknown"), "{unknown}");
    // Perfil inválido o aplazado: se rechaza al parsear.
    let bad_profile = create(&core, &client, &project, "perfil", json!({"provider": "claude", "profile": "autonomia_amplia"})).unwrap_err();
    assert_eq!(bad_profile, "Solicitud task.create inválida");
    assert!(core.lock().tasks.is_empty());
    assert_eq!(rev(&core), before);
}

#[test]
fn el_preflight_exige_la_capability_de_lanzar_disponible() {
    let entry = |matrix: CapabilityMatrix| ProviderLookup::Found(Box::new(ProviderEntry { id: "x".into(), cli_version: None, environment: Environment::Ready, matrix, transport: None, transport_fallback: None }));
    let with_start = |state: CapabilityState| CapabilityMatrix::all_available().with(Capability::Start, state);

    assert!(start_preflight("x", &entry(CapabilityMatrix::all_available())).is_ok());
    assert!(start_preflight("x", &entry(with_start(CapabilityState::Available))).is_ok());
    assert!(start_preflight("x", &ProviderLookup::Probing).unwrap_err().starts_with("provider_probing"));
    assert!(start_preflight("x", &ProviderLookup::Unknown).unwrap_err().starts_with("provider_unknown"));
    assert!(start_preflight("x", &entry(with_start(CapabilityState::Unsupported))).unwrap_err().starts_with("provider_start_unsupported"));
    assert!(start_preflight("x", &entry(CapabilityMatrix::new())).unwrap_err().starts_with("provider_start_unsupported"));
    assert!(start_preflight("x", &entry(with_start(CapabilityState::unavailable("sin sesión")))).unwrap_err().starts_with("provider_start_unavailable"));
    let blocked = CapabilityMatrix::all_blocked(super::agents::EnvBlock::CliMissing);
    assert!(start_preflight("x", &entry(blocked)).unwrap_err().starts_with("provider_environment_blocked"));
}

#[test]
fn crear_aprobar_y_lanzar_ocurre_una_sola_vez() {
    let (core, client, _ctx, project) = core_with_project();
    let (fake, log) = with_launcher(&core, StartOutcome::Running);
    let created = create(&core, &client, &project, "e2e-lanzar", selection()).unwrap();
    let task = created["task_id"].as_str().unwrap().to_string();
    let attempt = created["attempt_id"].as_str().unwrap().to_string();

    let approved = decide(&core, &client, "attempt_approve", &attempt).unwrap();
    assert_eq!(approved["status"], "Approved");
    // El despachador corre en su propio hilo, despertado por la aprobación.
    // `start` (la llamada al proveedor) va DESPUÉS de que el claim avance a started.
    wait_until("se llama al proveedor", || calls(&log).iter().any(|c| c == "start"));

    assert_eq!(row(&core, &attempt), ("running".into(), "started".into(), None));
    assert_eq!(core.lock().tasks[&task].status, Status::Running);
    assert_eq!(event_count(&core, &attempt, "attempt.requested"), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.approved"), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.started"), 1);
    assert_eq!(calls(&log), vec![format!("prepare:{attempt}"), "start".to_string()]);
    let intents = fake.intents.lock().unwrap();
    assert_eq!(intents.len(), 1);
    assert_eq!((intents[0].provider.as_str(), intents[0].model.as_deref(), intents[0].effort.as_deref(), intents[0].profile.as_str()), ("claude", Some("m-1"), Some("high"), "explorar"));
    assert_eq!(intents[0].prompt, "haz algo", "el prompt sale del spec persistido");
    assert_eq!(intents[0].repo, std::path::PathBuf::from("."));
    drop(intents);

    // Ni repetir la aprobación, ni una nueva pasada, ni el barrido periódico relanzan al proveedor.
    assert_eq!(decide(&core, &client, "attempt_approve", &attempt).unwrap()["status"], "Replayed");
    core.periodic_sweep();
    core.dispatch_waiting_approved();
    assert_eq!(calls(&log).iter().filter(|c| *c == "start").count(), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.started"), 1);
}

#[test]
fn un_attempt_rechazado_nunca_se_lanza() {
    let (core, client, _ctx, project) = core_with_project();
    let (_fake, log) = with_launcher(&core, StartOutcome::Running);
    let created = create(&core, &client, &project, "e2e-rechazar", selection()).unwrap();
    let attempt = created["attempt_id"].as_str().unwrap().to_string();

    assert_eq!(decide(&core, &client, "attempt_reject", &attempt).unwrap()["status"], "Rejected");
    core.periodic_sweep();
    core.dispatch_waiting_approved();
    assert!(calls(&log).is_empty());
    assert_eq!(row(&core, &attempt), ("stopped".into(), "none".into(), None));
}

#[test]
fn un_aprobado_que_quedo_esperando_se_despacha_en_el_barrido_periodico() {
    let (core, client, ctx, project) = core_with_project();
    let (_fake, log) = with_launcher(&core, StartOutcome::Running);
    let created = create(&core, &client, &project, "e2e-recuperar", selection()).unwrap();
    let attempt = created["attempt_id"].as_str().unwrap().to_string();

    // La aprobación se confirma sin despertar al despachador (como si el Core cayera justo después).
    core.mutate_as(&ctx, |tx| tx.approve_attempt(&attempt)).unwrap();
    assert_eq!(row(&core, &attempt).1, "none");
    assert!(calls(&log).is_empty());

    // El hilo de fondo del Core también barre: dos despachadores pueden coincidir y el claim deja un único ganador, cuyo
    // desenlace puede tardar un instante en ser visible.
    core.periodic_sweep();
    wait_until("se llama al proveedor", || calls(&log).iter().any(|c| c == "start"));
    assert_eq!(row(&core, &attempt), ("running".into(), "started".into(), None));
    assert_eq!(calls(&log).iter().filter(|c| *c == "start").count(), 1, "un único ganador del claim");
}

#[test]
fn con_attempt_el_repo_de_la_task_es_la_ubicacion_del_project_y_no_lo_que_mande_el_cliente() {
    let (core, client, _ctx, project) = core_with_project();
    let (_fake, _log) = with_launcher(&core, StartOutcome::Running);
    let args = json!({"request_id": "repo-ajeno", "project_id": project, "objective": "o", "title": "t", "spec": "haz algo", "repo": "/otra/ruta", "attempt": selection()});
    let created = core.rpc_authenticated_via(&client, &ClientClaims::default(), Channel::Ui, "", "task_create", &args).unwrap();
    let task = created["task_id"].as_str().unwrap();
    assert_eq!(core.lock().tasks[task].repo, ".", "la ubicación del registro de proyectos, no la del cliente");
    assert_eq!(core.lock().tasks[task].cwd, ".");

    // Sin `attempt` la Task conserva lo que mandó el cliente.
    let intent = json!({"request_id": "repo-cliente", "project_id": project, "objective": "o", "title": "t", "repo": "/otra/ruta"});
    let created = core.rpc_authenticated_via(&client, &ClientClaims::default(), Channel::Ui, "", "task_create", &intent).unwrap();
    assert_eq!(core.lock().tasks[created["task_id"].as_str().unwrap()].repo, "/otra/ruta");
}
