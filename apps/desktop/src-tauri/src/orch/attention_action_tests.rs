//! LXO-89 · resolución Person/Desktop de `risk` con auditoría transaccional.

use std::sync::Arc;

use serde_json::json;

use super::attention_rules::EventRules;
use super::boot_tests::*;
use super::events::Channel;
use super::{Caller, Core};
use crate::store::{
    AttentionCategory, AttentionProjection, AttentionRow, AttentionStatus, AttentionTarget,
    ClientClaims, ClientCredential, ClientPrincipal, ClientRegistration, ClientSurface,
    DeviceIdentity, EventClass, EventProjector, EventQuery, NewAttention, NewEvent, Raised,
    Resolution, Severity, StoreError, StoreResult, TargetKind,
};

fn core_listo() -> (Limpia, Arc<Core>) {
    let (cleanup, data, core_dir) = dirs();
    let (core, _host, ready) = arranca(&data, &core_dir);
    ready.unwrap();
    core.settings.lock().unwrap().enabled = true;
    (cleanup, core)
}

fn fila(core: &Core, category: AttentionCategory) -> AttentionRow {
    let new = NewAttention {
        category,
        severity: Severity::High,
        target: AttentionTarget::new(TargetKind::SpawnRequest, "spawn-real-1").unwrap(),
        project_id: Some("project-real-1".into()),
        run_id: Some("run-real-1".into()),
        subject: None,
        source_event_id: Some("source-spawn".into()),
        correlation_id: Some("spawn-real-1".into()),
        facts: "{\"policy_status\":\"blocked\"}".into(),
        at: 1_000,
    };
    core.storage
        .with_store(|store| match store.attention_raise(&new).unwrap() {
            Raised::Created(row) => row,
            other => panic!("se esperaba una fila nueva, salió {other:?}"),
        })
        .unwrap()
}

fn evento(row: &AttentionRow) -> NewEvent {
    NewEvent {
        id: crate::store::new_uuid_v7(),
        at: 2_000,
        v: 1,
        kind: "attention.risk_acted".into(),
        class: EventClass::Decision,
        actor_kind: crate::store::ActorKind::Person,
        actor_id: Some("person-actor".into()),
        channel: Some("ui".into()),
        client_id: Some("client-desktop-actor".into()),
        project_id: row.project_id.clone(),
        run_id: row.run_id.clone(),
        entity_kind: "attention".into(),
        entity_id: row.id.clone(),
        correlation_id: Some(row.id.clone()),
        idem_key: Some(row.id.clone()),
        payload: json!({ "resolution": "acted" }).to_string(),
    }
}

#[test]
fn risk_acted_resuelve_y_emite_auditoria_y_lifecycle_en_orden() {
    let (_cleanup, core) = core_listo();
    let risk = fila(&core, AttentionCategory::Risk);
    let source = evento(&risk);
    let source_id = source.id.clone();

    core.storage
        .with_store(|store| store.append_events(&[source]).unwrap())
        .unwrap();

    let resolved = core
        .storage
        .with_store(|store| store.attention_get(&risk.id).unwrap().unwrap())
        .unwrap();
    assert_eq!(
        (resolved.status, resolved.resolution),
        (AttentionStatus::Resolved, Some(Resolution::Acted))
    );
    let events = core
        .storage
        .with_store(|store| {
            store
                .events_page(&EventQuery {
                    after: Some(0),
                    limit: Some(20),
                    ..Default::default()
                })
                .unwrap()
                .events
        })
        .unwrap();
    let source = events
        .iter()
        .find(|event| event.id == source_id)
        .expect("Event de decisión durable");
    let lifecycle = events
        .iter()
        .find(|event| event.kind == "attention.resolved")
        .expect("Event derivado de ciclo de vida");
    assert!(
        source.seq < lifecycle.seq,
        "la causalidad conserva primero decisión y luego lifecycle"
    );
    assert_eq!(
        (
            source.actor_kind.as_str(),
            source.actor_id.as_deref(),
            source.channel.as_deref(),
            source.client_id.as_deref()
        ),
        (
            "person",
            Some("person-actor"),
            Some("ui"),
            Some("client-desktop-actor")
        )
    );
    assert_eq!(
        lifecycle.payload,
        json!({"resolution":"acted", "source_event_id": source_id}).to_string()
    );
    assert!(
        !source.payload.contains("policy_status"),
        "la auditoría no copia facts internos"
    );
}

