//! Take Over (LXO-170): una persona toma el control del workspace de un Attempt EN MARCHA, sin crear otro Attempt ni otro chat.
//! Contrato: `docs/core/TAKE_OVER.md`.
//!
//! ```text
//! Core::take_over(ctx, attempt_id, request_id)
//!   1. autorizar (persona)  y validar la clave                              <- antes de escribir
//!   2. ¿ya se atendió esta clave?  -> el MISMO resultado, sin tocar al proveedor
//!   3. ¿Attempt `running`, con una ejecución viva, que sigue siendo del agente?
//!      ¿el proveedor puede interrumpirse (`interrupt`) Y reanudarse (`resume`), y tiene sesión?   <- si no, error y NADA se escribe
//!   4. pending_takeover + Gated::interrupt(handle)       el BOMBEO confirma la interrupción cuando `events` vuelve
//!   5. el bombeo: proceso cerrado con prueba -> `attempt.ownership_changed` (agent -> human) -> retira la ejecución del registro
//!      (el Attempt NO se cierra: sigue `running`, sin proceso, y su dueño es la persona)
//!   6. espera acotada del veredicto: TakenOver | NotConfirmed | Failed | timeout
//! ```
//!
//! # Invariantes
//! * **El dueño no cambia hasta que la frontera es segura.** «Segura» = el adapter confirmó la interrupción y cerró el proceso con prueba
//!   (`events` volvió `Interrupted`): ni terminal, ni proceso, ni editor del agente escriben ya en el worktree. Pedir la interrupción no es haberla
//!   conseguido.
//! * **Un fallo o un plazo vencido conserva al dueño anterior.** `NotConfirmed`, `Failed` y `stop_timeout` no escriben el hecho de propiedad.
//! * **Take Over no crea nada**: ni Attempt, ni Task, ni sesión. La sesión del proveedor queda intacta para poder devolvérsela (Return).
//! * **Exige poder devolver.** Sin `interrupt` no hay frontera segura; sin `resume` (o sin sesión declarada) la persona no podría devolver el
//!   trabajo al mismo Attempt. Las dos o ninguna, y sin ellas no se interrumpe nada.
//! * **Un Attempt terminado no se toma** (`attempt_final`): es historia.
//! * **Idempotente por `request_id`:** repetir la petición devuelve el mismo resultado sin interrumpir otra vez.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};

use super::adapter::{Capability, Gated};
use super::events::{Channel, MutationContext};
use super::live_run::{PendingTakeover, TakeCell, TakeVerdict};
use super::queue_commands::{self, ErrorKind, QueueError};
use super::run_pump::Terminal;
use super::steer_commands as cmd;
use super::Core;
use crate::store::{AttemptRow, Owner};

/// Cuánto espera el Take Over a que la interrupción se confirme. Pasado, es `stop_timeout` y el dueño no cambia.
pub(super) const TAKE_WAIT: Duration = Duration::from_secs(15);
/// Si al vencer el plazo el bombeo ya había recogido la petición, su veredicto está a punto de llegar.
const VERDICT_GRACE: Duration = Duration::from_secs(5);
/// Cuántas peticiones recuerda el Core para repetirlas sin tocar al proveedor.
const LOG_CAP: usize = 512;

enum Entry {
    InFlight,
    Done(Result<Value, QueueError>),
}

enum Begin {
    Started,
    Replay(Result<Value, QueueError>),
    InFlight,
}

pub(super) struct TakeOverState {
    log: Mutex<HashMap<(String, String), Entry>>,
    wait_ms: std::sync::atomic::AtomicU64,
}

impl Default for TakeOverState {
    fn default() -> Self {
        TakeOverState { log: Mutex::new(HashMap::new()), wait_ms: std::sync::atomic::AtomicU64::new(TAKE_WAIT.as_millis() as u64) }
    }
}

impl TakeOverState {
    fn log(&self) -> std::sync::MutexGuard<'_, HashMap<(String, String), Entry>> {
        self.log.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn begin(&self, attempt: &str, request_id: &str) -> Begin {
        let mut log = self.log();
        let key = (attempt.to_string(), request_id.to_string());
        match log.get(&key) {
            Some(Entry::InFlight) => return Begin::InFlight,
            Some(Entry::Done(result)) => return Begin::Replay(result.clone()),
            None => {}
        }
        if log.len() >= LOG_CAP {
            log.retain(|_, entry| matches!(entry, Entry::InFlight));
        }
        log.insert(key, Entry::InFlight);
        Begin::Started
    }

