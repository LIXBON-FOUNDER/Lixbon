//! LXO-113 · hechos de la Task como intención: contrato de sus Events, quién puede hacer cada cosa y cómo los pinta
//! Activity. El almacén (filas, restricciones, atomicidad) se prueba en `store/tasks_tests.rs`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::activity_format::item;
use super::events::{Actor, Channel, MutationContext};
use super::task_ops::{create_child, create_run, remove, set_discarded, update_intent};
use crate::store::{
    embedded, ActorKind, ChangeOutcome, EventClass, EventProjector, EventQuery, EventRow, Fingerprint, IntentChange, NewEvent, NewLocation, NewRun, NewTaskIntent, Store, StoreError, StoreResult,
    TaskIntent, TaskRemoval, TaskRow, AGENTIC_MODEL, AGENTIC_MODEL_KEY,
};

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-taskops-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

const ENCARGO: &str = "ENCARGO-SECRETO: no viaja en ningún evento";

/// Almacén con el corte hecho y un Project.
fn listo(dir: &Path) -> (Store, String) {
    let mut s = Store::open_with(dir, &embedded(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let p = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    (s, p)
}

fn persona() -> MutationContext {
    MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) }
}

fn agente(task: &str) -> MutationContext {
    MutationContext::agent(task, Channel::Lxo)
}

fn intencion(title: &str) -> NewTaskIntent {
    NewTaskIntent { title: title.into(), spec: ENCARGO.into(), repo: "c:/app".into() }
}

fn run(s: &mut Store, p: &str, ctx: &MutationContext) -> TaskRow {
    create_run(s, ctx, &NewRun { objective: "login".into(), project_id: p.into(), root: intencion("coordinar") }).unwrap().1
}

fn eventos(s: &Store) -> Vec<EventRow> {
    s.events_page(&EventQuery { limit: Some(500), ..Default::default() }).unwrap().events
}

fn payload(e: &EventRow) -> Value {
    serde_json::from_str(&e.payload).unwrap()
}

fn denegado<T: std::fmt::Debug>(r: StoreResult<T>) {
    match r {
        Err(StoreError::TaskConflict(m)) => assert!(m.contains("no lo puede hacer"), "{m}"),
        otro => panic!("se esperaba una denegación: {otro:?}"),
    }
}

#[test]
fn un_run_nace_con_run_created_v1_y_task_created_v2_de_solo_intencion() {
    let t = Tmp::new();
    let (mut s, p) = listo(t.path());
    let raiz = run(&mut s, &p, &persona());
    let ev = eventos(&s);
    assert_eq!(ev.iter().map(|e| (e.kind.as_str(), e.v, e.class)).collect::<Vec<_>>(), [("run.created", 1, EventClass::State), ("task.created", 2, EventClass::State)]);
    for e in &ev {
        assert_eq!((e.actor_kind, e.actor_id.as_deref(), e.channel.as_deref(), e.client_id.as_deref()), (ActorKind::Person, Some("ana"), Some("ui"), Some("cli-desktop")));
        assert_eq!((e.project_id.as_deref(), e.run_id.as_deref()), (Some(p.as_str()), Some(raiz.run_id.as_str())));
        assert_eq!(e.at, raiz.created_at, "la fila y su hecho llevan la misma hora");
    }
    assert_eq!((ev[0].entity_kind.as_str(), ev[0].entity_id.as_str()), ("run", raiz.run_id.as_str()));
    assert_eq!(payload(&ev[0]), json!({ "root_task": raiz.id }));
    assert_eq!((ev[1].entity_kind.as_str(), ev[1].entity_id.as_str()), ("task", raiz.id.as_str()));
    // v2: solo la intención. Nada de la ejecución (agent, role, model, external) ni el encargo.
    assert_eq!(payload(&ev[1]), json!({ "parent": null, "depth": 0, "title": "coordinar" }));
}

