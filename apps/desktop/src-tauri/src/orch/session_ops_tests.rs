//! LXO-115 · hechos de ProviderSession y Thread: contrato de sus Events (sin la referencia del proveedor ni el
//! resumen), quién puede hacer cada cosa, vocabulario reservado y cómo los pinta Activity. El almacén se prueba en
//! `store/sessions_tests.rs`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use super::activity_format::item;
use super::attempt_ops;
use super::events::{Actor, Channel, MutationContext};
use super::session_ops::{bind, close, detach, open, open_thread, resume, summarize};
use super::task_ops::{create_child, create_run};
use super::vocab::{DURABLE_EVENT, ENTITY_KIND};
use crate::store::{
    embedded, ActorKind, ChangeOutcome, EventClass, EventQuery, EventRow, Fingerprint, NewAttempt, NewLocation, NewProviderSession, NewRun, NewTaskIntent, SessionBinding, Store,
    StoreError, StoreResult, AGENTIC_MODEL, AGENTIC_MODEL_KEY,
};

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-sessionops-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const REF: &str = "REF-OPACA-6f1c2a9e-0b7d-4d1e";
const RESUMEN: &str = "RESUMEN-PRIVADO del Thread";

fn persona() -> MutationContext {
    MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) }
}

fn core() -> MutationContext {
    MutationContext::core()
}

struct Mundo {
    s: Store,
    raiz: String,
    hija: String,
}

