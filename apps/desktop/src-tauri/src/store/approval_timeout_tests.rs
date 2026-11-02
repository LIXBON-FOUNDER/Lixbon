//! Contratos del timeout durable de aprobación inicial (LXO-141).
//! Estas pruebas usan SQLite en memoria y no abren ni modifican almacenes en disco.

use std::collections::BTreeMap;

use super::runtime::{
    validate_approval_timeout_events, validate_initial_approval_decisions,
    validate_run_closed_initial_rejections, DocRun, DocTask, RuntimeDoc,
};
use super::*;

const TASK: &str = "task-1";
const ROOT: &str = "task-root";
const RUN: &str = "run-1";
const ATTEMPT: &str = "task-1-a1";
const DEADLINE: i64 = 10_000;

fn conn() -> rusqlite::Connection {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE runs (id TEXT PRIMARY KEY, root_task_id TEXT NOT NULL, closed INTEGER NOT NULL); CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT); CREATE TABLE attempts (id TEXT, n INTEGER, status TEXT, initial_approval_deadline INTEGER, task_id TEXT); CREATE TABLE events (kind TEXT, idem_key TEXT); CREATE TABLE clients (client_id TEXT PRIMARY KEY, surface TEXT, created_at INTEGER, revoked_at INTEGER); CREATE TABLE client_credentials (client_id TEXT, principal_kind TEXT, principal_id TEXT, created_at INTEGER, revoked_at INTEGER);").unwrap();
    c.execute("INSERT INTO runs VALUES (?1, ?2, 0)", rusqlite::params![RUN, ROOT]).unwrap();
    c.execute("INSERT INTO tasks VALUES (?1, ?2, NULL)", rusqlite::params![ROOT, RUN]).unwrap();
    c.execute("INSERT INTO tasks VALUES (?1, ?2, NULL)", rusqlite::params![TASK, RUN]).unwrap();
    c.execute("INSERT INTO attempts VALUES (?1, 1, 'pending_approval', ?2, ?3)", rusqlite::params![ATTEMPT, DEADLINE, TASK]).unwrap();
    c.execute("INSERT INTO clients VALUES ('client-1', 'desktop', 1, NULL)", []).unwrap();
    c.execute("INSERT INTO client_credentials VALUES ('client-1', 'person', 'person-1', 1, NULL)", []).unwrap();
    c
}

fn doc(status: &str) -> RuntimeDoc {
    doc_with_run(status, false)
}

fn doc_with_run(status: &str, closed: bool) -> RuntimeDoc {
    let mut tasks = BTreeMap::new();
    tasks.insert(ROOT.to_string(), DocTask {
        id: ROOT.into(), run: RUN.into(), status: "running".into(),
        ..Default::default()
    });
    tasks.insert(TASK.to_string(), DocTask {
        id: TASK.into(), run: RUN.into(), status: status.into(),
        ..Default::default()
    });
    let mut runs = BTreeMap::new();
    runs.insert(RUN.to_string(), DocRun {
        id: RUN.into(), root: ROOT.into(), closed,
        ..Default::default()
    });
    RuntimeDoc { runs, tasks, ..Default::default() }
}

fn event(at: i64, task: &str, n: i64, actor: ActorKind, actor_id: Option<&str>) -> NewEvent {
    NewEvent {
        id: new_uuid_v7(), at, v: 1, kind: "attempt.rejected".into(), class: EventClass::State,
        actor_kind: actor, actor_id: actor_id.map(str::to_owned), channel: Some("core".into()),
        client_id: None, project_id: None, run_id: Some(RUN.into()), entity_kind: "attempt".into(),
        entity_id: ATTEMPT.into(), correlation_id: None, idem_key: None,
        payload: serde_json::json!({"task":task,"n":n,"cause":"approval_timeout"}).to_string(),
    }
}

fn human_decision(kind: &str, cause: Option<&str>, at: i64, actor: ActorKind, actor_id: Option<&str>) -> NewEvent {
    let mut payload = serde_json::json!({"task": TASK, "n": 1});
    if let Some(cause) = cause {
        payload["cause"] = serde_json::json!(cause);
    }
    NewEvent {
        id: new_uuid_v7(), at, v: 1, kind: kind.into(), class: EventClass::Decision,
        actor_kind: actor, actor_id: actor_id.map(str::to_owned), channel: Some("ui".into()),
        client_id: (actor == ActorKind::Person && actor_id == Some("person-1")).then(|| "client-1".into()), project_id: None, run_id: Some(RUN.into()), entity_kind: "attempt".into(),
        entity_id: format!("{TASK}-a1"), correlation_id: None, idem_key: None,
        payload: payload.to_string(),
    }
}

