//! LXO-88 · la proyección Events → Attention corre en los writers AUTORITATIVOS del Event Log, no solo cuando un
//! test llama al motor.
//!
//! Writers (los únicos que insertan Events; ver `store::events::insert_events_projected`):
//!
//! | Writer | Quién lo usa | Qué Events |
//! |---|---|---|
//! | `Store::commit_authoritative_with_events` | `Core::mutate*` (`SqlitePersistence::persist`) | `task.*`, `run.*`, `decision.recorded`, `effect.observed`, `spawn.resolved` con fila legacy |
//! | `Store::append_events` | `Core::record_facts` (`SqlitePersistence::append`) | `spawn.requested`, `spawn.resolved` standalone |
//! | `Store::project_*_recorded` | `project_ops` (gestión de Project) | `project.*` |
//!
//! Aquí se ejercitan con un Core real y SQLite: la Attention aparece en el almacén del propio Core sin que el test
//! invoque `project_in`, y todo se confirma o se deshace en la misma transacción que el Event origen.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::attention_rules::EventRules;
use super::attention_rules_tests::{abre, aplica, categorias_activas, ciclo_de_vida, instantanea};
use super::events::{Channel, MutationContext};
use super::projects_tests::{base_de, clon, core_listo, id_de, registra, repo, rpc, s as ruta};
use super::spawn_cleanup_tests::{desde, fake, head, kinds, setup_con, Env};
use super::Caller;
use crate::store::{AttentionProjection, EventProjector, EventRow, NewEvent, Store, StoreError, StoreResult};

fn real() -> AttentionProjection {
    AttentionProjection::new(Arc::new(EventRules))
}

fn en_el_core<R>(e: &Env, f: impl FnOnce(&mut Store) -> R) -> R {
    e.core.storage.with_store(f).expect("almacén abierto")
}

/// Registra qué Events ve el proyector y delega en el real.
#[derive(Debug, Default)]
struct Graba(Mutex<Vec<String>>);

#[derive(Debug)]
struct GrabaYDelega(Arc<Graba>);

impl EventProjector for GrabaYDelega {
    fn project(&self, tx: &rusqlite::Transaction<'_>, events: &[EventRow]) -> StoreResult<Vec<NewEvent>> {
        self.0 .0.lock().unwrap().extend(events.iter().map(|e| format!("{}#{}", e.kind, e.seq)));
        real().project(tx, events)
    }
}

/// Proyecta (escribe filas y `attention.*`) y después falla: la transacción de quien llama debe deshacerlo TODO.
#[derive(Debug)]
struct ProyectaYFalla;

impl EventProjector for ProyectaYFalla {
    fn project(&self, tx: &rusqlite::Transaction<'_>, events: &[EventRow]) -> StoreResult<Vec<NewEvent>> {
        real().project(tx, events)?;
        Err(StoreError::InvalidEvent("proyección rota a propósito".into()))
    }
}

fn pide(e: &Env, perfil: &str) -> Result<Value, String> {
    e.core.rpc(Caller::Agent(Some(e.root.clone())), "", "spawn", &json!({ "agent": "claude", "task": "Encargo", "name": "Hija", "shared": true, "profile": perfil }))
}

