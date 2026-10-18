//! LXO-89 · contratos de lectura de Attention por la frontera autenticada del Core.

use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use serde_json::{json, Value};

use super::boot_tests::*;
use super::events::{Channel, MutationContext};
use super::state::NewTask;
use super::{Caller, Core};
use crate::store::{
    AttentionCategory, AttentionRow, AttentionTarget, ClientClaims, ClientCredential,
    ClientPrincipal, ClientRegistration, ClientSurface, NewAttention, Raised, Resolution, Severity,
    TargetKind,
};

fn core_listo() -> (Limpia, PathBuf, PathBuf, Arc<Core>) {
    let (l, data, core_dir) = dirs();
    let (core, _host, ready) = arranca(&data, &core_dir);
    ready.unwrap();
    core.settings.lock().unwrap().enabled = true;
    (l, data, core_dir, core)
}

fn persona(
    core: &Core,
    id: &str,
    installation: &str,
    secret: &str,
) -> crate::store::AuthenticatedClient {
    let registration = ClientRegistration::new(
        ClientSurface::Cli,
        crate::store::DeviceIdentity::new(installation, None).unwrap(),
    )
    .unwrap();
    let credential = ClientCredential::new(ClientPrincipal::Person(id.into()), secret).unwrap();
    core.storage
        .with_store(|store| {
            store
                .register_client(&registration, &credential, 10_000)
                .unwrap()
        })
        .unwrap();
    core.authenticate_client(secret).unwrap().unwrap()
}

fn agente(
    core: &Core,
    task: &str,
    installation: &str,
    secret: &str,
) -> crate::store::AuthenticatedClient {
    let registration = ClientRegistration::new(
        ClientSurface::Cli,
        crate::store::DeviceIdentity::new(installation, None).unwrap(),
    )
    .unwrap();
    let credential = ClientCredential::new(ClientPrincipal::Agent(task.into()), secret).unwrap();
    core.storage
        .with_store(|store| {
            store
                .register_client(&registration, &credential, 10_001)
                .unwrap()
        })
        .unwrap();
    core.authenticate_client(secret).unwrap().unwrap()
}

fn tarea(core: &Core, title: &str) -> String {
    core.mutate(|tx| {
        let (run, root) = tx.create_run(
            title,
            NewTask {
                agent: "claude".into(),
                model: None,
                effort: None,
                role: None,
                title: title.into(),
                spec: "spec".into(),
                repo: "repo".into(),
                cwd: "cwd".into(),
                branch: None,
                base: None,
                worktree: None,
                external: true,
            },
        );
        tx.mark_running(&root)?;
        let child = tx.add_child(
            &root,
            1,
            NewTask {
                external: false,
                agent: "claude".into(),
                model: None,
                effort: None,
                role: None,
                title: format!("{title}-child"),
                spec: "child".into(),
                repo: "repo".into(),
                cwd: "cwd".into(),
                branch: None,
                base: None,
                worktree: None,
            },
        )?;
        tx.mark_running(&child)?;
        let _ = run;
        Ok(child)
    })
    .unwrap()
}

