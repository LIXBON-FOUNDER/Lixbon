//! Pruebas de ProviderSession y Thread en el almacén (migración 009, LXO-115).
//!
//! Cubren `docs/core/SESIONES_THREADS.md`: proveedor resumible y no resumible, Attempt con y sin sesión, lecturas por
//! Attempt, ciclo de vida cerrado (Rust contra trigger), referencia opaca fijada una vez y sin forma de credencial,
//! Thread sin estado de ejecución y estado + evento atómicos. Los eventos se construyen a mano: el contrato de los
//! hechos se prueba en `orch/session_ops_tests.rs`.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::sessions::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-session-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

/// Un almacén con el corte hecho, un Run con su raíz y dos hijas (`hija` y `otra`).
struct Mundo {
    s: Store,
    raiz: String,
    hija: String,
    otra: String,
}

fn evento(kind: &str, entity_kind: &str, entity_id: &str, t: &TaskRow) -> NewEvent {
    NewEvent {
        id: new_uuid_v7(),
        at: 1_000,
        v: 1,
        kind: kind.into(),
        class: EventClass::State,
        actor_kind: ActorKind::System,
        actor_id: None,
        channel: Some("core".into()),
        client_id: None,
        project_id: t.project_id.clone(),
        run_id: Some(t.run_id.clone()),
        entity_kind: entity_kind.into(),
        entity_id: entity_id.into(),
        correlation_id: None,
        idem_key: None,
        payload: "{}".into(),
    }
}

