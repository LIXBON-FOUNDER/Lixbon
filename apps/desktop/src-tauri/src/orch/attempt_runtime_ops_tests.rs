//! LXO-231 · hechos nuevos del Attempt (esperas, vuelta, salida e integración): contrato de los eventos, quién puede,
//! Activity y la Attention de la aprobación en la terminal sobre el Attempt.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use super::activity_format::item;
use super::attempt_ops::{await_terminal, create, exit, finish, integrate, resume, start, wait};
use super::attention_rules::derive;
use super::events::{Actor, Channel, MutationContext};
use super::task_ops::{create_child, create_run};
use super::vocab::DURABLE_EVENT;
use crate::store::{
    embedded, ChangeOutcome, EventQuery, EventRow, Fingerprint, Intent, NewAttempt, NewLocation, NewRun, NewTaskIntent, Store, StoreError, StoreResult,
    AGENTIC_MODEL, AGENTIC_MODEL_KEY,
};

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-runtimeops-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

fn persona() -> MutationContext {
    MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) }
}

fn core() -> MutationContext {
    MutationContext::core()
}

fn mundo(dir: &Path) -> (Store, String) {
    let mut s = Store::open_with(dir, &embedded(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (_, raiz) = create_run(&mut s, &persona(), &NewRun { objective: "login".into(), project_id: project, root: intencion("coordinar") }).unwrap();
    let hija = create_child(&mut s, &persona(), &raiz.id, &intencion("api")).unwrap();
    (s, hija.id)
}

fn nuevo() -> NewAttempt {
    NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false }
}

fn eventos(s: &Store) -> Vec<EventRow> {
    s.events_page(&EventQuery { entity_kind: Some("attempt".into()), limit: Some(100), ..Default::default() }).unwrap().events
}

fn denegado<T: std::fmt::Debug>(r: StoreResult<T>) {
    match r {
        Err(StoreError::AttemptConflict(m)) => assert!(m.contains("no lo puede hacer"), "{m}"),
        otro => panic!("se esperaba una denegación: {otro:?}"),
    }
}

#[test]
fn cada_hecho_nuevo_lleva_el_estado_del_que_venia() {
    let t = Tmp::new();
    let (mut s, h) = mundo(t.path());
    let agente = MutationContext::agent(&h, Channel::Lxo);
    let a = create(&mut s, &persona(), &h, &nuevo()).unwrap();
    start(&mut s, &core(), &a.id).unwrap();
    wait(&mut s, &agente, &a.id).unwrap();
    resume(&mut s, &agente, &a.id).unwrap();
    await_terminal(&mut s, &core(), &a.id).unwrap();
    resume(&mut s, &core(), &a.id).unwrap();
    finish(&mut s, &core(), &a.id, "").unwrap();
    assert_eq!(integrate(&mut s, &core(), &a.id).unwrap(), ChangeOutcome::Changed);
    let b = create(&mut s, &persona(), &h, &nuevo()).unwrap();
    start(&mut s, &core(), &b.id).unwrap();
    exit(&mut s, &core(), &b.id).unwrap();
    let ev = eventos(&s);
    let hechos: Vec<(String, Value)> = ev.iter().map(|e| (e.kind.clone(), serde_json::from_str(&e.payload).unwrap())).filter(|(k, _)| !matches!(k.as_str(), "attempt.requested" | "attempt.started" | "attempt.completed")).collect();
    assert_eq!(
        hechos,
        [
            ("attempt.waiting".into(), json!({ "task": h, "n": 1, "state": "waiting", "from": "running" })),
            ("attempt.resumed".into(), json!({ "task": h, "n": 1, "from": "waiting" })),
            ("attempt.waiting".into(), json!({ "task": h, "n": 1, "state": "awaiting_terminal_approval", "from": "running" })),
            ("attempt.resumed".into(), json!({ "task": h, "n": 1, "from": "awaiting_terminal_approval" })),
            ("attempt.integrated".into(), json!({ "task": h, "n": 1 })),
            ("attempt.exited".into(), json!({ "task": h, "n": 2, "from": "running" })),
        ]
    );
    for k in ["attempt.waiting", "attempt.resumed", "attempt.exited", "attempt.integrated"] {
        assert!(DURABLE_EVENT.contains(&k), "{k} reservado");
    }
    let items: Vec<Value> = ev.iter().map(item).collect();
    assert!(items.iter().all(|i| i["fallback"] == false), "{items:#?}");
    assert!(items.iter().any(|i| i["message_key"] == "activity.attempt.awaiting_terminal_approval"));
}

#[test]
fn quien_puede_esperar_volver_salir_e_integrar() {
    let t = Tmp::new();
    let (mut s, h) = mundo(t.path());
    let a = create(&mut s, &persona(), &h, &nuevo()).unwrap();
    start(&mut s, &core(), &a.id).unwrap();
    let otro = MutationContext::agent("t999", Channel::Lxo);
    denegado(wait(&mut s, &persona(), &a.id));
    denegado(wait(&mut s, &otro, &a.id));
    denegado(await_terminal(&mut s, &MutationContext::agent(&h, Channel::Lxo), &a.id));
    denegado(exit(&mut s, &persona(), &a.id));
    finish(&mut s, &core(), &a.id, "").unwrap();
    denegado(integrate(&mut s, &persona(), &a.id));
}

#[test]
fn la_aprobacion_en_la_terminal_es_attention_del_attempt_y_se_resuelve_al_volver_o_al_terminar() {
    let t = Tmp::new();
    let (mut s, h) = mundo(t.path());
    let a = create(&mut s, &persona(), &h, &nuevo()).unwrap();
    start(&mut s, &core(), &a.id).unwrap();
    await_terminal(&mut s, &core(), &a.id).unwrap();
    resume(&mut s, &core(), &a.id).unwrap();
    await_terminal(&mut s, &core(), &a.id).unwrap();
    exit(&mut s, &core(), &a.id).unwrap();
    let derivados: Vec<String> = eventos(&s)
        .iter()
        .flat_map(|e| derive(e).intents.into_iter().map(move |i| format!("{}:{}", e.kind, describe(&i))))
        .collect();
    assert_eq!(
        derivados,
        [
            "attempt.waiting:raise approval attempt terminal",
            "attempt.resumed:resolve approval attempt terminal",
            // La espera levantada sobre la Task antes del corte se resuelve igual (D10, LXO-233).
            "attempt.resumed:resolve approval task terminal",
            "attempt.waiting:raise approval attempt terminal",
            "attempt.exited:resolve approval attempt terminal",
            "attempt.exited:resolve approval task terminal",
        ]
    );
}

fn describe(i: &Intent) -> String {
    match i {
        Intent::Raise { key, .. } => format!("raise {} {} {}", key.category.as_str(), key.target.kind.as_str(), key.subject.as_deref().unwrap_or("")),
        Intent::Resolve { key, .. } => format!("resolve {} {} {}", key.category.as_str(), key.target.kind.as_str(), key.subject.as_deref().unwrap_or("")),
        otro => format!("{otro:?}"),
    }
}
