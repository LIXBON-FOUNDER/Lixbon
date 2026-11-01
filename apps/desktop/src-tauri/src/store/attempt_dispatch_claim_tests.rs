//! Durable regression tests for the dispatch claim on Attempt (LXO-141).
//! Uses an isolated temporary Store; no project database is opened or removed.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

static NEXT: AtomicU64 = AtomicU64::new(0);

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        loop {
            let n = NEXT.fetch_add(1, Ordering::Relaxed);
            let tick = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default();
            let p = std::env::temp_dir().join(format!(
                "lxo-141-{}-{tick}-{n}",
                std::process::id()
            ));
            match std::fs::create_dir(&p) {
                Ok(()) => return Self(p),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("no se pudo crear el scratch exclusivo {}: {error}", p.display()),
            }
        }
    }
    fn path(&self) -> &Path { &self.0 }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        // Intentionally do not delete files: tests never perform database/data cleanup.
    }
}

/// Esquema de prueba con las migraciones de despacho: el CORTE se sustituye por una migración neutra (la 020 queda detrás
/// de la barrera del corte y el migrador general no la aplica sin ella).
fn open_store(path: &Path) -> Store {
    Store::open_with(path, &embedded_post_cut(), "lxo-141-test").unwrap()
}

fn event(kind: &str, entity_kind: &str, entity_id: &str, run: &str, project: &str) -> NewEvent {
    NewEvent { id: new_uuid_v7(), at: 1, v: 1, kind: kind.into(), class: EventClass::State,
        actor_kind: ActorKind::System, actor_id: None, channel: Some("core".into()), client_id: None,
        project_id: Some(project.into()), run_id: Some(run.into()), entity_kind: entity_kind.into(),
        entity_id: entity_id.into(), correlation_id: None, idem_key: None, payload: "{}".into() }
}

fn attempt_event(
    kind: &str,
    attempt: &AttemptRow,
    task: &TaskRow,
    payload: serde_json::Value,
) -> NewEvent {
    let mut event = event(
        kind,
        "attempt",
        &attempt.id,
        &task.run_id,
        task.project_id.as_deref().unwrap_or_default(),
    );
    event.payload = payload.to_string();
    event.project_id = task.project_id.clone();
    event
}

fn record_started(s: &mut Store, id: &str) {
    s.attempt_transition_recorded(id, &AttemptAction::Start, 25, |attempt, _, task| {
        Ok(attempt_event(
            "attempt.started",
            attempt,
            task,
            serde_json::json!({ "task": attempt.task_id, "n": attempt.n }),
        ))
    })
    .unwrap();
}

fn record_completed(s: &mut Store, id: &str) {
    s.attempt_transition_recorded(
        id,
        &AttemptAction::Finish {
            summary: "done".into(),
        },
        30,
        |attempt, _, task| {
            Ok(attempt_event(
                "attempt.completed",
                attempt,
                task,
                serde_json::json!({
                    "task": attempt.task_id,
                    "n": attempt.n,
                    "has_summary": !attempt.summary.is_empty(),
                }),
            ))
        },
    )
    .unwrap();
}

fn record_proven_not_started(s: &mut Store, id: &str) {
    s.attempt_transition_recorded(
        id,
        &AttemptAction::Fail {
            reason: "launch_failed".into(),
            summary: "provider no iniciado".into(),
        },
        30,
        |attempt, _, task| {
            Ok(attempt_event(
                "attempt.failed",
                attempt,
                task,
                serde_json::json!({
                    "task": attempt.task_id,
                    "n": attempt.n,
                    "reason": attempt.failure_reason,
                    "has_summary": !attempt.summary.is_empty(),
                }),
            ))
        },
    )
    .unwrap();
}

fn record_stopped_as(
    s: &mut Store,
    id: &str,
    actor_kind: ActorKind,
    actor_id: Option<&str>,
    channel: &str,
    cause: &str,
) {
    record_started(s, id);
    assert!(s.attempt_dispatch_started(id).unwrap());
    s.attempt_transition_recorded(id, &AttemptAction::Cancel, 35, |attempt, _, task| {
        let mut event = attempt_event(
            "attempt.stopped",
            attempt,
            task,
            serde_json::json!({
                "task": attempt.task_id,
                "n": attempt.n,
                "from": "running",
                "cause": cause,
            }),
        );
        event.actor_kind = actor_kind;
        event.actor_id = actor_id.map(str::to_owned);
        event.channel = Some(channel.into());
        Ok(event)
    })
    .unwrap();
}