fn base(dir: &Path, activo: bool) -> Mundo {
    let mut s = Store::open_with(dir, &embedded(), "t").unwrap();
    let loc = NewLocation { machine: "m1".into(), path: "c:/app".into(), display_path: "C:/app".into(), primary: true };
    let project = s.project_create("app", &Fingerprint::default(), &loc).unwrap().id;
    s.meta_set(AGENTIC_MODEL_KEY, AGENTIC_MODEL).unwrap();
    let intencion = |t: &str| NewTaskIntent { title: t.into(), spec: String::new(), repo: "c:/app".into() };
    let (_, raiz) = s
        .run_create_recorded(&NewRun { objective: "login".into(), project_id: project.clone(), root: intencion("coordinar") }, 10, |r, t| {
            Ok(vec![evento("run.created", "run", &r.id, t), evento("task.created", "task", &t.id, t)])
        })
        .unwrap();
    let hija = s.task_create_child_recorded(&raiz.id, &intencion("api"), 20, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    let otra = s.task_create_child_recorded(&raiz.id, &intencion("ui"), 21, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    if !activo {
        s.write(|tx| Ok(tx.execute("DELETE FROM meta WHERE key = ?1", [AGENTIC_MODEL_KEY])?)).unwrap();
    }
    Mundo { s, raiz: raiz.id, hija: hija.id, otra: otra.id }
}

fn mundo(dir: &Path) -> Mundo {
    base(dir, true)
}

fn attempt(w: &mut Mundo, task: &str, provider: &str, at: i64) -> AttemptRow {
    let new = NewAttempt { provider: provider.into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    let a = w.s.attempt_create_recorded(task, &new, at, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap();
    w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, at + 1, |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, t))).unwrap();
    a
}

fn termina(w: &mut Mundo, id: &str, at: i64) {
    let r = w.s.attempt_transition_recorded(id, &AttemptAction::Finish { summary: String::new() }, at, |a, _, t| Ok(evento("attempt.completed", "attempt", &a.id, t)));
    assert_eq!(r.unwrap(), ChangeOutcome::Changed);
}

fn abre(w: &mut Mundo, attempt_id: &str, resumable: bool, external_ref: Option<(&str, SessionBinding)>, at: i64) -> StoreResult<ProviderSessionRow> {
    let new = NewProviderSession { resumable, external_ref: external_ref.map(|(r, b)| (r.to_string(), b)) };
    w.s.provider_session_open_recorded(attempt_id, &new, at, |s, _, t| Ok(evento("provider_session.opened", "provider_session", &s.id, t)))
}

fn fija(w: &mut Mundo, id: &str, r: &str, b: SessionBinding) -> StoreResult<ChangeOutcome> {
    w.s.provider_session_bind_recorded(id, r, b, 500, |s, t| Ok(evento("provider_session.bound", "provider_session", &s.id, t)))
}

fn paso(w: &mut Mundo, id: &str, step: SessionStep, at: i64) -> StoreResult<ChangeOutcome> {
    w.s.provider_session_transition_recorded(id, step, at, |s, _, t| Ok(evento("provider_session.step", "provider_session", &s.id, t)))
}

fn reanuda(w: &mut Mundo, id: &str, attempt_id: &str, at: i64) -> StoreResult<ChangeOutcome> {
    w.s.provider_session_resume_recorded(id, attempt_id, at, |s, _, t| Ok(evento("provider_session.resumed", "provider_session", &s.id, t)))
}

fn thread(w: &mut Mundo, task: &str) -> StoreResult<ThreadRow> {
    w.s.thread_open_recorded(task, 300, |th, t| Ok(evento("thread.created", "thread", &th.id, t)))
}

fn resume(w: &mut Mundo, id: &str, summary: Option<&str>) -> StoreResult<ChangeOutcome> {
    w.s.thread_summary_set_recorded(id, summary, 400, |th, t| Ok(evento("thread.summarized", "thread", &th.id, t)))
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

/// Todo lo que deja rastro.
fn foto(s: &Store) -> Vec<i64> {
    ["provider_sessions", "threads", "thread_messages", "events", "attempts"].iter().map(|t| cuenta(s, t)).collect()
}

fn conflicto<T: std::fmt::Debug>(r: StoreResult<T>, contiene: &str) {
    match r {
        Err(StoreError::SessionConflict(m)) => assert!(m.contains(contiene), "«{m}» no menciona «{contiene}»"),
        otro => panic!("se esperaba SessionConflict ({contiene}): {otro:?}"),
    }
}

fn invalido<T: std::fmt::Debug>(r: StoreResult<T>) {
    assert!(matches!(r, Err(StoreError::InvalidSession(_))), "se esperaba InvalidSession: {r:?}");
}

// ---------------------------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------------------------

#[test]
fn la_009_es_una_migracion_hacia_adelante_sin_cwd_time_ni_cascadas() {
    let m = embedded().into_iter().find(|m| m.version == 9).expect("hay migración 009");
    assert_eq!(m.name, "sessions_threads");
    let sin_comentarios: String = m.sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n").to_uppercase();
    for prohibido in ["DROP ", "ALTER TABLE", "ON DELETE", "CASCADE", "BEGIN TRANSACTION", "COMMIT", "ROLLBACK", "CWD_TIME"] {
        assert!(!sin_comentarios.contains(prohibido), "la 009 no puede llevar «{prohibido}»");
    }
    let t = Tmp::new();
    let w = mundo(t.path());
    let fks = |tabla: &str| -> Vec<(String, String)> {
        w.s.read(|c| Ok(c.prepare(&format!("SELECT \"table\", on_delete FROM pragma_foreign_key_list('{tabla}') ORDER BY \"table\""))?.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?)).unwrap()
    };
    let no_action = |t: &str| (t.to_string(), "NO ACTION".to_string());
    assert_eq!(fks("provider_sessions"), [no_action("attempts"), no_action("tasks")]);
    assert_eq!(fks("threads"), [no_action("runs"), no_action("tasks")]);
    assert_eq!(fks("thread_messages"), [no_action("attempts"), no_action("tasks"), no_action("tasks"), no_action("thread_messages"), no_action("threads")]);
    let indices: Vec<String> = w.s.read(|c| Ok(c.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    for i in ["attempts_by_provider_session", "provider_sessions_by_task", "provider_sessions_external_ref", "thread_messages_by_attempt", "thread_messages_by_thread"] {
        assert!(indices.contains(&i.to_string()), "falta el índice {i}");
    }
    // La sesión no guarda nada del proceso ni del archivo interno del proveedor: solo la referencia opaca.
    let columnas: Vec<String> = w.s.read(|c| Ok(c.prepare("SELECT name FROM pragma_table_info('provider_sessions') ORDER BY cid")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert_eq!(columnas, ["id", "task_id", "opened_by_attempt_id", "provider", "external_ref", "binding", "resumable", "status", "created_at", "updated_at", "closed_at", "origin"]);
}

/// La 009 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_009_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 9).expect("existe la 009");
    assert_eq!(m.checksum(), "51167f2b0898821608a749901b3924240038dfb655c2be6a0560ad84f50ddbb2", "una migración publicada no se edita");
}

#[test]
fn antes_del_corte_nada_escribe_ni_por_el_almacen_ni_por_sql() {
    let t = Tmp::new();
    let mut w = base(t.path(), false);
    let antes = foto(&w.s);
    let r = w.s.provider_session_open_recorded("t3-a1", &NewProviderSession { resumable: true, external_ref: None }, 1, |_, _, _| unreachable!());
    assert!(matches!(r, Err(StoreError::AgenticModelInactive)), "{r:?}");
    assert!(matches!(w.s.thread_open_recorded(&w.raiz.clone(), 1, |_, _| unreachable!()), Err(StoreError::AgenticModelInactive)));
    for q in [
        format!("INSERT INTO threads (id, task_id, run_id, origin) VALUES ('th-{0}', '{0}', 'r1', 'legacy')", w.raiz),
        "INSERT INTO provider_sessions (id, task_id, opened_by_attempt_id, provider, resumable, status, created_at, updated_at, origin) VALUES ('ps-x', 'x', 'x', 'claude', 1, 'open', 1, 1, 'legacy')".into(),
    ] {
        assert!(sql(&mut w.s, &q).unwrap_err().to_string().contains("inerte"), "{q}");
    }
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// ProviderSession
// ---------------------------------------------------------------------------------------------

#[test]
fn un_proveedor_resumible_deja_la_sesion_en_espera_y_el_seguimiento_la_reanuda() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = attempt(&mut w, &hija, "claude", 100);
    let s = abre(&mut w, &a1.id, true, Some(("6f1c2a9e-0b7d-4d1e-9a51-3c2f8e7d9b10", SessionBinding::StreamJson)), 110).unwrap();
    assert_eq!((s.id.as_str(), s.status, s.resumable, s.binding), (format!("ps-{}", a1.id).as_str(), SessionStatus::Open, true, Some(SessionBinding::StreamJson)));
    assert_eq!(w.s.attempt_row(&a1.id).unwrap().unwrap().provider_session_id.as_deref(), Some(s.id.as_str()));

    // Mientras el Attempt corre, la sesión no queda en espera.
    conflicto(paso(&mut w, &s.id, SessionStep::Detach, 120), "sigue corriendo");
    termina(&mut w, &a1.id, 130);
    assert_eq!(paso(&mut w, &s.id, SessionStep::Detach, 140).unwrap(), ChangeOutcome::Changed);
    assert_eq!(paso(&mut w, &s.id, SessionStep::Detach, 141).unwrap(), ChangeOutcome::Unchanged);

    let a2 = attempt(&mut w, &hija, "claude", 200);
    assert_eq!(reanuda(&mut w, &s.id, &a2.id, 210).unwrap(), ChangeOutcome::Changed);
    assert_eq!(reanuda(&mut w, &s.id, &a2.id, 211).unwrap(), ChangeOutcome::Unchanged, "reintento idempotente");

    // Lecturas por Attempt: los dos intentos corren en la sesión que abrió el primero.
    assert_eq!(w.s.provider_session_of_attempt(&a2.id).unwrap().unwrap().id, s.id);
    assert_eq!(w.s.attempts_of_provider_session(&s.id).unwrap().iter().map(|a| a.n).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(w.s.provider_sessions_of_task(&hija).unwrap().len(), 1);
    assert_eq!(w.s.provider_session_row(&s.id).unwrap().unwrap().status, SessionStatus::Open);
}

#[test]
fn un_proveedor_sin_resume_no_queda_en_espera_y_el_retry_no_tiene_sesion() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = attempt(&mut w, &hija, "codex", 100);
    let s = abre(&mut w, &a1.id, false, None, 110).unwrap();
    termina(&mut w, &a1.id, 120);
    conflicto(paso(&mut w, &s.id, SessionStep::Detach, 130), "no es resumible");
    // Ni por SQL: `idle` exige `resumable = 1`.
    assert!(sql(&mut w.s, &format!("UPDATE provider_sessions SET status = 'idle' WHERE id = '{}'", s.id)).is_err());
    assert_eq!(paso(&mut w, &s.id, SessionStep::Close, 140).unwrap(), ChangeOutcome::Changed);
    let cerrada = w.s.provider_session_row(&s.id).unwrap().unwrap();
    assert_eq!((cerrada.status, cerrada.closed_at), (SessionStatus::Closed, Some(140)));

    // El retry nace sin sesión: un Attempt puede carecer de sesión resumible.
    let a2 = attempt(&mut w, &hija, "codex", 200);
    assert_eq!(w.s.provider_session_of_attempt(&a2.id).unwrap(), None);
    conflicto(reanuda(&mut w, &s.id, &a2.id, 210), "cerrada");
}

#[test]
fn un_attempt_sin_sesion_es_valido_y_las_lecturas_lo_dicen() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = attempt(&mut w, &hija, "claude", 100);
    assert_eq!(w.s.provider_session_of_attempt(&a.id).unwrap(), None);
    assert_eq!(w.s.provider_session_of_attempt("t99-a1").unwrap(), None);
    assert!(w.s.provider_sessions_of_task(&hija).unwrap().is_empty());
    termina(&mut w, &a.id, 110);
    conflicto(abre(&mut w, &a.id, true, None, 120), "ya terminó");
}

#[test]
fn la_referencia_es_opaca_se_fija_una_vez_y_no_admite_credenciales() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = attempt(&mut w, &hija, "codex", 100);
    let s = abre(&mut w, &a.id, true, None, 110).unwrap();
    assert_eq!((s.external_ref.as_deref(), s.binding), (None, None), "nace sin referencia hasta que el adapter la entregue");
    // Opaca: el Core no la interpreta (una ruta con espacios del legado o un uuid valen igual).
    let r = "C:/Users/Ana María/.codex/sessions/rollout-1.jsonl";
    assert_eq!(fija(&mut w, &s.id, r, SessionBinding::SessionId).unwrap(), ChangeOutcome::Changed);
    assert_eq!(fija(&mut w, &s.id, r, SessionBinding::SessionId).unwrap(), ChangeOutcome::Unchanged);
    conflicto(fija(&mut w, &s.id, "otra", SessionBinding::SessionId), "no cambia");
    // Única por proveedor.
    let b = attempt(&mut w, &otra, "codex", 200);
    conflicto(abre(&mut w, &b.id, true, Some((r, SessionBinding::SessionId)), 210), "otra sesión de codex");
    // Nada con forma de credencial, ni vacío, ni con control. No se escribe nada.
    let antes = foto(&w.s);
    for malo in ["sk-ant-api03-AAAAAAAAAAAAAAAA", "ghp_0123456789abcdefghij", "Bearer abc.def", "", "  ", "a\nb", &"x".repeat(MAX_EXTERNAL_REF_CHARS + 1)] {
        invalido(abre(&mut w, &b.id, true, Some((malo, SessionBinding::SessionId)), 220));
    }
    assert_eq!(foto(&w.s), antes);
    // `cwd_time` no es un vínculo: la base no lo admite.
    assert!(sql(&mut w.s, &format!("UPDATE provider_sessions SET external_ref = 'y', binding = 'cwd_time' WHERE id = '{}'", s.id)).is_err());
    assert!(sql(&mut w.s, &format!("UPDATE provider_sessions SET external_ref = NULL, binding = NULL WHERE id = '{}'", s.id)).is_err(), "la referencia fijada no se borra");
}

#[test]
fn reanudar_exige_la_misma_task_el_mismo_proveedor_y_una_sesion_en_espera() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a1 = attempt(&mut w, &hija, "claude", 100);
    let s = abre(&mut w, &a1.id, true, None, 110).unwrap();
    let b = attempt(&mut w, &otra, "claude", 120);
    conflicto(reanuda(&mut w, &s.id, &b.id, 130), "en espera");
    termina(&mut w, &a1.id, 140);
    paso(&mut w, &s.id, SessionStep::Detach, 150).unwrap();
    conflicto(reanuda(&mut w, &s.id, &b.id, 160), "no es de la Task");
    let a2 = attempt(&mut w, &hija, "claude", 170);
    let antes = foto(&w.s);
    conflicto(reanuda(&mut w, &s.id, &a1.id, 180), "ya terminó");
    assert_eq!(reanuda(&mut w, "ps-nada", &a2.id, 180).unwrap(), ChangeOutcome::Missing);
    assert_eq!(foto(&w.s), antes);
    // Ni por SQL se enlaza un Attempt a la sesión de otra Task, a una que no existe o a una cerrada.
    assert!(sql(&mut w.s, &format!("UPDATE attempts SET provider_session_id = '{}' WHERE id = '{}'", s.id, b.id)).is_err());
    assert!(sql(&mut w.s, &format!("UPDATE attempts SET provider_session_id = 'ps-nada' WHERE id = '{}'", a2.id)).is_err());
    paso(&mut w, &s.id, SessionStep::Close, 190).unwrap();
    assert!(sql(&mut w.s, &format!("UPDATE attempts SET provider_session_id = '{}' WHERE id = '{}'", s.id, a2.id)).is_err());
}

#[test]
fn la_tabla_de_transiciones_de_rust_cuadra_con_el_trigger() {
    for from in SessionStatus::ALL {
        for to in SessionStatus::ALL {
            if from == to {
                continue;
            }
            let t = Tmp::new();
            let mut w = mundo(t.path());
            let hija = w.hija.clone();
            let a = attempt(&mut w, &hija, "claude", 100);
            sql(
                &mut w.s,
                &format!("INSERT INTO provider_sessions (id, task_id, opened_by_attempt_id, provider, resumable, status, created_at, updated_at, origin) VALUES ('ps-{0}', '{1}', '{0}', 'claude', 1, '{2}', 1, 1, 'legacy')", a.id, hija, from.as_str()),
            )
            .unwrap();
            let r = sql(&mut w.s, &format!("UPDATE provider_sessions SET status = '{}' WHERE id = 'ps-{}'", to.as_str(), a.id));
            assert_eq!(r.is_ok(), session_transition_allowed(from, to), "{} -> {}: {r:?}", from.as_str(), to.as_str());
        }
    }
    assert!(!session_transition_allowed(SessionStatus::Closed, SessionStatus::Open), "una sesión cerrada es final");
}

#[test]
fn una_sesion_cerrada_es_final_y_ninguna_se_borra() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = attempt(&mut w, &hija, "claude", 100);
    let s = abre(&mut w, &a.id, true, None, 110).unwrap();
    assert!(sql(&mut w.s, &format!("DELETE FROM provider_sessions WHERE id = '{}'", s.id)).is_err());
    assert_eq!(paso(&mut w, &s.id, SessionStep::Close, 120).unwrap(), ChangeOutcome::Changed);
    assert_eq!(paso(&mut w, &s.id, SessionStep::Close, 121).unwrap(), ChangeOutcome::Unchanged);
    conflicto(paso(&mut w, &s.id, SessionStep::Detach, 122), "no puede pasar de closed a idle");
    conflicto(fija(&mut w, &s.id, "tarde", SessionBinding::StreamJson), "cerrada");
    assert!(sql(&mut w.s, &format!("UPDATE provider_sessions SET updated_at = 999 WHERE id = '{}'", s.id)).is_err());
    conflicto(w.s.provider_session_transition_recorded(&s.id, SessionStep::Resume, 1, |_, _, _| unreachable!()), "usa provider_session_resume_recorded");
}

#[test]
fn sin_su_evento_no_hay_sesion_ni_enlace() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = attempt(&mut w, &hija, "claude", 100);
    let antes = foto(&w.s);
    // Un evento que no se refiere a la sesión deshace todo, también el enlace del Attempt.
    let r = w.s.provider_session_open_recorded(&a.id, &NewProviderSession { resumable: true, external_ref: None }, 110, |_, a, t| Ok(evento("provider_session.opened", "attempt", &a.id, t)));
    assert!(matches!(r, Err(StoreError::InvalidEvent(_))), "{r:?}");
    assert_eq!(foto(&w.s), antes);
    assert_eq!(w.s.attempt_row(&a.id).unwrap().unwrap().provider_session_id, None);
}

