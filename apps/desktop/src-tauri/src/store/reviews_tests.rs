//! Pruebas del Review targeting en el almacén (migración 011, LXO-118).
//!
//! Cubren `docs/core/REVIEWS.md`: target (Attempt, HEAD), dos Attempts de una Task con revisiones independientes, un
//! HEAD movido invalida la aceptación, una revisión nueva sustituye a la anterior del mismo Attempt, la puerta de
//! integrar (D8) y la historia de decisiones inmutable.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::reviews::*;
use super::*;

static N: AtomicU64 = AtomicU64::new(0);

struct Tmp(PathBuf);

impl Tmp {
    fn new() -> Tmp {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("lixbon-review-test-{}-{}-{nanos}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
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

struct Mundo {
    s: Store,
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
        .run_create_recorded(&NewRun { objective: "login".into(), project_id: project, root: intencion("coordinar") }, 10, |r, t| {
            Ok(vec![evento("run.created", "run", &r.id, t), evento("task.created", "task", &t.id, t)])
        })
        .unwrap();
    let hija = s.task_create_child_recorded(&raiz.id, &intencion("api"), 20, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    let otra = s.task_create_child_recorded(&raiz.id, &intencion("ui"), 21, |t| Ok(evento("task.created", "task", &t.id, t))).unwrap();
    if !activo {
        s.write(|tx| Ok(tx.execute("DELETE FROM meta WHERE key = ?1", [AGENTIC_MODEL_KEY])?)).unwrap();
    }
    Mundo { s, hija: hija.id, otra: otra.id }
}

fn mundo(dir: &Path) -> Mundo {
    base(dir, true)
}

fn pide(w: &mut Mundo, task: &str) -> AttemptRow {
    let new = NewAttempt { provider: "claude".into(), model: None, effort: None, role: None, profile: None, external: false, requires_approval: false };
    w.s.attempt_create_recorded(task, &new, 100, |a, t| Ok(evento("attempt.requested", "attempt", &a.id, t))).unwrap()
}

/// Un Attempt que corrió y terminó: listo para revisar.
fn hecho(w: &mut Mundo, task: &str) -> AttemptRow {
    let a = pide(w, task);
    w.s.attempt_transition_recorded(&a.id, &AttemptAction::Start, 101, |a, _, t| Ok(evento("attempt.started", "attempt", &a.id, t))).unwrap();
    w.s.attempt_transition_recorded(&a.id, &AttemptAction::Finish { summary: String::new() }, 102, |a, _, t| Ok(evento("attempt.completed", "attempt", &a.id, t))).unwrap();
    a
}

fn revisa(w: &mut Mundo, attempt_id: &str, verdict: Verdict, head: &str, at: i64) -> StoreResult<ReviewRow> {
    let new = NewReview { verdict, head_commit: head.into(), base_commit: Some("b0b0b0".into()), comment: Some("COMENTARIO".into()), actor: "human".into() };
    w.s.review_record_recorded(attempt_id, &new, at, |r, _, _, t| Ok(evento("review.completed", "review", &r.decision_id.to_string(), t)))
}

fn invalida(w: &mut Mundo, attempt_id: &str, head: &str) -> StoreResult<ChangeOutcome> {
    w.s.review_invalidate_recorded(attempt_id, head, 500, |r, _, t| Ok(evento("review.invalidated", "review", &r.decision_id.to_string(), t)))
}

fn sql(s: &mut Store, q: &str) -> StoreResult<usize> {
    s.write(|tx| Ok(tx.execute(q, [])?))
}

fn cuenta(s: &Store, tabla: &str) -> i64 {
    s.read(|c| Ok(c.query_row(&format!("SELECT COUNT(*) FROM {tabla}"), [], |r| r.get(0))?)).unwrap()
}

fn foto(s: &Store) -> Vec<i64> {
    ["decisions", "reviews", "events"].iter().map(|t| cuenta(s, t)).collect()
}

const X: &str = "c3c3c3c3";
const Y: &str = "d4d4d4d4";

// ---------------------------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------------------------

#[test]
fn la_011_es_una_migracion_hacia_adelante_sin_cascadas() {
    let m = embedded().into_iter().find(|m| m.version == 11).expect("hay migración 011");
    assert_eq!(m.name, "reviews");
    let sin_comentarios: String = m.sql.lines().filter(|l| !l.trim_start().starts_with("--")).collect::<Vec<_>>().join("\n").to_uppercase();
    for prohibido in ["DROP ", "ALTER TABLE", "ON DELETE", "CASCADE", "BEGIN TRANSACTION", "COMMIT;", "ROLLBACK"] {
        assert!(!sin_comentarios.contains(prohibido), "la 011 no puede llevar «{prohibido}»");
    }
    let t = Tmp::new();
    let w = mundo(t.path());
    let fks = |tabla: &str| -> Vec<String> {
        w.s.read(|c| Ok(c.prepare(&format!("SELECT \"table\" || ':' || on_delete FROM pragma_foreign_key_list('{tabla}') ORDER BY 1"))?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?)).unwrap()
    };
    assert_eq!(fks("decisions"), ["attempts:NO ACTION", "tasks:NO ACTION"]);
    assert_eq!(fks("reviews"), ["attempts:NO ACTION", "decisions:NO ACTION"]);
}

/// La 011 queda congelada en cuanto se publique (ver `docs/core/MIGRACIONES.md`).
#[test]
fn la_migracion_011_tiene_el_checksum_congelado() {
    let m = embedded().into_iter().find(|m| m.version == 11).expect("existe la 011");
    assert_eq!(m.checksum(), "82e3b088bc8d21a3e3f019b054354b49a2ddae9f6961cab611be7afeb4695d5a", "una migración publicada no se edita");
}

#[test]
fn antes_del_corte_nada_escribe() {
    let t = Tmp::new();
    let mut w = base(t.path(), false);
    let antes = foto(&w.s);
    assert!(matches!(revisa(&mut w, "t3-a1", Verdict::Accepted, X, 1), Err(StoreError::AgenticModelInactive)));
    assert!(sql(&mut w.s, "INSERT INTO decisions (id, task_id, kind, actor, at) VALUES (1, 't3', 'review', 'human', 1)").unwrap_err().to_string().contains("inerte"));
    assert_eq!(foto(&w.s), antes);
}

// ---------------------------------------------------------------------------------------------
// Target y Attempts
// ---------------------------------------------------------------------------------------------

#[test]
fn dos_attempts_de_una_task_tienen_revisiones_independientes() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a1 = hecho(&mut w, &hija);
    let r1 = revisa(&mut w, &a1.id, Verdict::Accepted, X, 200).unwrap();
    assert_eq!((r1.attempt_id.as_str(), r1.head_commit.as_str(), r1.base_commit.as_deref(), r1.status), (a1.id.as_str(), X, Some("b0b0b0"), ReviewStatus::Active));
    // El retry no hereda la aceptación del intento anterior, aunque esté sobre el mismo commit (D8).
    let a2 = hecho(&mut w, &hija);
    assert_eq!(w.s.review_gate(&a2.id, X).unwrap(), Err(GateDenial::NoReview));
    assert_eq!(w.s.review_gate(&a1.id, X).unwrap(), Err(GateDenial::NotCurrentAttempt { current: a2.id.clone() }));
    revisa(&mut w, &a2.id, Verdict::Rejected, Y, 300).unwrap();
    assert_eq!(w.s.review_gate(&a2.id, Y).unwrap(), Err(GateDenial::Rejected));
    // Rechazar el Attempt 2 no toca la revisión del 1.
    assert_eq!(w.s.review_active(&a1.id).unwrap().unwrap(), r1);
    let r3 = revisa(&mut w, &a2.id, Verdict::Accepted, Y, 400).unwrap();
    assert_eq!(w.s.review_gate(&a2.id, Y).unwrap(), Ok(r3));
    assert_eq!(w.s.reviews_of_attempt(&a1.id).unwrap().len(), 1);
    assert_eq!(w.s.reviews_of_attempt(&a2.id).unwrap().iter().map(|r| r.status).collect::<Vec<_>>(), [ReviewStatus::Superseded, ReviewStatus::Active]);
}

#[test]
fn un_head_movido_invalida_la_aceptacion_y_revisar_otra_vez_la_reabre() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = hecho(&mut w, &hija);
    revisa(&mut w, &a.id, Verdict::Accepted, X, 200).unwrap();
    assert!(w.s.review_gate(&a.id, X).unwrap().is_ok());
    // Integrar otra revisión distinta de la aceptada está prohibido.
    assert_eq!(w.s.review_gate(&a.id, Y).unwrap(), Err(GateDenial::HeadMoved { reviewed: X.into() }));
    assert_eq!(invalida(&mut w, &a.id, X).unwrap(), ChangeOutcome::Unchanged, "mismo HEAD: sigue valiendo");
    assert_eq!(invalida(&mut w, &a.id, Y).unwrap(), ChangeOutcome::Changed);
    assert_eq!(invalida(&mut w, &a.id, Y).unwrap(), ChangeOutcome::Unchanged, "ya no hay revisión activa");
    let stale = w.s.reviews_of_attempt(&a.id).unwrap().pop().unwrap();
    assert_eq!((stale.status, stale.observed_head.as_deref(), stale.closed_at), (ReviewStatus::Stale, Some(Y), Some(500)));
    // La aceptación vieja ya no autoriza ni siquiera sobre su HEAD.
    assert_eq!(w.s.review_gate(&a.id, X).unwrap(), Err(GateDenial::Stale { reviewed: X.into(), observed: Y.into() }));
    revisa(&mut w, &a.id, Verdict::Accepted, Y, 600).unwrap();
    assert!(w.s.review_gate(&a.id, Y).unwrap().is_ok());
    assert_eq!(w.s.reviews_of_attempt(&a.id).unwrap().len(), 2, "la historia conserva la revisión invalidada");
    assert_eq!(invalida(&mut w, "t99-a1", Y).unwrap(), ChangeOutcome::Missing);
}

#[test]
fn invalidar_un_attempt_no_toca_las_revisiones_de_otro() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = hecho(&mut w, &hija);
    let b = hecho(&mut w, &otra);
    revisa(&mut w, &a.id, Verdict::Accepted, X, 200).unwrap();
    let rb = revisa(&mut w, &b.id, Verdict::Accepted, X, 210).unwrap();
    invalida(&mut w, &a.id, Y).unwrap();
    assert_eq!(w.s.review_active(&b.id).unwrap().unwrap(), rb);
}

#[test]
fn un_attempt_que_no_arranco_no_se_revisa_y_los_datos_se_validan() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let pendiente = pide(&mut w, &otra);
    let antes = foto(&w.s);
    assert!(matches!(revisa(&mut w, &pendiente.id, Verdict::Accepted, X, 1), Err(StoreError::ReviewConflict(m)) if m.contains("no arrancó")));
    assert!(matches!(revisa(&mut w, "t99-a1", Verdict::Accepted, X, 1), Err(StoreError::ReviewConflict(_))));
    let a = hecho(&mut w, &hija);
    for malo in ["", "abc", "C3C3C3C3", "main", &"a".repeat(65)] {
        assert!(matches!(revisa(&mut w, &a.id, Verdict::Accepted, malo, 1), Err(StoreError::InvalidReview(_))), "{malo}");
    }
    let largo = NewReview { verdict: Verdict::Rejected, head_commit: X.into(), base_commit: None, comment: Some("x".repeat(4001)), actor: "human".into() };
    assert!(matches!(w.s.review_record_recorded(&a.id, &largo, 1, |_, _, _, _| unreachable!()), Err(StoreError::InvalidReview(_))));
    assert_eq!(foto(&w.s)[..2], antes[..2]);
}