#[test]
fn el_writer_de_mutaciones_proyecta_en_la_transaccion_del_event() {
    let e = setup_con("wr-mutate", fake);
    // La raíz no tiene a quién preguntar: pregunta una hija.
    let pid = e.spawn(true);
    e.aprobar(&pid);
    let hija = e.hijas().pop().unwrap();
    let antes = head(&e.core);
    let q = e.core.rpc(Caller::Agent(Some(hija.clone())), "", "ask", &json!({ "question": "¿rama?" })).unwrap()["question"].as_u64().unwrap();

    let nuevos = desde(&e.core, antes);
    assert_eq!(kinds(&nuevos), vec!["task.question", "task.status_changed", "attention.created"], "el Event origen y su attention.created salen del mismo commit");
    assert!(nuevos[0].state_rev.is_some() && nuevos.iter().all(|ev| ev.state_rev == nuevos[0].state_rev), "el attention.created lleva el state_rev de su commit");
    assert_eq!(en_el_core(&e, |s| categorias_activas(s)), vec!["question"], "sin invocar project_in");
    let origen = nuevos.iter().find(|ev| ev.kind == "task.question").unwrap();
    let fila = en_el_core(&e, |s| instantanea(s)).into_iter().find(|f| f[3] == "question").unwrap();
    assert_eq!((fila[7].as_str(), fila[10].as_str(), fila[11].as_str()), (hija.as_str(), q.to_string().as_str(), origen.id.as_str()), "destino, subject y source_event_id");

    e.core.rpc(Caller::User, "", "reply", &json!({ "question": q, "answer": "sí" })).unwrap();
    assert!(en_el_core(&e, |s| categorias_activas(s)).is_empty(), "task.reply la resuelve en su commit");
    assert!(kinds(&desde(&e.core, antes)).contains(&"attention.resolved"));
}

#[test]
fn el_writer_de_hechos_sin_estado_proyecta_el_risk_y_el_approval_de_spawn() {
    let e = setup_con("wr-append", fake);
    let antes = head(&e.core);
    pide(&e, "autonomia_amplia").expect_err("denegación explícita de policy");
    let nuevos = desde(&e.core, antes);
    assert_eq!(kinds(&nuevos), vec!["spawn.requested", "attention.created"], "record_facts → append_events proyecta");
    assert!(nuevos.iter().all(|ev| ev.state_rev.is_none()), "un hecho que no confirma legacy_state no lleva state_rev, tampoco su attention.created");
    assert_eq!(en_el_core(&e, |s| categorias_activas(s)), vec!["risk"]);

    let pendiente = pide(&e, "explorar").unwrap();
    assert_eq!(en_el_core(&e, |s| categorias_activas(s)), vec!["approval", "risk"]);
    // La resolución con fila legacy entra por el writer de mutaciones y resuelve solo el approval.
    e.core.reject_spawn(pendiente["pending_id"].as_str().unwrap(), true, Some("no")).unwrap();
    assert_eq!(en_el_core(&e, |s| categorias_activas(s)), vec!["risk"], "el risk no se cierra con otra solicitud");
}

#[test]
fn el_writer_de_resoluciones_standalone_resuelve_el_approval() {
    let e = setup_con("wr-standalone", fake);
    let pid = pide(&e, "explorar").unwrap()["pending_id"].as_str().unwrap().to_string();
    let p = e.core.list_pending_spawns().into_iter().find(|p| p.pending_id == pid).unwrap();
    let fact = super::tx_ops::spawn_resolution_fact(&MutationContext::core(), &p, super::event_kinds::SpawnOutcome::CoordinatorClosed, None, false).unwrap();
    e.core.record_facts(&MutationContext::core(), vec![fact]).unwrap();
    assert!(en_el_core(&e, |s| categorias_activas(s)).is_empty());
    let fila = en_el_core(&e, |s| instantanea(s)).pop().unwrap();
    assert_eq!((fila[5].as_str(), fila[17].as_str()), ("resolved", "condition_cleared"));
}

#[test]
fn los_tres_writers_pasan_por_el_proyector_y_el_de_projects_no_levanta_nada() {
    let e = setup_con("wr-todos", fake);
    let graba = Arc::new(Graba::default());
    en_el_core(&e, |s| s.set_event_projector(Arc::new(GrabaYDelega(graba.clone()))));

    // 1) mutaciones
    e.core.mutate(|tx| tx.mark_running(&e.root).map(|_| ())).ok();
    let hija = {
        let pid = e.spawn(true);
        e.aprobar(&pid);
        e.hijas().pop().unwrap()
    };
    e.core.rpc(Caller::Agent(Some(hija)), "", "ask", &json!({ "question": "q" })).unwrap();
    // 2) record_facts
    pide(&e, "autonomia_amplia").expect_err("denegada");
    // 3) gestión de Project
    e.core.rpc(Caller::User, "", "project_archive", &json!({ "project_id": e.project, "archived": true })).unwrap();

    let vistos = graba.0.lock().unwrap().clone();
    for esperado in ["task.question", "spawn.requested", "project.archived"] {
        assert!(vistos.iter().any(|v| v.starts_with(esperado)), "el writer de {esperado} no pasó por el proyector: {vistos:?}");
    }
    // `project.*` no es una señal de ninguna regla: el writer de Projects pasa por el proyector y no levanta nada.
    assert!(!en_el_core(&e, |s| categorias_activas(s)).iter().any(|c| c == "project"));
    let seqs: Vec<i64> = vistos.iter().map(|v| v.rsplit('#').next().unwrap().parse().unwrap()).collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "el proyector ve los Events en orden de seq: {seqs:?}");
}

