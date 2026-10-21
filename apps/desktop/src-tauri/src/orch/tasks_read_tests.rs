//! LXO-98 · `tasks_by_project` y `task_detail` despachados por el RPC del Core.

use std::sync::Arc;

use serde_json::{json, Value};

use super::attention_read_tests::{agente, core_listo, persona, rpc};
use super::rpc::rpc_action_for_tests;
use super::state::NewTask;
use super::Core;
use crate::store::{ClientAction, Fingerprint, NewLocation};

fn person(core: &Core) -> crate::store::AuthenticatedClient {
    persona(core, "person-tasks", "install-person-tasks", "person-tasks-secret-0123456789abcdef")
}

fn proyecto(core: &Core, name: &str) -> String {
    core.storage
        .with_store(|store| {
            store
                .project_create(
                    name,
                    &Fingerprint::default(),
                    &NewLocation { machine: "m".into(), path: format!("/r/{name}"), display_path: format!("/r/{name}"), primary: true },
                )
                .unwrap()
                .id
        })
        .unwrap()
}

fn tarea(core: &Core, title: &str, project: Option<&str>) -> String {
    core.mutate(|tx| {
        let (_run, root) = tx.create_run(
            title,
            NewTask {
                agent: "claude".into(), model: None, effort: None, role: None, title: title.into(), spec: "spec".into(),
                repo: "repo".into(), cwd: "cwd".into(), branch: None, base: None, worktree: None, external: true,
            },
        );
        tx.mark_running(&root)?;
        if let Some(t) = tx.tasks.get_mut(&root) {
            t.project_id = project.map(str::to_string);
        }
        Ok(root)
    })
    .unwrap()
}

#[test]
fn son_lecturas_clasificadas_como_read() {
    assert_eq!(rpc_action_for_tests("tasks_by_project"), ClientAction::Read);
    assert_eq!(rpc_action_for_tests("task_detail"), ClientAction::Read);
}

