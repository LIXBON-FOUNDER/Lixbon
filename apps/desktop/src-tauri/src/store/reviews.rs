//! Review targeting (LXO-118, épica F3): lado del **almacén**. Contrato: `docs/core/REVIEWS.md`.
//!
//! Guarda y lee `decisions` y `reviews` (migración `011_reviews`). Los eventos llegan de `orch::review_ops`.
//!
//! # Garantías
//! * **Target concreto.** Una revisión es `(attempt_id, head_commit)` más la base observada; nunca de la Task.
//! * **Una activa por Attempt.** Revisar otra vez deja `superseded` la anterior; un HEAD observado distinto deja la
//!   activa `stale`. Nada vuelve a `active`: reabrir es revisar de nuevo.
//! * **La puerta de integrar** ([`Store::review_gate`]) solo deja pasar el Attempt actual de su Task con su última
//!   revisión aceptada, activa y sobre el mismo HEAD (ADR D8: la de otro Attempt no autoriza aunque el commit coincida).
//! * **Historia inmutable**: una decisión no se modifica ni se borra.
//! * **Estado + evento juntos**, inerte hasta el corte.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: solo lo usan `orch::review_ops` y las pruebas

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;

use super::attempts::{attempt_in, AttemptRow, AttemptStatus};
use super::error::{StoreError, StoreResult};
use super::events::NewEvent;
use super::projects::ChangeOutcome;
use super::tasks::{insert_all, require_active, task_in, TaskRow};
use super::Store;

const MAX_COMMENT_CHARS: usize = 4000;

/// Veredicto de una revisión.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Accepted,
    Rejected,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Accepted => "accepted",
            Verdict::Rejected => "rejected",
        }
    }

    fn parse(s: &str) -> StoreResult<Verdict> {
        match s {
            "accepted" => Ok(Verdict::Accepted),
            "rejected" => Ok(Verdict::Rejected),
            otro => Err(StoreError::InvalidReview(format!("veredicto desconocido: {otro}"))),
        }
    }
}

/// Estado de una revisión.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewStatus {
    /// La vigente de su Attempt.
    Active,
    /// El HEAD observado ya no es el revisado.
    Stale,
    /// Hubo una revisión posterior del mismo Attempt.
    Superseded,
}

impl ReviewStatus {
    fn parse(s: &str) -> StoreResult<ReviewStatus> {
        match s {
            "active" => Ok(ReviewStatus::Active),
            "stale" => Ok(ReviewStatus::Stale),
            "superseded" => Ok(ReviewStatus::Superseded),
            otro => Err(StoreError::InvalidReview(format!("estado de revisión desconocido: {otro}"))),
        }
    }
}

/// Una revisión tal como está en la base.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReviewRow {
    /// La revisión es una decisión: su id.
    pub decision_id: i64,
    pub attempt_id: String,
    pub head_commit: String,
    pub base_commit: Option<String>,
    pub verdict: Verdict,
    pub at: i64,
    pub status: ReviewStatus,
    /// El HEAD que se vio al invalidarla (solo `stale`).
    pub observed_head: Option<String>,
    pub closed_at: Option<i64>,
}

/// Qué decide la persona y sobre qué revisión.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewReview {
    pub verdict: Verdict,
    pub head_commit: String,
    pub base_commit: Option<String>,
    pub comment: Option<String>,
    /// Quién decide, como en el legado (`human`).
    pub actor: String,
}

/// Por qué la puerta de integrar no deja pasar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", tag = "reason")]
pub enum GateDenial {
    /// El Attempt no existe.
    Missing,
    /// No es el Attempt actual de su Task: hay que revisar el actual (D8).
    NotCurrentAttempt { current: String },
    /// Este Attempt no tiene revisión vigente.
    NoReview,
    /// La última revisión lo rechazó.
    Rejected,
    /// El HEAD cambió desde la aceptación.
    Stale { reviewed: String, observed: String },
    /// Se pide integrar otro HEAD distinto del revisado.
    HeadMoved { reviewed: String },
}