// ---------------------------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------------------------

#[test]
fn el_thread_es_de_la_task_y_no_dice_nada_del_estado_del_attempt() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let th = thread(&mut w, &hija).unwrap();
    assert_eq!((th.id.as_str(), th.summary.as_deref(), th.created_at), (format!("th-{hija}").as_str(), None, Some(300)));
    conflicto(thread(&mut w, &hija), "ya tiene su Thread");
    let a = attempt(&mut w, &hija, "claude", 100);
    assert_eq!(w.s.thread_of_attempt(&a.id).unwrap().unwrap().id, th.id);
    assert_eq!(w.s.thread_of_task(&hija).unwrap().unwrap(), th);
    // Terminar el Attempt no toca el Thread: no es fuente de verdad de su estado.
    termina(&mut w, &a.id, 120);
    assert_eq!(w.s.thread_row(&th.id).unwrap().unwrap(), th);
    let cols: Vec<String> = w.s.read(|c| Ok(c.prepare("SELECT name FROM pragma_table_info('threads')")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap();
    assert!(!cols.iter().any(|c| c.contains("status") || c.contains("attempt")), "{cols:?}");
}

#[test]
fn una_task_descartada_no_abre_thread() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let otra = w.otra.clone();
    w.s.task_set_discarded_recorded(&otra, true, 50, |t| Ok(evento("task.discarded", "task", &t.id, t))).unwrap();
    conflicto(thread(&mut w, &otra), "descartada");
    conflicto(thread(&mut w, "t99"), "no existe");
}

