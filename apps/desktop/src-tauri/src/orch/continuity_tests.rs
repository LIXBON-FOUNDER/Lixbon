//! LXO-134 · continuidad de un Attempt: resume nativo, fallback explícito a ContextPackage y los errores de cada camino.
//! Contrato: `docs/core/CONTINUIDAD.md`. El almacén (transacción, idempotencia) se prueba en `store/continuity_tests.rs`;
//! aquí se prueba la política, la orquestación con adapters falsos y los eventos.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::Value;

use super::adapter::fake::{FakeAdapter, Step};
use super::adapter::{AdapterError, AdapterRegistry, CancelToken, Capability, CapabilityMatrix, CapabilityState, ProbeResult, ProviderAdapter, RunOutcome};
use super::agents::EnvBlock;
use super::attempt_ops;
use super::context_package::{build, NewPackage, RevisionInput};
use super::continuity::*;
use super::events::{Actor, Channel, MutationContext};
use super::session_ops;
use super::task_ops::{create_child, create_run};
use crate::store::{
    embedded, AttemptRow, AttemptStatus, ContinuationReason as Reason, ContinuityStrategy as Strategy, EventQuery, EventRow, Fingerprint, Migration, NewAttempt, NewLocation,
    NewProviderSession, NewRun, NewTaskIntent, SessionBinding, SessionStatus, Store, AGENTIC_MODEL, AGENTIC_MODEL_KEY,
};

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-continuity-ops-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

/// Referencia opaca de la sesión del proveedor: no puede aparecer en ningún Event ni en ningún error.
const REF: &str = "REF-OPACA-6f1c2a9e-0b7d-4d1e";
const PERFIL: &str = "proponer";

fn persona() -> MutationContext {
    MutationContext { actor: Actor::PersonId("ana".into()), channel: Channel::Ui, client_id: Some("cli-desktop".into()) }
}

fn core() -> MutationContext {
    MutationContext::core()
}

fn corte_neutro() -> Vec<Migration> {
    embedded().into_iter().map(|m| if m.name == crate::store::CUT_NAME { Migration::new(m.version, "corte_neutro_de_prueba", "SELECT 1;") } else { m }).collect()
}

struct Mundo {
    s: Store,
    hija: String,
    otra: String,
    claude: Arc<FakeAdapter>,
    codex: Arc<FakeAdapter>,
    reg: AdapterRegistry,
}

fn registro(adapters: &[&Arc<FakeAdapter>]) -> AdapterRegistry {
    let mut r = AdapterRegistry::new();
    for a in adapters {
        r.register((*a).clone() as Arc<dyn ProviderAdapter>).unwrap();
    }
    r
}

fn sin_resume() -> ProbeResult {
    ProbeResult::ready(Some("0.0.0-fake"), CapabilityMatrix::all_available().with(Capability::Resume, CapabilityState::Unsupported))
}