fn append_started_event_after_terminal(s: &mut Store, id: &str) {
    let (task_id, n, run_id, project_id): (String, i64, String, String) = s
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT a.task_id, a.n, t.run_id, t.project_id
                 FROM attempts a JOIN tasks t ON t.id=a.task_id WHERE a.id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .unwrap();
    let mut started = event("attempt.started", "attempt", id, &run_id, &project_id);
    started.payload = serde_json::json!({ "task": task_id, "n": n }).to_string();
    s.append_events(&[started]).unwrap();
}

fn ambiguity_event(attempt: &AttemptRow, task: &TaskRow, from: &str) -> NewEvent {
    attempt_event(
        "attempt.dispatch_ambiguous",
        attempt,
        task,
        serde_json::json!({
            "task": attempt.task_id,
            "n": attempt.n,
            "from": from,
            "cause": "core_restart",
        }),
    )
}

fn starting_store(path: &Path) -> (Store, String) {
    let mut s = open_store(path);
    let loc = NewLocation { machine: "test".into(), path: "C:/lxo141".into(), display_path: "C:/lxo141".into(), primary: true };
    let project = s.project_create("claim-test", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intent = NewTaskIntent { title: "test".into(), spec: String::new(), repo: "C:/lxo141".into() };
    let (run, task) = s.run_create_recorded(&NewRun { objective: "claim".into(), project_id: project.clone(), root: intent }, 10, |r, t| {
        Ok(vec![event("run.created", "run", &r.id, &r.id, &project), event("task.created", "task", &t.id, &r.id, &project)])
    }).unwrap();
    let attempt = s.attempt_create_recorded(&task.id, &NewAttempt { provider: "test-provider".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false }, 20, |a, _t| {
        Ok(event("attempt.requested", "attempt", &a.id, &run.id, &project))
    }).unwrap();
    (s, attempt.id)
}

fn approved_store_with_person(
    path: &Path,
    actor_id: Option<&str>,
    channel: &str,
    authenticated: bool,
) -> (Store, String) {
    let mut s = open_store(path);
    let loc = NewLocation { machine: "test".into(), path: "C:/lxo141".into(), display_path: "C:/lxo141".into(), primary: true };
    let project = s.project_create("claim-test", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intent = NewTaskIntent { title: "test".into(), spec: String::new(), repo: "C:/lxo141".into() };
    let (run, task) = s.run_create_recorded(&NewRun { objective: "claim".into(), project_id: project.clone(), root: intent }, 10, |r, t| {
        Ok(vec![event("run.created", "run", &r.id, &r.id, &project), event("task.created", "task", &t.id, &r.id, &project)])
    }).unwrap();
    let attempt = s.attempt_create_recorded(&task.id, &NewAttempt { provider: "test-provider".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: true }, 20, |a, _t| {
        Ok(event("attempt.requested", "attempt", &a.id, &run.id, &project))
    }).unwrap();
    let client_id = if authenticated && actor_id == Some("person-1") {
        let surface = match channel {
            "ui" => ClientSurface::Desktop,
            "lxo" => ClientSurface::Cli,
            _ => panic!("canal Person inesperado"),
        };
        let registration = ClientRegistration::new(
            surface,
            DeviceIdentity::new(format!("approval-{channel}"), None).unwrap(),
        )
        .unwrap();
        let credential = ClientCredential::new(
            ClientPrincipal::Person("person-1".into()),
            "approval-dispatch-test-secret-0123456789abcdef",
        )
        .unwrap();
        Some(
            s.register_client(&registration, &credential, 15)
                .unwrap()
                .identity()
                .client_id()
                .to_string(),
        )
    } else {
        None
    };
    s.write(|tx| {
        tx.execute(
            "UPDATE attempts SET status='starting', updated_at=30 WHERE id=?1 AND status='pending_approval'",
            [&attempt.id],
        )?;
        Ok(())
    })
    .unwrap();
    let mut approved = event(
        "attempt.approved",
        "attempt",
        &attempt.id,
        &run.id,
        &project,
    );
    approved.at = 30;
    approved.class = EventClass::Decision;
    approved.actor_kind = ActorKind::Person;
    approved.actor_id = actor_id.map(str::to_owned);
    approved.channel = Some(channel.into());
    approved.client_id = client_id;
    approved.payload = serde_json::json!({ "task": task.id, "n": attempt.n }).to_string();
    s.append_events(&[approved]).unwrap();
    (s, attempt.id)
}

fn claim(s: &Store, id: &str) -> String {
    s.read(|c| Ok(c.query_row("SELECT dispatch_claim FROM attempts WHERE id=?1", [id], |r| r.get(0))?)).unwrap()
}

#[test]
fn reservation_revalidates_open_run_and_active_project_in_its_write_transaction() {
    let closed_run_scratch = Scratch::new();
    let (mut closed_run, closed_run_attempt) = starting_store(closed_run_scratch.path());
    closed_run.write(|tx| {
        tx.execute(
            "UPDATE runs SET closed=1 WHERE id=(SELECT t.run_id FROM tasks t JOIN attempts a ON a.task_id=t.id WHERE a.id=?1)",
            [&closed_run_attempt],
        )?;
        Ok(())
    }).unwrap();
    assert!(matches!(
        closed_run.attempt_dispatch_reserve(&closed_run_attempt),
        Err(StoreError::AttemptConflict(_))
    ));
    assert_eq!(claim(&closed_run, &closed_run_attempt), "none", "a closed Run must not acquire a dispatch claim");

    let archived_project_scratch = Scratch::new();
    let (mut archived_project, archived_attempt) = starting_store(archived_project_scratch.path());
    archived_project.write(|tx| {
        tx.execute(
            "UPDATE projects SET state='archived' WHERE id=(SELECT t.project_id FROM tasks t JOIN attempts a ON a.task_id=t.id WHERE a.id=?1)",
            [&archived_attempt],
        )?;
        Ok(())
    }).unwrap();
    assert!(matches!(
        archived_project.attempt_dispatch_reserve(&archived_attempt),
        Err(StoreError::AttemptConflict(_))
    ));
    assert_eq!(claim(&archived_project, &archived_attempt), "none", "an archived Project must not acquire a dispatch claim");

    // A durable claim remains an idempotent replay even if the Run later closes;
    // the validation gate must not turn a used claim into a new eligibility error.
    let replay_scratch = Scratch::new();
    let (mut replay, replay_attempt) = starting_store(replay_scratch.path());
    assert!(replay.attempt_dispatch_reserve(&replay_attempt).unwrap());
    replay.write(|tx| {
        tx.execute(
            "UPDATE runs SET closed=1 WHERE id=(SELECT t.run_id FROM tasks t JOIN attempts a ON a.task_id=t.id WHERE a.id=?1)",
            [&replay_attempt],
        )?;
        Ok(())
    }).unwrap();
    assert!(!replay.attempt_dispatch_reserve(&replay_attempt).unwrap());
    assert_eq!(claim(&replay, &replay_attempt), "reserved");
}

#[test]
fn reservation_rejects_legacy_attempt_origin_and_preserves_the_claim() {
    let scratch = Scratch::new();
    let (mut store, root_attempt) = starting_store(scratch.path());
    let root_task = root_attempt.strip_suffix("-a1").unwrap().to_owned();
    let (run_id, project_id) = store.read(|conn| {
        Ok(conn.query_row(
            "SELECT run_id, project_id FROM tasks WHERE id=?1",
            [&root_task],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?)
    }).unwrap();
    let task_id = format!("{root_task}-legacy-attempt");
    let attempt_id = format!("{task_id}-a1");
    store.write(|tx| {
        tx.execute(
            "INSERT INTO tasks (id, run_id, parent_task_id, depth, project_id, title, spec, repo, intent, origin, created_at, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, 'legacy attempt', '', '', 'open', 'core', 30, 30)",
            [task_id.as_str(), run_id.as_str(), root_task.as_str(), project_id.as_str()],
        )?;
        tx.execute(
            "INSERT INTO attempts (id, task_id, n, status, provider, created_at, updated_at, origin)
             VALUES (?1, ?2, 1, 'starting', 'test-provider', 40, 40, 'legacy')",
            [attempt_id.as_str(), task_id.as_str()],
        )?;
        Ok(())
    }).unwrap();

    assert!(matches!(
        store.attempt_dispatch_reserve(&attempt_id),
        Err(StoreError::AttemptConflict(_))
    ));
    assert_eq!(claim(&store, &attempt_id), "none");
}

#[test]
fn reservation_requires_one_canonical_authenticated_initial_approval_when_required() {
    let approved_scratch = Scratch::new();
    let (mut approved, approved_id) = approved_store_with_person(
        approved_scratch.path(),
        Some("person-1"),
        "ui",
        true,
    );
    assert!(approved.attempt_dispatch_reserve(&approved_id).unwrap());
    assert_eq!(claim(&approved, &approved_id), "reserved");

    let unauthenticated_scratch = Scratch::new();
    let (mut unauthenticated, unauthenticated_id) = approved_store_with_person(
        unauthenticated_scratch.path(),
        Some("person-1"),
        "ui",
        false,
    );
    assert!(matches!(
        unauthenticated.attempt_dispatch_reserve(&unauthenticated_id),
        Err(StoreError::AttemptConflict(_))
    ));
    assert_eq!(claim(&unauthenticated, &unauthenticated_id), "none");
}

#[test]
fn reserve_is_once_started_and_ambiguous_never_reserves_again() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    assert_eq!(claim(&s, &id), "reserved");
    assert!(!s.attempt_dispatch_reserve(&id).unwrap());
    record_started(&mut s, &id);
    assert!(s.attempt_dispatch_started(&id).unwrap());
    assert_eq!(claim(&s, &id), "started");
    assert!(!s.attempt_dispatch_started(&id).unwrap());
    assert!(s.attempt_dispatch_mark_ambiguous(&id).unwrap());
    assert_eq!(claim(&s, &id), "ambiguous");
    assert!(!s.attempt_dispatch_reserve(&id).unwrap());
    assert!(!s.attempt_dispatch_started(&id).unwrap());
    assert!(!s.attempt_dispatch_mark_ambiguous(&id).unwrap());
}

#[test]
fn dispatch_started_requires_a_canonical_start_event_and_running_attempt() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());

    // Even a fully matching event cannot move the claim while the row is still
    // `starting`; the lifecycle transition must have committed first.
    let (task_id, n, run_id, project_id): (String, i64, String, String) = s
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT a.task_id, a.n, t.run_id, t.project_id FROM attempts a
                 JOIN tasks t ON t.id=a.task_id WHERE a.id=?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?)
        })
        .unwrap();
    let mut premature = event("attempt.started", "attempt", &id, &run_id, &project_id);
    premature.payload = serde_json::json!({ "task": task_id, "n": n }).to_string();
    s.append_events(&[premature]).unwrap();
    assert!(!s.attempt_dispatch_started(&id).unwrap());
    assert_eq!(claim(&s, &id), "reserved");

    let running_tmp = Scratch::new();
    let (mut running, running_id) = starting_store(running_tmp.path());
    assert!(running.attempt_dispatch_reserve(&running_id).unwrap());
    // A `running` row by itself still does not prove the event was committed.
    running.write(|tx| {
        tx.execute(
            "UPDATE attempts SET status='running', started_at=25, updated_at=25 WHERE id=?1",
            [&running_id],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(!running.attempt_dispatch_started(&running_id).unwrap());

    let (run_id, project_id): (String, String) = running
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT t.run_id, t.project_id FROM attempts a
                 JOIN tasks t ON t.id=a.task_id WHERE a.id=?1",
                [&running_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .unwrap();
    let mut mismatched = event("attempt.started", "attempt", &running_id, &run_id, &project_id);
    mismatched.payload = serde_json::json!({ "task": "another-task", "n": 1 }).to_string();
    running.append_events(&[mismatched]).unwrap();

    assert!(!running.attempt_dispatch_started(&running_id).unwrap());
    assert_eq!(claim(&running, &running_id), "reserved");
}

#[test]
fn reserve_persists_across_store_restart_and_settle_requires_final_lifecycle() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    drop(s);
    let (mut s, id2) = starting_store_reopen(tmp.path(), &id);
    assert_eq!(id, id2);
    assert_eq!(claim(&s, &id), "reserved");
    assert!(!s.attempt_dispatch_reserve(&id).unwrap());
    assert!(!s.attempt_dispatch_settled(&id).unwrap());
    record_started(&mut s, &id);
    assert!(s.attempt_dispatch_started(&id).unwrap());
    // Complete through the durable lifecycle API, then settle exactly once.
    record_completed(&mut s, &id);
    assert!(s.attempt_dispatch_settled(&id).unwrap());
    assert_eq!(claim(&s, &id), "settled");
    assert!(!s.attempt_dispatch_settled(&id).unwrap());
    assert!(!s.attempt_dispatch_mark_ambiguous(&id).unwrap());
    assert!(s.write(|tx| {
        tx.execute("UPDATE attempts SET summary='tampered' WHERE id=?1", [&id])?;
        Ok(())
    }).is_err(), "settling the dispatch claim must not make other final fields mutable");
    assert_eq!(claim(&s, &id), "settled");
}

fn starting_store_reopen(path: &Path, id: &str) -> (Store, String) {
    let s = open_store(path);
    (s, id.to_owned())
}

#[test]
fn invalid_transitions_and_concurrent_reservations_are_single_winner() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(!s.attempt_dispatch_started(&id).unwrap());
    assert!(!s.attempt_dispatch_mark_ambiguous(&id).unwrap());
    assert!(!s.attempt_dispatch_settled(&id).unwrap());
    // SQLite Store intentionally provides one writer; BEGIN IMMEDIATE makes the race
    // deterministic: the first committed claim wins, all subsequent claims observe it.
    let winners = (0..16).filter(|_| s.attempt_dispatch_reserve(&id).unwrap()).count();
    assert_eq!(winners, 1);
}

#[test]
fn batch_reconciliation_is_atomic_idempotent_and_does_not_change_attempt_status() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    let ids = vec![id.clone(), id.clone(), "missing-attempt".to_owned()];
    assert_eq!(s.attempt_dispatch_reconcile_ambiguous(&ids).unwrap(), 1);
    assert_eq!(s.attempt_dispatch_reconcile_ambiguous(&ids).unwrap(), 0);
    assert_eq!(claim(&s, &id), "ambiguous");
    let status: String = s.read(|c| Ok(c.query_row(
        "SELECT status FROM attempts WHERE id=?1", [&id], |r| r.get(0),
    )?)).unwrap();
    assert_eq!(status, "starting");
}

