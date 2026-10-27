//! LXO-114 · hechos del Attempt: contrato de sus Events, quién puede hacer cada cosa, que cuadran con el vocabulario
//! reservado y cómo los pinta Activity. El almacén (filas, ciclo de vida, atomicidad) se prueba en
//! `store/attempts_tests.rs`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::activity_format::item;
use super::attempt_ops::{approve, cancel, create, fail, finish, start};
use super::event_kinds::{FailureCode, StopCause};
use super::events::{Channel, MutationContext};
use super::task_ops::{create_child, create_run};
use super::vocab::{ATTEMPT_STATE, DURABLE_EVENT, ENTITY_KIND};
use crate::store::{
    embedded, ActorKind, AttemptStatus, ChangeOutcome, EventClass, EventProjector, EventQuery, EventRow, Fingerprint, NewAttempt, NewEvent, NewLocation, NewRun, NewTaskIntent, Store,
    StoreError, StoreResult, TaskRow, AGENTIC_MODEL, AGENTIC_MODEL_KEY,
};

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-attemptops-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

const RESUMEN: &str = "RESUMEN-SECRETO: no viaja en ningún evento";

fn persona() -> MutationContext {
    MutationContext { actor: super::events::Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) }
}

fn agente(task: &str) -> MutationContext {
    MutationContext::agent(task, Channel::Lxo)
}

fn nuevo(approval: bool) -> NewAttempt {
    NewAttempt { provider: "claude".into(), model: Some("claude-opus-5-5".into()), effort: Some("high".into()), role: Some("implementador".into()), profile: Some("implementar".into()), external: false, requires_approval: approval }
}

/// Almacén con el corte hecho, un Project, un Run con su raíz y dos hijas hermanas.
struct Mundo {
    s: Store,
    project: String,
    raiz: TaskRow,
    hija: TaskRow,
    hermana: TaskRow,
}

