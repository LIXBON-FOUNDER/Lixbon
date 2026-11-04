//! Steer y Stop & Send conectados al runtime (LXO-144): el orden de las cosas y el RPC de Desktop. Contrato: `docs/core/STEER.md`.
//!
//! ```text
//! Core::instruct(ctx, mode, petición)
//!   1. autorizar (persona o quien coordina la Task) y validar clave y texto       <- antes de escribir
//!   2. ¿ya se atendió esta clave?  -> el MISMO resultado, sin llamar al proveedor (otra instrucción con ella: request_conflict)
//!   3. ¿Attempt `running` con una ejecución viva? ¿el proveedor ofrece la capability? <- si no, error y NADA se escribe
//!   4. attempt.instruction_requested
//!   5. steer:          Gated::steer(handle, texto)
//!      stop_and_send:  pending_send + Gated::interrupt(handle); el BOMBEO confirma el stop y reanuda con el texto (live_run.rs)
//!   6. attempt.instruction_result  { delivered | failed | stop_failed | stop_timeout }
//! ```
//!
//! # Invariantes
//! * Steer nunca cae a la cola ni a Stop; Stop & Send no es «Steer y luego parar». Sin la capability, error (`steer_unsupported` /
//!   `stop_send_unsupported`) y nada se escribe.
//! * Stop & Send no envía NADA hasta que el adapter ha confirmado el stop (`events` ha vuelto). Si no se confirma a tiempo, la
//!   instrucción pendiente se RETIRA: un stop tardío no envía después de que la persona haya visto «no se confirmó».
//! * Un stop fallido o sin confirmar nunca se presenta como éxito: el resultado es `stop_failed` / `stop_timeout` y el error lo dice.
//! * Un cliente que repite la petición no duplica la instrucción: la clave se atiende UNA vez por proceso (la ejecución viva muere
//!   con él; tras un reinicio el Attempt ya no está `running` y repetirla es `attempt_final`/`busy`).

use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::adapter::{Capability, Gated};
use super::events::{Channel, MutationContext};
use super::live_run::{PendingSend, SendVerdict, Verdict};
use super::queue_commands::{ErrorKind, QueueError};
use super::steer_commands as cmd;
use super::Core;
use crate::store::{AttemptRow, InstructionMode, InstructionOutcome, QueueFailure};

/// Cuánto espera Stop & Send a que el stop se confirme. Pasado, es `stop_timeout`.
pub(super) const STOP_WAIT: Duration = Duration::from_secs(15);
/// Si al vencer el plazo el bombeo ya había recogido la instrucción, su veredicto está a punto de llegar.
const VERDICT_GRACE: Duration = Duration::from_secs(5);
/// Cuántas peticiones recuerda el Core para repetirlas sin llamar al proveedor.
const LOG_CAP: usize = 512;

// ── Idempotencia ─────────────────────────────────────────────────────────────────────────────────────────────────────

enum Entry {
    /// Se está atendiendo ahora mismo: una repetición simultánea no la ejecuta por segunda vez.
    InFlight { digest: u64 },
    Done { digest: u64, result: Result<Value, QueueError> },
}

enum Begin {
    Started,
    Replay(Result<Value, QueueError>),
    Conflict,
    InFlight,
}

pub(super) struct InstructionState {
    log: Mutex<HashMap<(String, String), Entry>>,
    stop_wait_ms: AtomicU64,
}

impl Default for InstructionState {
    fn default() -> Self {
        InstructionState { log: Mutex::new(HashMap::new()), stop_wait_ms: AtomicU64::new(STOP_WAIT.as_millis() as u64) }
    }
}

impl InstructionState {
    fn log(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), Entry>> {
        self.log.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn begin(&self, attempt: &str, request_id: &str, digest: u64) -> Begin {
        let mut log = self.log();
        let key = (attempt.to_string(), request_id.to_string());
        match log.get(&key) {
            Some(Entry::InFlight { digest: d }) => return if *d == digest { Begin::InFlight } else { Begin::Conflict },
            Some(Entry::Done { digest: d, result }) => return if *d == digest { Begin::Replay(result.clone()) } else { Begin::Conflict },
            None => {}
        }
        if log.len() >= LOG_CAP {
            // Acotado: lo ya resuelto se olvida (lo que sigue en vuelo no).
            log.retain(|_, entry| matches!(entry, Entry::InFlight { .. }));
        }
        log.insert(key, Entry::InFlight { digest });
        Begin::Started
    }

    fn finish(&self, attempt: &str, request_id: &str, digest: u64, result: Result<Value, QueueError>) {
        self.log().insert((attempt.to_string(), request_id.to_string()), Entry::Done { digest, result });
    }

    /// La petición no llegó a actuar (se rechazó antes): no deja rastro, puede repetirse.
    fn abort(&self, attempt: &str, request_id: &str) {
        self.log().remove(&(attempt.to_string(), request_id.to_string()));
    }

    fn stop_wait(&self) -> Duration {
        Duration::from_millis(self.stop_wait_ms.load(Ordering::SeqCst))
    }

    #[cfg(test)]
    pub(super) fn set_stop_wait(&self, wait: Duration) {
        self.stop_wait_ms.store(wait.as_millis() as u64, Ordering::SeqCst);
    }
}

fn digest_of(mode: InstructionMode, body: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    mode.as_str().hash(&mut hasher);
    body.hash(&mut hasher);
    hasher.finish()
}

// ── El comando ───────────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub(super) struct Instruction<'a> {
    pub request_id: &'a str,
    pub attempt_id: &'a str,
    pub body: &'a str,
}

