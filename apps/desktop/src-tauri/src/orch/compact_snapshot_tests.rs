//! LXO-94 · contrato de `compact_snapshot`: snapshot compacta de solo lectura para clientes ligeros.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::attention_read_tests::{agente, attention, core_listo, persona, raise, rpc};
use super::boot_tests::{arranca, espera_lock_libre};
use super::events::Channel;
use super::compact_snapshot::{clip, MAX_ACTIVE_TASKS, MAX_ATTENTION_ITEMS, MAX_PROJECTS, MAX_SNAPSHOT_BYTES, MAX_TEXT_CHARS};
use super::rpc::rpc_action_for_tests;
use super::state::{NewTask, Status};
use super::tasks_read_tests::{proyecto, tarea};
use super::Core;
use crate::store::{AttentionCategory, AuthenticatedClient, ClientAction, Severity};

const PERSON_SECRET: &str = "person-snapshot-secret-0123456789abcdef";

fn person(core: &Core) -> AuthenticatedClient {
    persona(core, "person-snapshot", "install-person-snapshot", PERSON_SECRET)
}

fn snap(core: &Arc<Core>, client: &AuthenticatedClient, args: Value) -> Value {
    rpc(core, client, "compact_snapshot", args).expect("compact_snapshot responde a una Person autenticada")
}

fn code(err: String) -> String {
    err.split(':').next().unwrap_or("").trim().to_string()
}

/// Todo el Event Log desde `cursor`, página a página, como lo seguiría un cliente.
fn events_after(core: &Arc<Core>, client: &AuthenticatedClient, cursor: i64) -> Vec<Value> {
    let mut out = Vec::new();
    let mut cursor = cursor;
    loop {
        let page = rpc(core, client, "events", json!({ "cursor": cursor, "limit": 500 })).expect("events");
        out.extend(page["events"].as_array().unwrap().iter().cloned());
        cursor = page["next_cursor"].as_i64().unwrap();
        if page["has_more"] != true {
            return out;
        }
    }
}

fn created_tasks(events: &[Value]) -> BTreeSet<String> {
    events
        .iter()
        .filter(|e| e["kind"] == "task.created")
        .map(|e| e["entity"]["id"].as_str().unwrap().to_string())
        .collect()
}

fn active_ids(snapshot: &Value) -> BTreeSet<String> {
    snapshot["active_tasks"]["items"].as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap().to_string()).collect()
}

fn project<'a>(snapshot: &'a Value, id: &str) -> &'a Value {
    snapshot["projects"]["items"].as_array().unwrap().iter().find(|p| p["id"] == id).unwrap_or_else(|| panic!("{id} no está en la snapshot"))
}

fn sin_generated_at(mut v: Value) -> Value {
    v.as_object_mut().unwrap().remove("generated_at");
    v
}

#[test]
fn es_una_lectura_clasificada_como_read() {
    assert_eq!(rpc_action_for_tests("compact_snapshot"), ClientAction::Read);
}

#[test]
fn bootstrap_vacio_tiene_forma_estable_y_cursor_del_event_log() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = person(&core);
    let head = core.storage.with_store(|s| s.events_head().unwrap()).unwrap();
    let out = snap(&core, &client, json!({}));

    assert_eq!(out["snapshot_version"], 1);
    assert!(out["generated_at"].as_u64().unwrap() > 0);
    assert_eq!(out["core"]["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(out["core"]["health"], "ok");
    assert_eq!(out["cursor"], json!({ "events": head }));
    assert_eq!(out["projects"], json!({ "total": 0, "truncated": false, "items": [] }));
    assert_eq!(out["active_tasks"], json!({ "total": 0, "truncated": false, "items": [] }));
    assert_eq!(out["attention"]["total"], 0);
    assert_eq!(out["attention"]["truncated"], false);
    assert_eq!(out["attention"]["items"], json!([]));
    let categories = out["attention"]["by_category"].as_object().unwrap();
    assert_eq!(categories.len(), AttentionCategory::ALL.len(), "siempre las siete categorías");
    assert!(categories.values().all(|n| n == 0));
    assert_eq!(out["unassigned"], json!({ "active": 0, "failed": 0, "attention": 0 }));
    assert_eq!(
        out["limits"],
        json!({ "projects": MAX_PROJECTS, "active_tasks": MAX_ACTIVE_TASKS, "attention_items": 5, "text_chars": MAX_TEXT_CHARS })
    );
    let mut keys: Vec<&str> = out.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["active_tasks", "attention", "core", "cursor", "generated_at", "limits", "projects", "snapshot_version", "unassigned"]
    );
    let mut core_keys: Vec<&str> = out["core"].as_object().unwrap().keys().map(String::as_str).collect();
    core_keys.sort_unstable();
    assert_eq!(core_keys, ["health", "machine_id", "version"]);
}

