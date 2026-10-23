//! LXO-119 · lecturas vNext del modelo Task/Attempt sobre un Core real: `core_model` antes y después del corte,
//! respuestas versionadas (`docs/core/fixtures/api/`), Attention y Activity de dos Attempts de una Task, compatibilidad
//! de las lecturas F2 y permisos.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use super::agentic_cut;
use super::attempt_ops;
use super::attention_read_tests::{agente, core_listo, persona, rpc};
use super::event_kinds::FailureCode;
use super::events::{Actor, Channel, MutationContext};
use super::rpc::rpc_action_for_tests;
use super::task_ops::create_run;
use super::Core;
use crate::store::{ClientAction, NewAttempt, NewRun, NewTaskIntent};

const FIXTURE: &str = include_str!("../../../../../docs/core/fixtures/corte-task-attempt/legacy_state.before.json");
const QUERIES: [&str; 5] = ["core_model", "task_list_v2", "task_detail_v2", "attempts_by_task", "attempt_detail"];

fn yo(core: &Core) -> crate::store::AuthenticatedClient {
    persona(core, "person-model", "install-person-model", "person-model-secret-0123456789abcdef")
}

/// Un Core real con `legacy_state` = la fixture de la ADR y su Project `p-1`.
fn con_fixture() -> (impl Drop, PathBuf, PathBuf, Arc<Core>) {
    let (l, data, core_dir, core) = core_listo();
    core.storage
        .with_store(|s| {
            s.write(|tx| {
                tx.execute("INSERT INTO projects (id, name, created_at, updated_at, fingerprint) VALUES ('p-1', 'app', 0, 0, '{}')", [])?;
                tx.execute(
                    "INSERT INTO legacy_state (id, rev, doc_schema, doc, updated_at) VALUES (1, 42, 0, ?1, 0) ON CONFLICT (id) DO UPDATE SET doc = excluded.doc",
                    [FIXTURE],
                )?;
                Ok(())
            })
        })
        .unwrap()
        .unwrap();
    (l, data, core_dir, core)
}

fn corta(core: &Core, core_dir: &Path, data: &Path) {
    let r = core.storage.with_store(|s| agentic_cut::run(s, core_dir, data, "t")).unwrap().unwrap();
    assert!(matches!(r, agentic_cut::CutReport::Applied { .. }));
}

/// Compara con la fixture versionada (`LXO_WRITE_API_FIXTURES=1` la regenera; revísala a mano).
fn fixture(name: &str, got: &Value) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../docs/core/fixtures/api").join(name);
    if std::env::var_os("LXO_WRITE_API_FIXTURES").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, serde_json::to_string_pretty(got).unwrap() + "\n").unwrap();
    }
    let want: Value = serde_json::from_slice(&std::fs::read(&path).unwrap_or_else(|_| panic!("falta {}", path.display()))).unwrap();
    assert_eq!(got, &want, "{name} cambió: si es a propósito, sube la versión de la query y regenera la fixture");
}

#[test]
fn son_lecturas_y_solo_una_person_las_hace() {
    for q in QUERIES {
        assert_eq!(rpc_action_for_tests(q), ClientAction::Read, "{q}");
    }
    let (_l, _d, _c, core) = con_fixture();
    let bot = agente(&core, "t3", "install-agent-model", "agent-model-secret-0123456789abcdef");
    for q in QUERIES {
        assert!(rpc(&core, &bot, q, json!({})).is_err(), "{q}: un agente no lee el modelo");
    }
}

#[test]
fn antes_del_corte_el_core_anuncia_legacy_y_las_lecturas_vnext_lo_dicen() {
    let (_l, _d, _c, core) = con_fixture();
    let me = yo(&core);
    assert_eq!(rpc(&core, &me, "core_model", json!({})).unwrap(), json!({ "core_model": "legacy", "compat": [], "queries": [] }));
    for (q, args) in [
        ("task_list_v2", json!({ "project_id": "p-1" })),
        ("task_detail_v2", json!({ "task_id": "t3" })),
        ("attempts_by_task", json!({ "task_id": "t3" })),
        ("attempt_detail", json!({ "attempt_id": "t3-a1" })),
    ] {
        let e = rpc(&core, &me, q, args).unwrap_err();
        assert!(e.contains("core_model_inactive"), "{q}: {e}");
    }
}