fn run_close_rejection(actor: ActorKind, actor_id: Option<&str>, channel: &str) -> NewEvent {
    let mut event = human_decision(
        "attempt.rejected",
        Some("run_closed"),
        DEADLINE - 1,
        actor,
        actor_id,
    );
    event.channel = Some(channel.into());
    event
}

fn run_closed_event(
    actor: ActorKind,
    actor_id: Option<&str>,
    channel: &str,
    forced: bool,
) -> NewEvent {
    NewEvent {
        id: new_uuid_v7(),
        at: DEADLINE - 1,
        v: 1,
        kind: "run.closed".into(),
        class: EventClass::State,
        actor_kind: actor,
        actor_id: actor_id.map(str::to_owned),
        channel: Some(channel.into()),
        client_id: (actor == ActorKind::Person && actor_id == Some("person-1")).then(|| "client-1".into()),
        project_id: None,
        run_id: Some(RUN.into()),
        entity_kind: "run".into(),
        entity_id: RUN.into(),
        correlation_id: None,
        idem_key: None,
        payload: serde_json::json!({"forced":forced,"stopped":[TASK],"stopped_total":1}).to_string(),
    }
}

#[test]
fn approval_inicial_usa_deadline_de_treinta_minutos() {
    assert_eq!(super::initial_approval::INITIAL_APPROVAL_TTL_MS, 30 * 60 * 1000);
}

#[test]
fn timeout_exige_attempt_pendiente_actual_deadline_vencido_y_actor_system() {
    let c = conn();
    let prev = doc("pending_approval");
    let next = doc("stopped");
    let e = event(DEADLINE, TASK, 1, ActorKind::System, None);
    assert!(validate_approval_timeout_events(&c, &prev, &next, &[e.clone()], DEADLINE).is_ok());

    assert!(validate_approval_timeout_events(&c, &prev, &next, &[event(DEADLINE - 1, TASK, 1, ActorKind::System, None)], DEADLINE - 1).is_err(), "no debe expirar antes del deadline");
    assert!(validate_approval_timeout_events(&c, &prev, &next, &[event(DEADLINE, TASK, 1, ActorKind::Person, Some("user"))], DEADLINE).is_err());
    assert!(validate_approval_timeout_events(&c, &prev, &next, &[event(DEADLINE, "otro-task", 1, ActorKind::System, None)], DEADLINE).is_err());
    let mut wrong_run = event(DEADLINE, TASK, 1, ActorKind::System, None);
    wrong_run.run_id = Some("run-wrong".into());
    assert!(validate_approval_timeout_events(&c, &prev, &next, &[wrong_run], DEADLINE).is_err(), "run_id debe coincidir con el durable");
    let mut duplicate_key = event(DEADLINE, TASK, 1, ActorKind::System, None);
    duplicate_key.idem_key = Some("used-key".into());
    c.execute("INSERT INTO events VALUES ('attempt.rejected', 'used-key')", []).unwrap();
    assert!(validate_approval_timeout_events(&c, &prev, &next, &[duplicate_key], DEADLINE).is_err(), "no se reutiliza idem_key");
    assert!(validate_approval_timeout_events(&c, &prev, &next, &[event(DEADLINE, TASK, 1, ActorKind::System, None), event(DEADLINE, TASK, 1, ActorKind::System, None)], DEADLINE).is_err(), "un solo evento de rechazo por timeout");
    assert!(validate_approval_timeout_events(&c, &doc("running"), &next, &[e], DEADLINE).is_err(), "un intento anterior no reemplaza el pendiente actual");
}