#[test]
fn restart_settles_only_a_started_claim_with_matching_canonical_terminal_events() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    record_started(&mut s, &id);
    assert!(s.attempt_dispatch_started(&id).unwrap());
    record_completed(&mut s, &id);

    let mut ambiguity_event_called = false;
    let reconciled = s
        .attempt_dispatch_reconcile_ambiguous_recorded(|attempt, task, from| {
            ambiguity_event_called = true;
            Ok(ambiguity_event(attempt, task, from))
        })
        .unwrap();

    assert_eq!(reconciled, 1);
    assert_eq!(claim(&s, &id), "settled");
    assert!(!ambiguity_event_called, "canonical completion must not emit false ambiguity");
    let dispatch_ambiguities: i64 = s
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT count(*) FROM events WHERE kind='attempt.dispatch_ambiguous' AND entity_id=?1",
                [&id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(dispatch_ambiguities, 0);
    assert!(!s.attempt_dispatch_reserve(&id).unwrap(), "settled claims never redispatch");
}

#[test]
fn proven_not_started_terminal_fact_can_settle_but_unknown_post_spawn_stays_ambiguous() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    record_started(&mut s, &id);
    assert!(s.attempt_dispatch_started(&id).unwrap());
    record_proven_not_started(&mut s, &id);

    assert_eq!(
        s.attempt_dispatch_reconcile_ambiguous_recorded(|attempt, task, from| {
            Ok(ambiguity_event(attempt, task, from))
        })
        .unwrap(),
        1
    );
    assert_eq!(claim(&s, &id), "settled");
    let dispatch_ambiguities: i64 = s
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT count(*) FROM events WHERE kind='attempt.dispatch_ambiguous' AND entity_id=?1",
                [&id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(dispatch_ambiguities, 0);
    assert!(!s.attempt_dispatch_reserve(&id).unwrap());

    let unknown_tmp = Scratch::new();
    let (mut unknown, unknown_id) = starting_store(unknown_tmp.path());
    assert!(unknown.attempt_dispatch_reserve(&unknown_id).unwrap());
    record_started(&mut unknown, &unknown_id);
    assert!(unknown.attempt_dispatch_started(&unknown_id).unwrap());
    assert_eq!(claim(&unknown, &unknown_id), "started");

    assert_eq!(
        unknown
            .attempt_dispatch_reconcile_ambiguous_recorded(|attempt, task, from| {
                Ok(ambiguity_event(attempt, task, from))
            })
            .unwrap(),
        1
    );
    assert_eq!(claim(&unknown, &unknown_id), "ambiguous");
    let ambiguity_count: i64 = unknown
        .read(|conn| {
            Ok(conn.query_row(
                "SELECT count(*) FROM events WHERE kind='attempt.dispatch_ambiguous' AND entity_id=?1",
                [&unknown_id],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(ambiguity_count, 1, "without a terminal fact, external effects stay unknown");
    assert!(!unknown.attempt_dispatch_reserve(&unknown_id).unwrap());
}

#[test]
fn mismatched_terminal_payload_does_not_settle_the_dispatch_claim() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    record_started(&mut s, &id);
    assert!(s.attempt_dispatch_started(&id).unwrap());
    s.attempt_transition_recorded(
        &id,
        &AttemptAction::Finish {
            summary: "done".into(),
        },
        30,
        |attempt, _, task| {
            Ok(attempt_event(
                "attempt.completed",
                attempt,
                task,
                serde_json::json!({
                    "task": "another-task",
                    "n": attempt.n,
                    "has_summary": true,
                }),
            ))
        },
    )
    .unwrap();

    assert_eq!(
        s.attempt_dispatch_reconcile_ambiguous_recorded(|attempt, task, from| {
            Ok(ambiguity_event(attempt, task, from))
        })
        .unwrap(),
        1
    );
    assert_eq!(claim(&s, &id), "ambiguous");
    assert!(!s.attempt_dispatch_reserve(&id).unwrap());
}

#[test]
fn reconciliation_requires_started_sequence_before_terminal_sequence() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());

    // Build a final row and terminal fact, then append the sole started fact afterwards.
    // Wall-clock `at` is not the Event Log order; seq must prove started < terminal.
    s.write(|tx| {
        tx.execute(
            "UPDATE attempts SET status='running', started_at=25, updated_at=25 WHERE id=?1",
            [&id],
        )?;
        Ok(())
    })
    .unwrap();
    assert!(!s.attempt_dispatch_started(&id).unwrap());
    assert_eq!(claim(&s, &id), "reserved");
    // Construct an impossible-to-reach claim/event ordering to exercise restart
    // reconciliation: the database guard constrains state transitions, not facts.
    s.write(|tx| {
        tx.execute(
            "UPDATE attempts SET dispatch_claim='started' WHERE id=?1",
            [&id],
        )?;
        Ok(())
    })
    .unwrap();
    record_completed(&mut s, &id);
    append_started_event_after_terminal(&mut s, &id);

    assert_eq!(
        s.attempt_dispatch_reconcile_ambiguous_recorded(|attempt, task, from| {
            Ok(ambiguity_event(attempt, task, from))
        })
        .unwrap(),
        1
    );
    assert_eq!(claim(&s, &id), "ambiguous");
    assert!(!s.attempt_dispatch_reserve(&id).unwrap(), "out-of-order evidence must never relaunch");
}

#[test]
fn approval_timeout_is_not_a_terminal_stopped_cause() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    record_stopped_as(
        &mut s,
        &id,
        ActorKind::System,
        None,
        "core",
        "approval_timeout",
    );

    assert_eq!(
        s.attempt_dispatch_reconcile_ambiguous_recorded(|attempt, task, from| {
            Ok(ambiguity_event(attempt, task, from))
        })
        .unwrap(),
        1
    );
    assert_eq!(claim(&s, &id), "ambiguous");
    assert!(!s.attempt_dispatch_reserve(&id).unwrap(), "invalid stopped evidence must not relaunch");
}