#[test]
fn risk_acted_invalido_rechaza_sin_persistir_el_event_de_origen() {
    let (_cleanup, core) = core_listo();
    let question = fila(&core, AttentionCategory::Question);
    let before = core
        .storage
        .with_store(|store| store.events_head().unwrap())
        .unwrap();
    let error = core
        .storage
        .with_store(|store| store.append_events(&[evento(&question)]))
        .unwrap()
        .unwrap_err();
    assert!(
        error.to_string().contains("risk"),
        "error útil para una categoría no autorizada: {error}"
    );
    let after = core
        .storage
        .with_store(|store| store.events_head().unwrap())
        .unwrap();
    assert_eq!(
        after, before,
        "event de decisión y proyección se revierten juntos"
    );
    let unchanged = core
        .storage
        .with_store(|store| store.attention_get(&question.id).unwrap().unwrap())
        .unwrap();
    assert_eq!(unchanged.status, AttentionStatus::Active);

    let missing = AttentionRow {
        id: "att_missing".into(),
        category: AttentionCategory::Risk,
        ..question
    };
    let error = core
        .storage
        .with_store(|store| store.append_events(&[evento(&missing)]))
        .unwrap()
        .unwrap_err();
    assert!(
        error.to_string().contains("inexistente"),
        "no permite auditar una referencia ausente: {error}"
    );
    assert_eq!(
        core.storage
            .with_store(|store| store.events_head().unwrap())
            .unwrap(),
        before
    );
}

#[derive(Debug)]
struct ProjectThenFail;

impl EventProjector for ProjectThenFail {
    fn project(
        &self,
        tx: &rusqlite::Transaction<'_>,
        events: &[crate::store::EventRow],
    ) -> StoreResult<Vec<NewEvent>> {
        let projector = AttentionProjection::new(Arc::new(EventRules));
        let _ = projector.project(tx, events)?;
        Err(StoreError::InvalidEvent(
            "fallo inyectado después de resolver risk".into(),
        ))
    }
}

#[test]
fn fallo_posterior_a_la_resolucion_revierte_fila_y_auditoria() {
    let (_cleanup, core) = core_listo();
    let risk = fila(&core, AttentionCategory::Risk);
    let before = core
        .storage
        .with_store(|store| store.events_head().unwrap())
        .unwrap();
    core.storage
        .with_store(|store| store.set_event_projector(Arc::new(ProjectThenFail)))
        .unwrap();

    let error = core
        .storage
        .with_store(|store| store.append_events(&[evento(&risk)]))
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("después de resolver"));
    assert_eq!(
        core.storage
            .with_store(|store| store.events_head().unwrap())
            .unwrap(),
        before
    );
    let unchanged = core
        .storage
        .with_store(|store| store.attention_get(&risk.id).unwrap().unwrap())
        .unwrap();
    assert_eq!(
        unchanged.status,
        AttentionStatus::Active,
        "SQLite deshace la resolución junto al source Event"
    );
}

#[test]
fn command_person_desktop_resuelve_y_atribuye_evento_sin_duplicar_reintentos() {
    let (_cleanup, core) = core_listo();
    let risk = fila(&core, AttentionCategory::Risk);
    let result = core
        .attention_act_risk_from_ui(&risk.id)
        .expect("Person/Desktop puede actuar un risk");
    assert_eq!(
        result,
        json!({"attention_id": risk.id, "status":"resolved", "resolution":"acted"})
    );

    let resolved = core
        .storage
        .with_store(|store| store.attention_get(&risk.id).unwrap().unwrap())
        .unwrap();
    assert_eq!(
        (resolved.status, resolved.resolution),
        (AttentionStatus::Resolved, Some(Resolution::Acted))
    );
    let events = core
        .storage
        .with_store(|store| {
            store
                .events_page(&EventQuery {
                    after: Some(0),
                    limit: Some(20),
                    ..Default::default()
                })
                .unwrap()
                .events
        })
        .unwrap();
    let source = events
        .iter()
        .find(|event| event.kind == "attention.risk_acted")
        .expect("auditoría source");
    assert_eq!(
        (
            source.actor_kind.as_str(),
            source.actor_id.as_deref(),
            source.channel.as_deref()
        ),
        ("person", Some("user"), Some("ui"))
    );
    assert!(
        source.client_id.as_deref().is_some_and(|id| !id.is_empty()),
        "client_id viene de la identidad Desktop registrada"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&source.payload).unwrap(),
        json!({"resolution":"acted"})
    );
    assert!(!source.payload.contains("secret"));
    let head = events.last().unwrap().seq;

    core.attention_act_risk_from_ui(&risk.id)
        .expect("retry idempotente tras respuesta perdida");
    assert_eq!(
        core.storage
            .with_store(|store| store.events_head().unwrap())
            .unwrap(),
        head,
        "retry no crea Events duplicados"
    );
}