fn mundo(dir: &Path) -> Mundo {
    let mut s = Store::open_with(dir, &embedded(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (_, raiz) = create_run(&mut s, &persona(), &NewRun { objective: "login".into(), project_id: project, root: intencion("coordinar") }).unwrap();
    let hija = create_child(&mut s, &persona(), &raiz.id, &intencion("api")).unwrap();
    Mundo { s, raiz: raiz.id, hija: hija.id }
}

fn corre(w: &mut Mundo, task: &str) -> String {
    let new = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    let a = attempt_ops::create(&mut w.s, &persona(), task, &new).unwrap();
    attempt_ops::start(&mut w.s, &core(), &a.id).unwrap();
    a.id
}

fn eventos(s: &Store) -> Vec<EventRow> {
    s.events_page(&EventQuery { limit: Some(500), ..Default::default() }).unwrap().events.into_iter().filter(|e| e.entity_kind == "provider_session" || e.entity_kind == "thread").collect()
}

fn payload(e: &EventRow) -> Value {
    serde_json::from_str(&e.payload).unwrap()
}

fn denegado<T: std::fmt::Debug>(r: StoreResult<T>) {
    match r {
        Err(StoreError::SessionConflict(m)) => assert!(m.contains("no lo puede hacer"), "{m}"),
        otro => panic!("se esperaba una denegación: {otro:?}"),
    }
}

/// El ciclo completo: abrir sin referencia, fijarla, dejar en espera, reanudar en el seguimiento, cerrar; y el
/// Thread con su resumen.
fn ciclo(w: &mut Mundo) -> (String, String, String, String) {
    let h = w.hija.clone();
    let a1 = corre(w, &h);
    let s = open(&mut w.s, &core(), &a1, &NewProviderSession { resumable: true, external_ref: None }).unwrap();
    assert_eq!(bind(&mut w.s, &core(), &s.id, REF, SessionBinding::StreamJson).unwrap(), ChangeOutcome::Changed);
    attempt_ops::finish(&mut w.s, &core(), &a1, "").unwrap();
    assert_eq!(detach(&mut w.s, &core(), &s.id).unwrap(), ChangeOutcome::Changed);
    let a2 = corre(w, &h);
    assert_eq!(resume(&mut w.s, &core(), &s.id, &a2).unwrap(), ChangeOutcome::Changed);
    assert_eq!(close(&mut w.s, &persona(), &s.id).unwrap(), ChangeOutcome::Changed);
    let th = open_thread(&mut w.s, &core(), &h).unwrap();
    assert_eq!(summarize(&mut w.s, &core(), &th.id, Some(RESUMEN)).unwrap(), ChangeOutcome::Changed);
    (a1, a2, s.id, th.id)
}

#[test]
fn cada_mutador_deja_su_evento_sin_la_referencia_ni_el_resumen() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (a1, a2, ps, th) = ciclo(&mut w);
    let h = w.hija.clone();
    let ev = eventos(&w.s);
    let resumen: Vec<(&str, i64, EventClass, &str)> = ev.iter().map(|e| (e.kind.as_str(), e.v, e.class, e.entity_id.as_str())).collect();
    assert_eq!(
        resumen,
        [
            ("provider_session.opened", 1, EventClass::State, ps.as_str()),
            ("provider_session.bound", 1, EventClass::State, ps.as_str()),
            ("provider_session.detached", 1, EventClass::State, ps.as_str()),
            ("provider_session.resumed", 1, EventClass::State, ps.as_str()),
            ("provider_session.closed", 1, EventClass::State, ps.as_str()),
            ("thread.created", 1, EventClass::State, th.as_str()),
            ("thread.summarized", 1, EventClass::State, th.as_str()),
        ]
    );
    let p: Vec<Value> = ev.iter().map(payload).collect();
    assert_eq!(p[0], json!({ "task": h, "attempt": a1, "n": 1, "provider": "claude", "resumable": true, "bound": false }));
    assert_eq!(p[1], json!({ "task": h, "binding": "stream_json" }));
    assert_eq!(p[2], json!({ "task": h }));
    assert_eq!(p[3], json!({ "task": h, "attempt": a2, "n": 2 }));
    assert_eq!(p[4], json!({ "task": h, "from": "open" }));
    assert_eq!(p[5], json!({ "task": h }));
    assert_eq!(p[6], json!({ "task": h, "has_summary": true }));
    let t = w.s.task_row(&h).unwrap().unwrap();
    for e in &ev {
        assert_eq!((e.run_id.as_deref(), e.project_id.as_deref()), (Some(t.run_id.as_str()), t.project_id.as_deref()), "{}", e.kind);
        assert!(!e.payload.contains("REF-OPACA") && !e.payload.contains("RESUMEN-PRIVADO"), "{}: {}", e.kind, e.payload);
    }
    assert_eq!(ev[4].actor_kind, ActorKind::Person, "cerrar lo puede pedir una persona");
}

#[test]
fn solo_el_core_conduce_la_sesion_y_el_thread_y_una_persona_puede_cerrar() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (h, r) = (w.hija.clone(), w.raiz.clone());
    let a = corre(&mut w, &h);
    let agente = MutationContext::agent(&h, Channel::Lxo);
    let coordinador = MutationContext::agent(&r, Channel::Lxo);
    let nueva = NewProviderSession { resumable: true, external_ref: None };
    for ctx in [&persona(), &agente, &coordinador] {
        denegado(open(&mut w.s, ctx, &a, &nueva));
        denegado(open_thread(&mut w.s, ctx, &h));
    }
    let s = open(&mut w.s, &core(), &a, &nueva).unwrap();
    let th = open_thread(&mut w.s, &core(), &h).unwrap();
    for ctx in [&persona(), &agente] {
        denegado(bind(&mut w.s, ctx, &s.id, REF, SessionBinding::SessionId));
        denegado(detach(&mut w.s, ctx, &s.id));
        denegado(resume(&mut w.s, ctx, &s.id, &a));
        denegado(summarize(&mut w.s, ctx, &th.id, Some("x")));
    }
    denegado(close(&mut w.s, &agente, &s.id));
    assert_eq!(eventos(&w.s).len(), 2, "las denegaciones no dejan rastro");
    assert_eq!(close(&mut w.s, &persona(), &s.id).unwrap(), ChangeOutcome::Changed);
}