#[test]
fn person_terminal_evidence_requires_a_valid_id_in_ui_or_lxo_context() {
    for channel in ["ui", "lxo"] {
        let valid_tmp = Scratch::new();
        let (mut valid, valid_id) = starting_store(valid_tmp.path());
        assert!(valid.attempt_dispatch_reserve(&valid_id).unwrap());
        record_stopped_as(
            &mut valid,
            &valid_id,
            ActorKind::Person,
            Some("person-1"),
            channel,
            "cancelled",
        );
        assert_eq!(
            valid
                .attempt_dispatch_reconcile_ambiguous_recorded(|attempt, task, from| {
                    Ok(ambiguity_event(attempt, task, from))
                })
                .unwrap(),
            1
        );
        assert_eq!(claim(&valid, &valid_id), "settled");
        assert!(!valid.attempt_dispatch_reserve(&valid_id).unwrap());

        for actor_id in [Some(""), Some(" "), Some("bad\u{0007}id")] {
            let invalid_tmp = Scratch::new();
            let (mut invalid, invalid_id) = starting_store(invalid_tmp.path());
            assert!(invalid.attempt_dispatch_reserve(&invalid_id).unwrap());
            record_stopped_as(
                &mut invalid,
                &invalid_id,
                ActorKind::Person,
                actor_id,
                channel,
                "cancelled",
            );

            assert_eq!(
                invalid
                    .attempt_dispatch_reconcile_ambiguous_recorded(|attempt, task, from| {
                        Ok(ambiguity_event(attempt, task, from))
                    })
                    .unwrap(),
                1
            );
            assert_eq!(claim(&invalid, &invalid_id), "ambiguous");
            assert!(!invalid.attempt_dispatch_reserve(&invalid_id).unwrap());
        }
    }
}