#[test]
fn coincide_con_projects_overview_y_ordena_por_lo_que_pide_atencion() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = person(&core);
    let idle = proyecto(&core, "Aaa reposo");
    let activo = proyecto(&core, "Bbb activo");
    let fallido = proyecto(&core, "Zzz fallido");
    let con_attention = proyecto(&core, "Yyy attention");
    let archivado = proyecto(&core, "Archivado");
    core.storage.with_store(|s| assert!(s.project_set_archived(&archivado, true).unwrap())).unwrap();

    let t_activa = tarea(&core, "en curso", Some(&activo));
    let t_falla = tarea(&core, "falla", Some(&fallido));
    core.mutate(|tx| tx.fail_with(&t_falla, "agent_idle_timeout", "sin actividad").map(|_| ())).unwrap();
    let t_cerrada = tarea(&core, "cerrada", Some(&idle));
    core.mutate(|tx| tx.close(&t_cerrada, Status::Done, "hecho").map(|_| ())).unwrap();
    let t_sin = tarea(&core, "sin proyecto", None);
    let _t_archivada = tarea(&core, "de archivado", Some(&archivado));
    raise(&core, attention(AttentionCategory::Question, "task-q", &con_attention, Severity::Medium, 10));

    let out = snap(&core, &client, json!({}));
    let overview = rpc(&core, &client, "projects_overview", json!({})).unwrap();

    // Mismo conjunto de Projects que el overview por defecto (sin archivados) y mismos contadores.
    assert_eq!(out["projects"]["total"], overview["total"]);
    for p in overview["projects"].as_array().unwrap() {
        let s = project(&out, p["id"].as_str().unwrap());
        assert_eq!(s["status"], p["status"], "{p}");
        assert_eq!(s["active"], p["counts"]["active"]);
        assert_eq!(s["failed"], p["counts"]["failed"]);
        assert_eq!(s["attention"], p["counts"]["attention"]["total"]);
        assert_eq!(s["name"], p["name"]);
    }
    assert!(out["projects"]["items"].as_array().unwrap().iter().all(|p| p["id"] != archivado.as_str()));
    // Orden de recorte: failed > attention > active > idle.
    let orden: Vec<&str> = out["projects"]["items"].as_array().unwrap().iter().map(|p| p["id"].as_str().unwrap()).collect();
    assert_eq!(orden, [fallido.as_str(), con_attention.as_str(), activo.as_str(), idle.as_str()]);

    // Tasks activas: todas las no finales, también las de archivados y las sin proyecto.
    let ids = active_ids(&out);
    assert!(ids.contains(&t_activa) && ids.contains(&t_sin));
    assert!(!ids.contains(&t_falla) && !ids.contains(&t_cerrada), "las finales no salen");
    assert_eq!(out["active_tasks"]["total"], 3);
    let item = out["active_tasks"]["items"].as_array().unwrap().iter().find(|t| t["id"] == t_activa.as_str()).unwrap();
    let mut campos: Vec<&str> = item.as_object().unwrap().keys().map(String::as_str).collect();
    campos.sort_unstable();
    assert_eq!(campos, ["id", "origin", "parent_id", "project_id", "provider", "root_id", "run_id", "status", "title", "updated_at"]);
    assert_eq!(item["project_id"], activo.as_str());
    assert_eq!(item["root_id"], t_activa.as_str());
    assert_eq!(item["origin"], "external");
    assert_eq!(item["status"], "running");

    assert_eq!(out["unassigned"]["active"], overview["unassigned"]["active"]);
    // Attention total: question + la `failed` que levanta la Task fallida.
    assert_eq!(out["attention"]["by_category"]["question"], 1);
    assert_eq!(out["attention"]["by_category"]["failed"], 1);
    assert_eq!(out["attention"]["total"], 2);
}

