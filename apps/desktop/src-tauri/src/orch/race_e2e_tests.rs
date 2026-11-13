//! LXO-215 · Race de extremo a extremo por la superficie de Desktop: la persona lanza N Forks comparables a la vez y el Core los deja como
//! Attempts reales, cada uno con su identidad, su Task y su procedencia común. Cada prueba entra por `rpc_via(Ui, User)` y comprueba el
//! desenlace DURABLE (Events, Attempts, el origen intacto). Contrato: `docs/core/RACE.md`.

use serde_json::{json, Value};

use super::attempt_e2e_tests::{kinds, world, World};
use super::dispatch_tests::row;
use super::fork_e2e_tests::{forked_payload, package_in, task_count, world_duo};
use super::Core;

fn task_of(attempt: &str) -> String {
    attempt.rsplit_once("-a").unwrap().0.to_string()
}

impl World {
    fn race(&self, request_id: &str, source: &str, candidates: Value) -> Result<Value, String> {
        self.desktop("task_race", json!({"request_id": request_id, "source_attempt_id": source, "candidates": candidates}))
    }

    fn race_with(&self, request_id: &str, source: &str, candidates: Value, extra: Value) -> Result<Value, String> {
        let mut args = json!({"request_id": request_id, "source_attempt_id": source, "candidates": candidates});
        for (k, v) in extra.as_object().cloned().unwrap_or_default() {
            args[k] = v;
        }
        self.desktop("task_race", args)
    }

    fn race_status(&self, race_id: &str) -> Value {
        self.desktop("task_race_status", json!({"race_id": race_id})).expect("task_race_status")
    }
}

fn race_events(core: &Core) -> Vec<(String, Value)> {
    core.storage
        .with_store(|s| {
            s.read(|c| {
                let mut stmt = c.prepare("SELECT kind, payload FROM events WHERE entity_kind = 'race' ORDER BY seq")?;
                let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                Ok(rows.collect::<Result<Vec<_>, _>>()?.into_iter().map(|(k, p)| (k, serde_json::from_str(&p).unwrap())).collect())
            })
        })
        .unwrap()
        .unwrap()
}

fn count_of(events: &[(String, Value)], kind: &str) -> usize {
    events.iter().filter(|(k, _)| k == kind).count()
}

fn attempts(status: &Value) -> Vec<String> {
    status["candidates"].as_array().unwrap().iter().filter_map(|c| c["attempt_id"].as_str().map(str::to_string)).collect()
}

fn duo() -> (World, String) {
    let (w, _codex) = world_duo();
    let a1 = w.finished("race-origen");
    (w, a1)
}

#[test]
fn un_race_de_dos_candidatos_mixtos_deja_dos_forks_reales_con_su_procedencia_comun_y_no_toca_el_origen() {
    let (w, a1) = duo();
    let antes = (row(&w.core, &a1), kinds(&w.core, &a1));
    let tareas = task_count(&w.core);

    let out = w.race("race-1", &a1, json!([{"provider": "claude", "model": "opus"}, {"provider": "codex"}])).expect("el race");
    assert_eq!(out["status"], "Requested");
    let race_id = out["race_id"].as_str().unwrap().to_string();
    assert!(race_id.starts_with("rc-") && race_id.len() == 23);
    assert_eq!(out["requested"], 2);
    assert_eq!(out["summary"], json!({"launched": 2, "failed": 0, "not_attempted": 0, "active": 2, "finished": 0}));
    assert_eq!(task_count(&w.core), tareas + 2);

    // Cada candidato es un Attempt real, con su Task y su estado propio (pendiente de la aprobación de la persona).
    let ids = attempts(&out);
    assert_eq!(ids.len(), 2);
    assert_ne!(task_of(&ids[0]), task_of(&ids[1]));
    for id in &ids {
        assert_eq!(row(&w.core, id).0, "pending_approval");
        assert_ne!(task_of(id), task_of(&a1));
    }
    assert_eq!(out["candidates"][0]["provider"], "claude");
    assert_eq!(out["candidates"][1]["provider"], "codex");

    // Procedencia común: `attempt.forked` lleva el race_id y el índice; el origen no recibió ni un hecho.
    for (i, id) in ids.iter().enumerate() {
        let p = forked_payload(&w.core, id);
        assert_eq!((p["race_id"].as_str(), p["race_index"].as_i64()), (Some(race_id.as_str()), Some(i as i64)));
        assert_eq!(p["source"], a1);
    }
    assert_eq!((row(&w.core, &a1), kinds(&w.core, &a1)), antes);

    // Los hechos del Race: lo pedido y qué pasó con cada candidato, sin encargo ni contenido.
    let ev = race_events(&w.core);
    assert_eq!((count_of(&ev, "race.requested"), count_of(&ev, "race.candidate_recorded")), (1, 2));
    assert_eq!(ev[0].1["candidates"], 2);
    assert_eq!(ev[0].1["strategy"], "clean");
    assert!(ev[0].1.get("package_id").is_none());
    assert!(!ev[0].1.to_string().contains("haz algo"), "el encargo no viaja en el Event");
}

