//! Evidencia canónica del despacho de un Attempt (LXO-141, fase 2b).
//!
//! El claim de despacho (`attempts.dispatch_claim`, migración 020) es una reserva de un solo uso que se confirma antes de
//! cualquier efecto externo. Este módulo reúne SOLO lecturas: decide si los hechos durables de un Attempt (`attempt.started`
//! y su evento terminal) son los que el Core habría emitido. Las escrituras del claim viven en `attempts.rs`, el único
//! módulo que escribe la tabla.
//!
//! Protocolo del despacho: reservar el claim → registrar `attempt.started` → marcar el claim `started` → llamar al
//! proveedor. Por eso un claim sin `attempt.started` prueba que el proveedor NO se llamó (ver
//! [`has_canonical_dispatch_terminal_evidence`]).
use rusqlite::Connection;

use super::attempts::{AttemptRow, AttemptStatus};
use super::error::StoreResult;
use super::initial_approval::valid_person_actor_id;
use super::tasks::{TaskOrigin, TaskRow};

#[derive(Debug)]
pub(super) struct DispatchEvidenceEvent {
    pub(super) seq: i64,
    pub(super) kind: String,
    pub(super) version: i64,
    pub(super) class: String,
    pub(super) actor_kind: String,
    pub(super) actor_id: Option<String>,
    pub(super) channel: Option<String>,
    pub(super) run_id: Option<String>,
    pub(super) project_id: Option<String>,
    pub(super) payload: String,
    pub(super) client_id: Option<String>,
    pub(super) correlation_id: Option<String>,
}

/// Eventos del ciclo de vida del Attempt relevantes para el despacho, en orden de secuencia.
fn dispatch_lifecycle_events(tx: &Connection, attempt_id: &str, only_started: bool) -> StoreResult<Vec<DispatchEvidenceEvent>> {
    let kinds = if only_started {
        "('attempt.started')"
    } else {
        "('attempt.started', 'attempt.completed', 'attempt.failed', 'attempt.stopped', 'attempt.exited')"
    };
    let mut stmt = tx.prepare(&format!(
        "SELECT seq, kind, v, class, actor_kind, actor_id, channel, run_id, project_id, payload, client_id, correlation_id
         FROM events
         WHERE entity_kind='attempt' AND entity_id=?1 AND kind IN {kinds}
         ORDER BY seq"
    ))?;
    let rows = stmt.query_map([attempt_id], |row| {
        Ok(DispatchEvidenceEvent {
            seq: row.get(0)?,
            kind: row.get(1)?,
            version: row.get(2)?,
            class: row.get(3)?,
            actor_kind: row.get(4)?,
            actor_id: row.get(5)?,
            channel: row.get(6)?,
            run_id: row.get(7)?,
            project_id: row.get(8)?,
            payload: row.get(9)?,
            client_id: row.get(10)?,
            correlation_id: row.get(11)?,
        })
    })?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

pub(super) fn terminal_event_kind(status: AttemptStatus) -> Option<&'static str> {
    match status {
        AttemptStatus::Done => Some("attempt.completed"),
        AttemptStatus::Failed => Some("attempt.failed"),
        AttemptStatus::Stopped => Some("attempt.stopped"),
        AttemptStatus::Exited => Some("attempt.exited"),
        AttemptStatus::PendingApproval
        | AttemptStatus::Starting
        | AttemptStatus::Running
        | AttemptStatus::Waiting
        | AttemptStatus::AwaitingTerminalApproval => None,
    }
}

pub(super) fn active_status_name(value: Option<&str>) -> bool {
    matches!(
        value,
        Some("starting" | "running" | "waiting" | "awaiting_terminal_approval")
    )
}

pub(super) fn canonical_dispatch_payload(
    event: &DispatchEvidenceEvent,
    attempt: &AttemptRow,
) -> bool {
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload) else {
        return false;
    };
    let Some(fields) = payload.as_object() else {
        return false;
    };
    if fields.get("task").and_then(serde_json::Value::as_str) != Some(attempt.task_id.as_str())
        || fields.get("n").and_then(serde_json::Value::as_i64) != Some(attempt.n)
    {
        return false;
    }

    match event.kind.as_str() {
        "attempt.started" => fields.len() == 2,
        "attempt.completed" => {
            fields.len() == 3
                && fields.get("has_summary").and_then(serde_json::Value::as_bool)
                    == Some(!attempt.summary.is_empty())
        }
        "attempt.failed" => {
            let valid_reason = matches!(
                attempt.failure_reason.as_deref(),
                Some(
                    "launch_failed"
                        | "terminal_approval_timeout"
                        | "agent_idle_timeout"
                        | "agent_reported"
                )
            );
            fields.len() == 4
                && valid_reason
                && fields.get("reason").and_then(serde_json::Value::as_str)
                    == attempt.failure_reason.as_deref()
                && fields.get("has_summary").and_then(serde_json::Value::as_bool)
                    == Some(!attempt.summary.is_empty())
        }
        "attempt.stopped" => {
            fields.len() == 4
                && active_status_name(fields.get("from").and_then(serde_json::Value::as_str))
                && matches!(
                    fields.get("cause").and_then(serde_json::Value::as_str),
                    Some("cancelled" | "run_closed")
                )
        }
        "attempt.exited" => {
            fields.len() == 3
                && active_status_name(fields.get("from").and_then(serde_json::Value::as_str))
        }
        _ => false,
    }
}

pub(super) fn canonical_dispatch_event(
    event: &DispatchEvidenceEvent,
    expected_kind: &str,
    attempt: &AttemptRow,
    task: &TaskRow,
) -> bool {
    event.kind == expected_kind
        && event.version == 1
        && event.class == "state"
        && canonical_dispatch_actor(event, attempt, expected_kind)
        && event.run_id.as_deref() == Some(task.run_id.as_str())
        && event.project_id == task.project_id
        && canonical_dispatch_payload(event, attempt)
}

