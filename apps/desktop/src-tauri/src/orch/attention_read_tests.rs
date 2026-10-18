//! LXO-89 · contratos de lectura de Attention por la frontera autenticada del Core.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};

use super::boot_tests::*;
use super::events::Channel;
use super::state::NewTask;
use super::{Caller, Core};
use crate::store::{
    AttentionCategory, AttentionRow, AttentionTarget, ClientClaims, ClientCredential, ClientPrincipal,
    ClientRegistration, ClientSurface, NewAttention, Raised, Resolution, Severity, TargetKind,
};

fn core_listo() -> (Limpia, PathBuf, PathBuf, Arc<Core>) {
    let (l, data, core_dir) = dirs();
    let (core, _host, ready) = arranca(&data, &core_dir);
    ready.unwrap();
    core.settings.lock().unwrap().enabled = true;
    (l, data, core_dir, core)
}

fn persona(core: &Core, id: &str, installation: &str, secret: &str) -> crate::store::AuthenticatedClient {
    let registration = ClientRegistration::new(
        ClientSurface::Cli,
        crate::store::DeviceIdentity::new(installation, None).unwrap(),
    )
    .unwrap();
    let credential = ClientCredential::new(ClientPrincipal::Person(id.into()), secret).unwrap();
    core.storage
        .with_store(|store| store.register_client(&registration, &credential, 10_000).unwrap())
        .unwrap();
    core.authenticate_client(secret).unwrap().unwrap()
}

fn agente(core: &Core, task: &str, installation: &str, secret: &str) -> crate::store::AuthenticatedClient {
    let registration = ClientRegistration::new(
        ClientSurface::Cli,
        crate::store::DeviceIdentity::new(installation, None).unwrap(),
    )
    .unwrap();
    let credential = ClientCredential::new(ClientPrincipal::Agent(task.into()), secret).unwrap();
    core.storage
        .with_store(|store| store.register_client(&registration, &credential, 10_001).unwrap())
        .unwrap();
    core.authenticate_client(secret).unwrap().unwrap()
}

fn tarea(core: &Core, title: &str) -> String {
    core.mutate(|tx| {
        let (run, root) = tx.create_run(title, NewTask {
            agent: "claude".into(), model: None, effort: None, role: None, title: title.into(), spec: "spec".into(),
            repo: "repo".into(), cwd: "cwd".into(), branch: None, base: None, worktree: None, external: true,
        });
        tx.mark_running(&root)?;
        let child = tx.add_child(&root, 1, NewTask {
            external: false,
            agent: "claude".into(), model: None, effort: None, role: None, title: format!("{title}-child"), spec: "child".into(),
            repo: "repo".into(), cwd: "cwd".into(), branch: None, base: None, worktree: None,
        })?;
        tx.mark_running(&child)?;
        let _ = run;
        Ok(child)
    }).unwrap()
}