fn mundo(dir: &Path) -> Mundo {
    let mut s = Store::open_with(dir, &corte_neutro(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (_, raiz) = create_run(&mut s, &persona(), &NewRun { objective: "login".into(), project_id: project, root: intencion("coordinar") }).unwrap();
    let hija = create_child(&mut s, &persona(), &raiz.id, &intencion("api")).unwrap();
    let otra = create_child(&mut s, &persona(), &raiz.id, &intencion("ui")).unwrap();
    let claude = Arc::new(FakeAdapter::full("claude"));
    let codex = Arc::new(FakeAdapter::full("codex"));
    let reg = registro(&[&claude, &codex]);
    Mundo { s, hija: hija.id, otra: otra.id, claude, codex, reg }
}

/// Un Attempt terminado, con su sesión (si `referencia`) ya en espera.
fn terminado(w: &mut Mundo, task: &str, provider: &str, referencia: Option<&str>) -> (AttemptRow, Option<String>) {
    let new = NewAttempt { provider: provider.into(), model: Some("modelo-x".into()), effort: None, role: Some("implementador".into()), profile: Some(PERFIL.into()), external: false, requires_approval: false };
    let a = attempt_ops::create(&mut w.s, &persona(), task, &new).unwrap();
    attempt_ops::start(&mut w.s, &core(), &a.id).unwrap();
    let ps = referencia.map(|r| {
        let s = session_ops::open(&mut w.s, &core(), &a.id, &NewProviderSession { resumable: true, external_ref: Some((r.to_string(), SessionBinding::StreamJson)) }).unwrap();
        s.id
    });
    attempt_ops::finish(&mut w.s, &core(), &a.id, "listo").unwrap();
    if let Some(ps) = &ps {
        session_ops::detach(&mut w.s, &core(), ps).unwrap();
    }
    (w.s.attempt_row(&a.id).unwrap().unwrap(), ps)
}

fn paquete_de(task: &str, attempt: &str, provider: &str) -> String {
    build(NewPackage {
        created_at_ms: 1,
        project_id: "p-1".into(),
        task_id: task.into(),
        attempt_id: attempt.into(),
        provider: provider.into(),
        provider_session: None,
        host: "host-a".into(),
        objective: "dejar el login funcionando".into(),
        decisions: vec!["usar sesiones con cookie".into()],
        constraints: vec!["no tocar la base".into()],
        thread_summary: None,
        revision: RevisionInput::Absent("el Attempt no tiene repositorio".into()),
        uncommitted: None,
        test_results: None,
        artifacts: vec![],
        bundle: None,
    })
    .unwrap()
    .package
    .to_json()
    .to_string()
}

struct Datos<'a> {
    id: &'a str,
    task: &'a str,
    from: &'a str,
    provider: &'a str,
    wt: PathBuf,
}

fn datos<'a>(id: &'a str, task: &'a str, from: &'a str, provider: &'a str) -> Datos<'a> {
    Datos { id, task, from, provider, wt: PathBuf::from("wt") }
}

fn pide<'a>(d: &'a Datos<'a>, intent: Intent<'a>) -> ContinueRequest<'a> {
    ContinueRequest { request_id: d.id, task_id: d.task, from_attempt_id: d.from, provider: d.provider, intent, prompt: "sigue con el login", worktree: &d.wt, profile: None, model: None, effort: None }
}

fn continua(w: &mut Mundo, ctx: &MutationContext, req: &ContinueRequest<'_>) -> Result<Outcome, ContinuityError> {
    continue_attempt(&mut w.s, &w.reg, ctx, &CancelToken::new(), &Settings::default(), req)
}

fn todos(s: &Store) -> Vec<EventRow> {
    s.events_page(&EventQuery { limit: Some(1000), ..Default::default() }).unwrap().events
}

fn tipos(s: &Store) -> Vec<String> {
    todos(s).into_iter().map(|e| e.kind).collect()
}

/// Todo lo que deja rastro.
fn foto(w: &Mundo) -> Vec<i64> {
    ["attempts", "attempt_continuations", "provider_sessions", "events"].iter().map(|t| w.s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))?)).unwrap()).collect()
}

fn estado(w: &Mundo, id: &str) -> AttemptStatus {
    w.s.attempt_row(id).unwrap().unwrap().status
}

fn sesion(w: &Mundo, id: &str) -> SessionStatus {
    w.s.provider_session_row(id).unwrap().unwrap().status
}

fn ok(r: Result<Outcome, ContinuityError>) -> Outcome {
    r.unwrap_or_else(|e| panic!("debía continuar: {e}"))
}

fn err(r: Result<Outcome, ContinuityError>) -> ContinuityError {
    match r {
        Err(e) => e,
        Ok(o) => panic!("debía fallar: {:?}", o.continuation),
    }
}