#[test]
fn tres_candidatos_con_modelo_y_esfuerzo_propios_cada_uno_con_su_clave() {
    let (w, a1) = duo();
    let out = w
        .race("race-3", &a1, json!([{"provider": "claude", "model": "opus", "effort": "high"}, {"provider": "codex", "model": "gpt-6.1-sol"}, {"title": "El tercero"}]))
        .unwrap();
    assert_eq!(out["summary"]["launched"], 3);
    let ids = attempts(&out);
    let models: Vec<Value> = out["candidates"].as_array().unwrap().iter().map(|c| c["model"].clone()).collect();
    assert_eq!(models[0], "opus");
    assert_eq!(models[1], "gpt-6.1-sol");
    assert_eq!(ids.iter().collect::<std::collections::BTreeSet<_>>().len(), 3, "tres Attempts distintos");
    // El tercero hereda del origen (proveedor claude) y lleva el título pedido.
    assert_eq!(out["candidates"][2]["provider"], "claude");
    assert_eq!(w.core.lock().tasks.get(&task_of(&ids[2])).unwrap().title, "El tercero");
}

#[test]
fn el_mismo_paquete_de_contexto_vale_para_todos_y_uno_de_otro_attempt_rechaza_el_race_sin_escribir_nada() {
    let (w, a1) = duo();
    let otro = w.finished("race-otro");
    let tareas = task_count(&w.core);
    let bueno = package_in(&w.project, &task_of(&a1), &a1);
    let out = w.race_with("race-pkg", &a1, json!([{}, {"provider": "codex"}]), json!({"package": bueno})).unwrap();
    assert_eq!(out["strategy"], "context_package");
    let package_id = out["package_id"].as_str().unwrap().to_string();
    for id in attempts(&out) {
        assert_eq!(forked_payload(&w.core, &id)["package_id"], package_id.as_str());
        assert_eq!(forked_payload(&w.core, &id)["strategy"], "context_package");
    }
    let creadas = task_count(&w.core);
    assert_eq!(creadas, tareas + 2);

    let ajeno = package_in(&w.project, &task_of(&otro), &otro);
    let e = w.race_with("race-pkg-2", &a1, json!([{}, {}]), json!({"package": ajeno})).unwrap_err();
    assert!(e.contains("context_package_source_mismatch"), "{e}");
    assert_eq!(task_count(&w.core), creadas, "un paquete que no es del origen no crea ni un candidato");
    assert_eq!(count_of(&race_events(&w.core), "race.requested"), 1, "ni deja un Race a medias");
}