/// Llena un Core con el triple de Projects y de Tasks activas que caben, y 40 Attention, con el texto que dé
/// `texto(i)`. Devuelve la snapshot con el máximo de Attention destacada.
fn workspace_grande(texto: impl Fn(usize) -> String) -> Value {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = person(&core);
    let projects: Vec<String> = (0..MAX_PROJECTS * 3).map(|i| proyecto(&core, &texto(i))).collect();
    for i in 0..MAX_ACTIVE_TASKS * 3 {
        tarea(&core, &texto(i), Some(&projects[i % projects.len()]));
    }
    for i in 0..(MAX_ATTENTION_ITEMS * 2) {
        let severity = [Severity::Low, Severity::Critical, Severity::Medium, Severity::High][i % 4];
        raise(&core, attention(AttentionCategory::Risk, &format!("task-big-{i}"), &projects[i], severity, i as i64 + 1));
    }
    snap(&core, &client, json!({ "attention_items": MAX_ATTENTION_ITEMS }))
}

#[test]
fn workspace_grande_recorta_marca_y_cabe_en_el_presupuesto() {
    // Típico: títulos de una línea de tamaño habitual.
    let tipico = workspace_grande(|i| format!("Arreglar el flujo de reconexión del cliente móvil #{i}"));
    let tipico_bytes = serde_json::to_vec(&tipico).unwrap().len();
    // Peor caso que permiten los topes: todos los textos largos, de 4 bytes por carácter y con controles.
    let peor = workspace_grande(|i| format!("{i:04}\u{1}{}", "🦀".repeat(400)));
    let peor_bytes = serde_json::to_vec(&peor).unwrap().len();
    eprintln!("compact_snapshot · workspace grande: típico {tipico_bytes} bytes, peor caso {peor_bytes} bytes (presupuesto {MAX_SNAPSHOT_BYTES})");
    assert!(peor_bytes <= MAX_SNAPSHOT_BYTES, "el peor caso ocupa {peor_bytes} bytes, más que el presupuesto {MAX_SNAPSHOT_BYTES}");
    assert!(tipico_bytes < peor_bytes);

    for out in [&tipico, &peor] {
        assert_eq!(out["projects"]["total"], MAX_PROJECTS * 3);
        assert_eq!(out["projects"]["truncated"], true);
        assert_eq!(out["projects"]["items"].as_array().unwrap().len(), MAX_PROJECTS);
        assert_eq!(out["active_tasks"]["total"], MAX_ACTIVE_TASKS * 3);
        assert_eq!(out["active_tasks"]["truncated"], true);
        assert_eq!(out["active_tasks"]["items"].as_array().unwrap().len(), MAX_ACTIVE_TASKS);
        assert_eq!(out["attention"]["total"], MAX_ATTENTION_ITEMS * 2);
        assert_eq!(out["attention"]["truncated"], true);
        let items = out["attention"]["items"].as_array().unwrap();
        assert_eq!(items.len(), MAX_ATTENTION_ITEMS);
        // Los más urgentes primero: las 10 críticas y luego las 10 altas, y dentro, las más recientes.
        let severidades: Vec<&str> = items.iter().map(|i| i["severity"].as_str().unwrap()).collect();
        assert!(severidades[..MAX_ATTENTION_ITEMS / 2].iter().all(|s| *s == "critical"), "{severidades:?}");
        assert!(severidades[MAX_ATTENTION_ITEMS / 2..].iter().all(|s| *s == "high"), "{severidades:?}");
        let creados: Vec<i64> = items[..MAX_ATTENTION_ITEMS / 2].iter().map(|i| i["created_at"].as_i64().unwrap()).collect();
        assert!(creados.windows(2).all(|w| w[0] >= w[1]), "más recientes primero: {creados:?}");
        // Las Tasks activas van de la más recientemente actualizada a la menos.
        let updated: Vec<u64> = out["active_tasks"]["items"].as_array().unwrap().iter().map(|t| t["updated_at"].as_u64().unwrap()).collect();
        assert!(updated.windows(2).all(|w| w[0] >= w[1]));
    }

    // En el peor caso los textos se recortan de forma visible y sin caracteres de control.
    for t in peor["active_tasks"]["items"].as_array().unwrap() {
        let title = t["title"].as_str().unwrap();
        assert_eq!(title.chars().count(), MAX_TEXT_CHARS);
        assert!(title.ends_with('…'));
        assert!(!title.chars().any(char::is_control), "{title:?}");
    }
    for p in peor["projects"]["items"].as_array().unwrap() {
        assert_eq!(p["name"].as_str().unwrap().chars().count(), MAX_TEXT_CHARS);
    }
}