const REVIEW_COLS: &str = "decision_id, attempt_id, head_commit, base_commit, verdict, at, status, observed_head, closed_at";

fn review_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(ReviewRow, String, String)> {
    Ok((
        ReviewRow {
            decision_id: r.get(0)?,
            attempt_id: r.get(1)?,
            head_commit: r.get(2)?,
            base_commit: r.get(3)?,
            verdict: Verdict::Accepted,
            at: r.get(5)?,
            status: ReviewStatus::Active,
            observed_head: r.get(7)?,
            closed_at: r.get(8)?,
        },
        r.get(4)?,
        r.get(6)?,
    ))
}

fn reviews_where(c: &Connection, filter: &str, arg: &dyn rusqlite::ToSql) -> StoreResult<Vec<ReviewRow>> {
    let rows = c.prepare(&format!("SELECT {REVIEW_COLS} FROM reviews WHERE {filter} ORDER BY decision_id"))?.query_map([arg], review_from_row)?.collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(mut x, verdict, status)| {
            x.verdict = Verdict::parse(&verdict)?;
            x.status = ReviewStatus::parse(&status)?;
            Ok(x)
        })
        .collect()
}

fn active_in(c: &Connection, attempt_id: &str) -> StoreResult<Option<ReviewRow>> {
    Ok(reviews_where(c, "attempt_id = ?1 AND status = 'active'", &attempt_id)?.pop())
}

fn review_in(c: &Connection, id: i64) -> StoreResult<Option<ReviewRow>> {
    Ok(reviews_where(c, "decision_id = ?1", &id)?.pop())
}

/// Un commit: hexadecimal en minúsculas, de 4 a 64 caracteres.
fn check_commit(field: &str, c: &str) -> StoreResult<()> {
    if (4..=64).contains(&c.len()) && c.chars().all(|ch| ch.is_ascii_digit() || ('a'..='f').contains(&ch)) {
        Ok(())
    } else {
        Err(StoreError::InvalidReview(format!("{field}: un commit es hexadecimal en minúsculas, de 4 a 64 caracteres")))
    }
}

fn check_new(n: &NewReview) -> StoreResult<()> {
    check_commit("head_commit", &n.head_commit)?;
    if let Some(b) = &n.base_commit {
        check_commit("base_commit", b)?;
    }
    if n.actor.trim().is_empty() {
        return Err(StoreError::InvalidReview("la decisión necesita quién la toma".into()));
    }
    if n.comment.as_ref().is_some_and(|c| c.chars().count() > MAX_COMMENT_CHARS) {
        return Err(StoreError::InvalidReview(format!("el comentario pasa de {MAX_COMMENT_CHARS} caracteres")));
    }
    Ok(())
}

fn conflict(m: impl Into<String>) -> StoreError {
    StoreError::ReviewConflict(m.into())
}

fn check_event(r: &ReviewRow, t: &TaskRow, e: &NewEvent) -> StoreResult<()> {
    if e.entity_kind != "review" || e.entity_id != r.decision_id.to_string() || e.run_id.as_deref() != Some(t.run_id.as_str()) || e.project_id != t.project_id {
        return Err(StoreError::InvalidEvent(format!("{}: el evento no se refiere a la revisión {}", e.kind, r.decision_id)));
    }
    e.check()
}

fn insert_event(tx: &rusqlite::Transaction<'_>, e: &NewEvent, projector: Option<&dyn super::events::EventProjector>) -> StoreResult<()> {
    insert_all(tx, std::slice::from_ref(e), projector).map_err(|err| match err {
        StoreError::TaskConflict(m) => StoreError::ReviewConflict(m),
        otro => otro,
    })
}

fn attempt_and_task(tx: &Connection, attempt_id: &str) -> StoreResult<(AttemptRow, TaskRow)> {
    let a = attempt_in(tx, attempt_id)?.ok_or_else(|| conflict(format!("no existe el Attempt {attempt_id}")))?;
    let t = task_in(tx, &a.task_id)?.ok_or_else(|| conflict(format!("no existe la Task {}", a.task_id)))?;
    Ok((a, t))
}

