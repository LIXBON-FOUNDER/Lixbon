//! Pruebas de `Core::record_facts` (slice E, E1b · Pending Spawn): hechos durables que NO modifican
//! `legacy_state`, incluidos `spawn.requested` y las resoluciones standalone.
//!
//! `Persistence::append` → `Persister::append` (reintentos con los mismos `NewEvent`) → `Store::append_events`
//! (`state_rev = NULL`). No incrementa la `rev` del estado, no escribe el espejo, no publica un `State`.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::boot_tests::*;
use super::events::{Channel, EntityKind, EventDraft, EventPayload, MutationContext};
use super::host::RecordingHost;
use super::mutation::{Health, MutateError, PersistError, Persistence, RetryPolicy};
use super::state::{NewTask, State};
use super::store_boot::StorageStatus;
use super::{Core, Orch};
use crate::store::{EventClass, EventQuery, EventRow, NewEvent};

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
struct Solicitud {
    n: u32,
}

impl EventPayload for Solicitud {
    const KIND: &'static str = "test.solicitud";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

fn hecho(n: u32) -> EventDraft {
    EventDraft::new(EntityKind::SpawnRequest, format!("sp{n}"), &Solicitud { n }).unwrap()
}

fn ctx() -> MutationContext {
    MutationContext::agent("padre", Channel::Lxo)
}

/// Persistencia de prueba delante de la real: anota cada intento (de estado y de hechos) y falla `quedan` veces.
struct Espia {
    inner: Mutex<Option<Arc<dyn Persistence>>>,
    quedan: AtomicUsize,
    transitorio: bool,
    hechos: Mutex<Vec<Vec<NewEvent>>>,
    persists: AtomicUsize,
    publicaciones: AtomicUsize,
}

impl Espia {
    fn instala(core: &Core, quedan: usize, transitorio: bool) -> Arc<Espia> {
        let w = Arc::new(Espia {
            inner: Mutex::new(None),
            quedan: AtomicUsize::new(quedan),
            transitorio,
            hechos: Mutex::new(vec![]),
            persists: AtomicUsize::new(0),
            publicaciones: AtomicUsize::new(0),
        });
        let w2 = w.clone();
        core.wrap_persistence(move |inner| {
            *w2.inner.lock().unwrap() = Some(inner);
            w2
        });
        core.set_retry_policy(RetryPolicy::with_backoffs(vec![Duration::from_millis(1); 3]));
        w
    }

    fn intentos(&self) -> Vec<Vec<NewEvent>> {
        self.hechos.lock().unwrap().clone()
    }

    fn real(&self) -> Arc<dyn Persistence> {
        self.inner.lock().unwrap().clone().expect("persistencia real")
    }

    fn falla(&self) -> Option<PersistError> {
        if self.quedan.load(Ordering::SeqCst) == 0 {
            return None;
        }
        self.quedan.fetch_sub(1, Ordering::SeqCst);
        Some(if self.transitorio { PersistError::transient("ocupada (simulada)") } else { PersistError::structural("disco (simulado)") })
    }
}

impl Persistence for Espia {
    fn persist(&self, state: &State, events: &[NewEvent]) -> Result<(), PersistError> {
        self.persists.fetch_add(1, Ordering::SeqCst);
        self.real().persist(state, events)
    }

    fn append(&self, events: &[NewEvent]) -> Result<(), PersistError> {
        self.hechos.lock().unwrap().push(events.to_vec());
        match self.falla() {
            Some(e) => Err(e),
            None => self.real().append(events),
        }
    }

    fn records_events(&self) -> bool {
        self.inner.lock().unwrap().as_ref().is_some_and(|i| i.records_events())
    }