#[test]
fn el_comentario_vive_en_la_decision_y_la_historia_no_se_reescribe() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let (hija, otra) = (w.hija.clone(), w.otra.clone());
    let a = hecho(&mut w, &hija);
    let b = hecho(&mut w, &otra);
    let r = revisa(&mut w, &a.id, Verdict::Rejected, X, 200).unwrap();
    assert_eq!(w.s.review_comment(r.decision_id).unwrap().as_deref(), Some("COMENTARIO"));
    for q in [
        format!("UPDATE decisions SET actor = 'otro' WHERE id = {}", r.decision_id),
        format!("DELETE FROM decisions WHERE id = {}", r.decision_id),
        format!("DELETE FROM reviews WHERE decision_id = {}", r.decision_id),
        format!("UPDATE reviews SET verdict = 'accepted' WHERE decision_id = {}", r.decision_id),
        format!("UPDATE reviews SET head_commit = '{Y}' WHERE decision_id = {}", r.decision_id),
        // Una decisión sobre un Attempt de otra Task, o una revisión de otro Attempt que su decisión.
        format!("INSERT INTO decisions (id, task_id, attempt_id, kind, actor, at) VALUES (99, '{hija}', '{}', 'review', 'human', 1)", b.id),
        format!("INSERT INTO reviews (decision_id, attempt_id, head_commit, verdict, at) VALUES ({}, '{}', '{X}', 'accepted', 1)", r.decision_id + 50, b.id),
    ] {
        assert!(sql(&mut w.s, &q).is_err(), "{q}");
    }
    invalida(&mut w, &a.id, Y).unwrap();
    assert!(sql(&mut w.s, &format!("UPDATE reviews SET status = 'active', observed_head = NULL, closed_at = NULL WHERE decision_id = {}", r.decision_id)).is_err(), "nada vuelve a active");
}

#[test]
fn sin_su_evento_no_hay_revision_ni_se_sustituye_la_anterior() {
    let t = Tmp::new();
    let mut w = mundo(t.path());
    let hija = w.hija.clone();
    let a = hecho(&mut w, &hija);
    let r1 = revisa(&mut w, &a.id, Verdict::Accepted, X, 200).unwrap();
    let antes = foto(&w.s);
    let new = NewReview { verdict: Verdict::Rejected, head_commit: Y.into(), base_commit: None, comment: None, actor: "human".into() };
    let r = w.s.review_record_recorded(&a.id, &new, 300, |_, _, a, t| Ok(evento("review.completed", "attempt", &a.id, t)));
    assert!(matches!(r, Err(StoreError::InvalidEvent(_))), "{r:?}");
    assert_eq!(foto(&w.s), antes);
    assert_eq!(w.s.review_active(&a.id).unwrap().unwrap(), r1);
}