// ── Resume nativo ───────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn el_resume_nativo_reanuda_la_sesion_con_su_referencia_y_deja_la_procedencia_en_los_eventos() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = terminado(&mut w, &hija, "claude", Some(REF));
    let ps = ps.unwrap();
    let antes = tipos(&w.s).len();

    let d = datos("req-1", &hija, &a1.id, "claude");
    let o = ok(continua(&mut w, &persona(), &pide(&d, Intent::Native)));
    assert!(!o.replayed && o.run.is_some());
    assert_eq!((o.attempt.n, o.attempt.status), (2, AttemptStatus::Running));
    assert_eq!((o.continuation.strategy, o.continuation.reason, o.continuation.from_n), (Strategy::NativeResume, Reason::Preferred, 1));
    assert_eq!(o.attempt.provider_session_id.as_deref(), Some(ps.as_str()));
    assert_eq!(sesion(&w, &ps), SessionStatus::Open);

    // Al adapter llegó un resume (y ningún start) con la referencia del proveedor, el mensaje y los permisos del original.
    assert!(w.claude.starts().is_empty());
    let r = &w.claude.resumes()[0];
    assert_eq!((r.attempt_id.as_str(), r.provider_ref.expose(), r.prompt.as_deref(), r.profile.as_str()), (o.attempt.id.as_str(), REF, Some("sigue con el login"), PERFIL));
    assert_eq!(r.model.as_deref(), Some("modelo-x"), "en el mismo proveedor hereda el modelo");

    // Los eventos, en orden, y ninguno lleva la referencia del proveedor.
    assert_eq!(tipos(&w.s)[antes..], ["attempt.requested", "attempt.continued", "provider_session.resumed", "attempt.started"]);
    let continuado = todos(&w.s).into_iter().find(|e| e.kind == "attempt.continued").unwrap();
    let p: Value = serde_json::from_str(&continuado.payload).unwrap();
    assert_eq!((p["task"].as_str(), p["n"].as_i64(), p["from_n"].as_i64(), p["strategy"].as_str(), p["reason"].as_str()), (Some(hija.as_str()), Some(2), Some(1), Some("native_resume"), Some("preferred")));
    assert!(p.get("package_id").is_none());
    assert_eq!(continuado.entity_id, o.attempt.id);
    assert!(todos(&w.s).iter().all(|e| !e.payload.contains(REF)), "la referencia del proveedor no viaja en ningún evento");
    // El Attempt anterior no cambió.
    assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), a1);
}

#[test]
fn repetir_el_comando_no_crea_otro_attempt_ni_vuelve_a_lanzar() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, _) = terminado(&mut w, &hija, "claude", Some(REF));
    let d = datos("req-1", &hija, &a1.id, "claude");
    let primero = ok(continua(&mut w, &persona(), &pide(&d, Intent::Native)));
    let antes = foto(&w);
    let otra_vez = ok(continua(&mut w, &persona(), &pide(&d, Intent::Native)));
    assert!(otra_vez.replayed && otra_vez.run.is_none());
    assert_eq!(otra_vez.attempt.id, primero.attempt.id);
    assert_eq!(foto(&w), antes, "un reintento no escribe");
    assert_eq!(w.claude.resumes().len(), 1, "ni vuelve a lanzar");
    // La misma clave para otra continuidad no se atiende con lo viejo.
    let con_paquete = paquete_de(&hija, &a1.id, "claude");
    let otro_proveedor = datos("req-1", &hija, &a1.id, "codex");
    assert_eq!(err(continua(&mut w, &persona(), &pide(&otro_proveedor, Intent::Package(&con_paquete)))).code, "request_conflict");
    assert_eq!(err(continua(&mut w, &persona(), &pide(&d, Intent::Package(&con_paquete)))).code, "request_conflict");
    assert_eq!(foto(&w), antes);
}

#[test]
fn hereda_los_permisos_y_sin_ellos_no_arranca() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, _) = terminado(&mut w, &hija, "claude", Some(REF));
    // Una petición con otro perfil lo usa; sin perfil, el del Attempt anterior.
    let d = datos("req-1", &hija, &a1.id, "claude");
    let mut r = pide(&d, Intent::Native);
    r.profile = Some("explorar");
    let o = ok(continua(&mut w, &persona(), &r));
    assert_eq!(o.attempt.profile.as_deref(), Some("explorar"));
    assert_eq!(w.claude.resumes()[0].profile, "explorar");

    // Un Attempt anterior sin perfil y una petición sin perfil: no hay con qué lanzar.
    let otra = w.otra.clone();
    let new = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    let b1 = attempt_ops::create(&mut w.s, &persona(), &otra, &new).unwrap();
    attempt_ops::start(&mut w.s, &core(), &b1.id).unwrap();
    attempt_ops::finish(&mut w.s, &core(), &b1.id, "").unwrap();
    let antes = foto(&w);
    let d2 = datos("req-2", &otra, &b1.id, "claude");
    let pkg = paquete_de(&otra, &b1.id, "claude");
    assert_eq!(err(continua(&mut w, &persona(), &pide(&d2, Intent::Package(&pkg)))).code, "profile_missing");
    assert_eq!(foto(&w), antes);
}