fn invalid(code: &'static str, message: impl Into<String>) -> QueueError {
    QueueError::new(ErrorKind::Invalid, code, message)
}

/// Lo que dice el resultado a quien lo pidió.
fn answer(mode: InstructionMode, i: &Instruction<'_>, replayed: bool) -> Value {
    json!({"status": if replayed { "Replayed" } else { "Delivered" }, "mode": mode.as_str(), "attempt_id": i.attempt_id, "request_id": i.request_id})
}

fn replayed(result: Result<Value, QueueError>) -> Result<Value, QueueError> {
    result.map(|mut v| {
        v["status"] = json!("Replayed");
        v
    })
}

impl Core {
    /// `attempt.steer` / `attempt.stop_and_send`. Ver el diagrama del módulo.
    pub(super) fn instruct(&self, ctx: &MutationContext, mode: InstructionMode, i: &Instruction<'_>) -> Result<Value, QueueError> {
        let attempt = self.instruction_authorize(ctx, i.attempt_id)?;
        cmd::validate(i.request_id, i.body)?;
        let digest = digest_of(mode, i.body);
        match self.instructions.begin(&attempt.id, i.request_id, digest) {
            Begin::Started => {}
            Begin::Replay(result) => return replayed(result),
            Begin::Conflict => return Err(invalid("request_conflict", "ese request_id ya se usó para otra instrucción")),
            Begin::InFlight => return Err(QueueError::new(ErrorKind::Busy, "in_progress", "esa petición se está atendiendo ahora mismo")),
        }
        // Comprobaciones previas: si falla alguna NO se ha escrito nada ni tocado el proveedor, y la clave queda libre.
        let live = match self.instruction_preflight(mode, &attempt) {
            Ok(live) => live,
            Err(refusal) => {
                self.instructions.abort(&attempt.id, i.request_id);
                return Err(refusal);
            }
        };
        if let Err(why) = self.instruction_requested(ctx, &attempt.id, i.request_id, mode, i.body.chars().count() as i64) {
            self.instructions.abort(&attempt.id, i.request_id);
            return Err(why);
        }
        let result = match mode {
            InstructionMode::Steer => self.steer_now(ctx, &attempt, i, &live),
            InstructionMode::StopAndSend => self.stop_and_send_now(ctx, &attempt, i, &live),
        };
        self.instructions.finish(&attempt.id, i.request_id, digest, result.clone());
        result
    }

    fn instruction_preflight(&self, mode: InstructionMode, attempt: &AttemptRow) -> Result<super::live_run::LiveView, QueueError> {
        if let Some(refusal) = cmd::state_refusal(attempt) {
            return Err(refusal);
        }
        let live = self.live_view(&attempt.task_id).filter(|live| live.attempt_id == attempt.id).ok_or_else(|| {
            QueueError::new(ErrorKind::Busy, "not_running", format!("el Attempt {} no tiene una ejecución viva a la que instruir", attempt.id))
        })?;
        match mode {
            InstructionMode::Steer => live.matrix.require(Capability::Steer).map_err(|e| cmd::capability_refusal(&e, "steer_unsupported"))?,
            InstructionMode::StopAndSend => {
                // Parar sin poder enviar después dejaría a la persona con un Attempt interrumpido y su instrucción perdida: las DOS o ninguna.
                live.matrix.require(Capability::Interrupt).map_err(|e| cmd::capability_refusal(&e, "stop_send_unsupported"))?;
                live.matrix.require(Capability::Resume).map_err(|e| cmd::capability_refusal(&e, "stop_send_unsupported"))?;
                let has_session = self.lock().tasks.get(&attempt.task_id).is_some_and(|t| t.session_ref.as_deref().is_some_and(|r| !r.trim().is_empty()));
                if !has_session {
                    return Err(invalid("session_missing", "el proveedor aún no ha declarado su sesión: no se puede reanudar para enviar la instrucción"));
                }
            }
        }
        Ok(live)
    }

