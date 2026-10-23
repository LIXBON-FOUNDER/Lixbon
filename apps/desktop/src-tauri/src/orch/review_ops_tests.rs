//! LXO-118 · hechos de la revisión: contrato de `review.completed` y `review.invalidated` (target Attempt + HEAD, sin
//! el comentario), quién puede, vocabulario, Activity, que la proyección de Attention los ve y arquitectura.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::activity_format::item;
use super::attempt_ops;
use super::events::{Actor, Channel, MutationContext};
use super::review_ops::{invalidate, review};
use super::task_ops::{create_child, create_run};
use super::vocab::DURABLE_EVENT;
use crate::store::{
    embedded, ChangeOutcome, EventClass, EventProjector, EventQuery, EventRow, Fingerprint, NewAttempt, NewEvent, NewLocation, NewReview, NewRun, NewTaskIntent, Store, StoreError,
    StoreResult, Verdict, AGENTIC_MODEL, AGENTIC_MODEL_KEY,
};

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-reviewops-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

const X: &str = "c3c3c3c3";
const Y: &str = "d4d4d4d4";

fn persona() -> MutationContext {
    MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) }
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

fn hecho(w: &mut Mundo) -> String {
    let h = w.hija.clone();
    let new = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    let a = attempt_ops::create(&mut w.s, &persona(), &h, &new).unwrap();
    attempt_ops::start(&mut w.s, &MutationContext::core(), &a.id).unwrap();
    attempt_ops::finish(&mut w.s, &MutationContext::core(), &a.id, "").unwrap();
    a.id
}

fn nueva(verdict: Verdict, head: &str) -> NewReview {
    NewReview { verdict, head_commit: head.into(), base_commit: Some("b0b0b0".into()), comment: Some("COMENTARIO-PRIVADO".into()), actor: "human".into() }
}

fn eventos(s: &Store) -> Vec<EventRow> {
    s.events_page(&EventQuery { entity_kind: Some("review".into()), limit: Some(100), ..Default::default() }).unwrap().events
}

fn denegado<T: std::fmt::Debug>(r: StoreResult<T>) {
    match r {
        Err(StoreError::ReviewConflict(m)) => assert!(m.contains("no lo puede hacer"), "{m}"),
        otro => panic!("se esperaba una denegación: {otro:?}"),
    }
}

#[test]
fn los_hechos_apuntan_a_la_revision_y_nombran_attempt_y_head_sin_el_comentario() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let a1 = hecho(&mut w);
    let r1 = review(&mut w.s, &persona(), &a1, &nueva(Verdict::Accepted, X)).unwrap();
    let r2 = review(&mut w.s, &persona(), &a1, &nueva(Verdict::Accepted, X)).unwrap();
    assert_eq!(invalidate(&mut w.s, &MutationContext::core(), &a1, Y).unwrap(), ChangeOutcome::Changed);
    let ev = eventos(&w.s);
    let h = w.hija.clone();
    let resumen: Vec<(&str, EventClass, String)> = ev.iter().map(|e| (e.kind.as_str(), e.class, e.entity_id.clone())).collect();
    assert_eq!(
        resumen,
        [
            ("review.completed", EventClass::Decision, r1.decision_id.to_string()),
            ("review.completed", EventClass::Decision, r2.decision_id.to_string()),
            ("review.invalidated", EventClass::State, r2.decision_id.to_string()),
        ]
    );
    let p: Vec<Value> = ev.iter().map(|e| serde_json::from_str(&e.payload).unwrap()).collect();
    assert_eq!(p[0], json!({ "task": h, "attempt": a1, "n": 1, "verdict": "accepted", "head_commit": X, "base_commit": "b0b0b0", "has_comment": true }));
    assert_eq!(p[1]["supersedes"], r1.decision_id, "nombra la revisión que deja de valer");
    assert_eq!(p[2], json!({ "task": h, "attempt": a1, "n": 1, "head_commit": X, "observed_head": Y }));
    let task = w.s.task_row(&h).unwrap().unwrap();
    for e in &ev {
        assert!(!e.payload.contains("COMENTARIO"), "{}", e.payload);
        assert_eq!(e.run_id.as_deref(), Some(task.run_id.as_str()));
    }
}