pub(super) fn canonical_dispatch_actor(
    event: &DispatchEvidenceEvent,
    attempt: &AttemptRow,
    kind: &str,
) -> bool {
    let system_core = event.actor_kind == "system"
        && event.actor_id.is_none()
        && event.channel.as_deref() == Some("core");
    let agent_lxo = event.actor_kind == "agent"
        && event.actor_id.as_deref() == Some(attempt.task_id.as_str())
        && event.channel.as_deref() == Some("lxo");
    let person_client = event.actor_kind == "person"
        && valid_person_actor_id(event.actor_id.as_deref())
        && matches!(event.channel.as_deref(), Some("ui" | "lxo"));
    // Pre-identity lifecycle events can prove that an already-started dispatch
    // reached a human-recorded terminal stop. They are not approval evidence.
    let legacy_person_terminal = kind == "attempt.stopped"
        && event.actor_kind == "person"
        && event.actor_id.is_none()
        && matches!(event.channel.as_deref(), Some("ui" | "lxo"));

    match kind {
        "attempt.started" | "attempt.exited" => system_core,
        "attempt.completed" => system_core || agent_lxo,
        "attempt.failed" => {
            if attempt.failure_reason.as_deref() == Some("launch_failed") {
                // `launch_failed` is recovery evidence only when Core recorded the typed
                // NotStarted outcome; an agent-reported code is not proof of no spawn.
                system_core
            } else {
                system_core || agent_lxo
            }
        }
        "attempt.stopped" => system_core || agent_lxo || person_client || legacy_person_terminal,
        _ => false,
    }
}

pub(super) fn terminal_event_kind_for_event(kind: &str) -> bool {
    matches!(
        kind,
        "attempt.completed" | "attempt.failed" | "attempt.stopped" | "attempt.exited"
    )
}

/// ¿Es el `from` del payload del evento exactamente `starting`? (el Attempt terminó sin haber arrancado)
fn payload_from_is_starting(event: &DispatchEvidenceEvent) -> bool {
    serde_json::from_str::<serde_json::Value>(&event.payload)
        .ok()
        .and_then(|p| p.get("from").and_then(serde_json::Value::as_str).map(|from| from == "starting"))
        .unwrap_or(false)
}

/// Una fila terminal no es prueba por sí sola: hace falta exactamente un hecho terminal canónico de ESTE Attempt y, según
/// de dónde venga el claim:
///
/// * Claim que cruzó `started` (o `ambiguous` tras haberlo hecho): además, exactamente un `attempt.started` canónico
///   anterior al terminal. Un fallo posterior al arranque con resultado desconocido sigue abierto: no es un terminal
///   conocido.
/// * Claim `reserved`/`ambiguous` **sin** `attempt.started`: como el protocolo registra `attempt.started` ANTES de llamar
///   al proveedor, que no exista prueba que el proveedor nunca se llamó. Solo vale un terminal que el Core emitió estando
///   el Attempt aún `starting`: `attempt.failed` por `launch_failed` (resultado NotStarted tipado, actor System) o
///   `attempt.stopped` con `from = starting`. Sin esto, un Attempt que falla antes de lanzar quedaba `ambiguous` para
///   siempre.
pub(super) fn has_canonical_dispatch_terminal_evidence(
    tx: &Connection,
    attempt: &AttemptRow,
    task: &TaskRow,
    from_claim: &str,
) -> StoreResult<bool> {
    let Some(expected_terminal) = terminal_event_kind(attempt.status) else {
        return Ok(false);
    };
    if attempt.origin != TaskOrigin::Core || attempt.ended_at.is_none() {
        return Ok(false);
    }
    let events = dispatch_lifecycle_events(tx, &attempt.id, false)?;
    let starts = events.iter().filter(|e| e.kind == "attempt.started").collect::<Vec<_>>();
    let terminals = events.iter().filter(|e| expected_terminal == e.kind.as_str()).collect::<Vec<_>>();
    let any_terminal = events.iter().filter(|e| terminal_event_kind_for_event(&e.kind)).count();
    if terminals.len() != 1 || any_terminal != 1 || !canonical_dispatch_event(terminals[0], expected_terminal, attempt, task) {
        return Ok(false);
    }
    let terminal = terminals[0];
    Ok(match starts.as_slice() {
        [start] => {
            attempt.started_at.is_some()
                && start.seq < terminal.seq
                && canonical_dispatch_event(start, "attempt.started", attempt, task)
        }
        [] => {
            matches!(from_claim, "reserved" | "ambiguous")
                && attempt.started_at.is_none()
                && match expected_terminal {
                    "attempt.failed" => attempt.failure_reason.as_deref() == Some("launch_failed"),
                    "attempt.stopped" => payload_from_is_starting(terminal),
                    _ => false,
                }
        }
        _ => false,
    })
}

/// El claim solo cruza `reserved -> started` si el `attempt.started` canónico ya es durable y la fila está `running`:
/// `starting` por sí solo no prueba que el despacho llegó a la frontera del traspaso.
pub(super) fn has_canonical_dispatch_started_event(tx: &Connection, attempt: &AttemptRow, task: &TaskRow) -> StoreResult<bool> {
    if attempt.started_at.is_none() || attempt.origin != TaskOrigin::Core || attempt.status != AttemptStatus::Running {
        return Ok(false);
    }
    let events = dispatch_lifecycle_events(tx, &attempt.id, true)?;
    Ok(events.len() == 1
        && events[0].client_id.is_none()
        && events[0].correlation_id.is_none()
        && canonical_dispatch_event(&events[0], "attempt.started", attempt, task))
}