#[test]
fn una_peticion_invalida_rechaza_todo_antes_de_escribir_y_no_es_un_fallo_parcial() {
    let (w, a1) = duo();
    let tareas = task_count(&w.core);
    let casos = [
        ("uno solo", json!([{}])),
        ("cinco", json!([{}, {}, {}, {}, {}])),
        ("provider inválido", json!([{}, {"provider": "Claude"}])),
        ("título vacío", json!([{}, {"title": "  "}])),
        ("host", json!([{}, {"host": "otra-maquina"}])),
        ("worktree compartido", json!([{}, {"worktree": "compartido"}])),
        ("perfil", json!([{}, {"profile": "autonomia_amplia"}])),
    ];
    for (nombre, candidatos) in casos {
        assert!(w.race(&format!("race-inv-{}", nombre.len()), &a1, candidatos).is_err(), "{nombre}");
    }
    assert!(w.race("clave con espacios", &a1, json!([{}, {}])).is_err());
    assert!(w.race("race-x", "no-existe-a1", json!([{}, {}])).is_err());
    assert!(w.desktop("task_race", json!({"request_id": "r", "source_attempt_id": a1, "candidates": [{}, {}], "approved": true})).is_err(), "no se aceptan campos que no existen");
    assert_eq!(task_count(&w.core), tareas);
    assert!(race_events(&w.core).is_empty());
}

#[test]
fn un_candidato_que_no_se_puede_lanzar_queda_registrado_sin_deshacer_a_los_lanzados() {
    let (w, a1) = duo();
    let tareas = task_count(&w.core);
    let out = w.race("race-parcial", &a1, json!([{"provider": "claude"}, {"provider": "no-existe"}, {"provider": "codex"}])).expect("un Race con un candidato fallido sigue siendo un Race");
    assert_eq!(out["summary"], json!({"launched": 2, "failed": 1, "not_attempted": 0, "active": 2, "finished": 0}));
    let c = out["candidates"].as_array().unwrap();
    assert_eq!((c[0]["outcome"].as_str(), c[1]["outcome"].as_str(), c[2]["outcome"].as_str()), (Some("launched"), Some("failed"), Some("launched")));
    assert!(c[1]["attempt_id"].is_null() && c[1]["status"].is_null());
    assert!(c[1]["code"].as_str().is_some_and(|code| !code.is_empty()), "el fallo tiene un código estable: {}", c[1]);
    assert_eq!(c[1]["provider"], "no-existe");
    assert_eq!(task_count(&w.core), tareas + 2, "solo se crearon los lanzados");
    // Es auditable: el fallo está en el log, con su código y sin texto libre.
    let ev = race_events(&w.core);
    let fallido = ev.iter().find(|(k, p)| k == "race.candidate_recorded" && p["outcome"] == "failed").expect("hecho del fallo");
    assert_eq!(fallido.1["index"], 1);
    assert_eq!(fallido.1["code"], c[1]["code"]);
    assert!(fallido.1.get("attempt_id").is_none());
    // Los lanzados siguen con su identidad: se pueden comparar.
    assert_eq!(out["compare"]["attempt_ids"].as_array().unwrap().len(), 2);
}

#[test]
fn con_muchas_tasks_activas_el_limite_corta_los_candidatos_que_no_caben_y_reintentar_lanza_solo_los_que_faltan() {
    let (w, a1) = duo();
    // Siete Tasks sin terminar: el candidato 0 cabe (8), los demás no.
    let relleno: Vec<String> = (0..7).map(|i| w.create("claude", &format!("relleno-{i}"))).collect();
    let tareas = task_count(&w.core);
    let out = w.race("race-limite", &a1, json!([{}, {"provider": "codex"}, {"provider": "codex", "model": "m"}])).unwrap();
    let c = out["candidates"].as_array().unwrap();
    assert_eq!((c[0]["outcome"].as_str(), c[1]["outcome"].as_str(), c[2]["outcome"].as_str()), (Some("launched"), Some("failed"), Some("failed")));
    assert_eq!((c[1]["code"].as_str(), c[2]["code"].as_str()), (Some("race_concurrency_limit"), Some("race_concurrency_limit")));
    assert_eq!(task_count(&w.core), tareas + 1);
    assert_eq!(out["limits"]["max_active_tasks"], 8);

    // Se libera sitio (la persona rechaza el relleno) y se reintenta la MISMA petición: el creado no se duplica, los fallidos se lanzan.
    for id in &relleno {
        w.desktop("attempt_reject", json!({"attempt_id": id})).unwrap();
    }
    let primero = c[0]["attempt_id"].as_str().unwrap().to_string();
    let retry = w.race("race-limite", &a1, json!([{}, {"provider": "codex"}, {"provider": "codex", "model": "m"}])).unwrap();
    assert_eq!(retry["status"], "Retried");
    assert_eq!(retry["replayed"], 1, "el candidato ya creado se devuelve, no se duplica");
    assert_eq!(retry["summary"]["launched"], 3);
    assert_eq!(retry["candidates"][0]["attempt_id"], primero.as_str());
    assert_eq!(task_count(&w.core), tareas + 3);
    // Otro reintento ya no hace nada nuevo.
    let again = w.race("race-limite", &a1, json!([{}, {"provider": "codex"}, {"provider": "codex", "model": "m"}])).unwrap();
    assert_eq!(again["replayed"], 3);
    assert_eq!(task_count(&w.core), tareas + 3);
}