#[test]
fn revisar_lo_hace_una_persona_e_invalidar_tambien_el_core() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let a = hecho(&mut w);
    let (h, r) = (w.hija.clone(), w.raiz.clone());
    for ctx in [MutationContext::core(), MutationContext::agent(&h, Channel::Lxo), MutationContext::agent(&r, Channel::Lxo)] {
        denegado(review(&mut w.s, &ctx, &a, &nueva(Verdict::Accepted, X)));
    }
    review(&mut w.s, &persona(), &a, &nueva(Verdict::Accepted, X)).unwrap();
    denegado(invalidate(&mut w.s, &MutationContext::agent(&h, Channel::Lxo), &a, Y));
    assert_eq!(eventos(&w.s).len(), 1);
    assert_eq!(invalidate(&mut w.s, &persona(), &a, Y).unwrap(), ChangeOutcome::Changed);
}

#[test]
fn activity_pinta_los_hechos_de_revision_sin_respaldo() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let a = hecho(&mut w);
    review(&mut w.s, &persona(), &a, &nueva(Verdict::Rejected, X)).unwrap();
    review(&mut w.s, &persona(), &a, &nueva(Verdict::Accepted, X)).unwrap();
    invalidate(&mut w.s, &MutationContext::core(), &a, Y).unwrap();
    let items: Vec<Value> = eventos(&w.s).iter().map(item).collect();
    let claves: Vec<&str> = items.iter().map(|i| i["message_key"].as_str().unwrap()).collect();
    assert_eq!(claves, ["activity.review.rejected", "activity.review.accepted", "activity.review.invalidated"]);
    assert!(items.iter().all(|i| i["fallback"] == false));
    assert_eq!(items[0]["target"]["kind"], "review");
    assert!(!items.iter().any(|i| i.to_string().contains("COMENTARIO")));
}

#[derive(Debug, Default)]
struct Cuenta(AtomicUsize, std::sync::Mutex<Vec<String>>);

#[derive(Debug)]
struct Proyector(Arc<Cuenta>);

impl EventProjector for Proyector {
    fn project(&self, _tx: &rusqlite::Transaction<'_>, events: &[EventRow]) -> StoreResult<Vec<NewEvent>> {
        self.0 .0.fetch_add(events.len(), Ordering::SeqCst);
        self.0 .1.lock().unwrap().extend(events.iter().map(|e| format!("{}:{}", e.entity_kind, e.payload)));
        Ok(vec![])
    }
}

#[test]
fn la_proyeccion_de_attention_ve_cada_hecho_con_su_attempt() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let a = hecho(&mut w);
    let cuenta = Arc::new(Cuenta::default());
    w.s.set_event_projector(Arc::new(Proyector(cuenta.clone())));
    review(&mut w.s, &persona(), &a, &nueva(Verdict::Accepted, X)).unwrap();
    invalidate(&mut w.s, &MutationContext::core(), &a, Y).unwrap();
    assert_eq!(cuenta.0.load(Ordering::SeqCst), 2);
    assert!(cuenta.1.lock().unwrap().iter().all(|e| e.starts_with("review:") && e.contains(&format!("\"attempt\":\"{a}\""))));
}

#[test]
fn el_vocabulario_reserva_los_hechos_de_revision() {
    for k in ["review.completed", "review.invalidated"] {
        assert!(DURABLE_EVENT.contains(&k), "{k}");
    }
}

#[test]
fn antes_del_corte_review_ops_no_escribe_nada_y_solo_review_ops_conduce_las_revisiones() {
    let t = Tmp::new();
    let mut s = Store::open_with(t.path(), &embedded(), "t").unwrap();
    assert!(matches!(review(&mut s, &persona(), "t1-a1", &nueva(Verdict::Accepted, X)), Err(StoreError::AgenticModelInactive)));
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entrada in std::fs::read_dir(src.join("orch")).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        for sim in ["review_completed(", "review_invalidated("] {
            assert!(!texto.contains(sim) || ["event_kinds.rs", "review_ops.rs"].contains(&nombre.as_str()), "orch/{nombre}: «{sim}»");
        }
        for sim in [".review_record_recorded(", ".review_invalidate_recorded("] {
            assert!(!texto.contains(sim) || nombre == "review_ops.rs", "orch/{nombre}: «{sim}»");
        }
    }
    for entrada in std::fs::read_dir(src.join("store")).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre.ends_with("_tests.rs") || nombre == "reviews.rs" {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        assert!(!texto.contains("INTO reviews ") && !texto.contains("UPDATE reviews ") && !texto.contains("INTO decisions "), "store/{nombre} escribe revisiones");
    }
}
