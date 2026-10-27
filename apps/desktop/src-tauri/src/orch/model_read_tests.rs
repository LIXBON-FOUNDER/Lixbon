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
fn con_fixture() -> (super::boot_tests::Limpia, PathBuf, PathBuf, Arc<Core>) {
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
    assert_eq!(rpc(&core, &me, "core_model", json!({})).unwrap(), json!({ "core_model": "legacy", "compat": [], "queries": [], "storage": { "status": "ready", "code": null, "message": null } }));
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
        ("task_list_v2", json!({ "project_id": "p-1", "cursor": "nope" }), "model_cursor_stale"),
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
    let items = att["items"].as_array().expect("attention_list devuelve items");
    let de = |id: &str| items.iter().filter(|i| i["target_id"] == id).map(|i| i["category"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(de(&a1), ["failed"], "el fallo del intento 1 es suyo");
    assert_eq!(de(&a2), ["approval"], "la aprobación pendiente es del intento 2");
    let de_la_task = rpc(&core, &me, "attention_list", json!({ "target_kind": "task", "target_id": task })).unwrap();
    assert!(de_la_task["items"].as_array().unwrap().is_empty(), "los hechos de ejecución no apuntan a la Task");
    let act = rpc(&core, &me, "activity_list", json!({ "target_kind": "attempt", "target_id": a1 })).unwrap();
    let claves: Vec<&str> = act["items"].as_array().expect("activity_list devuelve items").iter().map(|i| i["message_key"].as_str().unwrap()).collect();
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

/// LXO-124 · `lxo attempts --task` y `lxo attempt show` con el binario real, como persona, contra el HTTP de un Core
/// **migrado por su arranque**: la fixture de la ADR como estado legacy, un arranque sin el interruptor (los comandos
/// salen con 4 y remiten a `lxo task show`) y otro con `LIXBON_AGENTIC_CUT` (LXO-234), que corta y carga el estado
/// de las tablas. Luego, una Task sin intentos y otra con dos. Requiere `LXO_BIN`; usa el almacén seguro real.
#[test]
#[ignore = "requiere un binario lxo real (LXO_BIN) y el almacén seguro del sistema; ver apps/desktop/README.md"]
fn lxo_bin_e2e_attempts_person_real_store() {
    use super::agentic_cut::SWITCH_FOR_TESTS;
    use super::boot_tests::{arranca, suelta};
    use super::projects_overview_tests::RealStoreServer;
    let text = |out: &std::process::Output| (String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned());

    SWITCH_FOR_TESTS.with(|c| c.set(Some(false)));
    let (l, data, core_dir, core) = con_fixture();
    {
        let server = RealStoreServer::start(&core, &data, &l.0);
        let antes = server.lxo(&["attempts", "--task", "t3"], None);
        assert_eq!(antes.status.code(), Some(4), "sin el corte no hay intentos: {:?}", text(&antes));
        assert!(text(&antes).1.contains("lxo task show"), "{:?}", text(&antes));
        // LXO-125 · la forma 2 llega con el corte; la 1 sigue igual.
        assert_eq!(server.lxo(&["tasks", "--json", "--schema", "2"], None).status.code(), Some(4));
        assert_eq!(server.json(&["tasks", "--json"])["v"], 1);
    }
    suelta(core, &core_dir);
    SWITCH_FOR_TESTS.with(|c| c.set(Some(true)));
    let (core, _host, ready) = arranca(&data, &core_dir);
    ready.unwrap();
    core.settings.lock().unwrap().enabled = true;
    assert!(core.storage.with_store(|s| s.runtime_on_tables().unwrap()).unwrap(), "el arranque cortó la base");
    let server = RealStoreServer::start(&core, &data, &l.0);

    let ana = MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) };
    let (vacia, dos, a1, a2) = core
        .storage
        .with_store(|s| {
            let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: "encargo privado".into(), repo: "/home/ana/app".into() };
            let (_, vacia) = create_run(s, &ana, &NewRun { objective: "sin lanzar".into(), project_id: "p-1".into(), root: intencion("sin intentos") }).unwrap();
            let (_, dos) = create_run(s, &ana, &NewRun { objective: "dos intentos".into(), project_id: "p-1".into(), root: intencion("reintentada") }).unwrap();
            let new = NewAttempt { provider: "codex".into(), model: Some("gpt-5".into()), effort: None, role: None, profile: None, external: false, requires_approval: false };
            let a1 = attempt_ops::create(s, &ana, &dos.id, &new).unwrap();
            attempt_ops::start(s, &MutationContext::core(), &a1.id).unwrap();
            attempt_ops::fail(s, &MutationContext::core(), &a1.id, FailureCode::AgentIdleTimeout, "").unwrap();
            let a2 = attempt_ops::create(s, &ana, &dos.id, &NewAttempt { requires_approval: true, ..new }).unwrap();
            (vacia.id, dos.id, a1.id, a2.id)
        })
        .unwrap();
    let ids = |doc: &Value| -> Vec<String> { doc["attempts"].as_array().unwrap().iter().map(|a| a["attempt_id"].as_str().unwrap().to_string()).collect() };

    // Task con 0, 1 y N intentos.
    let cero = server.json(&["attempts", "--task", &vacia, "--json"]);
    assert_eq!((cero["total"].clone(), cero["attempts"].clone(), cero["core_model"].clone()), (json!(0), json!([]), json!("task_attempt_v1")), "{cero}");
    assert_eq!(ids(&server.json(&["attempts", "--task", "t5", "--json"])), ["t5-a1"]);
    let n = server.json(&["attempts", "--task", &dos, "--json"]);
    assert_eq!(ids(&n), [a1.clone(), a2.clone()]);
    assert_eq!((n["task"]["task_id"].as_str(), n["task"]["current_attempt_id"].as_str()), (Some(dos.as_str()), Some(a2.as_str())));
    assert_eq!((n["attempts"][0]["task_id"].as_str(), n["attempts"][0]["status"].as_str()), (Some(dos.as_str()), Some("failed")));
    assert!(!n.to_string().contains("encargo privado"), "no copia el encargo");
    let (lista, _) = text(&server.lxo(&["attempts", "--task", &dos], None));
    assert!(lista.contains(&format!("#2 {a2} · pendiente de aprobación · codex (gpt-5) · actual")), "{lista}");

    // Filtros.
    assert_eq!(ids(&server.json(&["attempts", "--task", &dos, "--status", "failed", "--json"])), [a1.clone()]);
    assert_eq!(ids(&server.json(&["attempts", "--task", &dos, "--provider", "CODEX", "--json"])).len(), 2);
    assert!(ids(&server.json(&["attempts", "--task", &dos, "--provider", "claude", "--json"])).is_empty());

    // Ficha: la ejecución con su sesión (sin la referencia del proveedor), Worktree, Artifacts y revisión.
    let ficha = server.json(&["attempt", "show", "t3-a1", "--json"]);
    let a = &ficha["attempt"];
    assert_eq!((a["attempt_id"].as_str(), a["task_id"].as_str(), a["provider_session"]["provider_session_id"].as_str()), (Some("t3-a1"), Some("t3"), Some("ps-t3-a1")));
    assert_eq!((a["worktree"]["path"].as_str(), a["review"]["verdict"].as_str(), a["review"]["head_commit"].as_str()), (Some("/home/ana/app.lixbon-wt/t3-api-de-sesiones"), Some("accepted"), Some("c3c3c3")));
    assert_eq!(a["worktree"]["machine"], Value::Null, "lo que el Core no registra queda null");
    assert!(!ficha.to_string().contains("rollout-t3.jsonl"), "la referencia opaca del proveedor no sale");
    let fallo = server.json(&["attempt", "show", &a1, "--json"]);
    assert_eq!((fallo["attempt"]["failure_reason"].as_str(), fallo["attempt"]["final"].as_bool()), (Some("agent_idle_timeout"), Some(true)));
    let textos: Vec<String> = fallo["activity"]["items"].as_array().unwrap().iter().filter_map(|i| i["text"].as_str().map(String::from)).collect();
    assert_eq!(textos.len(), 3, "requested, started y failed, traducidos: {}", fallo["activity"]);
    let (humana, _) = text(&server.lxo(&["attempt", "show", "t3-a1"], None));
    assert!(humana.contains("Revisión:    aceptada · HEAD c3c3c3 sobre base b0b0b0 · vigente") && humana.contains("máquina desconocida"), "{humana}");

    // Intento inexistente, y el id de una Task no elige ningún intento.
    let falta = server.lxo(&["attempt", "show", "t999-a1", "--json"], None);
    assert_eq!(falta.status.code(), Some(6));
    let error: Value = serde_json::from_slice(&falta.stderr).unwrap();
    assert_eq!(error["code"], "not_found", "{error}");
    let de_task = server.lxo(&["attempt", "show", &dos], None);
    assert_eq!(de_task.status.code(), Some(2), "{:?}", text(&de_task));
    assert!(text(&de_task).1.contains(&format!("lxo attempts --task {dos}")), "{:?}", text(&de_task));
    assert_eq!(server.lxo(&["attempts", "--task", "t999"], None).status.code(), Some(6));
    assert_eq!(server.lxo(&["attempts"], None).status.code(), Some(2), "la tarea se nombra siempre");

    // Compatibilidad: los comandos legacy (lecturas F2 sobre el estado cargado de las tablas) avisan tras el corte.
    let (ficha_legacy, aviso) = text(&server.lxo(&["task", "show", "t3"], None));
    assert!(ficha_legacy.contains("Intentos:    1 · cada uno con lxo attempts --task t3"), "{ficha_legacy} / {aviso}");
    assert!(aviso.contains("Aviso: el Core ya usa el modelo Task/Attempt") && aviso.contains("lxo attempts --task t3"), "{aviso}");
    let (_, aviso_lista) = text(&server.lxo(&["tasks"], None));
    assert!(aviso_lista.contains("lxo attempts --task <id>"), "{aviso_lista}");
    let legacy_json = server.lxo(&["task", "show", "t3", "--json"], None);
    assert!(legacy_json.status.success() && legacy_json.stderr.is_empty(), "el --json legacy no cambia en LXO-124");

    // LXO-125 · forma 2 del --json: la Task sin nada de la ejecución y sus intentos por id; la 1 no cambia.
    let v1 = server.json(&["tasks", "--json"]);
    assert_eq!((v1["v"].clone(), v1["task_model"].clone()), (json!(1), json!("legacy")));
    let v2 = server.json(&["tasks", "--json", "--schema", "2"]);
    assert_eq!((v2["v"].clone(), v2["task_model"].clone()), (json!(2), json!("task_attempt_v1")));
    let de = |doc: &Value, id: &str| doc["tasks"].as_array().unwrap().iter().find(|t| t["task_id"] == id).cloned().unwrap_or(Value::Null);
    assert_eq!((de(&v2, &dos)["attempt_count"].clone(), de(&v2, &dos)["current_attempt"]["attempt_id"].clone()), (json!(2), json!(a2)));
    assert_eq!(de(&v2, "t3")["state"], "integrated");
    assert!(!v2.to_string().contains("\"branch\"") && !v2.to_string().contains("encargo privado"), "{v2}");
    let en_revision = server.json(&["tasks", "--json", "--schema", "2", "--state", "in_review"]);
    assert!(en_revision["tasks"].as_array().unwrap().iter().all(|t| t["state"] == "in_review"));
    let detalle = server.json(&["task", "show", &dos, "--json", "--schema", "2"]);
    assert_eq!(
        detalle["task"]["attempts"],
        json!([{ "attempt_id": a1, "n": 1, "status": "failed" }, { "attempt_id": a2, "n": 2, "status": "pending_approval" }]),
        "con N intentos los nombra todos y no elige ninguno"
    );
    assert!(detalle["task"].get("provider").is_none() && detalle["task"].get("worktree").is_none());
    assert_eq!(server.lxo(&["tasks", "--json", "--schema", "2", "--status", "running"], None).status.code(), Some(2));
    assert_eq!(server.lxo(&["task", "show", "reintentada", "--json", "--schema", "2"], None).status.code(), Some(6), "la forma 2 va por id");
    // --attempt: la Attention y los eventos de un intento concreto.
    let att = server.json(&["attention", "--attempt", &a1, "--json"]);
    assert_eq!(att["items"].as_array().unwrap().iter().map(|i| i["category"].clone()).collect::<Vec<_>>(), [json!("failed")], "{att}");
    let ev = server.json(&["events", "--attempt", &a1, "--json"]);
    assert!(!ev["events"].as_array().unwrap().is_empty() && ev["events"].as_array().unwrap().iter().all(|e| e["entity"]["id"] == a1.as_str()), "{ev}");
    assert_eq!(server.lxo(&["events", "--task", &dos, "--attempt", &a1], None).status.code(), Some(2));

    // Solo personas.
    let token = "agent-lxo-attempts-e2e-token-with-32-bytes-ok";
    agente(&core, &dos, "install-agent-lxo-attempts-e2e", token);
    let como_agente = server.lxo(&["attempts", "--task", &dos], Some((&dos, token)));
    assert_eq!(como_agente.status.code(), Some(3), "{:?}", text(&como_agente));
    core.stop_server_with(&server.discovery);
    assert_eq!(server.lxo(&["attempts", "--task", &dos], None).status.code(), Some(5), "Lixbon cerrado");
}