// ── Sin resume → ContextPackage ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn sin_resume_el_paquete_aportado_arranca_un_attempt_limpio_y_queda_dicho_por_que() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    w.claude.set_probe(sin_resume());
    w.reg.refresh("claude").unwrap();
    let hija = w.hija.clone();
    let (a1, ps) = terminado(&mut w, &hija, "claude", Some(REF));
    let ps = ps.unwrap();
    let pkg = paquete_de(&hija, &a1.id, "claude");
    let antes = tipos(&w.s).len();

    let d = datos("req-1", &hija, &a1.id, "claude");
    let o = ok(continua(&mut w, &persona(), &pide(&d, Intent::Auto { package: Some(&pkg) })));
    assert_eq!((o.continuation.strategy, o.continuation.reason), (Strategy::ContextPackage, Reason::ResumeUnsupported));
    assert_eq!(o.attempt.provider_session_id, None, "un Attempt con paquete arranca limpio");
    assert_eq!(sesion(&w, &ps), SessionStatus::Idle, "la sesión no se toca");
    assert!(w.claude.resumes().is_empty(), "no se llamó a resume: no se finge continuidad");
    let lanzado = &w.claude.starts()[0];
    assert!(lanzado.prompt.contains("dejar el login funcionando") && lanzado.prompt.contains("sigue con el login"), "el paquete y el mensaje van juntos");
    assert_eq!(tipos(&w.s)[antes..], ["attempt.requested", "attempt.continued", "attempt.started"]);
    let p: Value = serde_json::from_str(&todos(&w.s).into_iter().find(|e| e.kind == "attempt.continued").unwrap().payload).unwrap();
    assert_eq!((p["strategy"].as_str(), p["reason"].as_str(), p["package_id"].as_str()), (Some("context_package"), Some("resume_unsupported"), o.continuation.package_id.as_deref()));
}

#[test]
fn sin_resume_y_sin_paquete_no_se_hace_nada_y_el_error_dice_que_un_paquete_lo_resolveria() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    w.claude.set_probe(sin_resume());
    w.reg.refresh("claude").unwrap();
    let hija = w.hija.clone();
    let (a1, _) = terminado(&mut w, &hija, "claude", Some(REF));
    let antes = foto(&w);
    let d = datos("req-1", &hija, &a1.id, "claude");
    for intent in [Intent::Native, Intent::Auto { package: None }] {
        let e = err(continua(&mut w, &persona(), &pide(&d, intent)));
        assert_eq!((e.kind, e.code, e.fallback_available, e.attempt_id), (ErrorKind::Unsupported, "resume_unsupported", true, None));
    }
    assert_eq!(foto(&w), antes, "no hay auto-resume ni fallback silencioso: nada se creó");
    assert!(w.claude.calls().iter().all(|c| c != "start" && c != "resume"));
}

#[test]
fn un_attempt_sin_sesion_no_es_resumible_y_pide_paquete() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, _) = terminado(&mut w, &hija, "claude", None);
    let d = datos("req-1", &hija, &a1.id, "claude");
    let e = err(continua(&mut w, &persona(), &pide(&d, Intent::Native)));
    assert_eq!((e.kind, e.code, e.fallback_available), (ErrorKind::Unsupported, "session_unavailable", true));
    // Con paquete, sí: y el motivo es el real.
    let pkg = paquete_de(&hija, &a1.id, "claude");
    let o = ok(continua(&mut w, &persona(), &pide(&d, Intent::Auto { package: Some(&pkg) })));
    assert_eq!((o.continuation.strategy, o.continuation.reason), (Strategy::ContextPackage, Reason::SessionUnavailable));
}