fn attention(
    category: AttentionCategory,
    target: &str,
    project: &str,
    severity: Severity,
    at: i64,
) -> NewAttention {
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

fn rpc(
    core: &Arc<Core>,
    client: &crate::store::AuthenticatedClient,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    core.rpc_authenticated_via(
        client,
        &ClientClaims::default(),
        Channel::Lxo,
        "",
        cmd,
        &args,
    )
}

fn dto_fields(item: &Value) -> Vec<String> {
    let mut keys: Vec<_> = item.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    keys
}

fn git(repo: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

#[test]
fn person_pagina_attention_activa_con_dto_allowlisted_sin_duplicar_ni_perder() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = persona(
        &core,
        "person-read",
        "install-person-read",
        "person-read-secret-0123456789abcdef",
    );
    let mut rows = vec![
        raise(
            &core,
            attention(
                AttentionCategory::Failed,
                "task-a",
                "project-a",
                Severity::High,
                1_000,
            ),
        ),
        raise(
            &core,
            attention(
                AttentionCategory::Question,
                "task-b",
                "project-a",
                Severity::Low,
                1_000,
            ),
        ),
        raise(
            &core,
            attention(
                AttentionCategory::Risk,
                "task-c",
                "project-b",
                Severity::Critical,
                2_000,
            ),
        ),
    ];
    rows.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
    core.storage
        .with_store(|store| {
            store
                .attention_resolve(&rows[1].id, Resolution::Acted, 1_500)
                .unwrap()
        })
        .unwrap();

    let mut args = json!({ "limit": 1 });
    let first =
        rpc(&core, &client, "attention_list", args.clone()).expect("Person debe leer la lista");
    assert_eq!(first["v"], 1);
    assert_eq!(first["has_more"], true);
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    let item = &first["items"][0];
    assert_eq!(
        dto_fields(item),
        [
            "category",
            "created_at",
            "id",
            "occurrence",
            "project_id",
            "resolution",
            "resolved_at",
            "run_id",
            "severity",
            "status",
            "target_id",
            "target_kind"
        ]
    );
    assert_eq!(item["status"], "active");
    assert!(item.get("fingerprint").is_none());
    assert!(item.get("facts").is_none());
    assert!(item.get("subject").is_none());
    assert!(item.get("event_seq").is_none());
    assert!(item.get("source_event_id").is_none());
    assert!(item.get("correlation_id").is_none());

    let mut found = vec![item.clone()];
    let mut cursor = first["next_cursor"]
        .as_str()
        .expect("cursor opaco como texto")
        .to_string();
    assert!(!cursor.is_empty());
    loop {
        args["cursor"] = json!(cursor);
        let page = rpc(&core, &client, "attention_list", args.clone())
            .expect("cursor de la misma consulta debe seguir");
        found.extend(page["items"].as_array().unwrap().iter().cloned());
        if !page["has_more"].as_bool().unwrap() {
            assert!(page["next_cursor"].is_null());
            break;
        }
        cursor = page["next_cursor"].as_str().unwrap().to_string();
    }
    let ids: Vec<_> = found
        .iter()
        .map(|item| item["id"].as_str().unwrap().to_string())
        .collect();
    let unique: BTreeSet<_> = ids.iter().cloned().collect();
    assert_eq!(unique.len(), ids.len(), "la paginación no duplica filas");
    let expected: Vec<_> = rows
        .iter()
        .filter(|row| row.id != rows[1].id)
        .map(|row| row.id.clone())
        .collect();
    assert_eq!(
        ids, expected,
        "orden ascendente por (created_at, id), sin saltos y solo activas"
    );

    let filtered = rpc(
        &core,
        &client,
        "attention_list",
        json!({
            "project_id": "project-b", "target_kind": "task", "target_id": "task-c",
            "category": "risk", "severity": "critical", "limit": 1
        }),
    )
    .expect("todos los filtros de lista son compatibles");
    assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["items"][0]["id"], rows[2].id);
    assert!(
        rpc(
            &core,
            &client,
            "attention_list",
            json!({ "severity": "urgent" })
        )
        .unwrap_err()
        .contains("severity"),
        "filtro inválido da error útil"
    );
    let desktop = core
        .rpc_via(Channel::Ui, Caller::User, "", "attention_list", &json!({}))
        .expect("orch_call usa identidad Person/Desktop autenticada");
    assert_eq!(desktop["items"].as_array().unwrap().len(), 2);
}

#[test]
fn agent_scope_y_detail_se_derivan_de_credencial_y_no_del_request() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let own_task = tarea(&core, "own-task");
    let other_task = tarea(&core, "other-task");
    let client = agente(
        &core,
        &own_task,
        "install-agent-read",
        "agent-read-secret-0123456789abcdef",
    );
    let own = raise(
        &core,
        attention(
            AttentionCategory::Question,
            &own_task,
            "project-a",
            Severity::High,
            1_000,
        ),
    );
    let other = raise(
        &core,
        attention(
            AttentionCategory::Risk,
            &other_task,
            "project-b",
            Severity::Critical,
            2_000,
        ),
    );

    let list = rpc(
        &core,
        &client,
        "attention_list",
        json!({ "target_id": other_task }),
    )
    .expect("el filtro se combina con el scope del Agent");
    assert!(
        list["items"].as_array().unwrap().is_empty(),
        "el scope del Agent se combina con filtros, no se reemplaza"
    );
    let body_spoof = rpc(
        &core,
        &client,
        "attention_list",
        json!({ "caller": other_task }),
    )
    .unwrap_err();
    assert!(
        body_spoof.contains("parámetro desconocido"),
        "el request no admite elegir identidad: {body_spoof}"
    );
    let own_detail = rpc(
        &core,
        &client,
        "attention_detail",
        json!({ "attention_id": own.id }),
    )
    .expect("detalle propio");
    assert_eq!(own_detail["id"], own.id);
    assert!(
        rpc(
            &core,
            &client,
            "attention_detail",
            json!({ "attention_id": other.id })
        )
        .is_err(),
        "detalle ajeno es indistinguible de inexistente"
    );

    let spoofed = ClientClaims {
        caller: Some(other_task),
        ..Default::default()
    };
    let error = core
        .rpc_authenticated_via(
            &client,
            &spoofed,
            Channel::Lxo,
            "",
            "attention_list",
            &json!({}),
        )
        .unwrap_err();
    assert!(
        error.contains("Identidad de cliente inválida"),
        "claims caller no pueden cambiar Task autenticada: {error}"
    );
}