fn mundo(dir: &Path) -> Mundo {
    let mut s = Store::open_with(dir, &embedded(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (_, raiz) = create_run(&mut s, &persona(), &NewRun { objective: "login".into(), project_id: project.clone(), root: intencion("coordinar") }).unwrap();
    let hija = create_child(&mut s, &persona(), &raiz.id, &intencion("api")).unwrap();
    let hermana = create_child(&mut s, &persona(), &raiz.id, &intencion("ui")).unwrap();
    Mundo { s, project, raiz, hija, hermana }
}

fn eventos(s: &Store) -> Vec<EventRow> {
    s.events_page(&EventQuery { limit: Some(500), ..Default::default() }).unwrap().events
}

fn de_attempts(s: &Store) -> Vec<EventRow> {
    eventos(s).into_iter().filter(|e| e.entity_kind == "attempt").collect()
}

fn payload(e: &EventRow) -> Value {
    serde_json::from_str(&e.payload).unwrap()
}

fn denegado<T: std::fmt::Debug>(r: StoreResult<T>) {
    match r {
        Err(StoreError::AttemptConflict(m)) => assert!(m.contains("no lo puede hacer"), "{m}"),
        otro => panic!("se esperaba una denegación: {otro:?}"),
    }
}

#[test]
fn cada_mutador_deja_su_evento_con_el_contrato_y_sin_el_resumen() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (h, r) = (w.hija.id.clone(), w.raiz.id.clone());
    let a1 = create(&mut w.s, &persona(), &h, &nuevo(true)).unwrap();
    approve(&mut w.s, &persona(), &a1.id).unwrap();
    start(&mut w.s, &MutationContext::core(), &a1.id).unwrap();
    finish(&mut w.s, &agente(&h), &a1.id, RESUMEN).unwrap();
    // Retry: lo pide quien coordina la Task.
    let a2 = create(&mut w.s, &agente(&r), &h, &nuevo(false)).unwrap();
    fail(&mut w.s, &MutationContext::core(), &a2.id, FailureCode::LaunchFailed, "").unwrap();
    let a3 = create(&mut w.s, &persona(), &h, &nuevo(false)).unwrap();
    cancel(&mut w.s, &persona(), &a3.id, StopCause::Cancelled).unwrap();
    let a4 = create(&mut w.s, &persona(), &h, &nuevo(true)).unwrap();
    cancel(&mut w.s, &MutationContext::core(), &a4.id, StopCause::RunClosed).unwrap();

    let ev = de_attempts(&w.s);
    let resumen: Vec<(&str, i64, EventClass, &str)> = ev.iter().map(|e| (e.kind.as_str(), e.v, e.class, e.entity_id.as_str())).collect();
    assert_eq!(
        resumen,
        [
            ("attempt.requested", 1, EventClass::State, a1.id.as_str()),
            ("attempt.approved", 1, EventClass::Decision, a1.id.as_str()),
            ("attempt.started", 1, EventClass::State, a1.id.as_str()),
            ("attempt.completed", 1, EventClass::State, a1.id.as_str()),
            ("attempt.requested", 1, EventClass::State, a2.id.as_str()),
            ("attempt.failed", 1, EventClass::State, a2.id.as_str()),
            ("attempt.requested", 1, EventClass::State, a3.id.as_str()),
            ("attempt.stopped", 1, EventClass::State, a3.id.as_str()),
            ("attempt.requested", 1, EventClass::State, a4.id.as_str()),
            ("attempt.rejected", 1, EventClass::Decision, a4.id.as_str()),
        ]
    );
    for e in &ev {
        assert_eq!((e.project_id.as_deref(), e.run_id.as_deref(), e.entity_kind.as_str()), (Some(w.project.as_str()), Some(w.hija.run_id.as_str()), "attempt"));
        assert!(!e.payload.contains("RESUMEN-SECRETO"), "{}: {}", e.kind, e.payload);
    }
    assert_eq!(
        payload(&ev[0]),
        json!({ "task": h, "n": 1, "provider": "claude", "model": "claude-opus-5-5", "effort": "high", "role": "implementador", "profile": "implementar", "external": false, "approval_required": true })
    );
    assert_eq!(payload(&ev[1]), json!({ "task": h, "n": 1 }));
    assert_eq!(payload(&ev[2]), json!({ "task": h, "n": 1 }));
    assert_eq!(payload(&ev[3]), json!({ "task": h, "n": 1, "has_summary": true }));
    assert_eq!(payload(&ev[4])["approval_required"], false);
    assert_eq!(payload(&ev[5]), json!({ "task": h, "n": 2, "reason": "launch_failed", "has_summary": false }));
    assert_eq!(payload(&ev[7]), json!({ "task": h, "n": 3, "from": "starting", "cause": "cancelled" }));
    assert_eq!(payload(&ev[9]), json!({ "task": h, "n": 4, "cause": "run_closed" }), "cancelar lo pendiente es rechazarlo");
    // Quién y por dónde.
    let quien = |i: usize| (ev[i].actor_kind, ev[i].actor_id.clone(), ev[i].channel.clone());
    assert_eq!(quien(0), (ActorKind::Person, Some("ana".into()), Some("ui".into())));
    assert_eq!(quien(1), (ActorKind::Person, Some("ana".into()), Some("ui".into())));
    assert_eq!(quien(2).0, ActorKind::System);
    assert_eq!(quien(3), (ActorKind::Agent, Some(h.clone()), Some("lxo".into())));
    assert_eq!(quien(4), (ActorKind::Agent, Some(r.clone()), Some("lxo".into())), "el retry lo pidió el coordinador");
    assert_eq!(quien(9).0, ActorKind::System);
    // La historia sigue entera.
    assert_eq!(w.s.attempts_of_task(&h).unwrap().iter().map(|a| a.status).collect::<Vec<_>>(), [AttemptStatus::Done, AttemptStatus::Failed, AttemptStatus::Stopped, AttemptStatus::Stopped]);
}

#[test]
fn el_evento_dice_si_hubo_resumen_y_si_el_coordinador_es_externo() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (h, r) = (w.hija.id.clone(), w.raiz.id.clone());
    let a = create(&mut w.s, &persona(), &h, &nuevo(false)).unwrap();
    start(&mut w.s, &MutationContext::core(), &a.id).unwrap();
    finish(&mut w.s, &MutationContext::core(), &a.id, "").unwrap();
    assert_eq!(payload(de_attempts(&w.s).last().unwrap()), json!({ "task": h, "n": 1, "has_summary": false }));
    let b = create(&mut w.s, &persona(), &h, &nuevo(false)).unwrap();
    start(&mut w.s, &MutationContext::core(), &b.id).unwrap();
    fail(&mut w.s, &MutationContext::core(), &b.id, FailureCode::AgentReported, RESUMEN).unwrap();
    assert_eq!(payload(de_attempts(&w.s).last().unwrap())["has_summary"], true);
    assert_eq!(w.s.attempt_row(&b.id).unwrap().unwrap().failure_reason.as_deref(), Some("agent_reported"));
    let externo = NewAttempt { external: true, ..nuevo(false) };
    create(&mut w.s, &persona(), &r, &externo).unwrap();
    assert_eq!(payload(de_attempts(&w.s).last().unwrap())["external"], true);
}