#[test]
fn el_resumen_del_thread_es_corto_y_nunca_guarda_secretos() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let raiz = w.raiz.clone();
    let th = thread(&mut w, &raiz).unwrap();
    assert_eq!(resume(&mut w, &th.id, Some("Login listo; falta la revisión de t3 (commit 0123456789abcdef0123456789abcdef01234567)")).unwrap(), ChangeOutcome::Changed);
    assert_eq!(resume(&mut w, &th.id, Some("Login listo; falta la revisión de t3 (commit 0123456789abcdef0123456789abcdef01234567)")).unwrap(), ChangeOutcome::Unchanged);
    let antes = foto(&w.s);
    for malo in ["usa OPENAI token=abc123", "clave sk-proj-ABCDEFGHIJKLMNOP", "-----BEGIN OPENSSH PRIVATE KEY-----", "Authorization: Basic x", "", &"x".repeat(MAX_THREAD_SUMMARY_CHARS + 1)] {
        invalido(resume(&mut w, &th.id, Some(malo)));
    }
    assert_eq!(foto(&w.s), antes);
    assert_eq!(resume(&mut w, &th.id, None).unwrap(), ChangeOutcome::Changed);
    assert_eq!(w.s.thread_row(&th.id).unwrap().unwrap().summary, None);
    assert_eq!(resume(&mut w, "th-nada", None).unwrap(), ChangeOutcome::Missing);
}