#[test]
fn command_no_actua_otra_categoria_y_rpc_no_expone_la_decision() {
    let (_cleanup, core) = core_listo();
    let question = fila(&core, AttentionCategory::Question);
    let before = core
        .storage
        .with_store(|store| store.events_head().unwrap())
        .unwrap();
    let error = core.attention_act_risk_from_ui(&question.id).unwrap_err();
    assert!(error.contains("categoría risk"), "{error}");
    assert_eq!(
        core.storage
            .with_store(|store| store.events_head().unwrap())
            .unwrap(),
        before
    );
    assert_eq!(
        core.storage
            .with_store(|store| store.attention_get(&question.id).unwrap().unwrap().status)
            .unwrap(),
        AttentionStatus::Active
    );

    let secret = "agent-attention-action-secret-at-least-32-bytes";
    let registration = ClientRegistration::new(
        ClientSurface::Cli,
        DeviceIdentity::new("install-agent-no-action", None).unwrap(),
    )
    .unwrap();
    let credential = ClientCredential::new(
        ClientPrincipal::Agent("task-agent-no-action".into()),
        secret,
    )
    .unwrap();
    core.storage
        .with_store(|store| {
            store
                .register_client(&registration, &credential, 10_000)
                .unwrap()
        })
        .unwrap();
    let agent = core.authenticate_client(secret).unwrap().unwrap();
    let error = core
        .rpc_authenticated_via(
            &agent,
            &ClientClaims::default(),
            Channel::Lxo,
            "",
            "attention_act_risk",
            &json!({"attention_id": question.id}),
        )
        .unwrap_err();
    assert!(
        error.contains("ForbiddenAction"),
        "la frontera autenticada rechaza el RPC no clasificado antes del dispatcher: {error}"
    );
    assert_eq!(
        core.storage
            .with_store(|store| store.events_head().unwrap())
            .unwrap(),
        before
    );
    assert_eq!(
        core.storage
            .with_store(|store| store.attention_get(&question.id).unwrap().unwrap().status)
            .unwrap(),
        AttentionStatus::Active
    );

    let legacy = core.rpc_via(
        Channel::Lxo,
        Caller::Agent(Some("task-agent-no-action".into())),
        "",
        "attention_act_risk",
        &json!({"attention_id": question.id}),
    );
    assert!(legacy.unwrap_err().contains("desconocido"));
}

#[test]
fn fallo_de_proyeccion_revierte_command_y_la_fila_sigue_activa() {
    let (_cleanup, core) = core_listo();
    let risk = fila(&core, AttentionCategory::Risk);
    let before = core
        .storage
        .with_store(|store| store.events_head().unwrap())
        .unwrap();
    core.storage
        .with_store(|store| store.set_event_projector(Arc::new(ProjectThenFail)))
        .unwrap();

    let error = core.attention_act_risk_from_ui(&risk.id).unwrap_err();
    assert!(
        error.contains("fallo inyectado después de resolver"),
        "{error}"
    );
    assert_eq!(
        core.storage
            .with_store(|store| store.events_head().unwrap())
            .unwrap(),
        before,
        "no queda Event parcial"
    );
    let unchanged = core
        .storage
        .with_store(|store| store.attention_get(&risk.id).unwrap().unwrap())
        .unwrap();
    assert_eq!(
        unchanged.status,
        AttentionStatus::Active,
        "se revierte la fila junto a la auditoría"
    );
}