#[test]
fn la_matriz_de_permisos() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (raiz, hermana) = (w.raiz.id.clone(), w.hermana.id.clone());
    let intencion = NewTaskIntent { title: "x".into(), spec: String::new(), repo: "c:/app".into() };

    // Prepara una Task nueva con un Attempt en la etapa pedida y devuelve (task, attempt).
    #[derive(Clone, Copy)]
    enum Etapa {
        SinAttempt,
        Pendiente,
        Arrancando,
        Corriendo,
    }
    let mut preparar = |w: &mut Mundo, etapa: Etapa| -> (String, String) {
        let task = create_child(&mut w.s, &persona(), &raiz, &intencion).unwrap().id;
        let id = match etapa {
            Etapa::SinAttempt => String::new(),
            Etapa::Pendiente => create(&mut w.s, &persona(), &task, &nuevo(true)).unwrap().id,
            Etapa::Arrancando => create(&mut w.s, &persona(), &task, &nuevo(false)).unwrap().id,
            Etapa::Corriendo => {
                let a = create(&mut w.s, &persona(), &task, &nuevo(false)).unwrap();
                start(&mut w.s, &MutationContext::core(), &a.id).unwrap();
                a.id
            }
        };
        (task, id)
    };

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Quien {
        Persona,
        SinCredencial,
        Propio,
        Coordinador,
        Hermano,
        Core,
    }
    use Quien::*;
    let ctx = |q: Quien, task: &str| match q {
        Persona => persona(),
        // Una cuenta sin la credencial de cliente verificada no es una persona para el Core.
        SinCredencial => MutationContext { actor: super::events::Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: None },
        Propio => agente(task),
        Coordinador => agente(&raiz),
        Hermano => agente(&hermana),
        Core => MutationContext::core(),
    };
    let todos = [Persona, SinCredencial, Propio, Coordinador, Hermano, Core];

    type Op = (&'static str, Etapa, &'static [Quien]);
    let ops: [Op; 6] = [
        ("create", Etapa::SinAttempt, &[Persona, Propio, Coordinador]),
        ("approve", Etapa::Pendiente, &[Persona]),
        ("start", Etapa::Arrancando, &[Core]),
        ("finish", Etapa::Corriendo, &[Propio, Core]),
        ("fail", Etapa::Corriendo, &[Propio, Core]),
        ("cancel", Etapa::Corriendo, &[Persona, Propio, Coordinador, Core]),
    ];
    for (op, etapa, permitidos) in ops {
        for quien in todos {
            let (task, id) = preparar(&mut w, etapa);
            let c = ctx(quien, &task);
            let antes = (eventos(&w.s).len(), w.s.attempts_of_task(&task).unwrap());
            let resultado: StoreResult<()> = match op {
                "create" => create(&mut w.s, &c, &task, &nuevo(false)).map(|_| ()),
                "approve" => approve(&mut w.s, &c, &id).map(|_| ()),
                "start" => start(&mut w.s, &c, &id).map(|_| ()),
                "finish" => finish(&mut w.s, &c, &id, "ok").map(|_| ()),
                "fail" => fail(&mut w.s, &c, &id, FailureCode::AgentReported, "").map(|_| ()),
                "cancel" => cancel(&mut w.s, &c, &id, StopCause::Cancelled).map(|_| ()),
                otro => unreachable!("{otro}"),
            };
            if permitidos.contains(&quien) {
                resultado.unwrap_or_else(|e| panic!("{op} por {quien:?} debería poder: {e}"));
                assert_eq!(eventos(&w.s).len(), antes.0 + 1, "{op} por {quien:?}: exactamente un evento");
            } else {
                denegado(resultado);
                assert_eq!((eventos(&w.s).len(), w.s.attempts_of_task(&task).unwrap()), antes, "{op} por {quien:?}: una denegación no escribe nada");
            }
        }
    }
    // Un Attempt que no existe no es una denegación sino `Missing`, y no se filtra su existencia a quien no puede.
    assert_eq!(finish(&mut w.s, &agente(&raiz), "t999-a1", "ok").unwrap(), ChangeOutcome::Missing);
    assert_eq!(cancel(&mut w.s, &persona(), "t999-a1", StopCause::Cancelled).unwrap(), ChangeOutcome::Missing);
}