#[test]
fn un_agente_solo_crea_hijas_bajo_su_propia_task() {
    let t = Tmp::new();
    let (mut s, p) = listo(t.path());
    let raiz = run(&mut s, &p, &MutationContext::system(Channel::Core));
    let h = create_child(&mut s, &agente(&raiz.id), &raiz.id, &intencion("api")).unwrap();
    let nieta = create_child(&mut s, &agente(&raiz.id), &h.id, &intencion("tests")).expect("también bajo una descendiente");
    let antes = eventos(&s).len();
    denegado(create_child(&mut s, &agente(&h.id), &raiz.id, &intencion("x")));
    denegado(create_child(&mut s, &agente(&nieta.id), &h.id, &intencion("x")));
    denegado(create_child(&mut s, &agente("t999"), &raiz.id, &intencion("x")));
    assert_eq!(eventos(&s).len(), antes);
    assert_eq!(s.task_children(&raiz.id).unwrap(), [h.clone()]);
    let e = eventos(&s).into_iter().find(|e| e.entity_id == nieta.id).unwrap();
    assert_eq!((e.kind.as_str(), e.v, e.actor_kind, e.actor_id.as_deref(), e.channel.as_deref()), ("task.created", 2, ActorKind::Agent, Some(raiz.id.as_str()), Some("lxo")));
    assert_eq!(payload(&e), json!({ "parent": h.id, "depth": 2, "title": "tests" }));
    // Una persona y el sistema crean donde haga falta.
    create_child(&mut s, &persona(), &nieta.id, &intencion("p")).unwrap();
    create_child(&mut s, &MutationContext::core(), &raiz.id, &intencion("s")).unwrap();
}

#[test]
fn cambiar_la_intencion_lo_hace_una_persona_o_el_agente_que_la_coordina_y_el_encargo_no_viaja() {
    let t = Tmp::new();
    let (mut s, p) = listo(t.path());
    let raiz = run(&mut s, &p, &persona());
    let h = create_child(&mut s, &persona(), &raiz.id, &intencion("api")).unwrap();
    let titulo = IntentChange { title: Some("API de sesiones".into()), spec: None };
    assert_eq!(update_intent(&mut s, &agente(&raiz.id), &h.id, &titulo).unwrap(), ChangeOutcome::Changed);
    let ultimo = eventos(&s).pop().unwrap();
    assert_eq!((ultimo.kind.as_str(), ultimo.v, ultimo.class, ultimo.entity_id.as_str()), ("task.updated", 1, EventClass::State, h.id.as_str()));
    assert_eq!(payload(&ultimo), json!({ "changed": ["title"], "title": "API de sesiones" }));
    let encargo = IntentChange { title: None, spec: Some(format!("{ENCARGO} (v2)")) };
    assert_eq!(update_intent(&mut s, &agente(&h.id), &h.id, &encargo).unwrap(), ChangeOutcome::Changed, "su propia Task");
    assert_eq!(payload(&eventos(&s).pop().unwrap()), json!({ "changed": ["spec"] }), "el encargo nunca viaja en el hecho");
    let antes = eventos(&s).len();
    denegado(update_intent(&mut s, &agente(&h.id), &raiz.id, &titulo));
    denegado(update_intent(&mut s, &MutationContext::core(), &h.id, &titulo));
    // Una persona sin credencial verificada del canal legacy sigue siendo una persona.
    update_intent(&mut s, &MutationContext::person(Channel::Ui), &h.id, &IntentChange { title: Some("API".into()), spec: None }).unwrap();
    assert_eq!(eventos(&s).len(), antes + 1);
    for e in eventos(&s) {
        assert!(!e.payload.contains("ENCARGO-SECRETO"), "{}: {}", e.kind, e.payload);
    }
}