// ── Caducada / inválida ─────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn una_sesion_fuera_de_plazo_o_cerrada_esta_caducada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = terminado(&mut w, &hija, "claude", Some(REF));
    let ps = ps.unwrap();
    let ahora = crate::orch::state::now_ms() as i64;

    // Fuera de plazo: solo si se configuró uno (por defecto no se inventa ninguno).
    let d = datos("req-1", &hija, &a1.id, "claude");
    let con_plazo = Settings { session_max_age_ms: Some(1_000) };
    let e = err(continue_attempt_at(&mut w.s, &w.reg, &persona(), &CancelToken::new(), &con_plazo, &pide(&d, Intent::Native), ahora + 60_000));
    assert_eq!((e.kind, e.code, e.fallback_available), (ErrorKind::Expired, "session_expired", true));
    let sin_plazo = continue_attempt_at(&mut w.s, &w.reg, &persona(), &CancelToken::new(), &Settings::default(), &pide(&d, Intent::Native), ahora + 60_000);
    let a2 = ok(sin_plazo).attempt;

    // Cerrada: es final.
    attempt_ops::finish(&mut w.s, &core(), &a2.id, "").unwrap();
    session_ops::close(&mut w.s, &persona(), &ps).unwrap();
    let antes = foto(&w);
    let d3 = datos("req-3", &hija, &a2.id, "claude");
    let e = err(continua(&mut w, &persona(), &pide(&d3, Intent::Native)));
    assert_eq!((e.kind, e.code), (ErrorKind::Expired, "session_expired"));
    assert_eq!(foto(&w), antes);
    // Con paquete, el fallback es explícito y dice por qué.
    let pkg = paquete_de(&hija, &a2.id, "claude");
    let o = ok(continua(&mut w, &persona(), &pide(&d3, Intent::Auto { package: Some(&pkg) })));
    assert_eq!((o.continuation.strategy, o.continuation.reason), (Strategy::ContextPackage, Reason::SessionExpired));
}

#[test]
fn si_el_proveedor_ya_no_tiene_la_sesion_el_attempt_nuevo_se_cierra_sin_fallar_y_la_sesion_caduca() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = terminado(&mut w, &hija, "claude", Some(REF));
    let ps = ps.unwrap();
    w.claude.fail_resume_with(Some(AdapterError::session_not_found()));
    let d = datos("req-1", &hija, &a1.id, "claude");
    let e = err(continua(&mut w, &persona(), &pide(&d, Intent::Native)));
    assert_eq!((e.kind, e.code, e.fallback_available), (ErrorKind::Expired, "session_expired", true));
    let nuevo = e.attempt_id.clone().expect("el Attempt nuevo se nombra");
    assert_eq!(estado(&w, &nuevo), AttemptStatus::Stopped, "nada se ejecutó: no es un fallo del Attempt");
    assert_eq!(sesion(&w, &ps), SessionStatus::Closed, "el proveedor ya no la tiene");
    assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), a1, "el Attempt histórico no se muta");

    // Reintentar con la MISMA clave devuelve lo que pasó, sin lanzar de nuevo; con paquete y otra clave sí continúa.
    w.claude.fail_resume_with(None);
    let otra_vez = ok(continua(&mut w, &persona(), &pide(&d, Intent::Native)));
    assert!(otra_vez.replayed && otra_vez.attempt.status == AttemptStatus::Stopped);
    assert!(w.claude.resumes().is_empty());
    let pkg = paquete_de(&hija, &a1.id, "claude");
    let d2 = datos("req-2", &hija, &a1.id, "claude");
    let o = ok(continua(&mut w, &persona(), &pide(&d2, Intent::Auto { package: Some(&pkg) })));
    assert_eq!((o.continuation.strategy, o.continuation.reason, o.attempt.n), (Strategy::ContextPackage, Reason::SessionExpired, 3));
}

#[test]
fn el_flujo_que_termina_con_session_not_found_cierra_la_sesion_y_el_attempt() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = terminado(&mut w, &hija, "claude", Some(REF));
    let ps = ps.unwrap();
    // Como Claude: el proceso arranca y es su resultado el que dice que no hay conversación.
    w.claude.set_script(vec![Step::Fail(AdapterError::session_not_found())]);
    let d = datos("req-1", &hija, &a1.id, "claude");
    let o = ok(continua(&mut w, &persona(), &pide(&d, Intent::Native)));
    let g = w.reg.gated("claude").unwrap();
    let RunOutcome::Failed(fallo) = g.events(o.run.as_ref().unwrap(), &CancelToken::new(), &mut |_| {}).unwrap() else { panic!("debía fallar") };
    settle_failure(&mut w.s, &o.attempt.id, &fallo);
    assert_eq!(estado(&w, &o.attempt.id), AttemptStatus::Stopped);
    assert_eq!(sesion(&w, &ps), SessionStatus::Closed);
    // Idempotente.
    settle_failure(&mut w.s, &o.attempt.id, &fallo);
    assert_eq!(estado(&w, &o.attempt.id), AttemptStatus::Stopped);
}

