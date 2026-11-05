//! Steer y Stop & Send (LXO-144, épica F5): la parte del comando que toca el almacén. Contrato: `docs/core/STEER.md`.
//!
//! Son DOS comandos distintos, no dos formas de encolar. Ninguno cae al otro ni a la cola (`attempt.queue`) en silencio:
//!
//! | comando | qué hace | capability que exige |
//! |---|---|---|
//! | `attempt.steer` | inyecta la instrucción en el turno EN CURSO | `steer` |
//! | `attempt.stop_and_send` | interrumpe el turno, espera a que el stop se confirme y envía la instrucción como turno nuevo | `interrupt` + `resume` |
//!
//! Cada petición deja un par de Events unidos por `request_id`: `attempt.instruction_requested` (el Core la aceptó y va a intentarla)
//! y `attempt.instruction_result` (lo que pasó). Nunca llevan el texto de la instrucción. El orden de las cosas lo lleva
//! `steer_runtime.rs`; aquí está lo que lee y escribe el almacén: la autorización, las validaciones y los dos Events.
//!
//! # Decisiones
//! 1. **Quién**: una persona o el agente que coordina la Task (como la cola). El Core no instruye a nadie: la automatización es F9.
//!    La policy efectiva por actor/Attempt (LXO-209) todavía no existe: hasta entonces la validación es la del actor.
//! 2. **Cuándo**: solo un Attempt `running` con una ejecución viva. Uno terminado es `attempt_final`; uno que espera una respuesta
//!    (`waiting`, `awaiting_terminal_approval`) o aún no ha arrancado es `busy`: lo que se le diga entonces es un `answer`.
//! 3. **Todo o nada antes de actuar**: la capability, la sesión y el estado se comprueban ANTES de escribir nada o de tocar el proveedor.
//!    Una petición rechazada no deja Events.
//! 4. **Idempotencia** (`steer_runtime`): la clave es del cliente; repetirla devuelve el resultado que ya hubo sin volver a llamar al
//!    proveedor. Reutilizarla para otra instrucción es `request_conflict`.

#![cfg_attr(not(test), allow(dead_code))]

use super::adapter::{AdapterError, ErrorCode};
use super::attempt_ops::{self, person_or_manager};
use super::events::MutationContext;
use super::queue_commands::{attempt_of, check_request_id, from_store, not_allowed, ErrorKind, QueueError};
use super::state::now_ms;
use crate::store::{AttemptRow, InstructionMode, InstructionOutcome, NewEvent, QueueFailure, Store};

/// Una instrucción admite hasta 20 000 caracteres, como las de la cola.
pub(super) const MAX_INSTRUCTION_CHARS: usize = 20_000;

/// Lee el Attempt y comprueba que `ctx` puede instruirlo.
pub(super) fn authorize(st: &Store, ctx: &MutationContext, attempt_id: &str) -> Result<AttemptRow, QueueError> {
    let attempt = attempt_of(st, attempt_id)?;
    if !person_or_manager(st, ctx, &attempt.task_id).map_err(from_store)? {
        return Err(not_allowed(&format!("instruir a {}", attempt.id), ctx));
    }
    Ok(attempt)
}

/// La clave y el texto, antes de escribir nada.
pub(super) fn validate(request_id: &str, body: &str) -> Result<(), QueueError> {
    check_request_id(request_id)?;
    let chars = body.chars().count();
    if body.trim().is_empty() {
        return Err(QueueError::new(ErrorKind::Invalid, "invalid_request", "la instrucción no puede estar vacía"));
    }
    if chars > MAX_INSTRUCTION_CHARS {
        return Err(QueueError::new(ErrorKind::Invalid, "invalid_request", format!("la instrucción admite hasta {MAX_INSTRUCTION_CHARS} caracteres")));
    }
    Ok(())
}

/// ¿Está el Attempt en un momento en que Steer y Stop & Send valen? `None`: sí.
pub(super) fn state_refusal(attempt: &AttemptRow) -> Option<QueueError> {
    use crate::store::AttemptStatus as S;
    match attempt.status {
        S::Running => None,
        s if s.is_final() => Some(QueueError::new(ErrorKind::Invalid, "attempt_final", format!("el Attempt {} ya terminó: no admite instrucciones", attempt.id))),
        S::Waiting | S::AwaitingTerminalApproval => {
            Some(QueueError::new(ErrorKind::Busy, "not_running", format!("el Attempt {} espera una respuesta: lo que se le diga ahora es una respuesta, no una instrucción", attempt.id)))
        }
        S::PendingApproval | S::Starting | S::Done | S::Failed | S::Stopped | S::Exited => {
            Some(QueueError::new(ErrorKind::Busy, "not_running", format!("el Attempt {} todavía no está en marcha", attempt.id)))
        }
    }
}

/// El error con que se rechaza la petición cuando el proveedor no ofrece la capability. `code` dice cuál comando (nunca se cae al otro).
pub(super) fn capability_refusal(e: &AdapterError, code: &'static str) -> QueueError {
    match e.code {
        ErrorCode::EnvironmentBlocked => QueueError::new(ErrorKind::EnvironmentBlocked, "environment_blocked", e.message.clone()),
        ErrorCode::UnsupportedCapability | ErrorCode::CapabilityUnavailable | ErrorCode::UnknownCapability => QueueError::new(ErrorKind::Unsupported, code, e.message.clone()),
        ErrorCode::UnknownProvider | ErrorCode::UnknownRun | ErrorCode::SessionNotFound | ErrorCode::InvalidRequest | ErrorCode::Cancelled | ErrorCode::Provider | ErrorCode::Internal => {
            QueueError::new(ErrorKind::Failed, "adapter_error", e.message.clone())
        }
    }
}

/// El motivo cerrado con que queda registrado un fallo del adapter (el mismo conjunto que la cola).
pub(super) fn reason_of(e: &AdapterError) -> QueueFailure {
    super::queue_commands::failure_of(e)
}

/// El hecho `attempt.instruction_requested`: el Core aceptó la petición y va a intentarla. Lo escribe el almacén (`store_boot.rs`).
pub(super) fn requested_event(st: &Store, ctx: &MutationContext, attempt_id: &str, request_id: &str, mode: InstructionMode, chars: i64) -> Result<NewEvent, QueueError> {
    let (attempt, task) = rows(st, attempt_id)?;
    attempt_ops::instruction_requested_fact(&attempt, &task, request_id, mode, chars, ctx, now_ms() as i64).map_err(from_store)
}

/// El hecho `attempt.instruction_result`: lo que pasó con esa petición.
pub(super) fn result_event(st: &Store, ctx: &MutationContext, attempt_id: &str, request_id: &str, mode: InstructionMode, outcome: InstructionOutcome, reason: Option<QueueFailure>) -> Result<NewEvent, QueueError> {
    let (attempt, task) = rows(st, attempt_id)?;
    attempt_ops::instruction_result_fact(&attempt, &task, request_id, mode, outcome, reason, ctx, now_ms() as i64).map_err(from_store)
}

fn rows(st: &Store, attempt_id: &str) -> Result<(AttemptRow, crate::store::TaskRow), QueueError> {
    let attempt = attempt_of(st, attempt_id)?;
    let task = st.task_row(&attempt.task_id).map_err(from_store)?.ok_or_else(|| QueueError::new(ErrorKind::Failed, "store", "no se encontró la Task del Attempt"))?;
    Ok((attempt, task))
}
