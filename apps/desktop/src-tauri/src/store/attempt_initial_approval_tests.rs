//! Coverage for the durable initial-approval decision (Person credential, deadline, run-closed rejection).
//! Scratch directories are unique and intentionally retained; these tests never
//! delete databases or invoke a provider/PTY.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use super::{
    ActorKind, AttemptAction, AttemptStatus, ClientCredential, ClientPrincipal,
    ClientRegistration, ClientSurface, DeviceIdentity, EventClass, Fingerprint,
    InitialApprovalDecision, Migration, NewAttempt, NewEvent, NewLocation, NewRun, NewTaskIntent, Store,
    AGENTIC_MODEL, AGENTIC_MODEL_KEY,
};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// Las migraciones del binario con el CORTE sustituido por una migración vacía: la 019 (plazo de la aprobación) queda
/// detrás de la barrera del corte y el migrador general no la aplica sin ella.
fn post_cut_migrations() -> Vec<Migration> {
    super::migrate::embedded()
        .into_iter()
        .map(|m| if m.name == super::cut::CUT_NAME { Migration::new(m.version, "corte_neutro_aprobacion_test", "SELECT 1;") } else { m })
        .collect()
}

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let tick = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let path = std::env::temp_dir().join(format!(
            "lxo-initial-approval-{}-{tick}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

fn event(
    kind: &str,
    class: EventClass,
    actor_kind: ActorKind,
    actor_id: Option<&str>,
    channel: &str,
    entity_kind: &str,
    entity_id: &str,
    run_id: &str,
    project_id: &str,
    payload: &str,
    at: i64,
) -> NewEvent {
    NewEvent {
        id: super::new_uuid_v7(),
        at,
        v: 1,
        kind: kind.into(),
        class,
        actor_kind,
        actor_id: actor_id.map(str::to_owned),
        channel: Some(channel.into()),
        client_id: None,
        project_id: Some(project_id.into()),
        run_id: Some(run_id.into()),
        entity_kind: entity_kind.into(),
        entity_id: entity_id.into(),
        correlation_id: None,
        idem_key: None,
        payload: payload.into(),
    }
}

fn create_task(store: &mut Store, project_id: &str, suffix: &str, at: i64) -> (String, String) {
    let (run, task) = store
        .run_create_recorded(
            &NewRun {
                objective: format!("approval recovery {suffix}"),
                project_id: project_id.into(),
                root: NewTaskIntent {
                    title: format!("task {suffix}"),
                    spec: String::new(),
                    repo: "C:/lxo-initial-approval".into(),
                },
            },
            at,
            |run, task| {
                Ok(vec![
                    event(
                        "run.created",
                        EventClass::State,
                        ActorKind::System,
                        None,
                        "core",
                        "run",
                        &run.id,
                        &run.id,
                        project_id,
                        "{}",
                        at,
                    ),
                    event(
                        "task.created",
                        EventClass::State,
                        ActorKind::System,
                        None,
                        "core",
                        "task",
                        &task.id,
                        &run.id,
                        project_id,
                        "{}",
                        at,
                    ),
                ])
            },
        )
        .unwrap();
    (run.id, task.id)
}

#[test]
fn direct_store_approval_checks_credential_revocation_at_the_event_instant() {
    const EVENT_AT: i64 = 100;

    for (revoked_at, surface, channel, should_approve) in [
        (99, ClientSurface::Desktop, "ui", false),
        (EVENT_AT, ClientSurface::Desktop, "ui", false),
        (101, ClientSurface::Desktop, "ui", true),
        // Historical `lxo` facts are bound to a CLI credential, not a Desktop one.
        (101, ClientSurface::Cli, "lxo", true),
    ] {
        let scratch = Scratch::new();
        let mut store = Store::open_with(&scratch.0, &post_cut_migrations(), "lxo-141-approval-revocation-test").unwrap();
        let project = store
            .project_create(
                "approval-revocation-test",
                &Fingerprint::default(),
                &NewLocation {
                    machine: "approval-revocation-test".into(),
                    path: "C:/lxo-approval-revocation".into(),
                    display_path: "C:/lxo-approval-revocation".into(),
                    primary: true,
                },
            )
            .unwrap()
            .id;
        store.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();

        let person_id = "person-approval-revocation";
        let registration = ClientRegistration::new(
            surface,
            DeviceIdentity::new("approval-revocation-desktop", None).unwrap(),
        )
        .unwrap();
        let credential = ClientCredential::new(
            ClientPrincipal::Person(person_id.into()),
            "approval-revocation-test-secret-0123456789abcdef",
        )
        .unwrap();
        let authenticated = store.register_client(&registration, &credential, 10).unwrap();
        let client_id = authenticated.identity().client_id().to_string();
        let credential_id = credential.credential_id().to_string();

        let (run, task) = create_task(&mut store, &project, "credential-revocation", 20);
        let attempt = store
            .attempt_create_recorded(
                &task,
                &NewAttempt {
                    provider: "fake".into(),
                    model: None,
                    effort: None,
                    role: None,
                    profile: None,
                    external: false,
                    requires_approval: true,
                },
                80,
                |attempt, task| {
                    Ok(event(
                        "attempt.requested",
                        EventClass::State,
                        ActorKind::System,
                        None,
                        "core",
                        "attempt",
                        &attempt.id,
                        &run,
                        task.project_id.as_deref().unwrap_or_default(),
                        "{}",
                        80,
                    ))
                },
            )
            .unwrap();
        assert!(store.revoke_credential(&credential_id, revoked_at).unwrap());

        let result = store.attempt_transition_recorded(
            &attempt.id,
            &AttemptAction::Approve,
            EVENT_AT,
            |attempt, _, task| {
                let mut approved = event(
                    "attempt.approved",
                    EventClass::Decision,
                    ActorKind::Person,
                    Some(person_id),
                    channel,
                    "attempt",
                    &attempt.id,
                    &run,
                    task.project_id.as_deref().unwrap_or_default(),
                    &format!(r#"{{"task":"{}","n":{}}}"#, attempt.task_id, attempt.n),
                    EVENT_AT,
                );
                approved.client_id = Some(client_id.clone());
                Ok(approved)
            },
        );

        if should_approve {
            assert!(matches!(result, Ok(super::ChangeOutcome::Changed)));
            assert_eq!(
                store.attempt_initial_approval_snapshot(&attempt.id).unwrap().unwrap().decision,
                Some(InitialApprovalDecision::Approved),
                "revocation after the event must not erase an already-valid approval"
            );
        } else {
            assert!(matches!(result, Err(super::StoreError::InvalidEvent(_))));
            assert_eq!(
                store.attempt_row(&attempt.id).unwrap().unwrap().status,
                AttemptStatus::PendingApproval,
                "revocation before or at the event rejects the write atomically"
            );
            assert_eq!(
                store
                    .read(|conn| Ok(conn.query_row(
                        "SELECT count(*) FROM events WHERE kind='attempt.approved' AND entity_id=?1",
                        [&attempt.id],
                        |row| row.get::<_, i64>(0),
                    )?))
                    .unwrap(),
                0
            );
        }
    }
}

#[test]
fn run_closed_snapshot_ignores_rejection_without_canonical_forced_close_commit() {
    let scratch = Scratch::new();
    let mut store = Store::open_with(&scratch.0, &post_cut_migrations(), "lxo-141-run-closed-snapshot-test").unwrap();
    let project = store
        .project_create(
            "run-closed-snapshot-test",
            &Fingerprint::default(),
            &NewLocation {
                machine: "run-closed-snapshot-test".into(),
                path: "C:/lxo-run-closed-snapshot".into(),
                display_path: "C:/lxo-run-closed-snapshot".into(),
                primary: true,
            },
        )
        .unwrap()
        .id;
    store.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let (run, task) = create_task(&mut store, &project, "forged-run-closed", 10);
    let attempt = store
        .attempt_create_recorded(
            &task,
            &NewAttempt {
                provider: "fake".into(),
                model: None,
                effort: None,
                role: None,
                profile: None,
                external: false,
                requires_approval: true,
            },
            20,
            |attempt, task| {
                Ok(event(
                    "attempt.requested",
                    EventClass::State,
                    ActorKind::System,
                    None,
                    "core",
                    "attempt",
                    &attempt.id,
                    &run,
                    task.project_id.as_deref().unwrap_or_default(),
                    "{}",
                    20,
                ))
            },
        )
        .unwrap();

    store
        .attempt_transition_recorded(&attempt.id, &AttemptAction::Cancel, 30, |attempt, _, task| {
            Ok(event(
                "attempt.rejected",
                EventClass::Decision,
                ActorKind::System,
                None,
                "core",
                "attempt",
                &attempt.id,
                &run,
                task.project_id.as_deref().unwrap_or_default(),
                &format!(
                    r#"{{"task":"{}","n":{},"cause":"run_closed"}}"#,
                    attempt.task_id, attempt.n
                ),
                30,
            ))
        })
        .unwrap();

    let snapshot = store
        .attempt_initial_approval_snapshot(&attempt.id)
        .unwrap()
        .unwrap();
    assert_eq!(snapshot.status, AttemptStatus::Stopped);
    assert_eq!(
        snapshot.decision, None,
        "a payload fragment without a forced run.closed fact in the same runtime commit is not historical evidence"
    );
}