// ── Proveedor distinto ──────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn una_sesion_no_se_comparte_entre_proveedores_pero_un_paquete_si_cruza() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = terminado(&mut w, &hija, "claude", Some(REF));
    let ps = ps.unwrap();
    let d = datos("req-1", &hija, &a1.id, "codex");

    let antes = foto(&w);
    let e = err(continua(&mut w, &persona(), &pide(&d, Intent::Native)));
    assert_eq!((e.kind, e.code, e.fallback_available), (ErrorKind::Invalid, "provider_mismatch", true));
    let e = err(continua(&mut w, &persona(), &pide(&d, Intent::Auto { package: None })));
    assert_eq!(e.code, "provider_mismatch");
    assert_eq!(foto(&w), antes);
    assert!(w.codex.calls().iter().all(|c| c != "start" && c != "resume"), "ni siquiera se tocó al otro proveedor");

    let pkg = paquete_de(&hija, &a1.id, "claude");
    let o = ok(continua(&mut w, &persona(), &pide(&d, Intent::Auto { package: Some(&pkg) })));
    assert_eq!((o.continuation.strategy, o.continuation.reason), (Strategy::ContextPackage, Reason::ProviderChanged));
    assert_eq!(o.attempt.provider, "codex");
    assert_eq!(o.attempt.provider_session_id, None, "el Attempt de Codex no hereda la sesión de Claude");
    assert_eq!(o.attempt.model, None, "el modelo de un proveedor no se lleva a otro");
    assert_eq!(sesion(&w, &ps), SessionStatus::Idle);
    assert!(w.codex.resumes().is_empty() && w.codex.starts().len() == 1);
    assert!(w.codex.starts()[0].prompt.contains("`claude`"), "el receptor sabe de qué proveedor viene el contexto");
}

#[test]
fn con_intent_paquete_se_usa_el_paquete_aunque_el_resume_nativo_fuera_posible() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = terminado(&mut w, &hija, "claude", Some(REF));
    let ps = ps.unwrap();
    let pkg = paquete_de(&hija, &a1.id, "claude");
    let d = datos("req-1", &hija, &a1.id, "claude");
    let o = ok(continua(&mut w, &persona(), &pide(&d, Intent::Package(&pkg))));
    assert_eq!((o.continuation.strategy, o.continuation.reason), (Strategy::ContextPackage, Reason::Requested), "un Attempt limpio a petición");
    assert_eq!(sesion(&w, &ps), SessionStatus::Idle);
    assert!(w.claude.resumes().is_empty());
}

// ── Paquete inválido ────────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn un_paquete_invalido_no_inicia_ningun_attempt_ni_siquiera_si_no_se_iba_a_usar() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, _) = terminado(&mut w, &hija, "claude", Some(REF));
    let bueno = paquete_de(&hija, &a1.id, "claude");
    let manipulado = bueno.replace("dejar el login funcionando", "borrar la base de datos");
    let mut v: Value = serde_json::from_str(&bueno).unwrap();
    v["schema_version"] = 99.into();
    let version = v.to_string();
    let con_secreto = bueno.replace("no tocar la base", "token ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    let d = datos("req-1", &hija, &a1.id, "claude");
    let antes = foto(&w);
    for malo in [manipulado.as_str(), version.as_str(), con_secreto.as_str(), "no es json", ""] {
        for intent in [Intent::Package(malo), Intent::Auto { package: Some(malo) }] {
            let e = err(continua(&mut w, &persona(), &pide(&d, intent)));
            assert_eq!((e.kind, e.code, e.attempt_id), (ErrorKind::Invalid, "package_invalid", None), "{malo:.30}");
        }
    }
    assert_eq!(foto(&w), antes);
    assert!(w.claude.calls().iter().all(|c| c != "start" && c != "resume"));
}