#[test]
fn cursor_rechaza_manipulacion_filtros_distintos_y_principal_distinto() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let person_a = persona(
        &core,
        "person-a",
        "install-person-a",
        "person-a-secret-0123456789abcdef",
    );
    let person_b = persona(
        &core,
        "person-b",
        "install-person-b",
        "person-b-secret-0123456789abcdef",
    );
    for index in 0..3 {
        raise(
            &core,
            attention(
                AttentionCategory::Failed,
                &format!("task-{index}"),
                "project-a",
                Severity::High,
                1_000 + index,
            ),
        );
    }
    let first = rpc(
        &core,
        &person_a,
        "attention_list",
        json!({ "limit": 1, "project_id": "project-a" }),
    )
    .unwrap();
    let cursor = first["next_cursor"].as_str().unwrap();
    assert!(
        !cursor.contains("person-a")
            && !cursor.contains("install-person-a")
            && !cursor.contains("task-"),
        "el cursor no expone scope ni ids internos"
    );
    let mutated = format!("{cursor}x");
    assert!(
        rpc(
            &core,
            &person_a,
            "attention_list",
            json!({ "limit": 1, "project_id": "project-a", "cursor": mutated })
        )
        .is_err(),
        "integridad del cursor"
    );
    assert!(
        rpc(
            &core,
            &person_a,
            "attention_list",
            json!({ "limit": 1, "project_id": "project-b", "cursor": cursor })
        )
        .is_err(),
        "filtros canonizados ligados al cursor"
    );
    assert!(
        rpc(
            &core,
            &person_b,
            "attention_list",
            json!({ "limit": 1, "project_id": "project-a", "cursor": cursor })
        )
        .is_err(),
        "principal y client_id ligados al cursor"
    );

    let agent_task = tarea(&core, "agent-cursor-task");
    let agent = agente(
        &core,
        &agent_task,
        "install-agent-cursor",
        "agent-cursor-secret-0123456789abcdef",
    );
    assert!(
        rpc(
            &core,
            &agent,
            "attention_list",
            json!({ "limit": 1, "project_id": "project-a", "cursor": cursor })
        )
        .is_err(),
        "el cursor Person no se reutiliza en scope Agent"
    );
}

#[test]
fn tras_reiniciar_core_se_reanuda_desde_primera_pagina_y_rechaza_cursor_anterior() {
    let (cleanup, data, core_dir) = dirs();
    let (core1, _host1, ready1) = arranca(&data, &core_dir);
    ready1.unwrap();
    let secret = "person-reconnect-cursor-secret-0123456789abcdef";
    let client1 = persona(
        &core1,
        "person-reconnect",
        "install-person-reconnect",
        secret,
    );
    let first = raise(
        &core1,
        attention(
            AttentionCategory::Failed,
            "task-old",
            "project-reconnect",
            Severity::High,
            1_000,
        ),
    );
    raise(
        &core1,
        attention(
            AttentionCategory::Question,
            "task-new",
            "project-reconnect",
            Severity::Low,
            2_000,
        ),
    );
    let page1 = rpc(&core1, &client1, "attention_list", json!({ "limit": 1 })).unwrap();
    assert_eq!(page1["items"][0]["id"], first.id);
    let old_cursor = page1["next_cursor"].as_str().unwrap().to_string();
    drop(client1);
    drop(core1);

    let (core2, _host2, ready2) = arranca(&data, &core_dir);
    ready2.unwrap();
    let client2 = core2.authenticate_client(secret).unwrap().unwrap();
    let resumed = rpc(
        &core2,
        &client2,
        "attention_list",
        json!({ "limit": 1, "cursor": old_cursor }),
    );
    assert!(
        resumed.unwrap_err().contains("attention_invalid_cursor"),
        "la clave rota con el Core impide reanudar el cursor anterior"
    );
    let restarted = rpc(&core2, &client2, "attention_list", json!({ "limit": 1 })).unwrap();
    assert_eq!(
        restarted["items"][0]["id"], first.id,
        "el cliente reinicia desde la primera página"
    );
    drop(core2);
    drop(cleanup);
}