#[test]
fn recorte_de_textos_y_attention_items_cero() {
    assert_eq!(clip("corto"), "corto");
    let exacto = "a".repeat(MAX_TEXT_CHARS);
    assert_eq!(clip(&exacto), exacto, "en el límite no se recorta");
    let recortado = clip(&"é".repeat(MAX_TEXT_CHARS + 1));
    assert_eq!(recortado.chars().count(), MAX_TEXT_CHARS);
    assert!(recortado.ends_with('…'));
    assert_eq!(clip("a\u{1}b\nc"), "a b c", "los controles pasan a espacio");

    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = person(&core);
    let p = proyecto(&core, "uno");
    raise(&core, attention(AttentionCategory::Approval, "task-a", &p, Severity::High, 1));
    let out = snap(&core, &client, json!({ "attention_items": 0 }));
    assert_eq!(out["attention"]["items"], json!([]));
    assert_eq!(out["attention"]["total"], 1);
    assert_eq!(out["attention"]["truncated"], true, "hay Attention que no se lista: no aparenta completitud");
    assert_eq!(out["limits"]["attention_items"], 0);
    let out = snap(&core, &client, json!({ "attention_items": null }));
    assert_eq!(out["attention"]["truncated"], false, "null cuenta como el valor por defecto (5) y cabe");
}

#[test]
fn el_cursor_continua_el_event_log_sin_huecos_ni_repetidos() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = person(&core);
    let p = proyecto(&core, "cursor");
    let antes = tarea(&core, "antes", Some(&p));
    let out = snap(&core, &client, json!({}));
    let cursor = out["cursor"]["events"].as_i64().unwrap();
    assert!(active_ids(&out).contains(&antes));

    let despues = tarea(&core, "después", Some(&p));
    core.mutate(|tx| tx.fail_with(&antes, "agent_idle_timeout", "sin actividad").map(|_| ())).unwrap();

    let todos = events_after(&core, &client, 0);
    let siguientes = events_after(&core, &client, cursor);
    assert!(!siguientes.is_empty());
    assert!(siguientes.iter().all(|e| e["seq"].as_i64().unwrap() > cursor), "nada repetido de antes del cursor");
    let esperados: Vec<&Value> = todos.iter().filter(|e| e["seq"].as_i64().unwrap() > cursor).collect();
    assert_eq!(siguientes.iter().collect::<Vec<_>>(), esperados, "ningún hueco tras el cursor");
    assert!(todos.iter().filter(|e| e["seq"].as_i64().unwrap() <= cursor).count() > 0);
    // Lo que la snapshot ya refleja está antes del cursor; lo nuevo llega después.
    assert!(created_tasks(&todos.iter().filter(|e| e["seq"].as_i64().unwrap() <= cursor).cloned().collect::<Vec<_>>()).contains(&antes));
    assert_eq!(created_tasks(&siguientes), BTreeSet::from([despues.clone()]));
    assert!(siguientes.iter().any(|e| e["kind"] == "task.status_changed" && e["entity"]["id"] == antes.as_str()));
}