#[test]
fn un_paquete_de_otro_attempt_o_de_otra_task_se_rechaza() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let (a1, _) = terminado(&mut w, &hija, "claude", None);
    let (b1, _) = terminado(&mut w, &otra, "claude", None);
    let d = datos("req-1", &hija, &a1.id, "claude");
    let antes = foto(&w);
    for ajeno in [paquete_de(&otra, &b1.id, "claude"), paquete_de(&hija, &format!("{hija}-a9"), "claude")] {
        assert_eq!(err(continua(&mut w, &persona(), &pide(&d, Intent::Package(&ajeno)))).code, "package_source_mismatch");
    }
    assert_eq!(foto(&w), antes);
}

// ── Entorno bloqueado y fallos de lanzamiento ───────────────────────────────────────────────────────────────────────

#[test]
fn un_entorno_bloqueado_no_se_esquiva_con_otra_estrategia_ni_falla_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = terminado(&mut w, &hija, "claude", Some(REF));
    let ps = ps.unwrap();
    w.claude.set_probe(ProbeResult::blocked(None, vec![EnvBlock::CliMissing]));
    w.reg.refresh("claude").unwrap();
    let pkg = paquete_de(&hija, &a1.id, "claude");
    let d = datos("req-1", &hija, &a1.id, "claude");
    let antes = foto(&w);
    for intent in [Intent::Native, Intent::Auto { package: Some(&pkg) }, Intent::Package(&pkg)] {
        let e = err(continua(&mut w, &persona(), &pide(&d, intent)));
        assert_eq!((e.kind, e.code, e.fallback_available), (ErrorKind::EnvironmentBlocked, "environment_blocked", false));
    }
    assert_eq!(foto(&w), antes);
    assert_eq!(estado(&w, &a1.id), AttemptStatus::Done);
    assert_eq!(sesion(&w, &ps), SessionStatus::Idle);
}

#[test]
fn un_bloqueo_que_llega_al_lanzar_cancela_el_attempt_nuevo_sin_marcarlo_failed_y_deja_la_sesion_lista() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = terminado(&mut w, &hija, "claude", Some(REF));
    let ps = ps.unwrap();
    w.claude.fail_resume_with(Some(AdapterError::environment_blocked(EnvBlock::CliMissing)));
    let d = datos("req-1", &hija, &a1.id, "claude");
    let e = err(continua(&mut w, &persona(), &pide(&d, Intent::Native)));
    assert_eq!((e.kind, e.fallback_available), (ErrorKind::EnvironmentBlocked, false));
    let nuevo = e.attempt_id.unwrap();
    assert_eq!(estado(&w, &nuevo), AttemptStatus::Stopped);
    assert_eq!(sesion(&w, &ps), SessionStatus::Idle, "se puede reintentar cuando el entorno se arregle");
    // Y con la clave nueva, ya arreglado, continúa.
    w.claude.fail_resume_with(None);
    let o = ok(continua(&mut w, &persona(), &pide(&datos("req-2", &hija, &a1.id, "claude"), Intent::Native)));
    assert_eq!(o.attempt.n, 3);
}

#[test]
fn un_fallo_del_proveedor_al_lanzar_si_deja_el_attempt_nuevo_failed() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, ps) = terminado(&mut w, &hija, "claude", Some(REF));
    let ps = ps.unwrap();
    w.claude.fail_resume_with(Some(AdapterError::provider("el servicio devolvió 500")));
    let d = datos("req-1", &hija, &a1.id, "claude");
    let e = err(continua(&mut w, &persona(), &pide(&d, Intent::Native)));
    assert_eq!((e.kind, e.code), (ErrorKind::Failed, "launch_failed"));
    let nuevo = w.s.attempt_row(&e.attempt_id.unwrap()).unwrap().unwrap();
    assert_eq!((nuevo.status, nuevo.failure_reason.as_deref()), (AttemptStatus::Failed, Some("launch_failed")));
    assert_eq!(sesion(&w, &ps), SessionStatus::Idle);
    assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap(), a1);
}

// ── Quién y sobre qué ───────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn solo_una_persona_el_coordinador_o_el_core_continuan_un_attempt() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, _) = terminado(&mut w, &hija, "claude", Some(REF));
    let d = datos("req-1", &hija, &a1.id, "claude");
    let ajeno = MutationContext { actor: Actor::Agent("otra-task".into()), channel: Channel::Lxo, client_id: None };
    let antes = foto(&w);
    assert_eq!(err(continua(&mut w, &ajeno, &pide(&d, Intent::Native))).code, "not_allowed");
    assert_eq!(foto(&w), antes);
    ok(continua(&mut w, &core(), &pide(&d, Intent::Native)));
}