#[test]
fn la_misma_clave_con_otra_peticion_es_un_conflicto_y_no_lanza_nada() {
    let (w, a1) = duo();
    let out = w.race("race-c", &a1, json!([{}, {"provider": "codex"}])).unwrap();
    let tareas = task_count(&w.core);
    let e = w.race("race-c", &a1, json!([{}, {"provider": "claude", "model": "opus"}])).unwrap_err();
    assert!(e.contains("request_conflict"), "{e}");
    assert_eq!(task_count(&w.core), tareas);
    assert_eq!(w.race_status(out["race_id"].as_str().unwrap())["summary"]["launched"], 2);
}

#[test]
fn la_policy_niega_o_pide_confirmacion_antes_de_lanzar_y_no_deja_rastro() {
    let (w, a1) = duo();
    let tareas = task_count(&w.core);
    let rev = |w: &World| w.desktop("policy_effective", json!({})).unwrap()["revision"].as_i64().unwrap();
    w.desktop("policy_set", json!({"scope": {"kind": "global"}, "category": "fork", "level": "deny", "expected_revision": rev(&w)})).unwrap();
    let e = w.race("race-pol", &a1, json!([{}, {}])).unwrap_err();
    assert!(e.starts_with("policy_denied"), "{e}");
    assert_eq!(task_count(&w.core), tareas);
    assert!(race_events(&w.core).is_empty());

    w.desktop("policy_set", json!({"scope": {"kind": "global"}, "category": "fork", "level": "confirm", "expected_revision": rev(&w), "confirm": true})).unwrap();
    assert!(w.race("race-pol", &a1, json!([{}, {}])).unwrap_err().starts_with("policy_confirm_required"));
    let ok = w.race_with("race-pol", &a1, json!([{}, {}]), json!({"confirm": true})).unwrap();
    assert_eq!(ok["summary"]["launched"], 2);
}