#[test]
fn el_juego_de_estados_y_de_eventos_cuadra_con_el_vocabulario_reservado() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    assert_eq!(AttemptStatus::ALL.map(AttemptStatus::as_str), ATTEMPT_STATE, "los 9 estados son los de contracts/status-vocabulary.json");
    let ddl: String = w.s.read(|c| Ok(c.query_row("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attempts'", [], |r| r.get(0))?)).unwrap();
    let check = ddl.split("CHECK (status IN (").nth(1).unwrap().split("))").next().unwrap().to_string();
    let de_la_base: BTreeSet<&str> = check.split('\'').skip(1).step_by(2).collect();
    assert_eq!(de_la_base, ATTEMPT_STATE.into_iter().collect::<BTreeSet<_>>(), "el CHECK de la 008 admite exactamente esos estados");
    assert!(ENTITY_KIND.contains(&"attempt"));
    // Todo kind que se emite está reservado en el contrato (`attempt.waiting` lo emitirá el runtime).
    let h = w.hija.id.clone();
    let a = create(&mut w.s, &persona(), &h, &nuevo(true)).unwrap();
    approve(&mut w.s, &persona(), &a.id).unwrap();
    start(&mut w.s, &MutationContext::core(), &a.id).unwrap();
    fail(&mut w.s, &MutationContext::core(), &a.id, FailureCode::AgentIdleTimeout, "").unwrap();
    let b = create(&mut w.s, &persona(), &h, &nuevo(true)).unwrap();
    cancel(&mut w.s, &persona(), &b.id, StopCause::Cancelled).unwrap();
    let c = create(&mut w.s, &persona(), &h, &nuevo(false)).unwrap();
    cancel(&mut w.s, &persona(), &c.id, StopCause::Cancelled).unwrap();
    let d = create(&mut w.s, &persona(), &h, &nuevo(false)).unwrap();
    start(&mut w.s, &MutationContext::core(), &d.id).unwrap();
    finish(&mut w.s, &MutationContext::core(), &d.id, "").unwrap();
    let kinds: BTreeSet<String> = de_attempts(&w.s).into_iter().map(|e| e.kind).collect();
    assert_eq!(kinds.len(), 7, "{kinds:?}");
    for k in &kinds {
        assert!(DURABLE_EVENT.contains(&k.as_str()), "{k} no está reservado en el contrato");
    }
    assert!(!kinds.contains("attempt.waiting"));
}

/// Cuenta los Events que le llegan y no deriva nada.
#[derive(Debug, Default)]
struct Cuenta(AtomicUsize);

#[derive(Debug)]
struct Proyector(Arc<Cuenta>);

impl EventProjector for Proyector {
    fn project(&self, _tx: &rusqlite::Transaction<'_>, events: &[EventRow]) -> StoreResult<Vec<NewEvent>> {
        self.0 .0.fetch_add(events.len(), Ordering::SeqCst);
        Ok(vec![])
    }
}

#[test]
fn todos_los_hechos_del_attempt_pasan_por_el_proyector_de_attention() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let cuenta = Arc::new(Cuenta::default());
    w.s.set_event_projector(Arc::new(Proyector(cuenta.clone())));
    let h = w.hija.id.clone();
    let a = create(&mut w.s, &persona(), &h, &nuevo(true)).unwrap();
    approve(&mut w.s, &persona(), &a.id).unwrap();
    start(&mut w.s, &MutationContext::core(), &a.id).unwrap();
    finish(&mut w.s, &MutationContext::core(), &a.id, "ok").unwrap();
    let b = create(&mut w.s, &persona(), &h, &nuevo(false)).unwrap();
    fail(&mut w.s, &MutationContext::core(), &b.id, FailureCode::LaunchFailed, "").unwrap();
    let c = create(&mut w.s, &persona(), &h, &nuevo(false)).unwrap();
    cancel(&mut w.s, &persona(), &c.id, StopCause::Cancelled).unwrap();
    assert_eq!(cuenta.0.load(Ordering::SeqCst), 8, "8 hechos (4 + 2 + 2), todos proyectados");
}