fn attention(category: AttentionCategory, target: &str, project: &str, severity: Severity, at: i64) -> NewAttention {
    NewAttention {
        category,
        severity,
        target: AttentionTarget::new(TargetKind::Task, target).unwrap(),
        project_id: Some(project.into()),
        run_id: Some("run-test".into()),
        subject: Some(format!("private subject {target}")),
        source_event_id: Some(format!("source-{target}")),
        correlation_id: Some(format!("correlation-{target}")),
        facts: format!(r#"{{"internal":"secret-{target}"}}"#),
        at,
    }
}

fn raise(core: &Core, row: NewAttention) -> AttentionRow {
    core.storage
        .with_store(|store| match store.attention_raise(&row).unwrap() {
            Raised::Created(row) => row,
            other => panic!("se esperaba nueva Attention, salió {other:?}"),
        })
        .unwrap()
}

fn rpc(core: &Arc<Core>, client: &crate::store::AuthenticatedClient, cmd: &str, args: Value) -> Result<Value, String> {
    core.rpc_authenticated_via(client, &ClientClaims::default(), Channel::Lxo, "", cmd, &args)
}

fn dto_fields(item: &Value) -> Vec<String> {
    let mut keys: Vec<_> = item.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

#[test]
fn person_pagina_attention_activa_con_dto_allowlisted_sin_duplicar_ni_perder() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = persona(&core, "person-read", "install-person-read", "person-read-secret-0123456789abcdef");
    let mut rows = vec![
        raise(&core, attention(AttentionCategory::Failed, "task-a", "project-a", Severity::High, 1_000)),
        raise(&core, attention(AttentionCategory::Question, "task-b", "project-a", Severity::Low, 1_000)),
        raise(&core, attention(AttentionCategory::Risk, "task-c", "project-b", Severity::Critical, 2_000)),
    ];
    rows.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    core.storage.with_store(|store| store.attention_resolve(&rows[1].id, Resolution::Acted, 1_500).unwrap()).unwrap();

    let mut args = json!({ "limit": 1 });
    let first = rpc(&core, &client, "attention_list", args.clone()).expect("Person debe leer la lista");
    assert_eq!(first["v"], 1);
    assert_eq!(first["has_more"], true);
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    let item = &first["items"][0];
    assert_eq!(dto_fields(item), [
        "category", "created_at", "id", "occurrence", "project_id", "resolution", "resolved_at", "run_id", "severity", "status", "target_id", "target_kind"
    ]);
    assert_eq!(item["status"], "active");
    assert!(item.get("fingerprint").is_none());
    assert!(item.get("facts").is_none());
    assert!(item.get("subject").is_none());
    assert!(item.get("event_seq").is_none());
    assert!(item.get("source_event_id").is_none());
    assert!(item.get("correlation_id").is_none());

    let mut found = vec![item.clone()];
    let mut cursor = first["next_cursor"].as_str().expect("cursor opaco como texto").to_string();
    assert!(!cursor.is_empty());
    loop {
        args["cursor"] = json!(cursor);
        let page = rpc(&core, &client, "attention_list", args.clone()).expect("cursor de la misma consulta debe seguir");
        found.extend(page["items"].as_array().unwrap().iter().cloned());
        if !page["has_more"].as_bool().unwrap() {
            assert!(page["next_cursor"].is_null());
            break;
        }
        cursor = page["next_cursor"].as_str().unwrap().to_string();
    }
    let ids: Vec<_> = found.iter().map(|item| item["id"].as_str().unwrap().to_string()).collect();
    let unique: BTreeSet<_> = ids.iter().cloned().collect();
    assert_eq!(unique.len(), ids.len(), "la paginación no duplica filas");
    let expected: Vec<_> = rows.iter().filter(|row| row.id != rows[1].id).map(|row| row.id.clone()).collect();
    assert_eq!(ids, expected, "orden ascendente por (created_at, id), sin saltos y solo activas");
}

#[test]
fn agent_scope_y_detail_se_derivan_de_credencial_y_no_del_request() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let own_task = tarea(&core, "own-task");
    let other_task = tarea(&core, "other-task");
    let client = agente(&core, &own_task, "install-agent-read", "agent-read-secret-0123456789abcdef");
    let own = raise(&core, attention(AttentionCategory::Question, &own_task, "project-a", Severity::High, 1_000));
    let other = raise(&core, attention(AttentionCategory::Risk, &other_task, "project-b", Severity::Critical, 2_000));

    let list = rpc(&core, &client, "attention_list", json!({ "target_id": other_task }))
        .expect("el filtro se combina con el scope del Agent");
    assert!(list["items"].as_array().unwrap().is_empty(), "el scope del Agent se combina con filtros, no se reemplaza");
    let body_spoof = rpc(&core, &client, "attention_list", json!({ "caller": other_task })).unwrap_err();
    assert!(body_spoof.contains("parámetro desconocido"), "el request no admite elegir identidad: {body_spoof}");
    let own_detail = rpc(&core, &client, "attention_detail", json!({ "attention_id": own.id }))
        .expect("detalle propio");
    assert_eq!(own_detail["id"], own.id);
    assert!(rpc(&core, &client, "attention_detail", json!({ "attention_id": other.id })).is_err(), "detalle ajeno es indistinguible de inexistente");

    let spoofed = ClientClaims { caller: Some(other_task), ..Default::default() };
    let error = core.rpc_authenticated_via(&client, &spoofed, Channel::Lxo, "", "attention_list", &json!({})).unwrap_err();
    assert!(error.contains("Identidad de cliente inválida"), "claims caller no pueden cambiar Task autenticada: {error}");
}

#[test]
fn cursor_rechaza_manipulacion_filtros_distintos_y_principal_distinto() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let person_a = persona(&core, "person-a", "install-person-a", "person-a-secret-0123456789abcdef");
    let person_b = persona(&core, "person-b", "install-person-b", "person-b-secret-0123456789abcdef");
    for index in 0..3 {
        raise(&core, attention(AttentionCategory::Failed, &format!("task-{index}"), "project-a", Severity::High, 1_000 + index));
    }
    let first = rpc(&core, &person_a, "attention_list", json!({ "limit": 1, "project_id": "project-a" })).unwrap();
    let cursor = first["next_cursor"].as_str().unwrap();
    let mutated = format!("{cursor}x");
    assert!(rpc(&core, &person_a, "attention_list", json!({ "limit": 1, "project_id": "project-a", "cursor": mutated })).is_err(), "integridad del cursor");
    assert!(rpc(&core, &person_a, "attention_list", json!({ "limit": 1, "project_id": "project-b", "cursor": cursor })).is_err(), "filtros canonizados ligados al cursor");
    assert!(rpc(&core, &person_b, "attention_list", json!({ "limit": 1, "project_id": "project-a", "cursor": cursor })).is_err(), "principal y client_id ligados al cursor");
}

#[test]
fn list_y_detail_son_read_only_y_el_token_legacy_no_autentica_attention() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = persona(&core, "person-read-only", "install-read-only", "readonly-secret-0123456789abcdef");
    let row = raise(&core, attention(AttentionCategory::ReviewReady, "task-read-only", "project-a", Severity::Medium, 1_000));
    let before = core.storage.with_store(|store| (store.events_head().unwrap(), store.attention_get(&row.id).unwrap().unwrap())).unwrap();
    rpc(&core, &client, "attention_list", json!({})).expect("lectura de lista");
    rpc(&core, &client, "attention_detail", json!({ "attention_id": row.id })).expect("lectura de detalle");
    let after = core.storage.with_store(|store| (store.events_head().unwrap(), store.attention_get(&row.id).unwrap().unwrap())).unwrap();
    assert_eq!(after, before, "list/detail no crean ni modifican filas ni eventos");

    let legacy = core.rpc_via(Channel::Lxo, Caller::Agent(Some("task-spoofed".into())), "", "attention_list", &json!({}));
    assert!(legacy.is_err(), "token legacy/caller de request no es identidad autenticada para Attention");
}
