//! LXO-116 · hechos de Worktree y Artifact: contrato de sus Events (sin rutas ni localizadores), quién puede hacer cada
//! cosa (descartar trabajo lo confirma una persona), vocabulario reservado y cómo los pinta Activity. El almacén se
//! prueba en `store/worktrees_tests.rs`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{json, Value};

use super::activity_format::item;
use super::attempt_ops;
use super::events::{Actor, Channel, MutationContext};
use super::task_ops::{create_child, create_run};
use super::vocab::DURABLE_EVENT;
use super::worktree_ops::{artifact, attach, found, lost, register, remove};
use crate::store::{
    embedded, ActorKind, ArtifactKind, ChangeOutcome, EventQuery, EventRow, Fingerprint, NewArtifact, NewAttempt, NewLocation, NewRun, NewTaskIntent, NewWorktree, Provenance, RemovalReason,
    Store, StoreError, StoreResult, AGENTIC_MODEL, AGENTIC_MODEL_KEY,
};

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-worktreeops-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

const RUTA: &str = "C:/RUTA-PRIVADA/app.lixbon-wt/t3";
const PR: &str = "https://github.com/ana/PR-PRIVADA/pull/42";

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
    let new = NewAttempt { provider: "codex".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    let a = attempt_ops::create(&mut w.s, &persona(), task, &new).unwrap();
    attempt_ops::start(&mut w.s, &core(), &a.id).unwrap();
    a.id
}

fn nuevo(provenance: Provenance, path: &str) -> NewWorktree {
    NewWorktree { provenance, machine: "m1".into(), repo: "C:/RUTA-PRIVADA/app".into(), path: path.into(), branch: Some("lx/r1/t3-api".into()), base_branch: Some("main".into()), base_commit: None }
}

fn eventos(s: &Store) -> Vec<EventRow> {
    s.events_page(&EventQuery { limit: Some(500), ..Default::default() }).unwrap().events.into_iter().filter(|e| e.entity_kind == "worktree" || e.entity_kind == "artifact").collect()
}

fn payload(e: &EventRow) -> Value {
    serde_json::from_str(&e.payload).unwrap()
}

fn denegado<T: std::fmt::Debug>(r: StoreResult<T>) {
    match r {
        Err(StoreError::WorktreeConflict(m)) => assert!(m.contains("no lo puede hacer"), "{m}"),
        otro => panic!("se esperaba una denegación: {otro:?}"),
    }
}

/// Crear, perderlo, encontrarlo, seguimiento en el mismo, Artifact, quitarlo tras integrar; y uno externo adoptado.
fn ciclo(w: &mut Mundo) -> (String, String, String) {
    let (h, r) = (w.hija.clone(), w.raiz.clone());
    let a1 = corre(w, &h);
    let x = register(&mut w.s, &core(), &a1, &nuevo(Provenance::Created, RUTA)).unwrap();
    assert_eq!(lost(&mut w.s, &core(), &x.id).unwrap(), ChangeOutcome::Changed);
    assert_eq!(found(&mut w.s, &core(), &x.id).unwrap(), ChangeOutcome::Changed);
    artifact(&mut w.s, &MutationContext::agent(&h, Channel::Lxo), &a1, &NewArtifact { kind: ArtifactKind::PullRequest, uri: PR.into(), sha256: None, bytes: None }).unwrap();
    attempt_ops::finish(&mut w.s, &core(), &a1, "").unwrap();
    let a2 = corre(w, &h);
    assert_eq!(attach(&mut w.s, &core(), &x.id, &a2).unwrap(), ChangeOutcome::Changed);
    attempt_ops::finish(&mut w.s, &core(), &a2, "").unwrap();
    assert_eq!(remove(&mut w.s, &core(), &x.id, RemovalReason::Integrated, true).unwrap(), ChangeOutcome::Changed);
    let b = corre(w, &r);
    let e = register(&mut w.s, &persona(), &b, &nuevo(Provenance::External, "C:/RUTA-PRIVADA/app")).unwrap();
    (a1, a2, format!("{}|{}", x.id, e.id))
}