#[test]
fn activity_pinta_cada_hecho_del_attempt_sin_respaldo() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let h = w.hija.id.clone();
    let a = create(&mut w.s, &persona(), &h, &nuevo(true)).unwrap();
    approve(&mut w.s, &persona(), &a.id).unwrap();
    start(&mut w.s, &MutationContext::core(), &a.id).unwrap();
    finish(&mut w.s, &MutationContext::core(), &a.id, RESUMEN).unwrap();
    let b = create(&mut w.s, &persona(), &h, &nuevo(false)).unwrap();
    fail(&mut w.s, &MutationContext::core(), &b.id, FailureCode::TerminalApprovalTimeout, "").unwrap();
    assert_eq!(w.s.attempt_row(&b.id).unwrap().unwrap().failure_reason.as_deref(), Some("terminal_approval_timeout"), "el código del evento es el de la fila");
    let c = create(&mut w.s, &persona(), &h, &nuevo(false)).unwrap();
    start(&mut w.s, &MutationContext::core(), &c.id).unwrap();
    cancel(&mut w.s, &persona(), &c.id, StopCause::RunClosed).unwrap();
    let d = create(&mut w.s, &persona(), &h, &nuevo(true)).unwrap();
    cancel(&mut w.s, &persona(), &d.id, StopCause::Cancelled).unwrap();

    let items: Vec<Value> = de_attempts(&w.s).iter().map(item).collect();
    let claves: Vec<&str> = items.iter().map(|i| i["message_key"].as_str().unwrap()).collect();
    assert_eq!(
        claves,
        [
            "activity.attempt.requested",
            "activity.attempt.approved",
            "activity.attempt.started",
            "activity.attempt.completed",
            "activity.attempt.requested",
            "activity.attempt.failed",
            "activity.attempt.requested",
            "activity.attempt.started",
            "activity.attempt.stopped",
            "activity.attempt.requested",
            "activity.attempt.rejected",
        ]
    );
    assert!(items.iter().all(|i| i["fallback"] == false), "{items:#?}");
    let visuales: Vec<&str> = items.iter().map(|i| i["visual"].as_str().unwrap()).collect();
    assert_eq!(visuales, ["info", "success", "info", "success", "info", "error", "info", "info", "warning", "info", "warning"]);
    assert_eq!(items[0]["args"], json!({ "task": h, "n": 1, "provider": "claude", "model": "claude-opus-5-5", "effort": "high", "role": "implementador", "profile": "implementar", "external": false, "approval_required": true }));
    assert_eq!(items[3]["args"], json!({ "task": h, "n": 1, "has_summary": true }));
    assert_eq!(items[5]["args"], json!({ "task": h, "n": 2, "reason": "terminal_approval_timeout", "has_summary": false }));
    assert_eq!(items[8]["args"], json!({ "task": h, "n": 3, "from": "running", "cause": "run_closed" }));
    assert_eq!(items[10]["args"], json!({ "task": h, "n": 4, "cause": "cancelled" }));
    assert_eq!(items[0]["target"], json!({ "kind": "attempt", "id": a.id }));
    for i in &items {
        assert!(!i.to_string().contains("RESUMEN-SECRETO"));
    }
    // Un código fuera del conjunto cerrado no se copia: cae al respaldo.
    let mut mala = de_attempts(&w.s).remove(5);
    mala.payload = json!({ "task": h, "n": 2, "reason": "me-lo-invento", "has_summary": false }).to_string();
    let r = item(&mala);
    assert_eq!((r["fallback"].as_bool(), r["args"]["reason"].as_str()), (Some(true), Some("invalid_payload")));
    assert!(!r.to_string().contains("me-lo-invento"));
    let mut futura = de_attempts(&w.s).remove(0);
    futura.v = 2;
    assert_eq!(item(&futura)["args"]["reason"], "unsupported_version", "una versión que nadie publicó");
}