#[test]
fn cancelar_es_explicito_uno_o_los_que_quedan_y_nada_se_cancela_porque_otro_termine() {
    let (w, a1) = duo();
    let out = w.race("race-can", &a1, json!([{}, {"provider": "codex"}, {"provider": "codex", "model": "m"}])).unwrap();
    let race_id = out["race_id"].as_str().unwrap().to_string();
    let ids = attempts(&out);

    // El primero se aprueba y termina: los otros siguen pendientes, nadie los cancela por él.
    w.approve(&ids[0]);
    w.settled(&ids[0], "done");
    assert_eq!(row(&w.core, &ids[1]).0, "pending_approval");
    assert_eq!(row(&w.core, &ids[2]).0, "pending_approval");
    let st = w.race_status(&race_id);
    assert_eq!(st["summary"]["finished"], 1);
    assert_eq!(st["summary"]["active"], 2);
    assert_eq!(st["cancellable"], json!([ids[1], ids[2]]));

    // Cancelar UNO.
    let one = w.desktop("task_race_cancel", json!({"race_id": race_id, "attempt_id": ids[1]})).unwrap();
    assert_eq!(one["results"], json!([{"attempt_id": ids[1], "outcome": "rejected"}]));
    assert!(["stopped", "exited", "failed"].contains(&row(&w.core, &ids[1]).0.as_str()), "terminó: {}", row(&w.core, &ids[1]).0);
    assert_eq!(row(&w.core, &ids[2]).0, "pending_approval", "el otro sigue");
    // Cancelar lo que queda.
    let rest = w.desktop("task_race_cancel", json!({"race_id": race_id})).unwrap();
    let outcomes: Vec<(&str, &str)> = rest["results"].as_array().unwrap().iter().map(|r| (r["attempt_id"].as_str().unwrap(), r["outcome"].as_str().unwrap())).collect();
    assert_eq!(outcomes, vec![(ids[0].as_str(), "already_final"), (ids[1].as_str(), "already_final"), (ids[2].as_str(), "rejected")]);
    assert_eq!(rest["race"]["summary"]["active"], 0);
    // Es auditable y repetirlo no rompe nada.
    assert_eq!(count_of(&race_events(&w.core), "race.cancelled"), 2);
    let tercera = w.desktop("task_race_cancel", json!({"race_id": race_id})).unwrap();
    assert!(tercera["results"].as_array().unwrap().iter().all(|r| r["outcome"] == "already_final"));
    // Un Attempt que no es candidato de este Race no se toca.
    assert!(w.desktop("task_race_cancel", json!({"race_id": race_id, "attempt_id": a1})).unwrap_err().contains("race_candidate_not_found"));
    assert!(w.desktop("task_race_cancel", json!({"race_id": "rc-00000000000000000000"})).is_err());
}

#[test]
fn el_estado_del_race_no_elige_ganador_y_los_candidatos_se_pueden_comparar() {
    let (w, a1) = duo();
    let out = w.race("race-cmp", &a1, json!([{}, {"provider": "codex"}])).unwrap();
    let race_id = out["race_id"].as_str().unwrap().to_string();
    let ids = attempts(&out);
    for id in &ids {
        w.approve(id);
        w.settled(id, "done");
    }
    let st = w.race_status(&race_id);
    assert_eq!(st["summary"]["finished"], 2);
    // «Ganador» es una decisión posterior de la persona: el Core no marca ni puntúa a nadie.
    let mut keys: Vec<&str> = st.as_object().unwrap().keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["cancellable", "candidates", "compare", "created_at", "limits", "package_id", "race_id", "requested", "source_attempt_id", "strategy", "summary", "v"]);
    for c in st["candidates"].as_array().unwrap() {
        let mut ck: Vec<&str> = c.as_object().unwrap().keys().map(String::as_str).collect();
        ck.sort_unstable();
        assert_eq!(ck, ["attempt_id", "code", "index", "model", "outcome", "provider", "status", "task_id"]);
    }
    // Compare consume exactamente los Attempts del Race.
    let compare_ids = st["compare"]["attempt_ids"].clone();
    assert_eq!(compare_ids, json!(ids));
    let cmp = w.desktop("attempt_compare", json!({"attempt_ids": compare_ids})).expect("compare del race");
    assert_eq!(cmp["attempts"].as_array().unwrap().len(), 2);
    assert_eq!((cmp["relation"]["kind"].as_str(), cmp["relation"]["root"].as_str()), (Some("fork_family"), Some(a1.as_str())));
}