    fn after_publish(&self, state: &State) -> Result<(), String> {
        self.publicaciones.fetch_add(1, Ordering::SeqCst);
        self.real().after_publish(state)
    }
}

struct Entorno {
    _l: Limpia,
    data: std::path::PathBuf,
    host: Arc<RecordingHost>,
    core: Arc<Core>,
}

fn entorno() -> Entorno {
    let (l, data, core_dir) = dirs();
    let (core, host, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(matches!(core.storage_status(), StorageStatus::Ready(_)));
    Entorno { _l: l, data, host, core }
}

fn eventos(core: &Core) -> Vec<EventRow> {
    core.storage.with_store(|s| s.events_page(&EventQuery { limit: Some(500), ..Default::default() }).unwrap().events).expect("almacén abierto")
}

fn rev(core: &Core) -> i64 {
    core.storage.confirmed_rev().unwrap().expect("rev confirmada")
}

fn estado(core: &Core) -> serde_json::Value {
    serde_json::to_value(&*core.lock()).unwrap()
}

fn nt() -> NewTask {
    NewTask {
        agent: "claude".into(), model: None, effort: None, role: None, title: "t".into(), spec: "s".into(),
        repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: false,
    }
}

// ---------------------------------------------------------------------------------------------
// SQLite
// ---------------------------------------------------------------------------------------------

#[test]
fn un_hecho_standalone_se_persiste_sin_tocar_el_estado_la_rev_el_espejo_ni_la_publicacion() {
    let e = entorno();
    let espia = Espia::instala(&e.core, 0, false);
    let (rev0, estado0, espejo0) = (rev(&e.core), estado(&e.core), std::fs::read(e.data.join("state.json")).ok());
    let cambios0 = e.host.events_named("orch:changed").len();

    e.core
        .record_facts(&ctx(), vec![hecho(1).project(Some("p1".into())).run(Some("r1".into())).correlated("sp1").idempotent("sp1")])
        .unwrap();

    let evs = eventos(&e.core);
    assert_eq!(evs.len(), 1);
    let ev = &evs[0];
    assert_eq!((ev.kind.as_str(), ev.class, ev.v), ("test.solicitud", EventClass::State, 1));
    assert_eq!(ev.state_rev, None, "un hecho standalone no confirma legacy_state");
    assert_eq!((ev.entity_kind.as_str(), ev.entity_id.as_str()), ("spawn_request", "sp1"));
    assert_eq!((ev.actor_kind.as_str(), ev.actor_id.as_deref(), ev.channel.as_deref()), ("agent", Some("padre"), Some("lxo")));
    assert_eq!((ev.project_id.as_deref(), ev.run_id.as_deref(), ev.correlation_id.as_deref(), ev.idem_key.as_deref()), (Some("p1"), Some("r1"), Some("sp1"), Some("sp1")));
    assert_eq!(rev(&e.core), rev0, "no incrementa legacy_state.rev");
    assert_eq!(estado(&e.core), estado0, "no publica un State nuevo");
    assert_eq!(std::fs::read(e.data.join("state.json")).ok(), espejo0, "ni escribe el espejo");
    assert_eq!(espia.publicaciones.load(Ordering::SeqCst), 0, "after_publish no se llama");
    assert_eq!(espia.persists.load(Ordering::SeqCst), 0, "no pasa por la persistencia del estado");
    assert_eq!(e.host.events_named("orch:changed").len(), cambios0, "ni avisa a la interfaz");
}

#[test]
fn varios_hechos_de_una_llamada_se_persisten_juntos_y_en_orden() {
    let e = entorno();
    e.core.record_facts(&ctx(), vec![hecho(1), hecho(2), hecho(3)]).unwrap();
    let evs = eventos(&e.core);
    assert_eq!(evs.iter().map(|x| x.entity_id.as_str()).collect::<Vec<_>>(), vec!["sp1", "sp2", "sp3"]);
    assert!(evs.windows(2).all(|w| w[0].seq < w[1].seq));
    assert!(evs.iter().all(|x| x.state_rev.is_none() && x.at == evs[0].at));
    assert_eq!(evs.iter().map(|x| x.id.clone()).collect::<std::collections::HashSet<_>>().len(), 3);
}

#[test]
fn un_fallo_transitorio_se_reintenta_con_los_mismos_eventos_sin_rematerializar() {
    let e = entorno();
    let espia = Espia::instala(&e.core, 2, true);
    e.core.record_facts(&ctx(), vec![hecho(1).idempotent("k1")]).unwrap();
    let intentos = espia.intentos();
    assert_eq!(intentos.len(), 3, "dos fallos transitorios y el éxito");
    assert!(intentos.iter().all(|i| *i == intentos[0]), "el MISMO id, hora e idem_key en cada intento");
    let evs = eventos(&e.core);
    assert_eq!(evs.len(), 1, "un solo evento, sin duplicar");
    assert_eq!((evs[0].id.as_str(), evs[0].at, evs[0].idem_key.as_deref()), (intentos[0][0].id.as_str(), intentos[0][0].at, Some("k1")));
    assert_eq!(e.core.health(), Health::Normal);
}

#[test]
fn un_fallo_definitivo_degrada_el_core_y_lo_siguiente_se_rechaza_sin_intentar_nada() {
    let e = entorno();
    let espia = Espia::instala(&e.core, 1, false);
    let r = e.core.record_facts(&ctx(), vec![hecho(1)]);
    assert!(matches!(r, Err(MutateError::Persist(ref m)) if m.contains("disco")), "{r:?}");
    assert_eq!(espia.intentos().len(), 1, "un fallo estructural no se reintenta");
    assert!(matches!(e.core.health(), Health::DegradedReadOnly(_)), "igual que una mutación normal");
    assert!(eventos(&e.core).is_empty());
    // Ya degradado: ni los hechos ni las mutaciones intentan nada.
    assert!(matches!(e.core.record_facts(&ctx(), vec![hecho(2)]), Err(MutateError::ReadOnly(_))));
    assert_eq!(espia.intentos().len(), 1);
    assert!(matches!(e.core.mutate(|_| Ok(())), Err(MutateError::ReadOnly(_))));
}

#[test]
fn con_el_core_ya_degradado_se_rechaza_de_inmediato_sin_finalizar_ni_persistir() {
    let e = entorno();
    let espia = Espia::instala(&e.core, 0, false);
    e.core.degrade_for_tests("fallo previo");
    // Incluso un borrador inválido recibe ReadOnly (no Rejected): la guarda va antes que la finalización.
    let r = e.core.record_facts(&ctx(), vec![hecho(1).idempotent("")]);
    assert!(matches!(r, Err(MutateError::ReadOnly(ref m)) if m == "fallo previo"), "{r:?}");
    assert!(matches!(e.core.record_facts(&ctx(), vec![hecho(2)]), Err(MutateError::ReadOnly(_))));
    assert!(espia.intentos().is_empty());
    assert!(eventos(&e.core).is_empty());
}

#[test]
fn repetir_un_hecho_con_la_misma_clave_es_un_exito_que_no_duplica() {
    let e = entorno();
    e.core.record_facts(&ctx(), vec![hecho(1).idempotent("sp1")]).unwrap();
    e.core.record_facts(&ctx(), vec![hecho(1).idempotent("sp1")]).unwrap();
    e.core.record_facts(&ctx(), vec![hecho(7).idempotent("sp1"), hecho(8).idempotent("sp1")]).unwrap();
    let evs = eventos(&e.core);
    assert_eq!(evs.len(), 1, "UNIQUE (kind, idem_key) con DO NOTHING");
    assert_eq!(evs[0].entity_id, "sp1", "gana el primero");
    assert_eq!(e.core.health(), Health::Normal);
}

#[test]
fn un_borrador_invalido_rechaza_el_lote_entero_sin_persistir_ni_degradar() {
    let e = entorno();
    let espia = Espia::instala(&e.core, 0, false);
    let r = e.core.record_facts(&ctx(), vec![hecho(1), hecho(2).idempotent("")]);
    assert!(matches!(r, Err(MutateError::Rejected(_))), "{r:?}");
    assert!(espia.intentos().is_empty(), "se valida ANTES de persistir");
    assert!(eventos(&e.core).is_empty(), "ni siquiera el borrador válido del lote");
    assert_eq!(e.core.health(), Health::Normal, "un error de programación no degrada el Core");
    // Un lote vacío es un éxito sin tocar nada.
    e.core.record_facts(&ctx(), vec![]).unwrap();
    assert!(espia.intentos().is_empty());
}

#[test]
fn el_project_id_de_un_borrador_con_project_from_task_se_resuelve_con_el_estado_confirmado() {
    let e = entorno();
    let task = e
        .core
        .mutate(|tx| {
            let (_run, t) = tx.create_run("obj", nt());
            tx.task_mut(&t)?.project_id = Some("p-resuelto".into());
            Ok(t)
        })
        .unwrap();
    e.core.record_facts(&ctx(), vec![hecho(1).project_from_task(task)]).unwrap();
    let ev = eventos(&e.core).into_iter().find(|x| x.kind == "test.solicitud").unwrap();
    assert_eq!(ev.project_id.as_deref(), Some("p-resuelto"));
}

#[test]
fn no_change_no_confirma_eventos_ni_los_hechos_standalone_dependen_de_el() {
    let e = entorno();
    let (rev0, n0) = (rev(&e.core), eventos(&e.core).len());
    e.core
        .mutate(|tx| {
            tx.push_event(hecho(1));
            tx.no_change();
            Ok(())
        })
        .unwrap();
    assert_eq!((rev(&e.core), eventos(&e.core).len()), (rev0, n0), "Tx::no_change no confirma eventos");
    // Y un hecho standalone sí queda, sin mover la rev.
    e.core.record_facts(&ctx(), vec![hecho(2)]).unwrap();
    assert_eq!((rev(&e.core), eventos(&e.core).len()), (rev0, n0 + 1));
}

// ---------------------------------------------------------------------------------------------
// state.json (sin Event Log)
// ---------------------------------------------------------------------------------------------

#[test]
fn con_state_json_se_valida_y_se_descarta_con_exito_sin_crear_archivos() {
    let (_l, data, _core_dir) = dirs();
    let core = Orch::default().0; // persistencia state.json (legacy/degradado)
    let espia = Espia::instala(&core, 0, false);
    // (sin SQLite, el `inner` es StateJsonFile: records_events = false)
    core.record_facts(&ctx(), vec![hecho(1), hecho(2)]).unwrap();
    assert!(espia.intentos().is_empty(), "el backend sin Event Log no recibe nada");
    assert!(archivos(&data).is_empty(), "ni events.json ni state.json: no hay nada que escribir");
    // La validación es la misma que con SQLite.
    let r = core.record_facts(&ctx(), vec![hecho(3).idempotent("")]);
    assert!(matches!(r, Err(MutateError::Rejected(_))), "{r:?}");
    // Y la guarda de salud también.
    core.degrade_for_tests("x");
    assert!(matches!(core.record_facts(&ctx(), vec![hecho(4)]), Err(MutateError::ReadOnly(_))));
}

// ---------------------------------------------------------------------------------------------
// Arquitectura
// ---------------------------------------------------------------------------------------------

#[test]
fn solo_la_frontera_de_persistencia_añade_hechos_standalone() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch");
    let mut vistos = 0;
    for entrada in std::fs::read_dir(&dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        let prod = texto.split("mod tests {").next().unwrap().split("mod durable_tests {").next().unwrap();
        for (n, l) in prod.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")) {
            for (simbolo, donde) in [
                (".append_events(", &["store_boot.rs"][..]),
                ("fn append(", &["mutation.rs", "store_boot.rs"]),
                (".append(&finalized)", &["mutation.rs"]),
                // `attention_action.rs` is the dedicated Person/Desktop risk decision producer.
                ("record_facts(", &["mutation.rs", "spawn_approval.rs", "attention_action.rs"]),
            ] {
                assert!(!l.contains(simbolo) || donde.contains(&nombre.as_str()), "{nombre}:{}: «{simbolo}» solo puede aparecer en {donde:?}", n + 1);
            }
        }
        vistos += 1;
    }
    assert!(vistos >= 30);
    // Un hecho standalone nunca sube la rev: SqlitePersistence::append no toca `committed`.
    let src = std::fs::read_to_string(dir.join("store_boot.rs")).unwrap();
    let cuerpo = src.split("fn append(&self, events: &[NewEvent])").nth(1).unwrap().split("fn after_publish").next().unwrap();
    assert!(!cuerpo.contains("committed") && !cuerpo.contains("commit_authoritative"), "append no avanza la rev ni usa la transacción del estado:\n{cuerpo}");
}