#[test]
fn cada_mutador_deja_su_evento_sin_rutas_ni_localizadores() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (a1, a2, ids) = ciclo(&mut w);
    let (x, e) = ids.split_once('|').unwrap();
    let h = w.hija.clone();
    let ev = eventos(&w.s);
    let kinds: Vec<&str> = ev.iter().map(|e| e.kind.as_str()).collect();
    assert_eq!(kinds, ["worktree.created", "worktree.missing", "worktree.found", "artifact.created", "worktree.attached", "worktree.removed", "worktree.adopted"]);
    let p: Vec<Value> = ev.iter().map(payload).collect();
    assert_eq!(p[0], json!({ "task": h, "attempt": a1, "n": 1, "branch": "lx/r1/t3-api" }));
    assert_eq!(p[1], json!({ "task": h }));
    assert_eq!(p[3], json!({ "task": h, "attempt": a1, "n": 1, "kind": "pull_request", "verifiable": false }));
    assert_eq!(p[4], json!({ "task": h, "attempt": a2, "n": 2 }));
    assert_eq!(p[5], json!({ "task": h, "reason": "integrated", "branch_kept": true }));
    assert_eq!(p[6]["provenance"], "external");
    assert_eq!((ev[0].entity_id.as_str(), ev[6].entity_id.as_str()), (x, e));
    assert_eq!(ev[3].actor_kind, ActorKind::Agent, "el agente de esa Task deja su PR");
    assert_eq!(ev[6].actor_kind, ActorKind::Person, "adoptar uno que ya existía lo puede hacer una persona");
    for e in &ev {
        assert!(!e.payload.contains("RUTA-PRIVADA") && !e.payload.contains("PR-PRIVADA"), "{}: {}", e.kind, e.payload);
    }
}

#[test]
fn descartar_trabajo_lo_confirma_una_persona_e_integrar_lo_hace_el_core() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (h, r) = (w.hija.clone(), w.raiz.clone());
    let a = corre(&mut w, &h);
    let agente = MutationContext::agent(&h, Channel::Lxo);
    let coordinador = MutationContext::agent(&r, Channel::Lxo);
    for ctx in [&persona(), &agente, &coordinador] {
        denegado(register(&mut w.s, ctx, &a, &nuevo(Provenance::Created, RUTA)));
    }
    denegado(register(&mut w.s, &agente, &a, &nuevo(Provenance::Adopted, RUTA)));
    let x = register(&mut w.s, &core(), &a, &nuevo(Provenance::Created, RUTA)).unwrap();
    for ctx in [&persona(), &agente] {
        denegado(lost(&mut w.s, ctx, &x.id));
        denegado(found(&mut w.s, ctx, &x.id));
        denegado(attach(&mut w.s, ctx, &x.id, &a));
    }
    attempt_ops::finish(&mut w.s, &core(), &a, "").unwrap();
    denegado(remove(&mut w.s, &core(), &x.id, RemovalReason::Discarded, false));
    denegado(remove(&mut w.s, &persona(), &x.id, RemovalReason::Integrated, false));
    denegado(remove(&mut w.s, &agente, &x.id, RemovalReason::Gone, false));
    denegado(artifact(&mut w.s, &coordinador, &a, &NewArtifact { kind: ArtifactKind::Commit, uri: "abcdef0".into(), sha256: None, bytes: None }));
    assert_eq!(eventos(&w.s).len(), 1, "las denegaciones no dejan rastro");
    assert_eq!(remove(&mut w.s, &persona(), &x.id, RemovalReason::Discarded, false).unwrap(), ChangeOutcome::Changed);
}