#[test]
fn list_y_detail_son_read_only_y_el_token_legacy_no_autentica_attention() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = persona(
        &core,
        "person-read-only",
        "install-read-only",
        "readonly-secret-0123456789abcdef",
    );
    let row = raise(
        &core,
        attention(
            AttentionCategory::ReviewReady,
            "task-read-only",
            "project-a",
            Severity::Medium,
            1_000,
        ),
    );
    let before = core
        .storage
        .with_store(|store| {
            (
                store.events_head().unwrap(),
                store.attention_get(&row.id).unwrap().unwrap(),
            )
        })
        .unwrap();
    rpc(&core, &client, "attention_list", json!({})).expect("lectura de lista");
    rpc(
        &core,
        &client,
        "attention_detail",
        json!({ "attention_id": row.id }),
    )
    .expect("lectura de detalle");
    let after = core
        .storage
        .with_store(|store| {
            (
                store.events_head().unwrap(),
                store.attention_get(&row.id).unwrap().unwrap(),
            )
        })
        .unwrap();
    assert_eq!(
        after, before,
        "list/detail no crean ni modifican filas ni eventos"
    );

    let legacy = core.rpc_via(
        Channel::Lxo,
        Caller::Agent(Some("task-spoofed".into())),
        "",
        "attention_list",
        &json!({}),
    );
    assert!(
        legacy.is_err(),
        "token legacy/caller de request no es identidad autenticada para Attention"
    );
}

#[test]
fn pregunta_reply_de_dominio_hace_desaparecer_attention_de_la_lista_activa() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let task = tarea(&core, "question-attention-e2e");
    let agent = agente(
        &core,
        &task,
        "install-question-e2e",
        "agent-question-e2e-secret-0123456789abcdef",
    );
    let person = persona(
        &core,
        "person-question-e2e",
        "install-person-question-e2e",
        "person-question-e2e-secret-0123456789abcdef",
    );

    let asked = rpc(
        &core,
        &agent,
        "ask",
        json!({ "question": "¿Qué debe hacer el worker?" }),
    )
    .expect("la Task Agent crea la pregunta mediante el Command de dominio");
    let question_id = asked["question"].as_u64().expect("id de pregunta real");

    let before = rpc(
        &core,
        &person,
        "attention_list",
        json!({ "category": "question" }),
    )
    .expect("Person ve la Attention segura del Core local");
    let active = before["items"].as_array().unwrap();
    assert_eq!(active.len(), 1, "la pregunta activa llega al read API");
    let attention_id = active[0]["id"].as_str().unwrap().to_string();
    assert_eq!(active[0]["category"], "question");
    assert_eq!(active[0]["target_id"], task);
    assert_eq!(active[0]["status"], "active");
    let detail = rpc(
        &core,
        &person,
        "attention_detail",
        json!({ "attention_id": attention_id }),
    )
    .expect("detail usa el mismo contrato público");
    assert_eq!(detail["id"], before["items"][0]["id"]);

    core.rpc_via(
        Channel::Ui,
        Caller::User,
        "",
        "reply",
        &json!({
            "question": question_id,
            "answer": "Continúa con el plan aprobado.",
        }),
    )
    .expect("Person responde mediante el Command de dominio desde Desktop");

    let after = rpc(
        &core,
        &person,
        "attention_list",
        json!({ "category": "question" }),
    )
    .expect("la lista activa se consulta otra vez");
    assert!(
        after["items"].as_array().unwrap().is_empty(),
        "task.reply resuelve la Attention de esa pregunta"
    );
    let resolved = rpc(
        &core,
        &person,
        "attention_detail",
        json!({ "attention_id": detail["id"] }),
    )
    .expect("detail conserva la fila resuelta como historial");
    assert_eq!(resolved["status"], "resolved");
    assert_eq!(resolved["resolution"], "acted");
}