#[test]
fn initial_approval_recovery_requires_the_same_valid_person_context() {
    for channel in ["ui", "lxo"] {
        let valid_tmp = Scratch::new();
        let (valid, valid_id) = approved_store_with_person(
            valid_tmp.path(),
            Some("person-1"),
            channel,
            true,
        );
        assert_eq!(valid.attempt_approved_dispatch_candidates(8).unwrap(), vec![valid_id.clone()]);
        assert_eq!(
            valid.attempt_initial_approval_snapshot(&valid_id).unwrap().unwrap().decision,
            Some(InitialApprovalDecision::Approved),
        );

        for actor_id in [None, Some(""), Some(" "), Some("bad\u{0007}id")] {
            let invalid_tmp = Scratch::new();
            let (invalid, invalid_id) =
                approved_store_with_person(invalid_tmp.path(), actor_id, channel, false);
            assert!(invalid.attempt_approved_dispatch_candidates(8).unwrap().is_empty());
            assert_eq!(
                invalid.attempt_initial_approval_snapshot(&invalid_id).unwrap().unwrap().decision,
                None,
            );
        }
    }

    for channel in ["ui", "lxo"] {
        let unlinked_tmp = Scratch::new();
        let (unlinked, unlinked_id) =
            approved_store_with_person(unlinked_tmp.path(), Some("person-1"), channel, false);
        assert!(unlinked.attempt_approved_dispatch_candidates(8).unwrap().is_empty());
        assert_eq!(
            unlinked
                .attempt_initial_approval_snapshot(&unlinked_id)
                .unwrap()
                .unwrap()
                .decision,
            None,
            "un actor escrito sin identidad autenticada queda pendiente de revisión"
        );
    }
}