#[test]
fn no_se_continua_un_attempt_que_corre_ni_el_de_otra_task_ni_el_que_no_existe() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let new = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: Some(PERFIL.into()), external: false, requires_approval: false };
    let activo = attempt_ops::create(&mut w.s, &persona(), &hija, &new).unwrap();
    attempt_ops::start(&mut w.s, &core(), &activo.id).unwrap();
    let (b1, _) = terminado(&mut w, &otra, "claude", None);
    let antes = foto(&w);
    let casos = [
        (datos("r1", &hija, &activo.id, "claude"), "source_not_final"),
        (datos("r2", &hija, &b1.id, "claude"), "source_not_in_task"),
        (datos("r3", &hija, "no-existe", "claude"), "source_missing"),
    ];
    for (d, codigo) in &casos {
        let pkg = paquete_de(&hija, d.from, "claude");
        assert_eq!(err(continua(&mut w, &persona(), &pide(d, Intent::Package(&pkg)))).code, *codigo);
    }
    assert_eq!(foto(&w), antes);
}

#[test]
fn una_peticion_mal_formada_se_rechaza_antes_de_leer_nada() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let (a1, _) = terminado(&mut w, &hija, "claude", Some(REF));
    let antes = foto(&w);
    for id in ["", "con espacio", "ñandú", &"x".repeat(65)] {
        let d = datos(id, &hija, &a1.id, "claude");
        assert_eq!(err(continua(&mut w, &persona(), &pide(&d, Intent::Native))).code, "invalid_request", "{id:?}");
    }
    let d = datos("ok", &hija, &a1.id, "claude");
    let mut vacio = pide(&d, Intent::Native);
    vacio.prompt = "  ";
    assert_eq!(err(continua(&mut w, &persona(), &vacio)).code, "invalid_request");
    let desconocido = datos("ok", &hija, &a1.id, "no-registrado");
    assert_eq!(err(continua(&mut w, &persona(), &pide(&desconocido, Intent::Native))).code, "invalid_request");
    assert_eq!(foto(&w), antes);
}

// ── La política, sin E/S ────────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn la_tabla_de_la_politica_cubre_todas_las_combinaciones() {
    let sesiones = [SessionFacts::Usable, SessionFacts::Unavailable("sin sesión"), SessionFacts::Expired("cerrada")];
    let resumes = [CapabilityState::Available, CapabilityState::Unsupported, CapabilityState::unavailable("sin login")];
    let mut nativos = 0;
    for same in [true, false] {
        for r in &resumes {
            for s in &sesiones {
                let b = native_blocker(same, r, s);
                let esperado = if !same {
                    Some(Reason::ProviderChanged)
                } else if !r.is_available() {
                    Some(Reason::ResumeUnsupported)
                } else {
                    match s {
                        SessionFacts::Usable => None,
                        SessionFacts::Unavailable(_) => Some(Reason::SessionUnavailable),
                        SessionFacts::Expired(_) => Some(Reason::SessionExpired),
                    }
                };
                assert_eq!(b.as_ref().map(|b| b.reason), esperado, "same={same} resume={r:?} sesión={s:?}");
                nativos += b.is_none() as u32;
                // Cada intención con y sin paquete: la estrategia es la que dice la política, nunca otra.
                for pkg in [false, true] {
                    let nativo_libre = b.is_none();
                    assert_eq!(decide(&Intent::Native, b.clone(), pkg).is_ok(), nativo_libre);
                    assert_eq!(decide(&Intent::Package(""), b.clone(), pkg).unwrap().strategy, Strategy::ContextPackage);
                    let auto = decide(&Intent::Auto { package: None }, b.clone(), pkg);
                    match (nativo_libre, pkg) {
                        (true, _) => assert_eq!(auto.unwrap().strategy, Strategy::NativeResume),
                        (false, true) => assert_eq!(auto.unwrap().strategy, Strategy::ContextPackage),
                        (false, false) => assert!(auto.unwrap_err().fallback_available),
                    }
                }
            }
        }
    }
    assert_eq!(nativos, 1, "solo uno de los 18 casos permite el resume nativo: mismo proveedor, resume disponible y sesión que sirve");
}