#[test]
fn approval_visible_en_inbox_se_resuelve_por_el_command_del_dominio() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let task = tarea(&core, "approval-attention-e2e");
    core.mutate(|tx| tx.await_terminal_approval(&task, 123_000))
        .unwrap();
    let person = persona(
        &core,
        "person-approval-e2e",
        "install-person-approval-e2e",
        "person-approval-e2e-secret-0123456789abcdef",
    );

    let before = rpc(
        &core,
        &person,
        "attention_list",
        json!({ "category": "approval" }),
    )
    .unwrap();
    assert_eq!(before["items"].as_array().unwrap().len(), 1);
    let id = before["items"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(before["items"][0]["target_id"], task);

    core.mutate_as(&MutationContext::person(Channel::Ui), |tx| {
        tx.resume_from_approval(&task)
    })
    .unwrap();
    let after = rpc(
        &core,
        &person,
        "attention_list",
        json!({ "category": "approval" }),
    )
    .unwrap();
    assert!(
        after["items"].as_array().unwrap().is_empty(),
        "la reanudación confirmada por la persona resuelve la approval"
    );
    let detail = rpc(
        &core,
        &person,
        "attention_detail",
        json!({ "attention_id": id }),
    )
    .unwrap();
    assert_eq!(detail["status"], "resolved");
    assert_eq!(detail["resolution"], "acted");
}

#[test]
fn review_ready_visible_en_inbox_desaparece_despues_de_la_revision_de_dominio() {
    let (cleanup, data, core_dir) = dirs();
    let repo = cleanup.0.join("review-repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["config", "user.name", "Attention E2E"]);
    git(
        &repo,
        &["config", "user.email", "attention-e2e@example.test"],
    );
    std::fs::write(repo.join("README.md"), "base\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "base"]);
    git(&repo, &["checkout", "-q", "-b", "feature/attention-e2e"]);
    std::fs::write(repo.join("change.txt"), "review me\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "change"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    git(&repo, &["checkout", "-q", "main"]);

    let (core, _host, ready) = arranca(&data, &core_dir);
    ready.unwrap();
    core.settings.lock().unwrap().enabled = true;
    let repo_text = repo.to_string_lossy().into_owned();
    let task = core
        .mutate(|tx| {
            let (run, root) = tx.create_run(
                "review acceptance",
                NewTask {
                    agent: "coordinator".into(),
                    model: None,
                    effort: None,
                    role: None,
                    title: "review acceptance".into(),
                    spec: "root".into(),
                    repo: repo_text.clone(),
                    cwd: repo_text.clone(),
                    branch: Some("main".into()),
                    base: None,
                    worktree: None,
                    external: true,
                },
            );
            tx.mark_running(&root)?;
            let child = tx.add_child(
                &root,
                1,
                NewTask {
                    agent: "claude".into(),
                    model: None,
                    effort: None,
                    role: None,
                    title: "reviewable result".into(),
                    spec: "child".into(),
                    repo: repo_text.clone(),
                    cwd: repo_text.clone(),
                    branch: Some("feature/attention-e2e".into()),
                    base: Some("main".into()),
                    worktree: None,
                    external: false,
                },
            )?;
            tx.mark_running(&child)?;
            tx.done(&child, true, "delivered", Vec::new(), None)?;
            let _ = run;
            Ok(child)
        })
        .unwrap();
    let person = persona(
        &core,
        "person-review-e2e",
        "install-person-review-e2e",
        "person-review-e2e-secret-0123456789abcdef",
    );

    let before = rpc(
        &core,
        &person,
        "attention_list",
        json!({ "category": "review_ready" }),
    )
    .unwrap();
    assert_eq!(before["items"].as_array().unwrap().len(), 1);
    let id = before["items"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(before["items"][0]["target_id"], task);

    let reviewed = core
        .review_from_ui(&task, "accepted", &head, Some("revisado"), true)
        .unwrap();
    assert_eq!(reviewed["outcome"], "recorded");
    let after = rpc(
        &core,
        &person,
        "attention_list",
        json!({ "category": "review_ready" }),
    )
    .unwrap();
    assert!(
        after["items"].as_array().unwrap().is_empty(),
        "decision.recorded de review resuelve review_ready"
    );
    let detail = rpc(
        &core,
        &person,
        "attention_detail",
        json!({ "attention_id": id }),
    )
    .unwrap();
    assert_eq!(detail["status"], "resolved");
    assert_eq!(detail["resolution"], "acted");
    drop(core);
    drop(cleanup);
}