#[test]
fn si_la_proyeccion_falla_el_writer_de_mutaciones_deshace_event_estado_y_attention() {
    let e = setup_con("wr-rollback-mutate", fake);
    let pid = e.spawn(true);
    e.aprobar(&pid);
    let hija = e.hijas().pop().unwrap();
    let (antes, foto) = (head(&e.core), en_el_core(&e, |s| instantanea(s)));
    let mensajes = e.core.lock().messages.len();
    en_el_core(&e, |s| s.set_event_projector(Arc::new(ProyectaYFalla)));

    let error = e.core.rpc(Caller::Agent(Some(hija)), "", "ask", &json!({ "question": "¿rama?" })).expect_err("la mutación no se confirma");
    assert!(error.contains("proyección rota a propósito"), "{error}");
    assert_eq!(head(&e.core), antes, "ni el Event origen ni attention.created");
    assert_eq!(en_el_core(&e, |s| instantanea(s)), foto, "ni filas de Attention");
    assert_eq!(e.core.lock().messages.len(), mensajes, "y el estado en memoria no cambió");
}

#[test]
fn si_la_proyeccion_falla_record_facts_deshace_el_event_y_no_se_devuelve_denegacion() {
    let e = setup_con("wr-rollback-append", fake);
    let (antes, foto) = (head(&e.core), en_el_core(&e, |s| instantanea(s)));
    en_el_core(&e, |s| s.set_event_projector(Arc::new(ProyectaYFalla)));

    let error = pide(&e, "autonomia_amplia").expect_err("no se registra");
    assert!(error.contains("proyección rota a propósito"), "el fallo real, no una denegación «registrada»: {error}");
    assert!(!error.contains("bloqueado"), "{error}");
    assert_eq!(head(&e.core), antes);
    assert_eq!(en_el_core(&e, |s| instantanea(s)), foto);
    assert!(e.core.list_pending_spawns().is_empty());
}

#[test]
fn si_la_proyeccion_falla_el_writer_de_projects_deshace_el_cambio() {
    let e = setup_con("wr-rollback-project", fake);
    let antes = head(&e.core);
    en_el_core(&e, |s| s.set_event_projector(Arc::new(ProyectaYFalla)));
    let error = e.core.rpc(Caller::User, "", "project_archive", &json!({ "project_id": e.project, "archived": true })).expect_err("no se confirma");
    assert!(error.contains("proyección rota a propósito"), "{error}");
    assert_eq!(head(&e.core), antes, "sin project.archived");
    en_el_core(&e, |s| s.set_event_projector(Arc::new(real())));
    assert!(e.core.rpc(Caller::User, "", "project_archive", &json!({ "project_id": e.project, "archived": true })).is_ok(), "y el proyecto no quedó archivado a medias");
}