#[test]
fn tasks_by_project_lista_solo_las_del_project() {
    let (_l, _d, _c, core) = core_listo();
    let core: Arc<Core> = core;
    let p = person(&core);
    let a = proyecto(&core, "alfa");
    let b = proyecto(&core, "beta");
    let ta = tarea(&core, "Task A", Some(&a));
    let _tb = tarea(&core, "Task B", Some(&b));
    let _tn = tarea(&core, "Sin project", None);

    let r = rpc(&core, &p, "tasks_by_project", json!({ "project_id": a, "status": "all", "limit": 50 })).unwrap();
    assert_eq!(r["v"], 1);
    assert_eq!(r["project_id"], json!(a));
    assert_eq!(r["filters"], json!({ "status": "all" }));
    assert_eq!(r["limit"], 50);
    assert_eq!(r["has_more"], false);
    assert_eq!(r["next_cursor"], Value::Null);
    let tasks = r["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0]["id"], json!(ta));
    assert_eq!(tasks[0]["title"], "Task A");
    assert_eq!(tasks[0]["status"], "running");
    assert_eq!(tasks[0]["root_id"], json!(ta));
    assert!(tasks[0]["created_at"].is_u64() && tasks[0]["updated_at"].is_u64());

    let final_only = rpc(&core, &p, "tasks_by_project", json!({ "project_id": a, "status": "final" })).unwrap();
    assert_eq!(final_only["tasks"].as_array().unwrap().len(), 0);
}

#[test]
fn tasks_by_project_pagina_con_cursor_opaco() {
    let (_l, _d, _c, core) = core_listo();
    let p = person(&core);
    let a = proyecto(&core, "alfa");
    for i in 0..3 {
        tarea(&core, &format!("T{i}"), Some(&a));
    }
    let first = rpc(&core, &p, "tasks_by_project", json!({ "project_id": a, "status": "all", "limit": 2 })).unwrap();
    assert_eq!(first["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(first["has_more"], true);
    let cursor = first["next_cursor"].as_str().unwrap().to_string();
    let second = rpc(&core, &p, "tasks_by_project", json!({ "project_id": a, "status": "all", "limit": 2, "cursor": cursor })).unwrap();
    assert_eq!(second["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(second["has_more"], false);
    assert_eq!(second["next_cursor"], Value::Null);
    let err = rpc(&core, &p, "tasks_by_project", json!({ "project_id": a, "cursor": "nope" })).unwrap_err();
    assert!(err.starts_with("tasks_invalid_request"), "{err}");
}

#[test]
fn tasks_by_project_exige_project_id_y_project_existente() {
    let (_l, _d, _c, core) = core_listo();
    let p = person(&core);
    for args in [json!({}), json!({ "status": "all" }), json!({ "project_id": "" }), json!({ "project_id": 7 })] {
        let err = rpc(&core, &p, "tasks_by_project", args).unwrap_err();
        assert!(err.starts_with("tasks_invalid_request"), "{err}");
    }
    let err = rpc(&core, &p, "tasks_by_project", json!({ "project_id": "no-existe" })).unwrap_err();
    assert!(err.starts_with("tasks_project_not_found"), "{err}");
    let err = rpc(&core, &p, "tasks_by_project", json!({ "project_id": "x", "otro": 1 })).unwrap_err();
    assert!(err.starts_with("tasks_invalid_request"), "{err}");
}

#[test]
fn task_detail_devuelve_el_dto_del_task_workspace() {
    let (_l, _d, _c, core) = core_listo();
    let p = person(&core);
    let a = proyecto(&core, "alfa");
    let t = tarea(&core, "Task A", Some(&a));
    let r = rpc(&core, &p, "task_detail", json!({ "project_id": a, "task_id": t })).unwrap();
    assert_eq!(r["v"], 1);
    let task = &r["task"];
    assert_eq!(task["id"], json!(t));
    assert_eq!(task["project_id"], json!(a));
    assert_eq!(task["status"], "running");
    for field in ["run_id", "parent_id", "root_id", "provider", "model", "created_at", "updated_at", "child_ids",
        "phase", "messages", "cwd", "branch", "worktree", "merged", "review", "integration"] {
        assert!(task.get(field).is_some(), "falta {field}");
    }
    assert_eq!(task["child_ids"], json!([]));
    assert_eq!(task["review"], Value::Null);
    assert_eq!(task["integration"], Value::Null);
}

#[test]
fn task_detail_rechaza_ids_inexistentes_o_de_otro_project() {
    let (_l, _d, _c, core) = core_listo();
    let p = person(&core);
    let a = proyecto(&core, "alfa");
    let b = proyecto(&core, "beta");
    let t = tarea(&core, "Task A", Some(&a));
    let err = rpc(&core, &p, "task_detail", json!({ "project_id": a, "task_id": "no-existe" })).unwrap_err();
    assert!(err.starts_with("tasks_not_found"), "{err}");
    let err = rpc(&core, &p, "task_detail", json!({ "project_id": b, "task_id": t })).unwrap_err();
    assert!(err.starts_with("tasks_not_found"), "{err}");
    let err = rpc(&core, &p, "task_detail", json!({ "project_id": "no-existe", "task_id": t })).unwrap_err();
    assert!(err.starts_with("tasks_project_not_found"), "{err}");
    let err = rpc(&core, &p, "task_detail", json!({ "task_id": t })).unwrap_err();
    assert!(err.starts_with("tasks_invalid_request"), "{err}");
    let err = rpc(&core, &p, "task_detail", json!({ "project_id": a })).unwrap_err();
    assert!(err.starts_with("tasks_invalid_request"), "{err}");
}

#[test]
fn un_agent_no_lee_tasks_de_un_project() {
    let (_l, _d, _c, core) = core_listo();
    let a = proyecto(&core, "alfa");
    let t = tarea(&core, "Task A", Some(&a));
    let agent = agente(&core, &t, "install-agent-tasks", "agent-tasks-secret-0123456789abcdef");
    assert!(rpc(&core, &agent, "tasks_by_project", json!({ "project_id": a })).is_err());
    assert!(rpc(&core, &agent, "task_detail", json!({ "project_id": a, "task_id": t })).is_err());
}
