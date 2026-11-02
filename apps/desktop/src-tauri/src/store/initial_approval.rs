//! Aprobación inicial de un Attempt (LXO-141, fase 2a).
//!
//! Un Attempt que nace `pending_approval` espera la decisión de una Person autenticada hasta un plazo **durable**
//! (`initial_approval_deadline`, migración 019), fijado por el servidor al crearlo. Este módulo reúne:
//!
//! * los tipos de la decisión ([`InitialApprovalDecision`], [`InitialApprovalSnapshot`]);
//! * la **evidencia canónica**: una decisión solo cuenta si su evento es el que el Core habría emitido (actor Person con
//!   credencial vigente, canal, Project, Run, plazo) y no hay otro hecho que la contradiga;
//! * las lecturas que usa el Core: los candidatos con el plazo vencido y la instantánea de un Attempt. La expiración en sí
//!   no se escribe aquí: la hace el Core por `Core::mutate` (`attempt.rejected` con causa `approval_timeout`, actor
//!   System) y el commit del runtime revalida el plazo bajo la transacción.
//!
//! La columna del plazo solo se escribe y se lee para Attempts que requieren aprobación: el resto del almacén no
//! depende de la migración 019, que queda detrás de la barrera del corte.
use rusqlite::{params, Connection, OptionalExtension};

use super::attempts::{AttemptRow, AttemptStatus};
use super::error::{StoreError, StoreResult};
use super::events::NewEvent;
use super::tasks::{require_active, TaskRow};
use super::Store;

/// TTL fijo del servidor para una aprobación inicial, en milisegundos.
pub const INITIAL_APPROVAL_TTL_MS: i64 = 30 * 60 * 1000;

#[derive(Debug)]
pub(super) struct InitialApprovalEvidenceEvent {
    seq: i64,
    state_rev: Option<i64>,
    version: i64,
    class: String,
    actor_kind: String,
    actor_id: Option<String>,
    channel: Option<String>,
    client_id: Option<String>,
    run_id: Option<String>,
    project_id: Option<String>,
    at: i64,
    payload: String,
}

/// Decision that was durably recorded for an initial approval request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitialApprovalDecision {
    Approved,
    Rejected,
    Expired,
    RunClosed,
}

/// Durable facts needed by the authenticated initial-approval RPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InitialApprovalSnapshot {
    pub status: AttemptStatus,
    pub deadline_ms: Option<i64>,
    pub decision: Option<InitialApprovalDecision>,
}

/// Person identity uses the same constraints as a registered client principal. A blank or
/// malformed actor id cannot be treated as authenticated merely because the channel is UI/LXO.
pub(super) fn valid_person_actor_id(actor_id: Option<&str>) -> bool {
    actor_id.is_some_and(|id| {
        !id.trim().is_empty()
            && id == id.trim()
            && id.len() <= 200
            && !id.chars().any(char::is_control)
    })
}

/// A durable human decision is trusted only when both identities resolve to a
/// registered, non-revoked Person credential when the decision was recorded.
pub(super) fn has_authenticated_person_identity(
    conn: &Connection,
    actor_id: Option<&str>,
    client_id: Option<&str>,
    channel: Option<&str>,
    at: i64,
) -> StoreResult<bool> {
    let (Some(actor_id), Some(client_id), Some(surface)) = (
        actor_id.filter(|id| valid_person_actor_id(Some(*id))),
        client_id.filter(|id| valid_person_actor_id(Some(*id))),
        match channel {
            Some("ui") => Some("desktop"),
            Some("lxo") => Some("cli"),
            _ => None,
        },
    ) else {
        return Ok(false);
    };
    if at <= 0 {
        return Ok(false);
    }

    let authenticated: bool = conn.query_row(
        "SELECT EXISTS (
            SELECT 1
            FROM clients AS c
            JOIN client_credentials AS credential ON credential.client_id = c.client_id
            WHERE c.client_id = ?1
              AND c.surface = ?2
              AND c.created_at <= ?3
              AND (c.revoked_at IS NULL OR c.revoked_at > ?3)
              AND credential.principal_kind = 'person'
              AND credential.principal_id = ?4
              AND credential.created_at <= ?3
              AND (credential.revoked_at IS NULL OR credential.revoked_at > ?3)
        )",
        params![client_id, surface, at, actor_id],
        |row| row.get(0),
    )?;
    Ok(authenticated)
}