    fn steer_now(&self, ctx: &MutationContext, attempt: &AttemptRow, i: &Instruction<'_>, live: &super::live_run::LiveView) -> Result<Value, QueueError> {
        let gated = Gated::new(live.adapter.as_ref(), &live.matrix);
        match gated.steer(&live.handle, i.body) {
            Ok(()) => {
                self.instruction_result(ctx, &attempt.id, i.request_id, InstructionMode::Steer, InstructionOutcome::Delivered, None);
                Ok(answer(InstructionMode::Steer, i, false))
            }
            Err(e) => {
                self.instruction_result(ctx, &attempt.id, i.request_id, InstructionMode::Steer, InstructionOutcome::Failed, Some(cmd::reason_of(&e)));
                Err(cmd::capability_refusal(&e, "steer_unsupported").with_code("steer_failed"))
            }
        }
    }

    fn stop_and_send_now(&self, ctx: &MutationContext, attempt: &AttemptRow, i: &Instruction<'_>, live: &super::live_run::LiveView) -> Result<Value, QueueError> {
        let mode = InstructionMode::StopAndSend;
        let gated = Gated::new(live.adapter.as_ref(), &live.matrix);
        let verdict = Arc::new(Verdict::default());
        let pending = PendingSend { instruction: i.body.to_string(), verdict: Arc::clone(&verdict) };
        if !self.arm_pending_send(&attempt.task_id, pending) {
            self.instruction_result(ctx, &attempt.id, i.request_id, mode, InstructionOutcome::StopFailed, Some(QueueFailure::AdapterUnavailable));
            return Err(QueueError::new(ErrorKind::Busy, "stop_in_progress", "ya hay un Stop & Send esperando a que se confirme el stop, o la ejecución ya terminó"));
        }
        // Pedir el stop no es haberlo conseguido: si el adapter lo rechaza se retira la instrucción y NO se envía nada.
        if let Err(e) = gated.interrupt(&live.handle) {
            self.take_pending_send(&attempt.task_id);
            self.instruction_result(ctx, &attempt.id, i.request_id, mode, InstructionOutcome::StopFailed, Some(cmd::reason_of(&e)));
            return Err(cmd::capability_refusal(&e, "stop_send_unsupported").with_code("stop_failed"));
        }
        let wait = self.instructions.stop_wait();
        let verdict = match verdict.wait(wait) {
            Some(v) => Some(v),
            // Vencido el plazo: se RETIRA la instrucción. Si ya no está, el bombeo la había recogido y su veredicto llega enseguida.
            None => match self.take_pending_send(&attempt.task_id) {
                Some(_) => None,
                None => verdict.wait(VERDICT_GRACE),
            },
        };
        match verdict {
            Some(SendVerdict::Sent) => {
                self.instruction_result(ctx, &attempt.id, i.request_id, mode, InstructionOutcome::Delivered, None);
                Ok(answer(mode, i, false))
            }
            Some(SendVerdict::SendFailed(reason)) => {
                self.instruction_result(ctx, &attempt.id, i.request_id, mode, InstructionOutcome::Failed, Some(reason));
                Err(QueueError::new(ErrorKind::Failed, "send_failed", "el stop se confirmó pero la instrucción no llegó al proveedor"))
            }
            Some(SendVerdict::StopFailed) => {
                self.instruction_result(ctx, &attempt.id, i.request_id, mode, InstructionOutcome::StopFailed, None);
                Err(QueueError::new(ErrorKind::Failed, "stop_failed", "la ejecución terminó de otra forma antes de confirmar el stop: no se envió nada"))
            }
            None => {
                self.instruction_result(ctx, &attempt.id, i.request_id, mode, InstructionOutcome::StopTimeout, None);
                Err(QueueError::new(ErrorKind::Failed, "stop_timeout", "el proveedor no confirmó el stop a tiempo: no se envió nada"))
            }
        }
    }

    /// El resultado es un hecho durable, pero la acción ya ocurrió: si no se pudo anotar, se dice y no se cambia lo que se devuelve.
    fn instruction_result(&self, ctx: &MutationContext, attempt_id: &str, request_id: &str, mode: InstructionMode, outcome: InstructionOutcome, reason: Option<QueueFailure>) {
        if let Err(why) = self.instruction_record_result(ctx, attempt_id, request_id, mode, outcome, reason) {
            eprintln!("[core] no se pudo anotar el resultado de la instrucción {request_id} de {attempt_id}: {why}");
        }
    }
}

// ── RPC de Desktop ───────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct InstructionInput {
    pub attempt_id: String,
    pub request_id: String,
    pub body: String,
}

fn person(context: &MutationContext, what: &str) -> Result<(), String> {
    if !context.is_person() || context.client_id.as_deref().is_none_or(str::is_empty) || context.channel == Channel::Core {
        return Err(format!("{what} requiere una Person autenticada"));
    }
    Ok(())
}

/// `attempt_steer` y `attempt_stop_and_send`: solo una Person de Desktop (`HumanDecision`).
pub(super) fn rpc(core: &Core, context: &MutationContext, mode: InstructionMode, input: &InstructionInput) -> Result<Value, String> {
    person(context, "instruir a un Attempt")?;
    let i = Instruction { request_id: &input.request_id, attempt_id: &input.attempt_id, body: &input.body };
    core.instruct(context, mode, &i).map_err(|e| e.to_string())
}
