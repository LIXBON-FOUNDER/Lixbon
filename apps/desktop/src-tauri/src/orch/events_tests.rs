//! Pruebas del Event Log en el Core (slice E, etapa E1a): outbox en `Tx`, persistencia atómica con
//! `legacy_state`, reintentos, rollback, reinicio y arquitectura. Todavía no hay mutadores instrumentados:
//! los eventos de estas pruebas se emiten a mano con tipos de prueba.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use super::boot_tests::*;
use super::events::{Actor, Channel, EntityKind, EventDraft, EventError, EventPayload, MutationContext};
use super::mutation::{Health, MutateError, PersistError, Persistence, RetryPolicy, StateAccess, Tx};
use super::state::{NewTask, Run, State};
use super::store_boot::StorageStatus;
use super::{Core, Orch};
use crate::store::{ClientCredential, ClientClaims, ClientPrincipal, ClientRegistration, ClientSurface, DeviceIdentity, EventClass, EventQuery, EventRow, NewEvent, CORE_CLIENT_ID, MAX_PAYLOAD_BYTES};

// ---------------------------------------------------------------------------------------------
// Tipos de prueba: el contrato real de cada `kind` llega con E1b
// ---------------------------------------------------------------------------------------------

#[derive(Serialize)]
struct Hecho {
    n: u32,
}

impl EventPayload for Hecho {
    const KIND: &'static str = "test.hecho";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[derive(Serialize)]
struct Grande {
    texto: String,
}

impl EventPayload for Grande {
    const KIND: &'static str = "test.grande";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

#[derive(Serialize)]
struct SinObjeto(u32);

impl EventPayload for SinObjeto {
    const KIND: &'static str = "test.sin_objeto";
    const VERSION: i64 = 1;
    const CLASS: EventClass = EventClass::State;
}

fn hecho(n: u32) -> EventDraft {
    EventDraft::new(EntityKind::Core, "core", &Hecho { n }).unwrap()
}

// ---------------------------------------------------------------------------------------------
// Ayudas
// ---------------------------------------------------------------------------------------------

fn core_listo() -> (Limpia, std::path::PathBuf, std::path::PathBuf, Arc<Core>) {
    let (l, data, core_dir) = dirs();
    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    assert!(matches!(core.storage_status(), StorageStatus::Ready(_)));
    (l, data, core_dir, core)
}

fn eventos(core: &Core) -> Vec<EventRow> {
    core.storage.with_store(|s| s.events_page(&EventQuery { limit: Some(500), ..Default::default() }).unwrap().events).expect("almacén abierto")
}

fn cliente_autenticado(core: &Core, surface: ClientSurface, principal: ClientPrincipal, installation: &str, secret: &str) -> crate::store::AuthenticatedClient {
    let registration = ClientRegistration::new(surface, DeviceIdentity::new(installation, Some(format!("device-{installation}"))).unwrap()).unwrap();
    let credential = ClientCredential::new(principal, secret).unwrap();
    core.storage
        .with_store(|store| {
            store.register_client(&registration, &credential, super::state::now_ms() as i64).unwrap();
            store.authenticate_client(credential.reveal_for_delivery()).unwrap().unwrap()
        })
        .expect("almacén abierto")
}

fn rev(core: &Core) -> i64 {
    core.storage.confirmed_rev().unwrap().expect("rev confirmada")
}


/// Un cambio REAL del estado sin pasar por los mutadores semánticos de `Tx` (que ya emiten eventos):
/// las pruebas de esta infraestructura (E1a) cuentan solo los eventos que ellas mismas emiten.
///
/// El Run sintético nace AHORA (no en el epoch): con `created = 1` ya cumpliría la regla de inactividad y
/// el barrido de fondo (`close_idle_runs`) lo trataría como trabajo elegible, confirmando una mutación
/// ajena a la prueba (`rev` una unidad por delante, según el planificador).
fn run_sin_eventos(tx: &mut Tx, objetivo: &str) {
    let id = format!("x{}", tx.runs.len() + 1);
    let ahora = super::state::now_ms();
    tx.runs.insert(id.clone(), Run { id, objective: objetivo.into(), root: String::new(), created: ahora, closed: false, last_activity: ahora });
}

/// El helper de infraestructura no crea trabajo elegible para un vigilante de fondo: el Run sintético
/// no es inactivo y un barrido explícito no confirma nada (ni `rev`, ni eventos).
#[test]
fn el_run_sintetico_de_las_pruebas_no_es_elegible_para_el_barrido_de_inactividad() {
    let (_l, data, core_dir) = dirs();
    let (core, _h, r) = arranca(&data, &core_dir);
    r.unwrap();
    core.mutate(|tx| {
        run_sin_eventos(tx, "sintetico");
        Ok(())
    })
    .unwrap();
    assert!(core.lock().idle_runs(super::state::now_ms(), super::IDLE_CLOSE_MS, &[]).is_empty(), "no debe nacer inactivo");
    let (rev_antes, eventos_antes) = (rev(&core), eventos(&core).len());
    core.close_idle_runs();
    assert_eq!((rev(&core), eventos(&core).len()), (rev_antes, eventos_antes), "el barrido no confirma ninguna mutación");
}

/// Persistencia de prueba delante de la real: falla `quedan` veces y siempre anota los eventos que recibe.
struct Inyecta {
    inner: Mutex<Option<Arc<dyn Persistence>>>,
    quedan: AtomicUsize,
    transitorio: bool,
    vistos: Mutex<Vec<Vec<NewEvent>>>,
}

impl Inyecta {
    fn instala(core: &Core, quedan: usize, transitorio: bool) -> Arc<Inyecta> {
        let w = Arc::new(Inyecta { inner: Mutex::new(None), quedan: AtomicUsize::new(quedan), transitorio, vistos: Mutex::new(vec![]) });
        let w2 = w.clone();
        core.wrap_persistence(move |inner| {
            *w2.inner.lock().unwrap() = Some(inner);
            w2
        });
        w
    }