    fn finish(&self, attempt: &str, request_id: &str, result: Result<Value, QueueError>) {
        self.log().insert((attempt.to_string(), request_id.to_string()), Entry::Done(result));
    }

    /// La petición no llegó a actuar (se rechazó antes): no deja rastro y puede repetirse.
    fn abort(&self, attempt: &str, request_id: &str) {
        self.log().remove(&(attempt.to_string(), request_id.to_string()));
    }

    fn wait(&self) -> Duration {
        Duration::from_millis(self.wait_ms.load(std::sync::atomic::Ordering::SeqCst))
    }

    #[cfg(test)]
    pub(super) fn set_wait(&self, wait: Duration) {
        self.wait_ms.store(wait.as_millis() as u64, std::sync::atomic::Ordering::SeqCst);
    }
}

fn invalid(code: &'static str, message: impl Into<String>) -> QueueError {
    QueueError::new(ErrorKind::Invalid, code, message)
}

fn replayed(result: Result<Value, QueueError>) -> Result<Value, QueueError> {
    result.map(|mut v| {
        v["status"] = json!("Replayed");
        v
    })
}

impl Core {
    /// `attempt.take_over`. Ver el diagrama del módulo.
    pub(super) fn take_over(&self, ctx: &MutationContext, attempt_id: &str, request_id: &str) -> Result<Value, QueueError> {
        let attempt = self.instruction_authorize(ctx, attempt_id)?;
        queue_commands::check_request_id(request_id)?;
        match self.take_overs.begin(&attempt.id, request_id) {
            Begin::Started => {}
            Begin::Replay(result) => return replayed(result),
            Begin::InFlight => return Err(QueueError::new(ErrorKind::Busy, "in_progress", "esa petición se está atendiendo ahora mismo")),
        }
        // Comprobaciones previas: si falla alguna NO se ha escrito nada ni tocado el proveedor, y la clave queda libre.
        let live = match self.take_over_preflight(&attempt) {
            Ok(live) => live,
            Err(refusal) => {
                self.take_overs.abort(&attempt.id, request_id);
                return Err(refusal);
            }
        };
        let result = self.take_over_now(ctx, &attempt, request_id, &live);
        self.take_overs.finish(&attempt.id, request_id, result.clone());
        result
    }

    fn take_over_preflight(&self, attempt: &AttemptRow) -> Result<super::live_run::LiveView, QueueError> {
        if let Some(refusal) = cmd::state_refusal(attempt) {
            return Err(refusal);
        }
        // Ya es de una persona: no hay nada que tomar (y tampoco una ejecución viva a la que interrumpir).
        let owner = self.attempt_owner(&attempt.id)?;
        if owner.owner == Owner::Human {
            return Err(invalid("already_human", format!("el Attempt {} ya está en manos de una persona", attempt.id)));
        }
        let live = self.live_view(&attempt.task_id).filter(|live| live.attempt_id == attempt.id).ok_or_else(|| {
            QueueError::new(ErrorKind::Busy, "not_running", format!("el Attempt {} no tiene una ejecución viva que interrumpir", attempt.id))
        })?;
        // Sin `interrupt` no hay frontera segura; sin `resume` la persona no podría devolver el trabajo al mismo Attempt: las dos o ninguna.
        live.matrix.require(Capability::Interrupt).map_err(|e| cmd::capability_refusal(&e, "take_over_unsupported"))?;
        live.matrix.require(Capability::Resume).map_err(|e| cmd::capability_refusal(&e, "take_over_unsupported"))?;
        let has_session = self.lock().tasks.get(&attempt.task_id).is_some_and(|t| t.session_ref.as_deref().is_some_and(|r| !r.trim().is_empty()));
        if !has_session {
            return Err(invalid("session_missing", "el proveedor aún no ha declarado su sesión: no se podría devolver el trabajo al agente"));
        }
        Ok(live)
    }