#[test]
fn snapshot_y_cursor_son_del_mismo_punto_con_escrituras_concurrentes() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = person(&core);
    let p = proyecto(&core, "concurrente");
    let stop = Arc::new(AtomicBool::new(false));
    let writer = {
        let core = core.clone();
        let stop = stop.clone();
        let p = p.clone();
        std::thread::spawn(move || {
            let mut n = 0;
            while !stop.load(Ordering::Relaxed) && n < MAX_ACTIVE_TASKS - 5 {
                tarea(&core, &format!("w{n}"), Some(&p));
                n += 1;
            }
        })
    };
    let mut comprobadas = 0;
    while !writer.is_finished() || comprobadas < 3 {
        let out = snap(&core, &client, json!({}));
        let cursor = out["cursor"]["events"].as_i64().unwrap();
        let todos = events_after(&core, &client, 0);
        let hasta: Vec<Value> = todos.iter().filter(|e| e["seq"].as_i64().unwrap() <= cursor).cloned().collect();
        let tras: Vec<Value> = todos.iter().filter(|e| e["seq"].as_i64().unwrap() > cursor).cloned().collect();
        // Exactamente las Tasks creadas hasta el cursor, ni una más ni una menos.
        assert_eq!(active_ids(&out), created_tasks(&hasta), "snapshot y cursor de puntos distintos");
        assert!(created_tasks(&tras).is_disjoint(&active_ids(&out)));
        assert_eq!(out["active_tasks"]["total"].as_u64().unwrap() as usize, created_tasks(&hasta).len());
        comprobadas += 1;
        if comprobadas > 500 {
            stop.store(true, Ordering::Relaxed);
        }
    }
    writer.join().unwrap();
}

#[test]
fn reinicio_y_reconexion_continuan_desde_el_cursor_anterior() {
    let (_cleanup, data, core_dir, core) = core_listo();
    let client = person(&core);
    let p = proyecto(&core, "reinicio");
    let t1 = tarea(&core, "uno", Some(&p));
    raise(&core, attention(AttentionCategory::ReviewReady, &t1, &p, Severity::Medium, 5));
    let antes = snap(&core, &client, json!({}));
    drop(client);
    drop(core);
    espera_lock_libre(&core_dir);

    let (core, _host, ready) = arranca(&data, &core_dir);
    ready.unwrap();
    core.settings.lock().unwrap().enabled = true;
    let client = core.authenticate_client(PERSON_SECRET).unwrap().expect("la credencial sobrevive al reinicio");
    let despues = snap(&core, &client, json!({}));
    assert_eq!(sin_generated_at(despues), sin_generated_at(antes.clone()), "mismo estado, misma snapshot tras reiniciar");

    // El cliente reconecta con el cursor que tenía y recibe lo que pasó después, sin huecos.
    let t2 = tarea(&core, "dos", Some(&p));
    let siguientes = events_after(&core, &client, antes["cursor"]["events"].as_i64().unwrap());
    assert_eq!(created_tasks(&siguientes), BTreeSet::from([t2.clone()]));
    let nueva = snap(&core, &client, json!({}));
    assert_eq!(active_ids(&nueva), BTreeSet::from([t1, t2]));
    assert!(nueva["cursor"]["events"].as_i64() > antes["cursor"]["events"].as_i64());
}