    fn intentos(&self) -> Vec<Vec<NewEvent>> {
        self.vistos.lock().unwrap().clone()
    }
}

impl Persistence for Inyecta {
    fn persist(&self, state: &State, events: &[NewEvent]) -> Result<(), PersistError> {
        self.vistos.lock().unwrap().push(events.to_vec());
        if self.quedan.load(Ordering::SeqCst) > 0 {
            self.quedan.fetch_sub(1, Ordering::SeqCst);
            return Err(if self.transitorio { PersistError::transient("ocupada (simulada)") } else { PersistError::structural("disco (simulado)") });
        }
        let inner = self.inner.lock().unwrap().clone().expect("persistencia real");
        inner.persist(state, events)
    }

    fn records_events(&self) -> bool {
        self.inner.lock().unwrap().as_ref().is_some_and(|i| i.records_events())
    }

    fn after_publish(&self, state: &State) -> Result<(), String> {
        let inner = self.inner.lock().unwrap().clone().expect("persistencia real");
        inner.after_publish(state)
    }
}

// ---------------------------------------------------------------------------------------------
// El borrador solo nace de un payload tipado
// ---------------------------------------------------------------------------------------------

#[test]
fn el_borrador_exige_un_payload_tipado_que_sea_un_objeto_y_quepa() {
    assert!(EventDraft::new(EntityKind::Core, "core", &Hecho { n: 1 }).is_ok());
    assert_eq!(EventDraft::new(EntityKind::Core, "core", &SinObjeto(3)).unwrap_err(), EventError::NotAnObject("test.sin_objeto"));
    let e = EventDraft::new(EntityKind::Core, "core", &Grande { texto: "x".repeat(MAX_PAYLOAD_BYTES) }).unwrap_err();
    assert!(matches!(e, EventError::TooLarge { kind: "test.grande", bytes } if bytes > MAX_PAYLOAD_BYTES), "{e}");
    // Justo en el límite cabe: `{"texto":"…"}` suma 12 bytes alrededor del texto.
    assert!(EventDraft::new(EntityKind::Core, "core", &Grande { texto: "x".repeat(MAX_PAYLOAD_BYTES - 12) }).is_ok());
    assert!(EventDraft::new(EntityKind::Core, "core", &Grande { texto: "x".repeat(MAX_PAYLOAD_BYTES - 11) }).is_err());
    // Y se mide en BYTES: 3000 × «€» = 9000 bytes.
    assert!(EventDraft::new(EntityKind::Core, "core", &Grande { texto: "€".repeat(3000) }).is_err());
}

// ---------------------------------------------------------------------------------------------
// Atomicidad con la mutación
// ---------------------------------------------------------------------------------------------

#[test]
fn un_evento_emitido_en_mutate_se_confirma_con_la_mutacion() {
    let (_l, _d, _c, core) = core_listo();
    assert!(eventos(&core).is_empty(), "sin relleno histórico");
    let antes = rev(&core);
    core.mutate(|tx| {
        run_sin_eventos(tx, "obj");
        tx.push_event(hecho(1).project(Some("p1".into())).run(Some("r1".into())).correlated("c1").idempotent("k1"));
        Ok(())
    })
    .unwrap();
    let evs = eventos(&core);
    assert_eq!(evs.len(), 1);
    let e = &evs[0];
    assert_eq!((e.kind.as_str(), e.v, e.class), ("test.hecho", 1, EventClass::State));
    assert_eq!(e.state_rev, Some(antes + 1), "lleva la rev de la mutación que lo confirmó");
    assert_eq!(rev(&core), antes + 1);
    assert_eq!((e.actor_kind.as_str(), e.actor_id.as_deref(), e.channel.as_deref()), ("system", None, Some("core")), "actor por defecto: el Core");
    assert_eq!((e.project_id.as_deref(), e.run_id.as_deref(), e.correlation_id.as_deref(), e.idem_key.as_deref()), (Some("p1"), Some("r1"), Some("c1"), Some("k1")));
    assert_eq!((e.entity_kind.as_str(), e.entity_id.as_str(), e.payload.as_str()), ("core", "core", "{\"n\":1}"));
    assert_eq!(e.client_id.as_deref(), Some(CORE_CLIENT_ID), "los eventos internos identifican al Core reservado");
    assert!(e.at > 0 && e.id.len() == 36 && &e.id[14..15] == "7", "UUID v7: {}", e.id);
}

#[test]
fn cliente_autenticado_cli_y_desktop_conserva_client_id_actor_y_canal_en_evento() {
    let (_l, _d, _c, core) = core_listo();
    let clients = [
        (ClientSurface::Cli, ClientPrincipal::Agent("task-cli-85".into()), "install-cli-85", "cli-secret-85-this-is-at-least-32-bytes-long", Channel::Lxo, "agent", Some("task-cli-85")),
        (ClientSurface::Desktop, ClientPrincipal::Person("person-desktop-85".into()), "install-desktop-85", "desktop-secret-85-this-is-at-least-32-bytes-long", Channel::Ui, "person", Some("person-desktop-85")),
    ];

    for (index, (surface, principal, installation, secret, channel, actor_kind, actor_id)) in clients.into_iter().enumerate() {
        let authenticated = cliente_autenticado(&core, surface, principal, installation, secret);
        let client_id = authenticated.identity().client_id().to_string();
        let ctx = MutationContext::authenticated(&authenticated, &ClientClaims::default(), channel).unwrap();
        core.mutate_as(&ctx, |tx| {
            run_sin_eventos(tx, "identity-event");
            tx.push_event(hecho(index as u32 + 10));
            Ok(())
        })
        .unwrap();

        let event = &eventos(&core)[index];
        assert_eq!(event.client_id.as_deref(), Some(client_id.as_str()));
        assert_eq!(event.actor_kind.as_str(), actor_kind);
        assert_eq!(event.actor_id.as_deref(), actor_id);
        assert_eq!(event.channel.as_deref(), Some(match channel { Channel::Lxo => "lxo", Channel::Ui => "ui", Channel::Core => "core" }));
    }
}

#[test]
fn varios_eventos_de_una_mutacion_comparten_state_rev_y_cada_commit_tiene_el_suyo() {
    let (_l, _d, _c, core) = core_listo();
    core.mutate(|tx| {
        run_sin_eventos(tx, "a");
        tx.push_event(hecho(1));
        tx.push_event(hecho(2).by(Actor::Agent("t7".into()), Channel::Lxo));
        tx.push_event(hecho(3).by(Actor::Person, Channel::Ui));
        Ok(())
    })
    .unwrap();
    core.mutate(|tx| {
        run_sin_eventos(tx, "b");
        tx.push_event(hecho(4));
        Ok(())
    })
    .unwrap();
    let evs = eventos(&core);
    let revs: Vec<_> = evs.iter().map(|e| e.state_rev.unwrap()).collect();
    assert_eq!(revs[0], revs[1]);
    assert_eq!(revs[1], revs[2]);
    assert_eq!(revs[3], revs[0] + 1);
    assert_eq!(evs.iter().map(|e| e.payload.clone()).collect::<Vec<_>>(), vec!["{\"n\":1}", "{\"n\":2}", "{\"n\":3}", "{\"n\":4}"], "orden de emisión");
    assert_eq!((evs[1].actor_kind.as_str(), evs[1].actor_id.as_deref(), evs[1].channel.as_deref()), ("agent", Some("t7"), Some("lxo")));
    assert_eq!((evs[2].actor_kind.as_str(), evs[2].actor_id.as_deref(), evs[2].channel.as_deref()), ("person", None, Some("ui")));
    let ids: std::collections::HashSet<_> = evs.iter().map(|e| e.id.clone()).collect();
    assert_eq!(ids.len(), 4, "un id distinto cada uno");
    assert!(evs.iter().all(|e| e.at == evs[0].at || e.at >= evs[0].at));
}

#[test]
fn el_actor_por_defecto_de_la_mutacion_se_puede_fijar() {
    let (_l, _d, _c, core) = core_listo();
    core.mutate(|tx| {
        run_sin_eventos(tx, "a");
        tx.acting_as(Actor::Person, Channel::Ui);
        tx.push_event(hecho(1));
        Ok(())
    })
    .unwrap();
    let e = &eventos(&core)[0];
    assert_eq!((e.actor_kind.as_str(), e.channel.as_deref()), ("person", Some("ui")));
}

#[test]
fn el_tx_publicado_no_conserva_borradores_y_el_estado_no_transporta_eventos() {
    let (_l, _d, _c, core) = core_listo();
    core.mutate(|tx| {
        run_sin_eventos(tx, "a");
        tx.push_event(hecho(1));
        assert_eq!(tx.pending_events().len(), 1);
        Ok(())
    })
    .unwrap();
    // La mutación siguiente parte de un candidato SIN borradores pendientes.
    core.mutate(|tx| {
        assert!(tx.pending_events().is_empty(), "el outbox no sobrevive a la transacción");
        tx.no_change();
        Ok(())
    })
    .unwrap();
    // `State` no tiene ningún campo de eventos: ni en memoria ni en el documento de SQLite.
    let claves: Vec<String> = serde_json::to_value(&*core.lock()).unwrap().as_object().unwrap().keys().cloned().collect();
    assert_eq!(claves, vec!["decisions", "env_blocks", "messages", "runs", "seq", "tasks"]);
    let (_, doc) = fila(&core);
    assert!(!doc.contains("outbox") && !doc.contains("\"events\"") && !doc.contains("test.hecho"), "el documento autoritativo no lleva metadatos de la transacción");
}

#[test]
fn sin_cambio_o_con_rechazo_los_eventos_se_descartan() {
    let (_l, _d, _c, core) = core_listo();
    let antes = rev(&core);
    core.mutate(|tx| {
        tx.push_event(hecho(1));
        assert_eq!(tx.pending_events().len(), 1);
        tx.no_change();
        assert!(tx.pending_events().is_empty(), "sin cambio no hay hecho que contar: el outbox se vacía");
        Ok(())
    })
    .unwrap();
    let r: Result<(), MutateError> = core.mutate(|tx| {
        run_sin_eventos(tx, "x");
        tx.push_event(hecho(2));
        Err("precondición".into())
    });
    assert_eq!(r, Err(MutateError::Rejected("precondición".into())));
    assert!(eventos(&core).is_empty());
    assert_eq!(rev(&core), antes);
    assert!(core.lock().runs.is_empty());
}

#[test]
fn un_evento_invalido_rechaza_la_mutacion_entera_sin_degradar_el_core() {
    let (_l, _d, _c, core) = core_listo();
    let antes = rev(&core);
    // Una clave de idempotencia vacía pasa el constructor pero no el contrato final.
    let r = core.mutate(|tx| {
        run_sin_eventos(tx, "x");
        tx.push_event(hecho(1));
        tx.push_event(hecho(2).idempotent(""));
        Ok(())
    });
    assert!(matches!(&r, Err(MutateError::Rejected(m)) if m.contains("test.hecho") && m.contains("idem_key")), "{r:?}");
    assert!(eventos(&core).is_empty(), "ni siquiera el evento válido");
    assert_eq!(rev(&core), antes);
    assert!(core.lock().runs.is_empty(), "ni la mutación");
    assert_eq!(core.health(), Health::Normal, "un contrato roto no es un fallo de almacenamiento");
}

// ---------------------------------------------------------------------------------------------
// Fallos de persistencia
// ---------------------------------------------------------------------------------------------

#[test]
fn si_la_persistencia_falla_no_hay_mutacion_ni_evento_visible() {
    let (_l, _d, _c, core) = core_listo();
    let antes = (rev(&core), fila(&core));
    let w = Inyecta::instala(&core, usize::MAX / 2, false);
    let r = core.mutate(|tx| {
        run_sin_eventos(tx, "x");
        tx.push_event(hecho(1));
        tx.push_event(hecho(2));
        Ok(())
    });
    assert!(matches!(r, Err(MutateError::Persist(_))), "{r:?}");
    assert!(core.lock().runs.is_empty(), "la memoria no cambia");
    assert!(matches!(core.health(), Health::DegradedReadOnly(_)));
    assert_eq!(w.intentos().len(), 1, "un fallo estructural no se reintenta");
    assert_eq!((rev(&core), fila(&core)), antes, "SQLite intacto");
    assert!(eventos(&core).is_empty(), "ningún evento visible");
}

#[test]
fn un_reintento_persiste_los_mismos_eventos_con_el_mismo_id_y_la_misma_hora() {
    let (_l, _d, _c, core) = core_listo();
    core.set_retry_policy(RetryPolicy::with_backoffs(vec![Duration::from_millis(15); 3]));
    let w = Inyecta::instala(&core, 2, true);
    core.mutate(|tx| {
        run_sin_eventos(tx, "x");
        tx.push_event(hecho(1));
        tx.push_event(hecho(2));
        Ok(())
    })
    .unwrap();
    let intentos = w.intentos();
    assert_eq!(intentos.len(), 3, "dos fallos transitorios y un éxito");
    assert_eq!(intentos[0].len(), 2);
    assert!(intentos[0] == intentos[1] && intentos[1] == intentos[2], "id, hora, payload y metadatos idénticos en cada intento");
    // Una hora de pared distinta entre intentos (esperamos 15 ms) no cambia la `at` ya fijada.
    let evs = eventos(&core);
    assert_eq!(evs.len(), 2, "exactamente una vez");
    assert_eq!((evs[0].id.as_str(), evs[0].at), (intentos[0][0].id.as_str(), intentos[0][0].at));
    assert_eq!((evs[1].id.as_str(), evs[1].at), (intentos[0][1].id.as_str(), intentos[0][1].at));
    assert_eq!(core.health(), Health::Normal);
}

#[test]
fn un_reintento_de_persistencia_no_duplica_decision_recorded() {
    let (_l, _d, _c, core) = core_listo();
    core.set_retry_policy(RetryPolicy::with_backoffs(vec![Duration::from_millis(15); 3]));
    let tarea = core
        .mutate(|tx| {
            let nueva = NewTask {
                agent: "claude".into(), model: None, effort: None, role: None, title: "t".into(), spec: "s".into(),
                repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: false,
            };
            Ok(tx.create_run("obj", nueva).1)
        })
        .unwrap();
    let antes = eventos(&core).len();
    let w = Inyecta::instala(&core, 2, true);
    let detalle = serde_json::json!({ "decision": "accepted", "head_commit": "h", "comment": null });
    let id = core
        .mutate_as(&MutationContext::person(Channel::Ui), |tx| tx.record_decision(&tarea, "review", "human", &detalle))
        .unwrap();
    let intentos = w.intentos();
    assert_eq!(intentos.len(), 3, "dos fallos transitorios y un éxito");
    assert!(intentos.iter().all(|i| i.len() == 1 && i[0] == intentos[0][0]), "el mismo evento (id, hora, payload) en cada intento");
    let evs: Vec<_> = eventos(&core).into_iter().skip(antes).collect();
    assert_eq!(evs.len(), 1, "exactamente un decision.recorded confirmado");
    assert_eq!((evs[0].kind.as_str(), evs[0].id.as_str()), ("decision.recorded", intentos[0][0].id.as_str()));
    assert_eq!(core.lock().decisions.iter().filter(|d| d.id == id).count(), 1, "y una sola fila");
    assert_eq!(core.health(), Health::Normal);
}

#[test]
fn un_reintento_de_persistencia_conserva_el_mismo_effect_id_y_no_duplica_el_efecto_ni_la_decision() {
    let (_l, _d, _c, core) = core_listo();
    core.set_retry_policy(RetryPolicy::with_backoffs(vec![Duration::from_millis(15); 3]));
    let tarea = core
        .mutate(|tx| {
            let nueva = NewTask {
                agent: "claude".into(), model: None, effort: None, role: None, title: "t".into(), spec: "s".into(),
                repo: "r".into(), cwd: "c".into(), branch: None, base: None, worktree: None, external: false,
            };
            Ok(tx.create_run("obj", nueva).1)
        })
        .unwrap();
    let antes = eventos(&core).len();
    let w = Inyecta::instala(&core, 2, true);
    let efecto = super::mutation::Effect::new("integrate", "git_merge")
        .task(&tarea)
        .observed(serde_json::json!({ "outcome": "merged", "branch": "lx/t", "result_commit": "r" }));
    let effect_id = efecto.effect_id().to_string();
    let detalle = serde_json::json!({ "outcome": "merged", "branch": "lx/t", "squash": false });
    core.acting(MutationContext::person(Channel::Ui))
        .mutate_after_effect(efecto, |tx| tx.record_decision(&tarea, "merge", "human", &detalle).map(|_| ()))
        .unwrap();
    let intentos = w.intentos();
    assert_eq!(intentos.len(), 3, "dos fallos transitorios y un éxito");
    assert!(intentos.iter().all(|i| i.len() == 2 && *i == intentos[0]), "los mismos dos eventos (id, hora, payload) en cada intento");
    assert_eq!(intentos[0][0].idem_key.as_deref(), Some(effect_id.as_str()), "el mismo effect_id en cada intento");
    let evs: Vec<_> = eventos(&core).into_iter().skip(antes).collect();
    assert_eq!(evs.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["effect.observed", "decision.recorded"], "exactamente una vez, y en orden");
    assert!(evs.iter().all(|e| e.correlation_id.as_deref() == Some(effect_id.as_str())));
    assert_eq!(core.health(), Health::Normal);
}

// ---------------------------------------------------------------------------------------------
// Modo legacy / degradado: sin Event Log
// ---------------------------------------------------------------------------------------------

#[test]
fn con_state_json_no_hay_event_log_y_no_se_crea_ningun_archivo_paralelo() {
    let (_l, data, _core_dir) = dirs();
    let core = Orch::default().0;
    core.mutate(|tx| {
        run_sin_eventos(tx, "a");
        tx.push_event(hecho(1));
        Ok(())
    })
    .unwrap();
    assert_eq!(core.lock().runs.len(), 1, "la mutación se confirma igual");
    assert_eq!(archivos(&data), vec!["state.json".to_string()], "solo state.json: ni events.json ni nada parecido");
    let en_disco = std::fs::read_to_string(data.join("state.json")).unwrap();
    assert!(en_disco.contains("\"objective\": \"a\""), "el estado SÍ se persistió");
    assert!(!en_disco.contains("test.hecho") && !en_disco.contains("outbox"), "y no contiene el outbox");
    // Los borradores se finalizaron y validaron, y el resultado se descartó: el backend recibe una lista vacía.
    let w = Inyecta::instala(&core, 0, false);
    // (sin SQLite, el `inner` es StateJsonFile: records_events = false)
    core.mutate(|tx| {
        run_sin_eventos(tx, "b");
        tx.push_event(hecho(2));
        Ok(())
    })
    .unwrap();
    assert!(w.intentos().iter().all(|e| e.is_empty()), "StateJsonFile no recibe eventos: {:?}", w.intentos());
}

/// Mutación que cambia de verdad el estado y emite un borrador válido seguido de uno inválido
/// (clave de idempotencia vacía: solo la frontera final, `NewEvent::check`, la detecta).
fn con_un_borrador_invalido(tx: &mut Tx) -> Result<(), String> {
    run_sin_eventos(tx, "x");
    tx.push_event(hecho(1));
    tx.push_event(hecho(2).idempotent(""));
    Ok(())
}

#[test]
fn un_borrador_invalido_es_rechazado_tambien_con_state_json_sin_cambiar_nada() {
    let (_l, data, _core_dir) = dirs();
    let core = Orch::default().0; // persistencia state.json (legacy/degradado)
    core.mutate(|tx| {
        run_sin_eventos(tx, "previo");
        tx.push_event(hecho(0));
        Ok(())
    })
    .unwrap();
    let antes = std::fs::read(data.join("state.json")).unwrap();
    let r = core.mutate(con_un_borrador_invalido);
    assert!(matches!(&r, Err(MutateError::Rejected(m)) if m.contains("test.hecho") && m.contains("idem_key")), "{r:?}");
    assert_eq!(core.lock().runs.len(), 1, "la memoria no cambia");
    assert_eq!(std::fs::read(data.join("state.json")).unwrap(), antes, "state.json no recibe el cambio rechazado");
    assert_eq!(archivos(&data), vec!["state.json".to_string()], "ningún events.json");
    assert_eq!(core.health(), Health::Normal, "un contrato roto no degrada el Core");
}

#[test]
fn el_mismo_borrador_invalido_da_el_mismo_rejected_con_sqlite_y_con_state_json() {
    let (_l, _d, _c, sqlite) = core_listo();
    let r_sqlite = sqlite.mutate(con_un_borrador_invalido);
    let (_l2, _data2, _core_dir2) = dirs();
    let legacy = Orch::default().0;
    let r_legacy = legacy.mutate(con_un_borrador_invalido);
    assert!(matches!(r_sqlite, Err(MutateError::Rejected(_))), "{r_sqlite:?}");
    assert_eq!(r_sqlite, r_legacy, "la semántica de una mutación no depende del backend");
    assert!(sqlite.lock().runs.is_empty() && legacy.lock().runs.is_empty());
}

// ---------------------------------------------------------------------------------------------
// Arranque, reinicio y compatibilidad
// ---------------------------------------------------------------------------------------------

#[test]
fn las_migraciones_post_authority_se_aplican_en_el_arranque() {
    let (_l, _d, _c, core) = core_listo();
    let v = core.storage.with_store(|s| s.schema_version().unwrap()).unwrap();
    assert_eq!(v, (crate::store::cut_migration().version - 1), "el arranque autoritativo aplica TODAS las migraciones del binario");
    assert_eq!(core.storage.with_store(|s| s.events_head().unwrap()).unwrap(), 0);
}

#[test]
fn reiniciar_conserva_los_eventos_y_el_orden_continua() {
    let (_l, data, core_dir, core) = core_listo();
    core.mutate(|tx| {
        run_sin_eventos(tx, "a");
        tx.push_event(hecho(1));
        Ok(())
    })
    .unwrap();
    let antes = eventos(&core);
    suelta(core, &core_dir);
    let (core2, _h, res) = arranca(&data, &core_dir);
    res.unwrap();
    assert_eq!(eventos(&core2), antes, "los mismos eventos, con los mismos ids y seq");
    core2
        .mutate(|tx| {
            run_sin_eventos(tx, "b");
            tx.push_event(hecho(2));
            Ok(())
        })
        .unwrap();
    let evs = eventos(&core2);
    assert_eq!(evs.iter().map(|e| e.seq).collect::<Vec<_>>(), vec![antes[0].seq, antes[0].seq + 1]);
    // Al arrancar de nuevo se cierran las tareas huérfanas (otra mutación): la rev solo avanza.
    assert!(evs[1].state_rev.unwrap() > evs[0].state_rev.unwrap());
}

#[test]
fn un_estado_legacy_se_promueve_y_sigue_funcionando_sin_eventos_previos() {
    let (_l, data, core_dir) = dirs();
    legado_con(&data, "previa");
    let (core, _h, res) = arranca(&data, &core_dir);
    res.unwrap();
    assert!(titulos(&core).contains(&"previa".to_string()), "el estado legacy se cargó");
    assert!(eventos(&core).is_empty(), "no se inventa historia");
    let runs_antes = core.lock().runs.len();
    core.mutate(|tx| {
        run_sin_eventos(tx, "nueva");
        tx.push_event(hecho(1));
        Ok(())
    })
    .unwrap();
    assert_eq!(eventos(&core).len(), 1);
    assert_eq!(core.lock().runs.len(), runs_antes + 1, "y el estado legacy sigue mutándose normalmente");
}

#[test]
fn el_vocabulario_de_entidades_esta_definido() {
    let (_l, _d, _c, core) = core_listo();
    core.mutate(|tx| {
        for (i, k) in [EntityKind::Task, EntityKind::Run, EntityKind::Project, EntityKind::SpawnRequest, EntityKind::Core].into_iter().enumerate() {
            tx.push_event(EventDraft::new(k, format!("id{i}"), &Hecho { n: i as u32 }).unwrap());
        }
        Ok(())
    })
    .unwrap();
    let kinds: Vec<_> = eventos(&core).iter().map(|e| e.entity_kind.clone()).collect();
    assert_eq!(kinds, vec!["task", "run", "project", "spawn_request", "core"]);
}

// ---------------------------------------------------------------------------------------------
// Arquitectura: un único punto de emisión y un único escritor de la tabla
// ---------------------------------------------------------------------------------------------

/// Código de producción de un archivo (sin el módulo de pruebas) y sin comentarios de línea.
fn produccion(texto: &str) -> Vec<(usize, String)> {
    let prod = texto.split("mod tests {").next().unwrap().split("mod durable_tests {").next().unwrap();
    prod.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")).map(|(n, l)| (n + 1, l.to_string())).collect()
}

fn fuentes(dir: &Path) -> Vec<(String, String)> {
    let mut out = vec![];
    for entrada in std::fs::read_dir(dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        out.push((nombre, std::fs::read_to_string(&ruta).unwrap()));
    }
    out
}

#[test]
fn solo_store_events_escribe_en_la_tabla_y_solo_la_frontera_de_mutacion_emite() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    // (símbolo, archivos de `orch/` donde puede aparecer)
    let orch_permitido: [(&str, &[&str]); 9] = [
        // El único punto de emisión de estado son los mutadores semánticos de `Tx` (`tx_ops.rs`), que
        // llaman a `try_push_event`; nadie más empuja borradores a una transacción.
        (".push_event(", &[]),
        (".try_push_event(", &["tx_ops.rs"]),
        ("fn push_event(", &["mutation.rs"]),
        // Los borradores se finalizan en la frontera de mutación y, para lo que no vive en `State` (el registro de
        // proyectos y la Task como intención), en `project_ops.rs` y `task_ops.rs`, que entregan el `NewEvent` al almacén.
        ("finalize_all(", &["mutation.rs", "events.rs", "project_ops.rs", "task_ops.rs"]),
        // Solo el catálogo (`event_kinds.rs`) define contratos y construye borradores de dominio.
        ("impl EventPayload for", &["event_kinds.rs"]),
        ("EventDraft::new", &["events.rs", "event_kinds.rs"]),
        // Solo la persistencia de SQLite escribe eventos; nadie más de `orch/` toca el INSERT ni la inserción suelta.
        ("commit_authoritative_with_events", &["store_boot.rs"]),
        ("runtime_commit_recorded", &["store_boot.rs"]),
        ("append_events(", &["store_boot.rs"]),
    ];
    let mut revisados = 0;
    for (nombre, texto) in fuentes(&src.join("orch")) {
        for (n, l) in produccion(&texto) {
            for (simbolo, donde) in orch_permitido {
                assert!(
                    !l.contains(simbolo) || donde.contains(&nombre.as_str()),
                    "orch/{nombre}:{n}: «{simbolo}» solo puede aparecer en {donde:?}: los eventos tienen un único punto de emisión y un único escritor"
                );
            }
            assert!(!l.contains("INSERT INTO events") && !l.contains("INTO events"), "orch/{nombre}:{n}: orch no escribe SQL de eventos");
        }
        revisados += 1;
    }
    assert!(revisados >= 20, "revisó {revisados}");
    // En el almacén, solo `events.rs` inserta en la tabla.
    let mut con_insert = vec![];
    for (nombre, texto) in fuentes(&src.join("store")) {
        if produccion(&texto).iter().any(|(_, l)| l.contains("INSERT INTO events")) {
            con_insert.push(nombre);
        }
    }
    assert_eq!(con_insert, vec!["events.rs".to_string()], "`INSERT INTO events` solo en store/events.rs");
}

#[test]
fn el_estado_no_conoce_los_eventos() {
    // `State` es el documento autoritativo: no importa nada del Event Log ni lleva un outbox.
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("orch").join("state.rs");
    let texto = std::fs::read_to_string(src).unwrap();
    for (n, l) in produccion(&texto) {
        assert!(!l.contains("EventDraft") && !l.contains("outbox") && !l.contains("NewEvent"), "state.rs:{n}: el estado no transporta eventos: {l}");
    }
}

#[test]
fn rpc_desktop_persiste_client_id_en_eventos_de_run_create() {
    let (_l, _d, _c, core) = core_listo();
    let inicio = eventos(&core).len();
    let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();

    core.rpc_via(Channel::Ui, super::Caller::User, &cwd, "run_create", &serde_json::json!({"objective": "identidad desktop"})).unwrap();

    let nuevos = eventos(&core).into_iter().skip(inicio).collect::<Vec<_>>();
    assert!(!nuevos.is_empty(), "run_create debe producir eventos");
    let client_id = nuevos[0].client_id.as_deref().expect("la frontera Desktop debe asignar client_id");
    assert_ne!(client_id, CORE_CLIENT_ID, "Desktop no debe usar la identidad reservada del Core");
    assert!(nuevos.iter().all(|e| e.client_id.as_deref() == Some(client_id)), "los eventos de la acción comparten client_id");
    assert!(nuevos.iter().all(|e| e.channel.as_deref() == Some("ui")), "los eventos preservan el canal UI");
}

#[test]
fn decision_de_revision_desde_ui_persiste_client_id_autenticado() {
    let (_l, data, core_dir) = dirs();
    let (legacy_state, task, repo, _) = super::review::tests::setup("desktop-client-id");
    let legacy_core = Orch::default().0;
    *legacy_core.lock_unpersisted() = legacy_state.into_inner().unwrap();
    escribe_state_de(&legacy_core, &data);

    let (core, _host, started) = arranca(&data, &core_dir);
    started.unwrap();
    let head = super::review::branch_head(repo.to_str().unwrap(), "lx/t").unwrap();
    let before = eventos(&core).len();

    let outcome = core.review_from_ui(&task, "accepted", &head, None, true).unwrap();

    assert_eq!(outcome["outcome"], "recorded");
    let decision = eventos(&core)
        .into_iter()
        .skip(before)
        .find(|event| event.kind == "decision.recorded")
        .expect("la decisión aceptada emite decision.recorded");
    assert_eq!(decision.actor_kind.as_str(), "person");
    assert_eq!(decision.actor_id.as_deref(), Some("user"));
    assert_eq!(decision.channel.as_deref(), Some("ui"));
    assert!(decision.client_id.as_deref().is_some_and(|id| id != CORE_CLIENT_ID), "la acción humana lleva el client_id autenticado");
    let _ = std::fs::remove_dir_all(repo);
}