#[test]
fn cursores_por_clave_pertenencia_y_vigencia() {
    let (_l, data, core_dir, core) = con_fixture();
    corta(&core, &core_dir, &data);
    let me = yo(&core);
    // task_list_v2: el cursor es la clave (created_at, id), no una posición.
    let p1 = rpc(&core, &me, "task_list_v2", json!({ "project_id": "p-1", "limit": 2 })).unwrap();
    let cursor = p1["next_cursor"].as_str().unwrap().to_string();
    assert!(cursor.starts_with("t3:"), "{cursor}");
    let ajeno = rpc(&core, &me, "task_list_v2", json!({ "project_id": "p-otro", "cursor": cursor })).unwrap_err();
    assert!(ajeno.contains("model_invalid_request"), "{ajeno}");
    // El cursor anterior `t2:<task>` se acepta en la ventana de compatibilidad y la respuesta ya va en `t3:`.
    let id_corte = p1["items"][1]["id"].as_str().unwrap().to_string();
    let viejo = rpc(&core, &me, "task_list_v2", json!({ "project_id": "p-1", "limit": 1, "cursor": format!("t2:{id_corte}") })).unwrap();
    let nuevo = rpc(&core, &me, "task_list_v2", json!({ "project_id": "p-1", "limit": 1, "cursor": cursor })).unwrap();
    assert_eq!(viejo, nuevo, "t2: y t3: de la misma Task dan la misma página");
    assert!(viejo["next_cursor"].as_str().unwrap().starts_with("t3:"));
    assert!(rpc(&core, &me, "task_list_v2", json!({ "project_id": "p-otro", "cursor": format!("t2:{id_corte}") })).unwrap_err().contains("model_invalid_request"));
    for raro in ["t9:x", "t3:no-es-numero:t3", "a1:1"] {
        assert!(rpc(&core, &me, "task_list_v2", json!({ "project_id": "p-1", "cursor": raro })).unwrap_err().contains("model_cursor_stale"), "{raro}");
    }
    assert!(rpc(&core, &me, "attempts_by_task", json!({ "task_id": "t3", "cursor": "t3:1:t3" })).unwrap_err().contains("model_cursor_stale"));

    // attempts_by_task pagina, y una Task de otro Project no se lee con ese Project.
    let ctx = MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) };
    let task = core
        .storage
        .with_store(|s| {
            let intencion = NewTaskIntent { title: "tres intentos".into(), spec: String::new(), repo: "/home/ana/app".into() };
            let (_, t) = create_run(s, &ctx, &NewRun { objective: "x".into(), project_id: "p-1".into(), root: intencion }).unwrap();
            let new = NewAttempt { provider: "codex".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
            let sistema = MutationContext::core();
            for _ in 0..3 {
                let a = attempt_ops::create(s, &ctx, &t.id, &new).unwrap();
                attempt_ops::start(s, &sistema, &a.id).unwrap();
                attempt_ops::fail(s, &sistema, &a.id, FailureCode::AgentIdleTimeout, "").unwrap();
            }
            t.id
        })
        .unwrap();
    let a = rpc(&core, &me, "attempts_by_task", json!({ "task_id": task, "limit": 2 })).unwrap();
    assert_eq!(a["items"].as_array().unwrap().len(), 2);
    assert_eq!(a["next_cursor"], json!("a1:2"));
    let b = rpc(&core, &me, "attempts_by_task", json!({ "task_id": task, "limit": 2, "cursor": a["next_cursor"] })).unwrap();
    assert_eq!((b["items"][0]["n"].clone(), b["next_cursor"].clone()), (json!(3), Value::Null));
    // Un Attempt del runtime que terminó trae `ended_at` y `origin = core`.
    assert!(b["items"][0]["ended_at"].is_i64() && b["items"][0]["origin"] == "core" && b["items"][0]["ended_at_known"] == true);
    assert!(rpc(&core, &me, "attempts_by_task", json!({ "task_id": task, "cursor": "a1:9" })).unwrap_err().contains("model_invalid_request"));
    assert!(rpc(&core, &me, "attempts_by_task", json!({ "task_id": task, "project_id": "p-otro" })).unwrap_err().contains("model_not_found"));
    assert!(rpc(&core, &me, "attempt_detail", json!({ "attempt_id": "t3-a1", "task_id": task })).unwrap_err().contains("model_not_found"));
    assert!(rpc(&core, &me, "attempt_detail", json!({ "attempt_id": "t3-a1", "project_id": "p-otro" })).unwrap_err().contains("model_not_found"));
    assert!(rpc(&core, &me, "task_detail_v2", json!({ "task_id": "t3", "project_id": "p-otro" })).unwrap_err().contains("model_not_found"));
    // La revisión dice si sigue vigente.
    let d = rpc(&core, &me, "attempt_detail", json!({ "attempt_id": "t3-a1", "task_id": "t3", "project_id": "p-1" })).unwrap();
    let v = &d["attempt"]["review"]["validity"];
    assert_eq!((v["attempt_is_current"].as_bool(), v["integrated"].as_bool()), (Some(true), Some(true)));
    assert!(d["attempt"].get("integrated_at").is_some());
    // Un migrado final sin fin registrado lo marca.
    assert_eq!((d["attempt"]["origin"].as_str(), d["attempt"]["ended_at_known"].as_bool()), (Some("legacy"), Some(false)));
}