#[test]
fn legacy_person_terminal_sin_id_solo_asienta_claim_ya_iniciado() {
    let tmp = Scratch::new();
    let (mut store, id) = starting_store(tmp.path());
    assert!(store.attempt_dispatch_reserve(&id).unwrap());
    record_stopped_as(
        &mut store,
        &id,
        ActorKind::Person,
        None,
        "ui",
        "cancelled",
    );

    assert_eq!(
        store
            .attempt_dispatch_reconcile_ambiguous_recorded(|attempt, task, from| {
                Ok(ambiguity_event(attempt, task, from))
            })
            .unwrap(),
        1
    );
    assert_eq!(claim(&store, &id), "settled");
    assert!(!store.attempt_dispatch_reserve(&id).unwrap());

    let approval_tmp = Scratch::new();
    let (legacy_approval, approval_id) =
        approved_store_with_person(approval_tmp.path(), None, "ui", false);
    assert!(legacy_approval
        .attempt_approved_dispatch_candidates(8)
        .unwrap()
        .is_empty());
    assert_eq!(
        legacy_approval
            .attempt_initial_approval_snapshot(&approval_id)
            .unwrap()
            .unwrap()
            .decision,
        None,
        "una aprobación legacy sin identidad queda bloqueada para revisión; no se inventa actor"
    );
}

