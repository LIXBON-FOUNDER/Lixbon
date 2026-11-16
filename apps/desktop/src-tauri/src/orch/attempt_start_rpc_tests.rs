//! F5: start del primer Attempt sobre una Task existente. La CLI solo crea la
//! solicitud pendiente; no despierta el dispatcher ni lanza un proveedor.

use serde_json::json;

use super::attempt_start_rpc::{self, StartInput};
use super::events::{Channel, MutationContext};
use super::initial_approval_tests::e2e::core_with_project;
use super::state::Status;
use super::Core;
use crate::store::{AttemptStatus, ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity};

fn cli_client(core: &Core) -> crate::store::AuthenticatedClient {
    core.storage
        .with_store(|store| {
            let registration = ClientRegistration::new(
                ClientSurface::Cli,
                DeviceIdentity::new("f5-cli-test", None).unwrap(),
            )
            .unwrap();
            let credential = ClientCredential::new(
                ClientPrincipal::Person("e2e-person".into()),
                "f5-cli-test-secret-0123456789abcdef",
            )
            .unwrap();
            store.register_client(&registration, &credential, 10_000).unwrap();
        })
        .unwrap();
    core.authenticate_client("f5-cli-test-secret-0123456789abcdef")
        .unwrap()
        .unwrap()
}

fn create_task(core: &std::sync::Arc<Core>, client: &crate::store::AuthenticatedClient, project: &str) -> String {
    core.rpc_authenticated_via(
        client,
        &crate::store::ClientClaims::default(),
        Channel::Ui,
        "",
        "task_create",
        &json!({
            "request_id":"f5-start-task",
            "project_id":project,
            "objective":"objetivo",
            "title":"Task para iniciar",
            "spec":"haz una tarea concreta",
        }),
    )
    .unwrap()["task_id"]
        .as_str()
        .unwrap()
        .to_string()
}

fn start_input(task_id: &str, model: Option<&str>) -> StartInput {
    StartInput {
        task_id: task_id.into(),
        provider: "claude".into(),
        profile: "explorar".into(),
        model: model.map(str::to_string),
        effort: None,
    }
}

#[test]
fn iniciar_una_task_existente_crea_un_attempt_pendiente_y_repetir_no_duplica() {
    let (core, desktop, _, project) = core_with_project();
    let task = create_task(&core, &desktop, &project);
    let cli = cli_client(&core);

    core.settings.lock().unwrap().enabled = true;
    core.sync_launcher();
    core.provider_registry.probe_all();

    let requested = core.rpc_authenticated_via(
            &cli,
            &crate::store::ClientClaims::default(),
            Channel::Lxo,
            "",
            "attempt_start",
            &json!({"task_id":task,"provider":"claude","profile":"explorar","model":"sonnet"}),
        )
        .unwrap();
    assert_eq!(requested["status"], "Requested");
    assert_eq!(requested["attempt_status"], "pending_approval");
    assert_eq!(
        core.rpc_authenticated_via(
            &cli,
            &crate::store::ClientClaims::default(),
            Channel::Lxo,
            "",
            "attempt_start",
            &json!({"task_id":task,"provider":"claude","profile":"explorar","model":"sonnet"}),
        )
        .unwrap()["attempt_id"],
        format!("{task}-a1"),
        "el RPC devuelve el mismo Attempt en una repetición exacta",
    );
    assert_eq!(
        core.attempt_row_for_resume(&format!("{task}-a1")).unwrap().unwrap().status,
        AttemptStatus::PendingApproval,
        "la repetición no modifica el estado pendiente",
    );
    assert!(
        core.rpc_authenticated_via(
            &cli,
            &crate::store::ClientClaims::default(),
            Channel::Lxo,
            "",
            "attempt_start",
            &json!({"task_id":task,"provider":"claude","profile":"explorar","model":"opus"}),
        )
        .is_err(),
        "una selección distinta no puede reemplazar el Attempt inicial",
    );

    assert_eq!(core.lock().tasks[&task].status, Status::PendingApproval);
    let attempt = core.attempt_row_for_resume(&format!("{task}-a1")).unwrap().unwrap();
    assert_eq!(attempt.status, AttemptStatus::PendingApproval);
    assert_eq!((attempt.provider.as_str(), attempt.model.as_deref(), attempt.profile.as_deref()), ("claude", Some("sonnet"), Some("explorar")));
    assert_eq!(super::dispatch_tests::row(&core, &attempt.id), ("pending_approval".into(), "none".into(), None));
    assert_eq!(super::dispatch_tests::event_count(&core, &attempt.id, "attempt.requested"), 1);
    assert_eq!(super::dispatch_tests::event_count(&core, &attempt.id, "attempt.started"), 0);
    core.dispatch_waiting_approved();
    assert_eq!(super::dispatch_tests::row(&core, &attempt.id).0, "pending_approval", "sin aprobación Desktop no hay lanzamiento");
}

#[test]
fn un_provider_unsupported_no_escribe_ni_crea_attempt() {
    let (core, desktop, _, project) = core_with_project();
    let task = create_task(&core, &desktop, &project);
    let cli = cli_client(&core);
    core.settings.lock().unwrap().enabled = true;
    core.sync_launcher();
    core.provider_registry.probe_all();

    let mut input = start_input(&task, None);
    input.provider = "not-registered".into();
    let context = MutationContext::authenticated(&cli, &crate::store::ClientClaims::default(), Channel::Lxo).unwrap();
    let error = attempt_start_rpc::start(&core, &context, &input).unwrap_err();
    assert!(error.starts_with("attempt_start_unsupported:"), "{error}");
    assert_eq!(core.lock().tasks[&task].status, Status::NotStarted);
    assert!(!core.lock().attempt_n.contains_key(&task));
}

#[test]
fn start_solo_acepta_persona_cli_y_solo_un_payload_estricto() {
    let (core, desktop, _, project) = core_with_project();
    let task = create_task(&core, &desktop, &project);
    let cli = cli_client(&core);
    let context = MutationContext::authenticated(&cli, &crate::store::ClientClaims::default(), Channel::Lxo).unwrap();
    let input = start_input(&task, None);
    assert!(attempt_start_rpc::start(&core, &MutationContext::core(), &input).is_err());
    assert!(attempt_start_rpc::start(&core, &context, &input).is_err(), "sin launcher disponible falla cerrado");

    let unknown = serde_json::from_value::<StartInput>(json!({
        "task_id":task,"provider":"claude","profile":"explorar","host":"remote"
    }));
    assert!(unknown.is_err(), "host se fija al Core local y no forma parte del RPC");
}