#[test]
fn el_estado_que_mantienen_los_writers_es_el_de_un_replay_desde_cero_del_log() {
    let e = setup_con("wr-replay", fake);
    let ctx = MutationContext::core();
    let pid = e.spawn(true);
    e.aprobar(&pid);
    let hija = e.hijas().pop().unwrap();
    let q = e.core.rpc(Caller::Agent(Some(hija.clone())), "", "ask", &json!({ "question": "¿rama?" })).unwrap()["question"].as_u64().unwrap();
    pide(&e, "autonomia_amplia").expect_err("risk");
    pide(&e, "explorar").unwrap();
    e.core.mutate_as(&ctx, |tx| tx.fail_with(&hija, "agent_idle_timeout", "inactiva")).unwrap();
    e.core
        .mutate_as(&MutationContext::person(Channel::Ui), |tx| {
            tx.record_decision(&e.root, "merge", "human", &json!({ "outcome": "conflict", "branch": "lx/r1/t2", "squash": false, "conflicts": ["a"] }))
        })
        .unwrap();
    e.core.rpc(Caller::User, "", "reply", &json!({ "question": q, "answer": "sí" })).unwrap();

    let mantenido = en_el_core(&e, |s| instantanea(s));
    assert!(mantenido.len() >= 4, "hay Attention de varias categorías: {mantenido:?}");
    // Replay desde cero del log completo (incluidos los attention.* ya escritos, que se ignoran) en un almacén limpio.
    let log = desde(&e.core, 0);
    let (_d, mut limpio) = abre();
    aplica(&mut limpio, 0, &log);
    assert_eq!(instantanea(&limpio), mantenido, "replay desde cero = lo que mantuvieron los writers");
    assert_eq!(ciclo_de_vida(&limpio).len(), en_el_core(&e, |s| ciclo_de_vida(s)).len(), "mismos attention.created / resolved");
    // Y reaplicar el log sobre el estado vivo no cambia nada (restart / retry).
    en_el_core(&e, |s| {
        let r = aplica(s, 0, &log);
        assert!(r.created.is_empty() && r.updated.is_empty() && r.resolved.is_empty() && r.lifecycle_events == 0, "{r:?}");
    });
    assert_eq!(en_el_core(&e, |s| instantanea(s)), mantenido);
}

#[test]
fn un_retry_del_mismo_event_no_reproyecta() {
    // `append_events` con la misma `(kind, idem_key)`: el duplicado no se inserta y por tanto no se reproyecta.
    let e = setup_con("wr-retry", fake);
    let pid = pide(&e, "explorar").unwrap()["pending_id"].as_str().unwrap().to_string();
    let p = e.core.list_pending_spawns().into_iter().find(|p| p.pending_id == pid).unwrap();
    let ctx = MutationContext::agent(e.root.clone(), Channel::Lxo);
    let fact = super::tx_ops::spawn_requested_fact(&ctx, &p).unwrap();
    let (antes, foto) = (head(&e.core), en_el_core(&e, |s| instantanea(s)));
    e.core.record_facts(&ctx, vec![fact]).unwrap();
    assert_eq!(head(&e.core), antes, "el duplicado no añade nada");
    assert_eq!(en_el_core(&e, |s| instantanea(s)), foto);
}

#[test]
fn el_registro_y_los_cuatro_cambios_de_projects_pasan_por_el_proyector() {
    let (_l, data, _c, core) = core_listo();
    let graba = Arc::new(Graba::default());
    core.storage.with_store(|st| st.set_event_projector(Arc::new(GrabaYDelega(graba.clone())))).unwrap();
    let base = base_de(&data);
    let origen = repo(&base, "origen", None);
    let id = id_de(&registra(&core, &origen)); // project_register
    let copia = clon(&base, &origen, "copia", None);
    rpc(&core, "project_add", json!({ "path": ruta(&copia), "join": id })).unwrap(); // project_join_recorded
    rpc(&core, "project_locate", json!({ "project_id": id, "path": ruta(&copia), "confirm": false })).unwrap(); // project_relocate_recorded
    rpc(&core, "project_archive", json!({ "project_id": id })).unwrap(); // project_set_archived_recorded (archivar)
    rpc(&core, "project_archive", json!({ "project_id": id, "archived": false })).unwrap(); // (restaurar)
    let vistos: Vec<String> = graba.0.lock().unwrap().iter().map(|v| v.split('#').next().unwrap().to_string()).collect();
    assert_eq!(vistos, vec!["project.registered", "project.location_added", "project.relocated", "project.archived", "project.restored"]);
    // Ninguno es señal de Attention: el proyector se ejecutó y no levantó nada.
    assert!(core.storage.with_store(|st| categorias_activas(st)).unwrap().is_empty());
}