#[test]
fn descartar_restaurar_y_borrar_son_decisiones_de_una_persona() {
    let t = Tmp::new();
    let (mut s, p) = listo(t.path());
    let raiz = run(&mut s, &p, &persona());
    let h = create_child(&mut s, &agente(&raiz.id), &raiz.id, &intencion("api")).unwrap();
    let antes = eventos(&s).len();
    for ctx in [agente(&raiz.id), agente(&h.id), MutationContext::core(), MutationContext::system(Channel::Ui)] {
        denegado(set_discarded(&mut s, &ctx, &h.id, true));
        denegado(set_discarded(&mut s, &ctx, &h.id, false));
        denegado(remove(&mut s, &ctx, &h.id, TaskRemoval::IfUnused));
    }
    assert_eq!(eventos(&s).len(), antes);
    assert_eq!(set_discarded(&mut s, &persona(), &h.id, true).unwrap(), ChangeOutcome::Changed);
    assert_eq!(s.task_row(&h.id).unwrap().unwrap().intent, TaskIntent::Discarded);
    assert_eq!(set_discarded(&mut s, &persona(), &h.id, false).unwrap(), ChangeOutcome::Changed);
    assert_eq!(remove(&mut s, &persona(), &h.id, TaskRemoval::IfUnused).unwrap(), ChangeOutcome::Changed);
    let ultimos: Vec<(String, EventClass, Value)> = eventos(&s).into_iter().skip(antes).map(|e| (e.kind.clone(), e.class, payload(&e))).collect();
    assert_eq!(
        ultimos,
        [
            ("task.discarded".to_string(), EventClass::Decision, json!({})),
            ("task.restored".into(), EventClass::Decision, json!({})),
            ("task.removed".into(), EventClass::State, json!({ "cause": "unused" })),
        ]
    );
    let borrado = eventos(&s).pop().unwrap();
    assert_eq!((borrado.run_id.as_deref(), borrado.project_id.as_deref()), (Some(raiz.run_id.as_str()), Some(p.as_str())), "capturados de la fila antes de borrarla");
}

#[test]
fn antes_del_corte_task_ops_no_escribe_nada() {
    let t = Tmp::new();
    let mut s = Store::open_with(t.path(), &embedded(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let p = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    let r = create_run(&mut s, &persona(), &NewRun { objective: "o".into(), project_id: p, root: intencion("x") });
    assert!(matches!(r, Err(StoreError::AgenticModelInactive)), "{r:?}");
    assert!(eventos(&s).is_empty());
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
fn todos_los_hechos_de_la_task_pasan_por_el_proyector_de_attention() {
    let t = Tmp::new();
    let (mut s, p) = listo(t.path());
    let cuenta = Arc::new(Cuenta::default());
    s.set_event_projector(Arc::new(Proyector(cuenta.clone())));
    let raiz = run(&mut s, &p, &persona());
    let h = create_child(&mut s, &persona(), &raiz.id, &intencion("api")).unwrap();
    update_intent(&mut s, &persona(), &h.id, &IntentChange { title: Some("api 2".into()), spec: None }).unwrap();
    set_discarded(&mut s, &persona(), &h.id, true).unwrap();
    set_discarded(&mut s, &persona(), &h.id, false).unwrap();
    remove(&mut s, &persona(), &h.id, TaskRemoval::IfUnused).unwrap();
    assert_eq!(cuenta.0.load(Ordering::SeqCst), eventos(&s).len());
    assert_eq!(eventos(&s).len(), 7);
}

#[test]
fn activity_pinta_cada_hecho_nuevo_sin_respaldo_y_conserva_la_v1() {
    let t = Tmp::new();
    let (mut s, p) = listo(t.path());
    let raiz = run(&mut s, &p, &persona());
    let h = create_child(&mut s, &persona(), &raiz.id, &intencion("api")).unwrap();
    update_intent(&mut s, &persona(), &h.id, &IntentChange { title: Some("api 2".into()), spec: Some("otro".into()) }).unwrap();
    set_discarded(&mut s, &persona(), &h.id, true).unwrap();
    set_discarded(&mut s, &persona(), &h.id, false).unwrap();
    remove(&mut s, &persona(), &h.id, TaskRemoval::IfUnused).unwrap();
    let items: Vec<Value> = eventos(&s).iter().map(item).collect();
    let claves: Vec<&str> = items.iter().map(|i| i["message_key"].as_str().unwrap()).collect();
    assert_eq!(
        claves,
        [
            "activity.run.created",
            "activity.task.intent_created",
            "activity.task.intent_created",
            "activity.task.updated",
            "activity.task.discarded",
            "activity.task.restored",
            "activity.task.removed",
        ]
    );
    assert!(items.iter().all(|i| i["fallback"] == false), "{items:#?}");
    assert_eq!(items[2]["args"], json!({ "title": "api", "parent": raiz.id, "depth": 1 }));
    assert_eq!(items[3]["args"], json!({ "changed": ["title", "spec"], "title": "api 2" }));
    assert_eq!(items[6]["args"], json!({ "cause": "unused" }));
    // La v1 (legacy) sigue con su clave y sus argumentos; una versión que nadie publicó cae al respaldo.
    let mut v1 = eventos(&s).remove(1);
    v1.v = 1;
    v1.payload = json!({ "parent": null, "depth": 0, "agent": "claude", "role": null, "model": null, "title": "x", "external": false }).to_string();
    assert_eq!(item(&v1)["message_key"], "activity.task.created");
    v1.v = 3;
    assert_eq!((item(&v1)["fallback"].as_bool(), item(&v1)["args"]["reason"].as_str()), (Some(true), Some("unsupported_version")));
    let mut otro = eventos(&s).remove(3);
    otro.v = 2;
    assert_eq!(item(&otro)["args"]["reason"], "unsupported_version", "solo task.created tiene v2");
}

#[test]
fn un_core_real_aplica_la_007_y_sus_tablas_quedan_inertes_mientras_el_legacy_sigue_mandando() {
    use super::projects_tests::{base_de, core_listo, repo, s as ruta};
    use super::Caller;
    let (_l, data, _c, core) = core_listo();
    core.settings.lock().unwrap().enabled = true;
    let filas = |core: &Arc<super::Core>| {
        core.storage
            .with_store(|s| {
                let n = |t: &str| s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get::<_, i64>(0))?)).unwrap();
                (s.schema_version().unwrap(), s.agentic_model_active().unwrap(), n("runs"), n("tasks"))
            })
            .unwrap()
    };
    assert_eq!(filas(&core), (8, false, 0, 0), "el arranque autoritativo aplica la 007 y la 008; las tablas nacen vacías e inertes");
    // El runtime legacy sigue siendo la autoridad de las tareas: un run nuevo va al documento, no a estas tablas.
    let r = repo(&base_de(&data), "app", None);
    let out = core.rpc(Caller::Agent(None), &ruta(&r), "run_create", &json!({ "objective": "hacer algo" })).unwrap();
    assert!(core.lock().tasks.contains_key(out["task"].as_str().unwrap()));
    assert_eq!(filas(&core), (8, false, 0, 0));
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
        let lineas = prod.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")).map(|(n, l)| (n + 1, l.to_string())).collect();
        out.push((nombre, lineas));
    }
    out
}