    fn take_over_now(&self, ctx: &MutationContext, attempt: &AttemptRow, request_id: &str, live: &super::live_run::LiveView) -> Result<Value, QueueError> {
        let gated = Gated::new(live.adapter.as_ref(), &live.matrix);
        let verdict = Arc::new(TakeCell::default());
        let pending = PendingTakeover { ctx: ctx.clone(), request_id: request_id.to_string(), verdict: Arc::clone(&verdict) };
        if !self.arm_pending_takeover(&attempt.task_id, pending) {
            return Err(QueueError::new(ErrorKind::Busy, "stop_in_progress", "ya hay una interrupción esperando confirmación, o la ejecución ya terminó"));
        }
        // Pedir la interrupción no es haberla conseguido: si el adapter la rechaza se retira la petición y NO cambia el dueño.
        if let Err(e) = gated.interrupt(&live.handle) {
            self.take_pending_takeover(&attempt.task_id);
            return Err(cmd::capability_refusal(&e, "take_over_unsupported").with_code("stop_failed"));
        }
        let verdict = match verdict.wait(self.take_overs.wait()) {
            Some(v) => Some(v),
            // Vencido el plazo: se RETIRA la petición. Si ya no está, el bombeo la había recogido y su veredicto llega enseguida.
            None => match self.take_pending_takeover(&attempt.task_id) {
                Some(_) => None,
                None => verdict.wait(VERDICT_GRACE),
            },
        };
        match verdict {
            Some(TakeVerdict::TakenOver { base_commit }) => Ok(json!({
                "status": "TakenOver", "attempt_id": attempt.id, "request_id": request_id, "owner": Owner::Human.as_str(), "base_commit": base_commit,
            })),
            Some(TakeVerdict::NotConfirmed) => Err(QueueError::new(
                ErrorKind::Failed,
                "stop_failed",
                "la ejecución terminó de otra forma antes de confirmar la interrupción: no hubo frontera segura y el Attempt sigue con el agente",
            )),
            Some(TakeVerdict::Failed(why)) => Err(QueueError::new(
                ErrorKind::Failed,
                "take_over_failed",
                format!("la ejecución se interrumpió pero no se pudo dejar el control en manos de la persona: {why}"),
            )),
            None => Err(QueueError::new(ErrorKind::Failed, "stop_timeout", "el proveedor no confirmó la interrupción a tiempo: el Attempt sigue con el agente")),
        }
    }

    /// Detiene un Attempt que está en manos de una persona: no hay ejecución que cancelar, así que se cierra como `stopped` por el mismo camino
    /// que el desenlace de cualquier ejecución (hecho, cola y claim de despacho incluidos). Quien lo llama comprueba después el estado asentado.
    pub(super) fn stop_human_owned(&self, task: &str, attempt_id: &str) {
        self.finish_attempt(task, attempt_id, Terminal::Stopped("detenido por la persona que tenía el control".into()));
    }

    /// Lo que el bombeo hace cuando la interrupción ya está confirmada: lee la rama (la referencia para detectar los cambios de la persona) y anota
    /// el cambio de dueño atribuido a quien lo pidió. Devuelve el commit de la rama en ese instante, si se pudo leer.
    pub(super) fn hand_to_human(&self, task: &str, attempt_id: &str, take: &PendingTakeover) -> Result<Option<String>, String> {
        let base = self
            .storage
            .read_store(|s| s.worktree_of_attempt(attempt_id))
            .and_then(|w| w.ok().flatten())
            .and_then(|w| w.branch.as_deref().and_then(|b| super::review::branch_head(&w.repo, b)));
        self.ownership_changed(&take.ctx, attempt_id, Owner::Human, &take.request_id, base.as_deref())
            .map_err(|e| e.to_string())?;
        let _ = task;
        Ok(base)
    }
}

// ── RPC de Desktop ───────────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct TakeOverInput {
    pub attempt_id: String,
    pub request_id: String,
    /// La confirmación explícita que pide la policy cuando el nivel es `confirm` (LXO-209). La lee la policy en `rpc`, no este Command.
    #[serde(default)]
    pub confirm: bool,
}

fn person(context: &MutationContext, what: &str) -> Result<(), String> {
    if !context.is_person() || context.client_id.as_deref().is_none_or(str::is_empty) || context.channel == Channel::Core {
        return Err(format!("{what} requiere una Person autenticada"));
    }
    Ok(())
}

/// `attempt_take_over`: solo una Person de Desktop o de la CLI.
pub(super) fn rpc(core: &Core, context: &MutationContext, input: &TakeOverInput) -> Result<Value, String> {
    person(context, "tomar el control de un Attempt")?;
    core.take_over(context, &input.attempt_id, &input.request_id).map_err(|e| e.to_string())
}