impl Store {
    /// La persona revisa el Attempt sobre `head_commit`: una decisión `review` y su revisión `active`, que deja
    /// `superseded` la anterior del MISMO Attempt (las de otros no se tocan). Un Attempt que aún no arrancó no se revisa.
    pub fn review_record_recorded(
        &mut self,
        attempt_id: &str,
        new: &NewReview,
        at: i64,
        event: impl FnOnce(&ReviewRow, Option<i64>, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ReviewRow> {
        check_new(new)?;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let (attempt, task) = attempt_and_task(tx, attempt_id)?;
            if matches!(attempt.status, AttemptStatus::PendingApproval | AttemptStatus::Starting) {
                return Err(conflict(format!("el Attempt {attempt_id} aún no arrancó: no hay nada que revisar")));
            }
            let previous = active_in(tx, attempt_id)?;
            if let Some(p) = &previous {
                tx.execute("UPDATE reviews SET status = 'superseded', closed_at = ?2 WHERE decision_id = ?1", params![p.decision_id, at.max(p.at)])?;
            }
            let id: i64 = tx.query_row("SELECT COALESCE(MAX(id), 0) + 1 FROM decisions", [], |r| r.get(0))?;
            let detail = json!({ "decision": new.verdict.as_str(), "head_commit": new.head_commit, "base_commit": new.base_commit, "comment": new.comment }).to_string();
            tx.execute(
                "INSERT INTO decisions (id, task_id, attempt_id, kind, actor, detail_json, at) VALUES (?1, ?2, ?3, 'review', ?4, ?5, ?6)",
                params![id, attempt.task_id, attempt_id, new.actor, detail, at],
            )?;
            tx.execute(
                "INSERT INTO reviews (decision_id, attempt_id, head_commit, base_commit, verdict, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, attempt_id, new.head_commit, new.base_commit, new.verdict.as_str(), at],
            )?;
            let review = review_in(tx, id)?.ok_or_else(|| conflict(format!("la revisión {id} no existe")))?;
            let e = event(&review, previous.map(|p| p.decision_id), &attempt, &task)?;
            check_event(&review, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(review)
        })
    }

    /// Se observó el HEAD `observed_head` en la rama del Attempt: si su revisión activa es de otro HEAD, pasa a `stale`
    /// (la aceptación previa deja de valer). Sin revisión activa, o con el mismo HEAD, `Unchanged`.
    pub fn review_invalidate_recorded(
        &mut self,
        attempt_id: &str,
        observed_head: &str,
        at: i64,
        event: impl FnOnce(&ReviewRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<ChangeOutcome> {
        check_commit("observed_head", observed_head)?;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(_) = attempt_in(tx, attempt_id)? else { return Ok(ChangeOutcome::Missing) };
            let Some(active) = active_in(tx, attempt_id)? else { return Ok(ChangeOutcome::Unchanged) };
            if active.head_commit == observed_head {
                return Ok(ChangeOutcome::Unchanged);
            }
            tx.execute(
                "UPDATE reviews SET status = 'stale', observed_head = ?2, closed_at = ?3 WHERE decision_id = ?1",
                params![active.decision_id, observed_head, at.max(active.at)],
            )?;
            let review = review_in(tx, active.decision_id)?.ok_or_else(|| conflict("la revisión desapareció"))?;
            let (attempt, task) = attempt_and_task(tx, attempt_id)?;
            let e = event(&review, &attempt, &task)?;
            check_event(&review, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(ChangeOutcome::Changed)
        })
    }

    /// La puerta de integrar el Attempt `attempt_id` en `head_commit`: el Attempt actual de su Task, con su revisión
    /// activa aceptada sobre ese mismo HEAD. Devuelve la revisión que autoriza, o por qué no.
    pub fn review_gate(&self, attempt_id: &str, head_commit: &str) -> StoreResult<Result<ReviewRow, GateDenial>> {
        self.read(|c| {
            let Some(a) = attempt_in(c, attempt_id)? else { return Ok(Err(GateDenial::Missing)) };
            let current: String = c.query_row("SELECT id FROM attempts WHERE task_id = ?1 ORDER BY n DESC LIMIT 1", [&a.task_id], |r| r.get(0))?;
            if current != attempt_id {
                return Ok(Err(GateDenial::NotCurrentAttempt { current }));
            }
            let last = reviews_where(c, "attempt_id = ?1", &attempt_id)?.pop();
            Ok(match last {
                None => Err(GateDenial::NoReview),
                Some(r) if r.status == ReviewStatus::Stale => Err(GateDenial::Stale { reviewed: r.head_commit, observed: r.observed_head.unwrap_or_default() }),
                Some(r) if r.status != ReviewStatus::Active => Err(GateDenial::NoReview),
                Some(r) if r.verdict == Verdict::Rejected => Err(GateDenial::Rejected),
                Some(r) if r.head_commit != head_commit => Err(GateDenial::HeadMoved { reviewed: r.head_commit }),
                Some(r) => Ok(r),
            })
        })
    }

    /// Todas las revisiones de un Attempt, de la primera a la última (la historia de decisiones).
    pub fn reviews_of_attempt(&self, attempt_id: &str) -> StoreResult<Vec<ReviewRow>> {
        self.read(|c| reviews_where(c, "attempt_id = ?1", &attempt_id))
    }

    /// La revisión vigente de un Attempt, si la hay.
    pub fn review_active(&self, attempt_id: &str) -> StoreResult<Option<ReviewRow>> {
        self.read(|c| active_in(c, attempt_id))
    }

    pub fn review_row(&self, decision_id: i64) -> StoreResult<Option<ReviewRow>> {
        self.read(|c| review_in(c, decision_id))
    }

    /// El comentario de una revisión (vive en su decisión, nunca en el evento).
    pub fn review_comment(&self, decision_id: i64) -> StoreResult<Option<String>> {
        self.read(|c| {
            let detail: Option<String> = c.query_row("SELECT detail_json FROM decisions WHERE id = ?1", [decision_id], |r| r.get(0)).optional()?.flatten();
            Ok(detail.and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok()).and_then(|v| v["comment"].as_str().map(String::from)))
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Runtime sobre las tablas (LXO-232): piezas sin evento propio. Las llama `store::runtime` dentro de la transacción de
// la mutación del runtime, cuyo hecho ya va en sus eventos. Este módulo sigue siendo el único que escribe decisions y reviews.
// ---------------------------------------------------------------------------------------------------------------------

/// Una decisión del documento con su id, atada al Attempt actual de su Task.
#[allow(clippy::too_many_arguments)]
pub(crate) fn runtime_decision_insert_in(c: &Connection, id: i64, task_id: &str, attempt_id: Option<&str>, kind: &str, actor: &str, detail_json: Option<&str>, at: i64) -> StoreResult<()> {
    require_active(c)?;
    c.execute(
        "INSERT INTO decisions (id, task_id, attempt_id, kind, actor, detail_json, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, task_id, attempt_id, kind, actor, detail_json, at],
    )?;
    Ok(())
}

/// La revisión de esa decisión sobre (Attempt, head): deja `superseded` la activa anterior de ese Attempt (LXO-118).
pub(crate) fn runtime_review_insert_in(c: &Connection, decision_id: i64, attempt_id: &str, head_commit: &str, base_commit: Option<&str>, verdict: &str, at: i64) -> StoreResult<()> {
    require_active(c)?;
    c.execute("UPDATE reviews SET status = 'superseded', closed_at = ?2 WHERE attempt_id = ?1 AND status = 'active'", params![attempt_id, at])?;
    c.execute(
        "INSERT INTO reviews (decision_id, attempt_id, head_commit, base_commit, verdict, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![decision_id, attempt_id, head_commit, base_commit, verdict, at],
    )?;
    Ok(())
}