#[test]
fn solo_task_ops_construye_los_hechos_de_la_task_y_solo_store_tasks_escribe_sus_tablas() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let orch: [(&str, &[&str]); 9] = [
        ("run_created_intent(", &["event_kinds.rs", "task_ops.rs"]),
        ("task_intent_created(", &["event_kinds.rs", "task_ops.rs"]),
        ("task_updated(", &["event_kinds.rs", "task_ops.rs"]),
        ("task_discarded(", &["event_kinds.rs", "task_ops.rs"]),
        ("task_restored(", &["event_kinds.rs", "task_ops.rs"]),
        (".run_create_recorded(", &["task_ops.rs"]),
        (".task_create_child_recorded(", &["task_ops.rs"]),
        (".task_set_discarded_recorded(", &["task_ops.rs"]),
        (".task_remove_recorded(", &["task_ops.rs"]),
    ];
    let mut vistos = 0;
    for (nombre, lineas) in produccion(&src.join("orch")) {
        for (n, l) in &lineas {
            for (simbolo, donde) in orch {
                assert!(!l.contains(simbolo) || donde.contains(&nombre.as_str()), "orch/{nombre}:{n}: «{simbolo}» solo puede aparecer en {donde:?}");
            }
            assert!(!l.contains(".task_update_intent_recorded(") || nombre == "task_ops.rs", "orch/{nombre}:{n}");
            assert!(!l.contains("INTO tasks") && !l.contains("INTO runs"), "orch/{nombre}:{n}: orch no escribe SQL de tareas");
        }
        vistos += 1;
    }
    assert!(vistos >= 30, "revisó {vistos}");
    let mut escriben = BTreeSet::new();
    for (nombre, lineas) in produccion(&src.join("store")) {
        if lineas.iter().any(|(_, l)| ["INTO tasks", "INTO runs", "UPDATE tasks", "UPDATE runs", "DELETE FROM tasks", "DELETE FROM runs"].iter().any(|q| l.contains(q) && !l.contains("SELECT"))) {
            escriben.insert(nombre);
        }
    }
    assert_eq!(escriben, BTreeSet::from(["tasks.rs".to_string()]), "solo store/tasks.rs escribe runs y tasks");
}