#[test]
fn no_filtra_secretos_ni_campos_internos() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = person(&core);
    let p = proyecto(&core, "secretos");
    let t = core
        .mutate(|tx| {
            let (_run, root) = tx.create_run(
                "objetivo SENTINEL-OBJECTIVE",
                NewTask {
                    agent: "claude".into(), model: Some("SENTINEL-MODEL".into()), effort: None, role: None,
                    title: "visible".into(), spec: "SENTINEL-SPEC".into(), repo: "SENTINEL-REPO".into(),
                    cwd: "SENTINEL-CWD".into(), branch: Some("SENTINEL-BRANCH".into()), base: None,
                    worktree: Some("SENTINEL-WORKTREE".into()), external: false,
                },
            );
            tx.mark_running(&root)?;
            if let Some(task) = tx.tasks.get_mut(&root) {
                task.project_id = Some(p.clone());
            }
            Ok(root)
        })
        .unwrap();
    // `attention()` mete `subject` y `facts` privados (`private subject …`, `secret-…`).
    raise(&core, attention(AttentionCategory::Question, &t, &p, Severity::High, 1));
    let text = serde_json::to_string(&snap(&core, &client, json!({ "attention_items": MAX_ATTENTION_ITEMS }))).unwrap();
    for sentinel in [
        "SENTINEL-OBJECTIVE", "SENTINEL-MODEL", "SENTINEL-SPEC", "SENTINEL-REPO", "SENTINEL-CWD", "SENTINEL-BRANCH",
        "SENTINEL-WORKTREE", "private subject", "secret-", "correlation-", "source-", "/r/secretos", PERSON_SECRET,
    ] {
        assert!(!text.contains(sentinel), "la snapshot filtra {sentinel}: {text}");
    }
    assert!(text.contains("\"origin\":\"lixbon\""));
}

#[test]
fn solo_person_autenticada_y_parametros_validados() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = person(&core);
    let agent = agente(&core, "task-snapshot", "install-agent-snapshot", "agent-snapshot-secret-0123456789abcdef");
    assert_eq!(code(rpc(&core, &agent, "compact_snapshot", json!({})).unwrap_err()), "compact_snapshot_auth_required");
    assert_eq!(
        code(core.rpc_via(Channel::Lxo, super::Caller::User, "", "compact_snapshot", &json!({})).unwrap_err()),
        "compact_snapshot_auth_required",
        "sin cliente autenticado (token legacy) no hay snapshot"
    );
    for bad in [
        json!({ "otro": 1 }),
        json!({ "attention_items": MAX_ATTENTION_ITEMS + 1 }),
        json!({ "attention_items": -1 }),
        json!({ "attention_items": "5" }),
        json!({ "attention_items": 1.5 }),
        json!([1]),
    ] {
        let err = rpc(&core, &client, "compact_snapshot", bad.clone()).unwrap_err();
        assert_eq!(code(err), "compact_snapshot_invalid_request", "{bad}");
    }
    assert_eq!(snap(&core, &client, Value::Null)["limits"]["attention_items"], 5);
}

#[test]
fn es_solo_lectura_y_refleja_el_core_degradado() {
    let (_cleanup, _data, _core_dir, core) = core_listo();
    let client = person(&core);
    tarea(&core, "una", None);
    let head = core.storage.with_store(|s| s.events_head().unwrap()).unwrap();
    let machine = core.storage.with_store(|s| s.meta("machine_id").unwrap()).unwrap();
    let rev = core.storage.confirmed_rev().unwrap();
    let a = snap(&core, &client, json!({}));
    let b = snap(&core, &client, json!({}));
    assert_eq!(sin_generated_at(a.clone()), sin_generated_at(b));
    assert_eq!(core.storage.with_store(|s| s.events_head().unwrap()).unwrap(), head, "no escribe eventos");
    assert_eq!(core.storage.with_store(|s| s.meta("machine_id").unwrap()).unwrap(), machine, "no crea machine_id");
    assert_eq!(core.storage.confirmed_rev().unwrap(), rev, "no persiste estado");
    assert_eq!(a["core"]["machine_id"], json!(machine));

    core.degrade_for_tests("prueba");
    let out = snap(&core, &client, json!({}));
    assert_eq!(out["core"]["health"], "read_only");
    assert!(!serde_json::to_string(&out).unwrap().contains("prueba"), "el motivo interno no viaja");
}