#[test]
fn database_rejects_claim_reset_and_out_of_order_transitions() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    assert!(s.write(|tx| {
        tx.execute("UPDATE attempts SET dispatch_claim='none' WHERE id=?1", [&id])?;
        Ok(())
    }).is_err(), "a reserved claim cannot be reset");
    assert!(s.write(|tx| {
        tx.execute("UPDATE attempts SET dispatch_claim='settled' WHERE id=?1", [&id])?;
        Ok(())
    }).is_err(), "a reserved claim cannot skip started/ambiguous");
    assert_eq!(claim(&s, &id), "reserved");
}

// ── Hallazgo 2 de LXO-141: un claim cuyo Attempt termina SIN `attempt.started` ───────────────────────────────────────
// El protocolo registra `attempt.started` antes de llamar al proveedor; sin él, el proveedor nunca se llamó y el claim
// debe poder asentarse en lugar de quedarse `ambiguous` para siempre.

/// Termina un Attempt que sigue `starting` (nunca arrancó) con `attempt.stopped` y `from = starting`.
fn record_cancelled_before_start(s: &mut Store, id: &str, actor_kind: ActorKind, actor_id: Option<&str>, channel: &str) {
    s.attempt_transition_recorded(id, &AttemptAction::Cancel, 35, |attempt, _, task| {
        let mut event = attempt_event(
            "attempt.stopped",
            attempt,
            task,
            serde_json::json!({ "task": attempt.task_id, "n": attempt.n, "from": "starting", "cause": "cancelled" }),
        );
        event.actor_kind = actor_kind;
        event.actor_id = actor_id.map(str::to_owned);
        event.channel = Some(channel.into());
        Ok(event)
    })
    .unwrap();
}

fn ambiguity_events(s: &Store, id: &str) -> i64 {
    s.read(|conn| {
        Ok(conn.query_row(
            "SELECT count(*) FROM events WHERE kind='attempt.dispatch_ambiguous' AND entity_id=?1",
            [id],
            |row| row.get(0),
        )?)
    })
    .unwrap()
}