#[test]
fn looks_secret_no_confunde_ids_ni_commits_con_credenciales() {
    for ok in ["6f1c2a9e-0b7d-4d1e-9a51-3c2f8e7d9b10", "/home/ana/.codex/sessions/rollout-t3.jsonl", "0123456789abcdef0123456789abcdef01234567", "task-skip", "sk-8"] {
        assert!(!looks_secret(ok), "{ok}");
    }
    for malo in ["sk-ant-api03-xxxxxxxxxx", "GHP_ABCDEFGHIJKLMNOP", "(xoxb-123456789012)", "AKIAABCDEFGHIJKLMNOP", "password=hunter2"] {
        assert!(looks_secret(malo), "{malo}");
    }
}

#[test]
fn los_mensajes_del_thread_no_se_reescriben_ni_se_atribuyen_a_otro_attempt() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (raiz, hija, otra) = (w.raiz.clone(), w.hija.clone(), w.otra.clone());
    let th = thread(&mut w, &hija).unwrap();
    let a = attempt(&mut w, &hija, "claude", 100);
    let b = attempt(&mut w, &otra, "claude", 100);
    let msg = |id: i64, from: &str, to: &str, att: &str| {
        format!("INSERT INTO thread_messages (id, thread_id, from_task_id, to_task_id, from_attempt_id, kind, body, read, at) VALUES ({id}, '{}', '{from}', '{to}', {att}, 'question', '¿users o accounts?', 0, 5)", th.id)
    };
    sql(&mut w.s, &msg(1, &hija, &raiz, &format!("'{}'", a.id))).unwrap();
    sql(&mut w.s, &msg(2, &raiz, &hija, "NULL")).unwrap();
    assert!(sql(&mut w.s, &msg(3, &hija, &raiz, &format!("'{}'", b.id))).is_err(), "el Attempt de otra Task no envía por esta");
    assert_eq!(w.s.thread_messages(&th.id).unwrap().iter().map(|m| m.id).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(w.s.thread_messages_of_attempt(&a.id).unwrap().len(), 1);
    sql(&mut w.s, "UPDATE thread_messages SET read = 1 WHERE id = 1").unwrap();
    assert!(sql(&mut w.s, "UPDATE thread_messages SET body = 'otra cosa' WHERE id = 1").is_err());
    assert!(sql(&mut w.s, "DELETE FROM thread_messages WHERE id = 1").is_err());
    assert!(sql(&mut w.s, &format!("DELETE FROM threads WHERE id = '{}'", th.id)).is_err());
}