#[test]
fn se_listan_los_races_de_un_attempt_y_un_race_inexistente_no_inventa_nada() {
    let (w, a1) = duo();
    assert_eq!(w.desktop("task_race_status", json!({"source_attempt_id": a1})).unwrap()["races"], json!([]));
    let a = w.race("race-l1", &a1, json!([{}, {}])).unwrap();
    let b = w.race("race-l2", &a1, json!([{}, {"provider": "codex"}, {}])).unwrap();
    let listed = w.desktop("task_race_status", json!({"source_attempt_id": a1})).unwrap();
    let ids: Vec<&str> = listed["races"].as_array().unwrap().iter().map(|r| r["race_id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![b["race_id"].as_str().unwrap(), a["race_id"].as_str().unwrap()], "los más recientes primero");
    assert_eq!(listed["races"][0]["requested"], 3);
    assert!(w.desktop("task_race_status", json!({"race_id": "rc-00000000000000000000"})).unwrap_err().contains("race_not_found"));
    assert!(w.desktop("task_race_status", json!({})).is_err());
    assert!(w.desktop("task_race_status", json!({"race_id": "x"})).is_err());
}

#[test]
fn con_el_core_en_solo_lectura_no_se_lanza_nada() {
    let (w, a1) = duo();
    let tareas = task_count(&w.core);
    w.core.degrade_for_tests("disco lleno");
    assert!(w.race("race-ro", &a1, json!([{}, {}])).is_err());
    assert_eq!(task_count(&w.core), tareas);
}

#[test]
fn un_race_de_un_solo_proveedor_lanza_los_dos_candidatos_del_mismo() {
    let w = world("claude", None);
    let a1 = w.finished("race-sl");
    let tareas = task_count(&w.core);
    // El mundo normal tiene un solo proveedor: dos candidatos del mismo proveedor (otro modelo) se lanzan igual.
    let out = w.race("race-un-proveedor", &a1, json!([{}, {"model": "opus"}])).unwrap();
    assert_eq!(out["summary"]["launched"], 2);
    assert_eq!(task_count(&w.core), tareas + 2);
}

/// LXO-248 · Un Race no ofrece worktree compartido: sus candidatos corren a la vez y compartir es en serie. Cada candidato nace SIN worktree (lo recibe
/// al aprobar, el suyo); si la persona comparte a mano el del origen con uno, ese lo ocupa y el segundo se rechaza hasta que el primero termine.
#[test]
fn en_un_race_solo_un_candidato_puede_compartir_el_worktree_del_origen_el_otro_se_rechaza() {
    let w = world("claude", None);
    let a1 = w.finished("race-compartido");
    let out = w.race("race-share", &a1, json!([{}, {"model": "opus"}])).unwrap();
    let ids = attempts(&out);
    assert_eq!(ids.len(), 2);
    for id in &ids {
        let d = w.desktop("attempt_detail", json!({"attempt_id": id})).unwrap();
        assert_eq!(d["attempt"]["worktree"], Value::Null, "un candidato de un Race nace sin worktree: lo recibe al aprobar");
    }

    let share = |attempt: &str| w.desktop("attempt_share_worktree", json!({"attempt_id": attempt, "from_attempt_id": a1, "confirm": true}));
    assert_eq!(share(&ids[0]).expect("el primero comparte el worktree del origen")["status"], "Shared");
    let segundo = share(&ids[1]).unwrap_err();
    assert!(segundo.contains("share_conflict"), "el segundo, en serie, se rechaza: {segundo}");
    let d = w.desktop("attempt_detail", json!({"attempt_id": ids[1]})).unwrap();
    assert_eq!(d["attempt"]["worktree"], Value::Null, "y no quedó enlazado a nada");
}

#[test]
fn los_hechos_del_race_salen_en_activity_con_sus_argumentos_y_sin_el_encargo() {
    let (w, a1) = duo();
    let out = w.race("race-act", &a1, json!([{"provider": "codex"}, {"provider": "no-existe"}])).unwrap();
    let race_id = out["race_id"].as_str().unwrap();
    w.desktop("task_race_cancel", json!({"race_id": race_id})).unwrap();
    let page = w.desktop("activity_list", json!({})).unwrap();
    let items: Vec<&Value> = page["items"].as_array().unwrap().iter().filter(|i| i["message_key"].as_str().is_some_and(|k| k.starts_with("activity.race."))).collect();
    let keys: Vec<&str> = items.iter().map(|i| i["message_key"].as_str().unwrap()).collect();
    assert_eq!(keys.iter().filter(|k| **k == "activity.race.requested").count(), 1);
    assert_eq!(keys.iter().filter(|k| **k == "activity.race.candidate_recorded").count(), 2);
    assert_eq!(keys.iter().filter(|k| **k == "activity.race.cancelled").count(), 1);
    assert!(items.iter().all(|i| i["fallback"] == false), "ningún hecho del Race cae en «desconocido»");
    assert!(!page.to_string().contains("haz algo"), "el encargo no viaja en Activity");
}