#[test]
fn antes_del_corte_attempt_ops_no_escribe_nada() {
    let t = Tmp::new();
    let mut s = Store::open_with(t.path(), &embedded(), "t").unwrap();
    let r = create(&mut s, &persona(), "t1", &nuevo(false));
    assert!(matches!(r, Err(StoreError::AgenticModelInactive)), "{r:?}");
    assert!(eventos(&s).is_empty());
}

#[test]
fn un_core_real_aplica_la_008_y_sus_tablas_quedan_inertes_mientras_el_legacy_sigue_mandando() {
    use super::projects_tests::{base_de, core_listo, repo, s as ruta};
    use super::Caller;
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let estado = |core: &Arc<super::Core>| {
        core.storage
            .with_store(|s| {
                let n = |t: &str| s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get::<_, i64>(0))?)).unwrap();
                (s.schema_version().unwrap(), s.agentic_model_active().unwrap(), n("tasks"), n("attempts"))
            })
            .unwrap()
    };
    assert_eq!(estado(&core), ((crate::store::cut_migration().version - 1), false, 0, 0), "el arranque autoritativo aplica la 008 y las siguientes; las tablas nacen vacías e inertes");
    let r = repo(&base_de(&data), "app", None);
    let out = core.rpc(Caller::Agent(None), &ruta(&r), "run_create", &json!({ "objective": "hacer algo" })).unwrap();
    assert!(core.lock().tasks.contains_key(out["task"].as_str().unwrap()));
    assert_eq!(estado(&core), ((crate::store::cut_migration().version - 1), false, 0, 0), "el runtime legacy no escribe en attempts");
}

// ---------------------------------------------------------------------------------------------
// Arquitectura
// ---------------------------------------------------------------------------------------------

fn produccion(dir: &Path) -> Vec<(String, Vec<(usize, String)>)> {
    let mut out = vec![];
    for entrada in std::fs::read_dir(dir).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        let prod = texto.split("mod tests {").next().unwrap().to_string();
        out.push((nombre, prod.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")).map(|(n, l)| (n + 1, l.to_string())).collect()));
    }
    out
}

#[test]
fn solo_attempt_ops_construye_los_hechos_del_attempt_y_solo_store_attempts_escribe_su_tabla() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let orch: [(&str, &[&str]); 10] = [
        ("attempt_requested(", &["event_kinds.rs", "attempt_ops.rs"]),
        ("attempt_continued(", &["event_kinds.rs", "attempt_ops.rs"]),
        ("attempt_approved(", &["event_kinds.rs", "attempt_ops.rs"]),
        ("attempt_rejected(", &["event_kinds.rs", "attempt_ops.rs"]),
        ("attempt_started(", &["event_kinds.rs", "attempt_ops.rs"]),
        ("attempt_completed(", &["event_kinds.rs", "attempt_ops.rs"]),
        ("attempt_failed(", &["event_kinds.rs", "attempt_ops.rs"]),
        ("attempt_stopped(", &["event_kinds.rs", "attempt_ops.rs"]),
        (".attempt_create_recorded(", &["attempt_ops.rs"]),
        (".attempt_transition_recorded(", &["attempt_ops.rs"]),
    ];
    let mut vistos = 0;
    for (nombre, lineas) in produccion(&src.join("orch")) {
        for (n, l) in &lineas {
            for (simbolo, donde) in orch {
                assert!(!l.contains(simbolo) || donde.contains(&nombre.as_str()), "orch/{nombre}:{n}: «{simbolo}» solo puede aparecer en {donde:?}");
            }
            assert!(!l.contains("INTO attempts") && !l.contains("UPDATE attempts"), "orch/{nombre}:{n}: orch no escribe SQL de attempts");
        }
        vistos += 1;
    }
    assert!(vistos >= 30, "revisó {vistos}");
    let mut escriben = BTreeSet::new();
    for (nombre, lineas) in produccion(&src.join("store")) {
        if lineas.iter().any(|(_, l)| ["INTO attempts", "UPDATE attempts", "DELETE FROM attempts"].iter().any(|q| l.contains(q))) {
            escriben.insert(nombre);
        }
    }
    assert_eq!(escriben, BTreeSet::from(["attempts.rs".to_string()]), "solo store/attempts.rs escribe attempts");
}