#[test]
fn decision_humana_revalida_estado_actor_y_deadline_durable_en_el_commit() {
    let c = conn();
    c.execute("UPDATE attempts SET id=?1", [format!("{TASK}-a1")]).unwrap();
    let prev = doc("pending_approval");
    let starting = doc("starting");
    let stopped = doc("stopped");
    let approval = human_decision(
        "attempt.approved",
        None,
        DEADLINE - 1,
        ActorKind::Person,
        Some("person-1"),
    );
    assert!(validate_initial_approval_decisions(&c, &prev, &starting, &[approval.clone()], DEADLINE - 1).is_ok());
    assert!(validate_initial_approval_decisions(&c, &prev, &starting, &[approval], DEADLINE).is_err(), "el deadline es exclusivo dentro de la transacción");

    for actor_id in [None, Some(""), Some(" "), Some("bad\u{0007}id")] {
        let unauthenticated = human_decision(
            "attempt.approved",
            None,
            DEADLINE - 1,
            ActorKind::Person,
            actor_id,
        );
        assert!(validate_initial_approval_decisions(
            &c,
            &prev,
            &starting,
            &[unauthenticated],
            DEADLINE - 1,
        )
        .is_err(), "un actor Person inválido no puede aprobar");
    }

    let mut missing_client = human_decision(
        "attempt.approved",
        None,
        DEADLINE - 1,
        ActorKind::Person,
        Some("person-1"),
    );
    missing_client.client_id = None;
    assert!(validate_initial_approval_decisions(
        &c,
        &prev,
        &starting,
        &[missing_client],
        DEADLINE - 1,
    )
    .is_err(), "un id Person sin client_id autenticado no puede aprobar");

    let mut spoofed_client = human_decision(
        "attempt.approved",
        None,
        DEADLINE - 1,
        ActorKind::Person,
        Some("other-person"),
    );
    spoofed_client.client_id = Some("client-1".into());
    assert!(validate_initial_approval_decisions(
        &c,
        &prev,
        &starting,
        &[spoofed_client],
        DEADLINE - 1,
    )
    .is_err(), "el client_id debe autenticar al mismo principal Person");

    let rejected = human_decision(
        "attempt.rejected",
        Some("cancelled"),
        DEADLINE - 1,
        ActorKind::Person,
        Some("person-1"),
    );
    assert!(validate_initial_approval_decisions(&c, &prev, &stopped, &[rejected], DEADLINE - 1).is_ok());
    let mut agent_rejection = human_decision(
        "attempt.rejected",
        Some("cancelled"),
        DEADLINE - 1,
        ActorKind::Agent,
        Some(ROOT),
    );
    agent_rejection.channel = Some("lxo".into());
    assert!(validate_initial_approval_decisions(
        &c,
        &prev,
        &stopped,
        &[agent_rejection],
        DEADLINE - 1,
    )
    .is_err(), "un Agent no puede disfrazar cancel como decisión humana");
    let spoofed = human_decision(
        "attempt.approved",
        None,
        DEADLINE - 1,
        ActorKind::System,
        None,
    );
    assert!(validate_initial_approval_decisions(&c, &prev, &starting, &[spoofed], DEADLINE - 1).is_err());
}

#[test]
fn rechazo_run_closed_exige_cierre_forzado_y_actor_coordinador() {
    let c = conn();
    let prev = doc_with_run("pending_approval", false);
    let next = doc_with_run("stopped", true);
    let rejected = run_close_rejection(ActorKind::Agent, Some(ROOT), "lxo");
    let closed = run_closed_event(ActorKind::Agent, Some(ROOT), "lxo", true);
    let events = [rejected.clone(), closed.clone()];

    assert!(validate_initial_approval_decisions(&c, &prev, &next, &events, DEADLINE - 1).is_ok());
    assert!(validate_run_closed_initial_rejections(&c, &prev, &next, &events).is_ok());

    let uncoordinated = [
        run_close_rejection(ActorKind::Agent, Some(TASK), "lxo"),
        run_closed_event(ActorKind::Agent, Some(TASK), "lxo", true),
    ];
    assert!(validate_run_closed_initial_rejections(&c, &prev, &next, &uncoordinated).is_err());

    assert!(validate_run_closed_initial_rejections(&c, &prev, &next, &[rejected.clone()]).is_err());
    let not_forced = [
        rejected.clone(),
        run_closed_event(ActorKind::Agent, Some(ROOT), "lxo", false),
    ];
    assert!(validate_run_closed_initial_rejections(&c, &prev, &next, &not_forced).is_err());

    let mismatched_actor = [
        rejected,
        run_closed_event(ActorKind::Person, Some("person-1"), "ui", true),
    ];
    assert!(validate_run_closed_initial_rejections(&c, &prev, &next, &mismatched_actor).is_err());

    let person_close = [
        run_close_rejection(ActorKind::Person, Some("person-1"), "ui"),
        run_closed_event(ActorKind::Person, Some("person-1"), "ui", true),
    ];
    assert!(validate_run_closed_initial_rejections(&c, &prev, &next, &person_close).is_ok());
}