#[test]
fn a_reserved_claim_whose_attempt_failed_before_launch_settles_without_attempt_started() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    assert!(!s.attempt_dispatch_settled(&id).unwrap(), "con el Attempt aún starting no hay nada que asentar");
    record_proven_not_started(&mut s, &id);

    assert!(s.attempt_dispatch_settled(&id).unwrap());
    assert_eq!(claim(&s, &id), "settled");
    assert_eq!(ambiguity_events(&s, &id), 0);
    assert!(!s.attempt_dispatch_reserve(&id).unwrap(), "un claim asentado no se reserva de nuevo");
    assert!(!s.attempt_dispatch_settled(&id).unwrap());
}

#[test]
fn the_startup_reconcile_settles_a_reserved_claim_that_ended_before_launch_instead_of_marking_it_ambiguous() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    record_proven_not_started(&mut s, &id);
    drop(s);

    let mut s = open_store(tmp.path());
    assert_eq!(s.attempt_dispatch_reconcile_ambiguous_recorded(|a, t, from| Ok(ambiguity_event(a, t, from))).unwrap(), 1);
    assert_eq!(claim(&s, &id), "settled");
    assert_eq!(ambiguity_events(&s, &id), 0, "no se registra una ambigüedad falsa");
    assert_eq!(s.attempt_dispatch_reconcile_ambiguous_recorded(|a, t, from| Ok(ambiguity_event(a, t, from))).unwrap(), 0);
}

#[test]
fn an_ambiguous_claim_that_never_started_settles_once_the_attempt_ends_canonically() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    // El Core reinició con el Attempt aún starting: sin evidencia terminal, ambiguous.
    assert_eq!(s.attempt_dispatch_reconcile_ambiguous_recorded(|a, t, from| Ok(ambiguity_event(a, t, from))).unwrap(), 1);
    assert_eq!(claim(&s, &id), "ambiguous");
    assert_eq!(ambiguity_events(&s, &id), 1);

    record_proven_not_started(&mut s, &id);
    assert!(s.attempt_dispatch_settled(&id).unwrap());
    assert_eq!(claim(&s, &id), "settled");
}

#[test]
fn a_reserved_claim_cancelled_before_start_settles() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    record_cancelled_before_start(&mut s, &id, ActorKind::System, None, "core");
    assert!(s.attempt_dispatch_settled(&id).unwrap());
    assert_eq!(claim(&s, &id), "settled");
}

#[test]
fn a_claim_without_attempt_started_does_not_settle_on_weak_or_forged_evidence() {
    // 1. Terminal `launch_failed` emitido por un agente, no por el Core: no prueba que no hubo arranque.
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    s.attempt_transition_recorded(
        &id,
        &AttemptAction::Fail { reason: "launch_failed".into(), summary: "dicho por un agente".into() },
        30,
        |attempt, _, task| {
            let mut event = attempt_event(
                "attempt.failed",
                attempt,
                task,
                serde_json::json!({ "task": attempt.task_id, "n": attempt.n, "reason": attempt.failure_reason, "has_summary": true }),
            );
            event.actor_kind = ActorKind::Agent;
            event.actor_id = Some(attempt.task_id.clone());
            event.channel = Some("lxo".into());
            Ok(event)
        },
    )
    .unwrap();
    assert!(!s.attempt_dispatch_settled(&id).unwrap());
    assert_eq!(claim(&s, &id), "reserved");

    // 2. Un `attempt.started` añadido DESPUÉS del terminal no es un arranque previo.
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    record_proven_not_started(&mut s, &id);
    append_started_event_after_terminal(&mut s, &id);
    assert!(!s.attempt_dispatch_settled(&id).unwrap());
    assert_eq!(claim(&s, &id), "reserved");

    // 3. Una cancelación de una Person sin id válido (ni legacy) en un canal que no es ui/lxo tampoco asienta.
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    record_cancelled_before_start(&mut s, &id, ActorKind::Person, Some(" "), "ui");
    assert!(!s.attempt_dispatch_settled(&id).unwrap());
    assert_eq!(claim(&s, &id), "reserved");
}

#[test]
fn the_database_only_lets_a_reserved_claim_settle_once_the_attempt_is_final() {
    let tmp = Scratch::new();
    let (mut s, id) = starting_store(tmp.path());
    assert!(s.attempt_dispatch_reserve(&id).unwrap());
    assert!(
        s.write(|tx| {
            tx.execute("UPDATE attempts SET dispatch_claim='settled' WHERE id=?1", [&id])?;
            Ok(())
        })
        .is_err(),
        "reserved -> settled con el Attempt aún starting lo rechaza la base"
    );
    assert_eq!(claim(&s, &id), "reserved");
    record_proven_not_started(&mut s, &id);
    s.write(|tx| {
        tx.execute("UPDATE attempts SET dispatch_claim='settled' WHERE id=?1", [&id])?;
        Ok(())
    })
    .expect("con el Attempt final la base admite reserved -> settled");
}