/// Check the canonical persisted Person decision used by initial approval recovery. Keep the
/// actor/channel rule aligned with dispatch-terminal reconciliation: only a valid Person id
/// from the authenticated UI or LXO context is evidence.
pub(super) fn has_canonical_initial_person_decision(
    conn: &Connection,
    attempt_id: &str,
    task_id: &str,
    n: i64,
    kind: &str,
    cause: Option<&str>,
    deadline: Option<i64>,
) -> StoreResult<bool> {
    let scope: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT run_id, project_id FROM tasks WHERE id=?1",
            [task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((expected_run, expected_project)) = scope else {
        return Ok(false);
    };
    let mut stmt = conn.prepare(
        "SELECT v, class, actor_kind, actor_id, channel, client_id, run_id, project_id, at, payload
         FROM events
         WHERE kind=?1 AND entity_kind='attempt' AND entity_id=?2
         ORDER BY seq",
    )?;
    let rows = stmt.query_map(params![kind, attempt_id], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, String>(9)?,
        ))
    })?;

    for row in rows {
        let (
            version,
            class,
            actor_kind,
            actor_id,
            channel,
            client_id,
            run_id,
            project_id,
            at,
            raw_payload,
        ) = row?;
        if version != 1
            || class != "decision"
            || actor_kind != "person"
            || run_id.as_deref() != Some(expected_run.as_str())
            || project_id.as_deref() != expected_project.as_deref()
            || !has_authenticated_person_identity(
                conn,
                actor_id.as_deref(),
                client_id.as_deref(),
                channel.as_deref(),
                at,
            )?
            || (kind == "attempt.approved"
                && !deadline.is_some_and(|deadline| at > 0 && at < deadline))
        {
            continue;
        }

        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&raw_payload) else {
            continue;
        };
        let Some(fields) = payload.as_object() else {
            continue;
        };
        let expected_len = if cause.is_some() { 3 } else { 2 };
        if fields.len() == expected_len
            && fields.get("task").and_then(serde_json::Value::as_str) == Some(task_id)
            && fields.get("n").and_then(serde_json::Value::as_i64) == Some(n)
            && cause.is_none_or(|expected| {
                fields.get("cause").and_then(serde_json::Value::as_str) == Some(expected)
            })
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn initial_approval_evidence_events(
    conn: &Connection,
    kind: &str,
    entity_kind: &str,
    entity_id: &str,
) -> StoreResult<Vec<InitialApprovalEvidenceEvent>> {
    let mut stmt = conn.prepare(
        "SELECT seq, state_rev, v, class, actor_kind, actor_id, channel, client_id,
                run_id, project_id, at, payload
         FROM events
         WHERE kind=?1 AND entity_kind=?2 AND entity_id=?3
         ORDER BY seq",
    )?;
    let rows = stmt.query_map(params![kind, entity_kind, entity_id], |row| {
        Ok(InitialApprovalEvidenceEvent {
            seq: row.get(0)?,
            state_rev: row.get(1)?,
            version: row.get(2)?,
            class: row.get(3)?,
            actor_kind: row.get(4)?,
            actor_id: row.get(5)?,
            channel: row.get(6)?,
            client_id: row.get(7)?,
            run_id: row.get(8)?,
            project_id: row.get(9)?,
            at: row.get(10)?,
            payload: row.get(11)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// A `run_closed` rejection only resolves the historical snapshot when it is backed by
/// the canonical forced `run.closed` event from the same runtime commit. A matching
/// payload fragment or a non-Person actor alone is not sufficient evidence.
pub(super) fn has_canonical_run_closed_rejection(
    conn: &Connection,
    attempt_id: &str,
    task_id: &str,
    n: i64,
) -> StoreResult<bool> {
    let scope: Option<(String, Option<String>, String, Option<String>, i64)> = conn
        .query_row(
            "SELECT t.run_id, t.project_id, r.root_task_id, root.project_id, r.closed
             FROM tasks t
             JOIN runs r ON r.id=t.run_id
             JOIN tasks root ON root.id=r.root_task_id
             WHERE t.id=?1",
            [task_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((run_id, task_project, root_task, root_project, run_closed)) = scope else {
        return Ok(false);
    };
    if run_closed != 1 || n <= 0 || attempt_id != format!("{task_id}-a{n}") {
        return Ok(false);
    }

    let rejected_events = initial_approval_evidence_events(conn, "attempt.rejected", "attempt", attempt_id)?;
    let mut rejected = Vec::new();
    for event in rejected_events {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload) else {
            continue;
        };
        let Some(fields) = payload.as_object() else {
            continue;
        };
        if fields.get("cause").and_then(serde_json::Value::as_str) == Some("run_closed") {
            rejected.push((event, fields.len() == 3
                && fields.get("task").and_then(serde_json::Value::as_str) == Some(task_id)
                && fields.get("n").and_then(serde_json::Value::as_i64) == Some(n)));
        }
    }
    if rejected.len() != 1 {
        return Ok(false);
    }
    let (rejection, payload_is_canonical) = &rejected[0];
    let Some(state_rev) = rejection.state_rev.filter(|rev| *rev > 0) else {
        return Ok(false);
    };
    let rejection_actor_is_authorized = match rejection.actor_kind.as_str() {
        "person" => has_authenticated_person_identity(
            conn,
            rejection.actor_id.as_deref(),
            rejection.client_id.as_deref(),
            rejection.channel.as_deref(),
            rejection.at,
        )?,
        "agent" => {
            rejection.actor_id.as_deref() == Some(root_task.as_str())
                && rejection.channel.as_deref() == Some("lxo")
        }
        "system" => {
            rejection.actor_id.is_none()
                && rejection.client_id.is_none()
                && rejection.channel.as_deref() == Some("core")
        }
        _ => false,
    };
    if rejection.version != 1
        || rejection.class != "decision"
        || rejection.run_id.as_deref() != Some(run_id.as_str())
        || rejection.project_id != task_project
        || rejection.at <= 0
        || !*payload_is_canonical
        || !rejection_actor_is_authorized
    {
        return Ok(false);
    }

    let close_events = initial_approval_evidence_events(conn, "run.closed", "run", &run_id)?;
    let mut matching_closes = Vec::new();
    for event in close_events {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload) else {
            continue;
        };
        let Some(fields) = payload.as_object() else {
            continue;
        };
        let stopped = fields.get("stopped").and_then(serde_json::Value::as_array);
        let payload_is_canonical = fields.len() == 3
            && fields.get("forced").and_then(serde_json::Value::as_bool) == Some(true)
            && stopped.is_some_and(|ids| ids.iter().all(serde_json::Value::is_string))
            && fields
                .get("stopped_total")
                .and_then(serde_json::Value::as_u64)
                .zip(stopped.map(|ids| ids.len() as u64))
                .is_some_and(|(total, listed)| total >= listed);
        let same_actor = event.actor_kind == rejection.actor_kind
            && event.actor_id == rejection.actor_id
            && event.channel == rejection.channel
            && event.client_id == rejection.client_id;
        let close_actor_is_authorized = match event.actor_kind.as_str() {
            "person" => has_authenticated_person_identity(
                conn,
                event.actor_id.as_deref(),
                event.client_id.as_deref(),
                event.channel.as_deref(),
                event.at,
            )?,
            "agent" => {
                event.actor_id.as_deref() == Some(root_task.as_str())
                    && event.channel.as_deref() == Some("lxo")
            }
            "system" => {
                event.actor_id.is_none()
                    && event.client_id.is_none()
                    && event.channel.as_deref() == Some("core")
            }
            _ => false,
        };
        if event.state_rev == Some(state_rev)
            && event.seq > rejection.seq
            && event.version == 1
            && event.class == "state"
            && event.run_id.as_deref() == Some(run_id.as_str())
            && event.project_id == root_project
            && event.at == rejection.at
            && same_actor
            && close_actor_is_authorized
            && payload_is_canonical
        {
            matching_closes.push(event);
        }
    }
    Ok(matching_closes.len() == 1)
}

pub(super) fn canonical_initial_approval_write(
    conn: &Connection,
    event: &NewEvent,
    attempt: &AttemptRow,
    task: &TaskRow,
    deadline: Option<i64>,
    now: i64,
) -> StoreResult<bool> {
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload) else {
        return Ok(false);
    };
    let Some(fields) = payload.as_object() else {
        return Ok(false);
    };

    let canonical = event.kind == "attempt.approved"
        && event.v == 1
        && event.class == super::events::EventClass::Decision
        && event.actor_kind == super::events::ActorKind::Person
        && valid_person_actor_id(event.actor_id.as_deref())
        && valid_person_actor_id(event.client_id.as_deref())
        && matches!(event.channel.as_deref(), Some("ui" | "lxo"))
        && event.run_id.as_deref() == Some(task.run_id.as_str())
        && event.project_id == task.project_id
        && event.at > 0
        && event.at <= now
        && deadline.is_some_and(|deadline| event.at < deadline && now < deadline)
        && fields.len() == 2
        && fields.get("task").and_then(serde_json::Value::as_str)
            == Some(attempt.task_id.as_str())
        && fields.get("n").and_then(serde_json::Value::as_i64) == Some(attempt.n);
    if !canonical {
        return Ok(false);
    }

    // Keep the low-level Store writer on the same credential rule as the runtime RPC:
    // a Person-shaped event is not authenticated unless its client and credential were
    // registered and active at the event timestamp. This query runs in the transition's
    // write transaction, so revocation at `event.at` fails closed as well.
    has_authenticated_person_identity(
        conn,
        event.actor_id.as_deref(),
        event.client_id.as_deref(),
        event.channel.as_deref(),
        event.at,
    )
}

/// ¿Tiene `attempts` esa columna? Las migraciones 019 y 020 quedan detrás de la barrera del corte: un Core recién cortado
/// puede llevar un rato (hasta aplicarlas) sin ellas. Las lecturas periódicas lo tratan como «no hay nada que hacer», no
/// como un error que se repite cada minuto.
pub(super) fn attempts_has_column(conn: &Connection, column: &str) -> StoreResult<bool> {
    let mut stmt = conn.prepare("SELECT 1 FROM pragma_table_info('attempts') WHERE name = ?1")?;
    Ok(stmt.exists([column])?)
}

impl Store {
    /// Lee candidatos vencidos para que el Core los procese bajo su lock.
    /// Esta consulta es deliberadamente solo una sugerencia: la transición de expiración
    /// vuelve a comprobar estado y deadline dentro de su propia transacción.
    pub fn attempt_initial_approval_expiry_candidates(
        &self,
        at: i64,
        limit: usize,
    ) -> StoreResult<Vec<String>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        self.read(|conn| {
            require_active(conn)?;
            if !attempts_has_column(conn, "initial_approval_deadline")? {
                return Ok(Vec::new());
            }
            let mut stmt = conn.prepare(
                "SELECT id FROM attempts
                 WHERE status = 'pending_approval'
                   AND initial_approval_deadline IS NOT NULL
                   AND initial_approval_deadline <= ?1
                 ORDER BY initial_approval_deadline, id LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![at, limit.min(i64::MAX as usize) as i64], |row| row.get(0))?;
            rows.collect::<Result<Vec<String>, _>>().map_err(Into::into)
        })
    }

    /// Reads the current Attempt state, deadline and its canonical initial decision.
    /// A `starting` row without a valid `attempt.approved` event is deliberately not
    /// considered approved; `run_closed` also needs its matching forced close commit.
    pub fn attempt_initial_approval_snapshot(
        &self,
        id: &str,
    ) -> StoreResult<Option<InitialApprovalSnapshot>> {
        self.read(|conn| {
            require_active(conn)?;
            let row: Option<(String, Option<i64>, String, i64)> = conn
                .query_row(
                    "SELECT status, initial_approval_deadline, task_id, n FROM attempts WHERE id=?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;
            let Some((status, deadline, task_id, n)) = row else {
                return Ok(None);
            };
            let status = AttemptStatus::parse(&status)?;
            let expired: bool = conn
                .query_row(
                    "SELECT
                       EXISTS(SELECT 1 FROM events e
                         WHERE e.kind='attempt.rejected' AND e.class='decision'
                           AND e.entity_kind='attempt' AND e.entity_id=?1
                           AND e.actor_kind='system' AND e.actor_id IS NULL AND e.channel='core'
                            AND ?2 IS NOT NULL AND e.at >= ?2
                            AND json_extract(e.payload,'$.cause')='approval_timeout'
                            AND json_extract(e.payload,'$.task')=?3
                            AND json_extract(e.payload,'$.n')=?4)",
                    rusqlite::params![id, deadline, task_id, n],
                    |row| row.get(0),
                )?;
            let approved = has_canonical_initial_person_decision(
                conn,
                id,
                &task_id,
                n,
                "attempt.approved",
                None,
                deadline,
            )?;
            let rejected = has_canonical_initial_person_decision(
                conn,
                id,
                &task_id,
                n,
                "attempt.rejected",
                Some("cancelled"),
                deadline,
            )?;
            let run_closed = has_canonical_run_closed_rejection(
                conn,
                id,
                &task_id,
                n,
            )?;
            let decisions = [approved, rejected, expired, run_closed]
                .into_iter()
                .filter(|found| *found)
                .count();
            if decisions > 1 {
                return Err(StoreError::InvalidAttempt(format!(
                    "el Attempt {id} tiene decisiones iniciales incompatibles"
                )));
            }
            let decision = if approved {
                Some(InitialApprovalDecision::Approved)
            } else if rejected {
                Some(InitialApprovalDecision::Rejected)
            } else if expired {
                Some(InitialApprovalDecision::Expired)
            } else if run_closed {
                Some(InitialApprovalDecision::RunClosed)
            } else {
                None
            };
            if (decision == Some(InitialApprovalDecision::Rejected)
                || decision == Some(InitialApprovalDecision::Expired)
                || decision == Some(InitialApprovalDecision::RunClosed))
                && status != AttemptStatus::Stopped
            {
                return Err(StoreError::InvalidAttempt(format!(
                    "la decisión inicial del Attempt {id} no coincide con su estado"
                )));
            }
            if decision == Some(InitialApprovalDecision::Approved)
                && status == AttemptStatus::PendingApproval
            {
                return Err(StoreError::InvalidAttempt(format!(
                    "el Attempt {id} conserva una aprobación pero sigue pendiente"
                )));
            }
            Ok(Some(InitialApprovalSnapshot {
                status,
                deadline_ms: deadline,
                decision,
            }))
        })
    }

}