#[test]
fn activity_por_attempt_incluye_sesion_worktree_y_revision() {
    use crate::store::{ArtifactKind, NewArtifact, NewProviderSession, NewWorktree, Provenance, SessionBinding};
    let (_l, data, core_dir, core) = con_fixture();
    corta(&core, &core_dir, &data);
    let me = yo(&core);
    let ana = MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) };
    let (a1, a2) = core
        .storage
        .with_store(|s| {
            let sistema = MutationContext::core();
            let intencion = NewTaskIntent { title: "con worktree".into(), spec: String::new(), repo: "/home/ana/app".into() };
            let (_, t) = create_run(s, &ana, &NewRun { objective: "act".into(), project_id: "p-1".into(), root: intencion }).unwrap();
            let new = NewAttempt { provider: "codex".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
            let a1 = attempt_ops::create(s, &ana, &t.id, &new).unwrap();
            attempt_ops::start(s, &sistema, &a1.id).unwrap();
            let wt = super::worktree_ops::register(s, &sistema, &a1.id, &NewWorktree {
                provenance: Provenance::Created, machine: "m1".into(), repo: "/home/ana/app".into(), path: "/home/ana/app-wt".into(),
                branch: Some("lx/act".into()), base_branch: Some("main".into()), base_commit: None,
            }).unwrap();
            let ps = super::session_ops::open(s, &sistema, &a1.id, &NewProviderSession { resumable: true, external_ref: None }).unwrap();
            super::session_ops::bind(s, &sistema, &ps.id, "sesion-externa-1", SessionBinding::SessionId).unwrap();
            super::worktree_ops::artifact(s, &sistema, &a1.id, &NewArtifact { kind: ArtifactKind::Commit, uri: "abcdef1".into(), sha256: None, bytes: None }).unwrap();
            super::worktree_ops::lost(s, &sistema, &wt.id).unwrap();
            attempt_ops::fail(s, &sistema, &a1.id, FailureCode::AgentIdleTimeout, "").unwrap();
            let a2 = attempt_ops::create(s, &ana, &t.id, &new).unwrap();
            attempt_ops::start(s, &sistema, &a2.id).unwrap();
            super::worktree_ops::found(s, &sistema, &wt.id).unwrap();
            super::worktree_ops::attach(s, &sistema, &wt.id, &a2.id).unwrap();
            (a1.id, a2.id)
        })
        .unwrap();
    let kinds = |id: &str, limit: u64| {
        let r = rpc(&core, &me, "activity_list", json!({ "attempt_id": id, "limit": limit })).unwrap();
        assert!(r["next_cursor"].is_i64(), "next_cursor siempre");
        (r["items"].as_array().unwrap().iter().map(|i| i["kind"].as_str().unwrap().to_string()).collect::<Vec<_>>(), r)
    };
    let (k1, _) = kinds(&a1, 100);
    assert_eq!(k1, ["attempt.requested", "attempt.started", "worktree.created", "provider_session.opened", "provider_session.bound", "artifact.created", "worktree.missing", "attempt.failed", "worktree.found"]);
    let (k2, _) = kinds(&a2, 100);
    // Los hechos sin Attempt de un Worktree compartido salen en todos los Attempts que lo usan (también antes de enlazarlo).
    assert_eq!(k2, ["worktree.missing", "attempt.requested", "attempt.started", "worktree.found", "worktree.attached"]);
    // a1: sus hechos, los de su sesión y su Worktree (también `bound` y `missing`, que no nombran Attempt); nunca
    // los de a2 (`worktree.attached` nombra a2).
    for k in ["worktree.created", "provider_session.opened", "provider_session.bound", "artifact.created", "worktree.missing"] {
        assert_eq!(k1.iter().filter(|x| x.as_str() == k).count(), 1, "a1 tiene un {k}: {k1:?}");
    }
    assert!(!k1.iter().any(|k| k == "worktree.attached"), "{k1:?}");
    // a2 comparte el Worktree (lo enlazó): ve `attached` y los hechos sin Attempt de ese Worktree, no los que nombran a1.
    assert_eq!(k2.iter().filter(|x| x.as_str() == "worktree.attached").count(), 1, "{k2:?}");
    assert!(!k2.iter().any(|k| k == "worktree.created" || k == "artifact.created" || k.starts_with("provider_session.")), "{k2:?}");
    // Paginación: con limit 2 se recorre lo mismo.
    let (mut todo, mut cursor) = (Vec::new(), 0i64);
    loop {
        let r = rpc(&core, &me, "activity_list", json!({ "attempt_id": a1, "limit": 2, "cursor": cursor })).unwrap();
        todo.extend(r["items"].as_array().unwrap().iter().map(|i| i["kind"].as_str().unwrap().to_string()));
        cursor = r["next_cursor"].as_i64().unwrap();
        if !r["has_more"].as_bool().unwrap() {
            break;
        }
    }
    assert_eq!(todo, k1);
    let e = rpc(&core, &me, "activity_list", json!({ "attempt_id": a1, "target_kind": "attempt" })).unwrap_err();
    assert!(e.contains("activity_invalid_request"), "{e}");
}