#[test]
fn el_vocabulario_reserva_los_hechos_de_worktree_y_artifact() {
    let fuente = include_str!("event_kinds.rs");
    let marca = "const KIND: &'static str = \"";
    let kinds: BTreeSet<&str> = fuente
        .match_indices(marca)
        .filter_map(|(i, _)| fuente[i + marca.len()..].split('"').next())
        .filter(|k| k.starts_with("worktree.") || k.starts_with("artifact."))
        .collect();
    assert_eq!(kinds.len(), 7, "{kinds:?}");
    for k in kinds {
        assert!(DURABLE_EVENT.contains(&k), "{k} no está reservado en contracts/status-vocabulary.json");
    }
}

#[test]
fn activity_pinta_cada_hecho_sin_respaldo_ni_rutas() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    ciclo(&mut w);
    let items: Vec<Value> = eventos(&w.s).iter().map(item).collect();
    let claves: Vec<&str> = items.iter().map(|i| i["message_key"].as_str().unwrap()).collect();
    assert_eq!(
        claves,
        [
            "activity.worktree.created",
            "activity.worktree.missing",
            "activity.worktree.found",
            "activity.artifact.created",
            "activity.worktree.attached",
            "activity.worktree.removed",
            "activity.worktree.adopted",
        ]
    );
    assert!(items.iter().all(|i| i["fallback"] == false), "{items:#?}");
    assert_eq!(items[1]["visual"], "warning", "un Worktree que falta se ve");
    for i in &items {
        let s = i.to_string();
        assert!(!s.contains("RUTA-PRIVADA") && !s.contains("PR-PRIVADA"), "{s}");
    }
    let mut mala = eventos(&w.s).remove(5);
    mala.payload = json!({ "task": w.hija, "reason": "a_mano", "branch_kept": false }).to_string();
    assert_eq!(item(&mala)["fallback"], true);
}

#[test]
fn antes_del_corte_worktree_ops_no_escribe_nada() {
    let t = Tmp::new();
    let mut s = Store::open_with(t.path(), &embedded(), "t").unwrap();
    assert!(matches!(register(&mut s, &core(), "t1-a1", &nuevo(Provenance::Created, RUTA)), Err(StoreError::AgenticModelInactive)));
    assert!(eventos(&s).is_empty());
}

#[test]
fn solo_worktree_ops_construye_los_hechos_y_solo_store_worktrees_escribe_sus_tablas() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let constructores = ["worktree_registered(", "worktree_attached(", "worktree_missing(", "worktree_found(", "worktree_removed(", "artifact_created("];
    let mutadores = [".worktree_register_recorded(", ".worktree_attach_recorded(", ".worktree_transition_recorded(", ".artifact_create_recorded("];
    for entrada in std::fs::read_dir(src.join("orch")).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre == "tests.rs" || nombre.ends_with("_tests.rs") {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        for (n, l) in texto.lines().enumerate().filter(|(_, l)| !l.trim_start().starts_with("//")) {
            for sim in constructores {
                assert!(!l.contains(sim) || ["event_kinds.rs", "worktree_ops.rs"].contains(&nombre.as_str()), "orch/{nombre}:{}: «{sim}» solo en worktree_ops", n + 1);
            }
            for sim in mutadores {
                assert!(!l.contains(sim) || nombre == "worktree_ops.rs", "orch/{nombre}:{}: «{sim}» solo en worktree_ops", n + 1);
            }
        }
    }
    for entrada in std::fs::read_dir(src.join("store")).unwrap() {
        let ruta = entrada.unwrap().path();
        let nombre = ruta.file_name().unwrap().to_string_lossy().into_owned();
        if !nombre.ends_with(".rs") || nombre.ends_with("_tests.rs") || nombre == "worktrees.rs" {
            continue;
        }
        let texto = std::fs::read_to_string(&ruta).unwrap();
        for tabla in ["worktrees", "artifacts"] {
            for q in [format!("INTO {tabla} "), format!("UPDATE {tabla} ")] {
                assert!(!texto.contains(&q), "store/{nombre} escribe {tabla}");
            }
        }
    }
}