#[test]
fn tras_el_corte_las_lecturas_responden_con_su_version_y_cuadran_con_las_fixtures() {
    let (_l, data, core_dir, core) = con_fixture();
    corta(&core, &core_dir, &data);
    let me = yo(&core);
    fixture("core_model.v1.json", &rpc(&core, &me, "core_model", json!({})).unwrap());
    fixture("task_list_v2.json", &rpc(&core, &me, "task_list_v2", json!({ "project_id": "p-1" })).unwrap());
    fixture("task_detail_v2.json", &rpc(&core, &me, "task_detail_v2", json!({ "task_id": "t3" })).unwrap());
    fixture("attempts_by_task.v1.json", &rpc(&core, &me, "attempts_by_task", json!({ "task_id": "t5" })).unwrap());
    let t3 = rpc(&core, &me, "attempt_detail", json!({ "attempt_id": "t3-a1" })).unwrap();
    fixture("attempt_detail.v1.json", &t3);
    // La ejecución lleva lo suyo: sesión (sin la referencia del proveedor), Worktree, Artifacts y revisión.
    let a = &t3["attempt"];
    assert_eq!((a["provider_session"]["binding"].as_str(), a["provider_session"]["bound"].as_bool()), (Some("session_id"), Some(true)));
    assert!(!t3.to_string().contains("rollout-t3.jsonl"), "la referencia opaca del proveedor no sale");
    assert_eq!((a["worktree"]["provenance"].as_str(), a["review"]["verdict"].as_str(), a["integrated"].as_bool()), (Some("created"), Some("accepted"), Some(true)));
    // El estado de la Task se deriva de su Attempt actual.
    let lista = rpc(&core, &me, "task_list_v2", json!({ "project_id": "p-1" })).unwrap();
    let estado = |id: &str| lista["items"].as_array().unwrap().iter().find(|t| t["id"] == id).map(|t| t["state"].clone()).unwrap();
    assert_eq!((estado("t3"), estado("t4"), estado("t5")), (json!("integrated"), json!("open"), json!("in_review")));
    // Paginación con cursor opaco: las dos páginas son la lista.
    let total = lista["items"].as_array().unwrap().len();
    let p1 = rpc(&core, &me, "task_list_v2", json!({ "project_id": "p-1", "limit": 2 })).unwrap();
    let p2 = rpc(&core, &me, "task_list_v2", json!({ "project_id": "p-1", "limit": 100, "cursor": p1["next_cursor"] })).unwrap();
    let ids: Vec<Value> = p1["items"].as_array().unwrap().iter().chain(p2["items"].as_array().unwrap()).map(|t| t["id"].clone()).collect();
    assert_eq!(ids, lista["items"].as_array().unwrap().iter().map(|t| t["id"].clone()).collect::<Vec<_>>());
    assert!(total > 2 && p2["next_cursor"].is_null());
    for (q, args, code) in [
        ("task_detail_v2", json!({ "task_id": "t999" }), "model_not_found"),
        ("attempt_detail", json!({ "attempt_id": "t999-a1" }), "model_not_found"),
        ("task_list_v2", json!({ "project_id": "p-1", "limit": 0 }), "model_invalid_request"),
        ("task_list_v2", json!({ "project_id": "p-1", "cursor": "nope" }), "model_invalid_request"),
        ("task_list_v2", json!({ "project_id": "p-1", "status": "all" }), "model_invalid_request"),
        ("attempts_by_task", json!({}), "model_invalid_request"),
    ] {
        let e = rpc(&core, &me, q, args).unwrap_err();
        assert!(e.contains(code), "{q}: {e}");
    }
}

#[test]
fn dos_attempts_de_una_task_tienen_su_propia_attention_y_su_propia_activity() {
    let (_l, data, core_dir, core) = con_fixture();
    corta(&core, &core_dir, &data);
    let me = yo(&core);
    let ana = MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) };
    let (a1, a2, task) = core
        .storage
        .with_store(|s| {
            let intencion = NewTaskIntent { title: "reintentar".into(), spec: String::new(), repo: "/home/ana/app".into() };
            let (_, t) = create_run(s, &ana, &NewRun { objective: "dos intentos".into(), project_id: "p-1".into(), root: intencion }).unwrap();
            let new = NewAttempt { provider: "codex".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
            let sistema = MutationContext::core();
            let a1 = attempt_ops::create(s, &ana, &t.id, &new).unwrap();
            attempt_ops::start(s, &sistema, &a1.id).unwrap();
            attempt_ops::fail(s, &sistema, &a1.id, FailureCode::AgentIdleTimeout, "").unwrap();
            let a2 = attempt_ops::create(s, &ana, &t.id, &NewAttempt { requires_approval: true, ..new }).unwrap();
            (a1.id, a2.id, t.id)
        })
        .unwrap();
    let att = rpc(&core, &me, "attention_list", json!({ "target_kind": "attempt" })).unwrap();
    let items = att["items"].as_array().unwrap_or_else(|| panic!("{att}"));
    let de = |id: &str| items.iter().filter(|i| i["target_id"] == id).map(|i| i["category"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(de(&a1), ["failed"], "el fallo del intento 1 es suyo");
    assert_eq!(de(&a2), ["approval"], "la aprobación pendiente es del intento 2");
    let de_la_task = rpc(&core, &me, "attention_list", json!({ "target_kind": "task", "target_id": task })).unwrap();
    assert!(de_la_task["items"].as_array().unwrap().is_empty(), "los hechos de ejecución no apuntan a la Task");
    let act = rpc(&core, &me, "activity_list", json!({ "target_kind": "attempt", "target_id": a1 })).unwrap();
    let claves: Vec<&str> = act["items"].as_array().unwrap_or_else(|| panic!("{act}")).iter().map(|i| i["message_key"].as_str().unwrap()).collect();
    assert_eq!(claves, ["activity.attempt.requested", "activity.attempt.started", "activity.attempt.failed"]);
    let lista = rpc(&core, &me, "attempts_by_task", json!({ "task_id": task })).unwrap();
    assert_eq!(lista["items"].as_array().unwrap().iter().map(|a| a["status"].clone()).collect::<Vec<_>>(), [json!("failed"), json!("pending_approval")]);
    let detalle = rpc(&core, &me, "task_detail_v2", json!({ "task_id": task })).unwrap();
    assert_eq!((detalle["task"]["state"].as_str(), detalle["task"]["current_attempt"]["id"].as_str()), (Some("in_progress"), Some(a2.as_str())));
}

#[test]
fn las_lecturas_f2_no_cambian_con_el_corte() {
    let (_l, data, core_dir, core) = con_fixture();
    let me = yo(&core);
    let project = super::tasks_read_tests::proyecto(&core, "f2");
    super::tasks_read_tests::tarea(&core, "una tarea F2", Some(&project));
    let leer = || (rpc(&core, &me, "tasks_by_project", json!({ "project_id": project, "status": "all" })).unwrap(), rpc(&core, &me, "projects_overview", json!({})).unwrap()["projects"].clone());
    let antes = leer();
    corta(&core, &core_dir, &data);
    assert_eq!(leer(), antes, "tasks_by_project y projects_overview (v1) responden igual: los clientes F2 no cambian");
}