#[test]
fn el_vocabulario_reserva_las_entidades_y_sus_hechos() {
    assert!(ENTITY_KIND.contains(&"provider_session") && ENTITY_KIND.contains(&"thread"));
    let fuente = include_str!("event_kinds.rs");
    let marca = "const KIND: &'static str = \"";
    let kinds: BTreeSet<&str> = fuente
        .match_indices(marca)
        .filter_map(|(i, _)| fuente[i + marca.len()..].split('"').next())
        .filter(|k| k.starts_with("provider_session.") || k.starts_with("thread."))
        .collect();
    assert_eq!(kinds.len(), 7, "{kinds:?}");
    for k in kinds {
        assert!(DURABLE_EVENT.contains(&k), "{k} no está reservado en contracts/status-vocabulary.json");
    }
}

#[test]
fn activity_pinta_cada_hecho_sin_respaldo_ni_datos_privados() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (_, _, ps, th) = ciclo(&mut w);
    let items: Vec<Value> = eventos(&w.s).iter().map(item).collect();
    let claves: Vec<&str> = items.iter().map(|i| i["message_key"].as_str().unwrap()).collect();
    assert_eq!(
        claves,
        [
            "activity.provider_session.opened",
            "activity.provider_session.bound",
            "activity.provider_session.detached",
            "activity.provider_session.resumed",
            "activity.provider_session.closed",
            "activity.thread.created",
            "activity.thread.summarized",
        ]
    );
    assert!(items.iter().all(|i| i["fallback"] == false), "{items:#?}");
    assert_eq!(items[0]["target"], json!({ "kind": "provider_session", "id": ps }));
    assert_eq!(items[5]["target"], json!({ "kind": "thread", "id": th }));
    for i in &items {
        let s = i.to_string();
        assert!(!s.contains("REF-OPACA") && !s.contains("RESUMEN-PRIVADO"), "{s}");
    }
    // Un vínculo fuera del conjunto cerrado (`cwd_time`) no se copia: cae al respaldo.
    let mut mala = eventos(&w.s).remove(1);
    mala.payload = json!({ "task": w.hija, "binding": "cwd_time" }).to_string();
    assert_eq!(item(&mala)["fallback"], true);
}

#[test]
fn antes_del_corte_session_ops_no_escribe_nada() {
    let t = Tmp::new();
    let mut s = Store::open_with(t.path(), &embedded(), "t").unwrap();
    assert!(matches!(open(&mut s, &core(), "t1-a1", &NewProviderSession { resumable: false, external_ref: None }), Err(StoreError::AgenticModelInactive)));
    assert!(matches!(open_thread(&mut s, &core(), "t1"), Err(StoreError::AgenticModelInactive)));
    assert!(eventos(&s).is_empty());
}

#[test]
fn solo_session_ops_construye_los_hechos_y_solo_store_sessions_escribe_sus_tablas() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let constructores = ["provider_session_opened(", "provider_session_bound(", "provider_session_resumed(", "provider_session_detached(", "provider_session_closed(", "thread_created(", "thread_summarized("];
    let mutadores = [".provider_session_open_recorded(", ".provider_session_bind_recorded(", ".provider_session_resume_recorded(", ".provider_session_transition_recorded(", ".thread_open_recorded(", ".thread_summary_set_recorded("];
    for entrada in std::fs::read_dir(src.join("orch")).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        for (n, l) in texto.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")) {
            for sim in constructores {
                assert!(!l.contains(sim) || ["event_kinds.rs", "session_ops.rs"].contains(&nombre.as_str()), "orch/{nombre}:{}: «{sim}» solo en session_ops", n + 1);
            }
            for sim in mutadores {
                assert!(!l.contains(sim) || nombre == "session_ops.rs", "orch/{nombre}:{}: «{sim}» solo en session_ops", n + 1);
            }
        }
    }
    for entrada in std::fs::read_dir(src.join("store")).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre.ends_with("_tests.rs") || nombre == "sessions.rs" {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        for tabla in ["provider_sessions", "threads", "thread_messages"] {
            for q in [format!("INTO {tabla} "), format!("UPDATE {tabla} ")] {
                assert!(!texto.contains(&q), "store/{nombre} escribe {tabla}");
            }
        }
    }
}
