//! Bombeo de eventos de una ejecución por adapter (LXO-246, PR C): lo que el proveedor emite pasa a ser el ciclo de vida
//! durable del Attempt, y el Core puede cancelarla.
//!
//! ```text
//! AdapterLauncher::started(attempt)            <- tras Running: toma la ejecución y lanza el hilo
//!   hilo: Gated::events(run, cancel, sink)     <- BLOQUEA hasta el final; el sink llama a Core::mutate
//!     SessionBound  -> Task.session_ref + session_match = session_id   (el proveedor declara su sesión)
//!     Model         -> Task.model_effective + model_source = session_declared
//!     Permission / Question -> el Attempt pasa a `awaiting_terminal_approval` (Attention `approval`) con un plazo;
//!                              NO se responde (no hay RPC para eso todavía); vencido el plazo se cancela la ejecución
//!     Output, ToolUse, Retry, Transport, Usage -> sin hecho durable
//!   al volver `events`: el proceso ya murió (el adapter lo mata antes de devolver) -> se libera la ejecución del registro,
//!   se aplica el desenlace al Attempt y se asienta el claim
//! ```
//!
//! # Cancelación
//! Cada ejecución viva está en un registro del Core por Task. [`Core::cancel_adapter_run`] cancela su `CancelToken` y
//! **espera (acotado) a que el proceso muera**: `kill_term_checked`, `has_term`, `live_ids` y el apagado lo consultan, así que
//! `stop`, el cierre de un Run y el apagado cancelan también estas ejecuciones y nadie borra un worktree bajo un proceso vivo.
//! Si no muere a tiempo es un `Err`: «no hay control fiable», y se conserva todo.
//!
//! # Desenlace (función pura, sin comodín)
//! | `events` devuelve | Attempt |
//! |---|---|
//! | plazo de la espera vencido | `failed(terminal_approval_timeout)` |
//! | `Completed` | `completed` (el resumen, redactado y acotado) |
//! | `Failed(e)` o `Err(e)` | `failed(agent_reported)` |
//! | `Interrupted` | `exited` |
//! | `Cancelled` | `stopped` |
//!
//! Un pánico del bombeo no inventa un desenlace: se libera la ejecución del registro y el Attempt queda `running` para la
//! reconciliación de arranque.
//!
//! **Inerte**: nada en producción instala el lanzador todavía.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el PR D de LXO-246

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};

use super::adapter::{redact, AdapterError, AdapterEvent, CancelToken, ErrorCode, Gated, RunOutcome};
use super::adapter_launcher::StartedRun;
use super::events::MutationContext;
use super::mutation::Health;
use super::state::{now_ms, Status};
use super::Core;
use crate::store::MAX_SUMMARY_CHARS;

/// Cuánto espera quien cancela a que el proceso muera. Pasado, es un `Err`: no hay control fiable.
const CANCEL_WAIT: Duration = Duration::from_secs(10);
/// Cada cuánto mira el vigilante si venció la espera.
const WATCHDOG_TICK: Duration = Duration::from_millis(100);

type Done = Arc<(Mutex<bool>, Condvar)>;

/// Una ejecución viva: cómo cancelarla y cómo saber que su proceso murió.
pub(super) struct RunControl {
    cancel: CancelToken,
    done: Done,
}

/// Lo que se decide al terminar la ejecución.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Terminal {
    Done(String),
    Failed(&'static str, String),
    Stopped(String),
    Exited(String),
}

fn describe(e: &AdapterError) -> String {
    format!("{}: {}", e.code.code(), e.message)
}

/// El desenlace del Attempt a partir de cómo terminó `events`. Sin comodín: una variante nueva obliga a decidir.
pub(super) fn terminal_for(result: &Result<RunOutcome, AdapterError>, timed_out: bool) -> Terminal {
    if timed_out {
        return Terminal::Failed("terminal_approval_timeout", "nadie respondió a la petición del proveedor antes del plazo".into());
    }
    match result {
        Ok(RunOutcome::Completed { summary }) => Terminal::Done(redact(summary.as_deref().unwrap_or_default()).chars().take(MAX_SUMMARY_CHARS).collect()),
        Ok(RunOutcome::Failed(error)) => Terminal::Failed("agent_reported", describe(error)),
        Ok(RunOutcome::Interrupted) => Terminal::Exited("la ejecución se interrumpió".into()),
        Ok(RunOutcome::Cancelled) => Terminal::Stopped("ejecución cancelada".into()),
        Err(error) if error.code == ErrorCode::Cancelled => Terminal::Stopped("ejecución cancelada".into()),
        Err(error) => Terminal::Failed("agent_reported", describe(error)),
    }
}

/// Estado compartido entre el sink (que ve las peticiones), el vigilante (que vigila el plazo) y el hilo del bombeo.
struct PumpState {
    /// Cuándo vence la espera de una respuesta humana, si el proveedor pidió una.
    pending_until: Mutex<Option<Instant>>,
    timed_out: AtomicBool,
    finished: AtomicBool,
}

impl Core {
    fn adapter_runs_lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, RunControl>> {
        self.adapter_runs.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Da de alta una ejecución viva de `task`.
    pub(super) fn register_adapter_run(&self, task: &str, cancel: CancelToken) -> Done {
        let done: Done = Arc::new((Mutex::new(false), Condvar::new()));
        self.adapter_runs_lock().insert(task.to_string(), RunControl { cancel, done: Arc::clone(&done) });
        done
    }

    /// El proceso de `task` ya murió: sale del registro y avisa a quien esperaba.
    pub(super) fn finish_adapter_run(&self, task: &str) {
        let control = self.adapter_runs_lock().remove(task);
        if let Some(control) = control {
            let (flag, signal) = &*control.done;
            *flag.lock().unwrap_or_else(|e| e.into_inner()) = true;
            signal.notify_all();
        }
    }

    pub(super) fn has_adapter_run(&self, task: &str) -> bool {
        self.adapter_runs_lock().contains_key(task)
    }

    pub(super) fn adapter_run_ids(&self) -> Vec<String> {
        self.adapter_runs_lock().keys().cloned().collect()
    }

    /// Cancela la ejecución de `task` y espera a que su proceso muera. `None`: no había ninguna. `Err`: no murió a tiempo
    /// (no hay control fiable: quien llama no debe borrar nada que dependa de ello).
    pub(super) fn cancel_adapter_run(&self, task: &str) -> Option<Result<(), String>> {
        let (cancel, done) = {
            let runs = self.adapter_runs_lock();
            let control = runs.get(task)?;
            (control.cancel.clone(), Arc::clone(&control.done))
        };
        cancel.cancel();
        let (flag, signal) = &*done;
        let guard = flag.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = signal.wait_timeout_while(guard, CANCEL_WAIT, |finished| !*finished).unwrap_or_else(|e| e.into_inner());
        Some(if *guard { Ok(()) } else { Err(format!("la ejecución de {task} no terminó a tiempo tras cancelarla")) })
    }

    /// Apagado: cancela todas las ejecuciones vivas y espera (acotado) a cada una.
    pub(super) fn cancel_all_adapter_runs(&self) {
        for task in self.adapter_run_ids() {
            let _ = self.cancel_adapter_run(&task);
        }
    }

    /// Aplica un hecho del proveedor. Un fallo se dice y no detiene la ejecución: el bombeo nunca se cae por un evento.
    fn apply_adapter_event(&self, task: &str, event: AdapterEvent, ttl: Duration, state: &PumpState) {
        if !matches!(self.health(), Health::Normal) {
            return;
        }
        let core = MutationContext::core();
        let result = match event {
            AdapterEvent::SessionBound { provider_ref } => {
                let reference = provider_ref.expose().to_owned();
                self.mutate_as(&core, |tx| {
                    let t = tx.task_mut(task)?;
                    if t.session_ref.is_some() {
                        tx.no_change();
                        return Ok(());
                    }
                    t.session_ref = Some(reference);
                    t.session_match = Some("session_id".into());
                    Ok(())
                })
            }
            AdapterEvent::Model { model } => self.mutate_as(&core, |tx| {
                let t = tx.task_mut(task)?;
                if t.model_effective.as_deref() == Some(model.as_str()) {
                    tx.no_change();
                    return Ok(());
                }
                t.model_effective = Some(model);
                t.model_source = Some("session_declared".into());
                Ok(())
            }),
            AdapterEvent::Permission { .. } | AdapterEvent::Question { .. } => {
                let mut pending = state.pending_until.lock().unwrap_or_else(|e| e.into_inner());
                if pending.is_some() {
                    return;
                }
                let deadline_ms = now_ms().saturating_add(u64::try_from(ttl.as_millis()).unwrap_or(u64::MAX));
                let result = self.mutate_as(&core, |tx| tx.await_terminal_approval(task, deadline_ms).map(|_| ()));
                if result.is_ok() {
                    *pending = Some(Instant::now() + ttl);
                }
                result
            }
            // Hechos informativos: ninguno es un hecho durable del Attempt.
            AdapterEvent::Output { .. } | AdapterEvent::ToolUse { .. } | AdapterEvent::Retry { .. } | AdapterEvent::Transport { .. } | AdapterEvent::Usage { .. } => return,
        };
        if let Err(why) = result {
            eprintln!("[core] no se pudo registrar un hecho del proveedor: {why}");
        }
    }

    /// Aplica el desenlace al Attempt (si sigue abierto) y asienta el claim.
    fn finish_attempt(&self, task: &str, attempt: &str, terminal: Terminal) {
        if !matches!(self.health(), Health::Normal) {
            eprintln!("[core] el Core no está en estado normal: el desenlace de una ejecución queda para la reconciliación de arranque");
            return;
        }
        // Quien canceló (stop, cierre de Run) pudo dejarla ya cerrada: no hay nada que decir.
        if self.lock().tasks.get(task).is_some_and(|t| t.status.is_final()) {
            let _ = self.dispatch_settle(attempt);
            self.queue_settle(attempt);
            return;
        }
        let applied = self.mutate_as(&MutationContext::core(), |tx| match &terminal {
            Terminal::Done(summary) => tx.done(task, true, summary, vec![], None).map(|_| ()),
            Terminal::Failed(reason, why) => tx.fail_with(task, reason, why).map(|_| ()),
            Terminal::Stopped(why) => tx.close(task, Status::Stopped, why).map(|_| ()),
            Terminal::Exited(why) => tx.close(task, Status::Exited, why).map(|_| ()),
        });
        if let Err(why) = applied {
            eprintln!("[core] no se pudo aplicar el desenlace de una ejecución: {why}");
            return;
        }
        // Falla cerrado: sin evidencia canónica el claim se queda como está.
        if !matches!(self.dispatch_settle(attempt), Ok(true)) {
            eprintln!("[core] el claim de una ejecución terminada no se pudo asentar");
        }
        // Lo que seguía en la cola ya no se entregará: falla con `attempt_ended`.
        self.queue_settle(attempt);
    }
}

/// Lanza el hilo que escucha la ejecución. Si no se puede crear el hilo, se cancela la ejecución y se dice.
pub(super) fn spawn_pump(core: &Arc<Core>, run: StartedRun, approval_ttl: Duration) {
    let cancel = run.cancel.clone();
    let task = run.task_id.clone();
    let done = core.register_adapter_run(&task, cancel.clone());
    let weak = Arc::downgrade(core);
    let spawned = std::thread::Builder::new().name("adapter-run".into()).spawn(move || pump(weak, run, approval_ttl, done));
    if let Err(why) = spawned {
        eprintln!("[core] no se pudo crear el hilo de una ejecución: {why}");
        cancel.cancel();
        core.finish_adapter_run(&task);
    }
}

fn pump(core: Weak<Core>, run: StartedRun, approval_ttl: Duration, _done: Done) {
    let StartedRun { adapter, matrix, handle, cancel, worktree: _worktree, task_id, .. } = run;
    let attempt = handle.attempt_id.clone();
    let state = Arc::new(PumpState { pending_until: Mutex::new(None), timed_out: AtomicBool::new(false), finished: AtomicBool::new(false) });

    // El vigilante: si el proveedor pidió una respuesta que nadie puede dar, vencido el plazo cancela la ejecución.
    {
        let (state, cancel) = (Arc::clone(&state), cancel.clone());
        let _ = std::thread::Builder::new().name("adapter-run-watchdog".into()).spawn(move || {
            while !state.finished.load(Ordering::SeqCst) {
                let due = state.pending_until.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|until| Instant::now() >= until);
                if due {
                    state.timed_out.store(true, Ordering::SeqCst);
                    cancel.cancel();
                    return;
                }
                std::thread::sleep(WATCHDOG_TICK);
            }
        });
    }

    let gated = Gated::new(adapter.as_ref(), &matrix);
    let mut sink = |event: AdapterEvent| {
        if let Some(core) = core.upgrade() {
            core.apply_adapter_event(&task_id, event, approval_ttl, &state);
        }
    };
    // Un run es UN turno. Si al acabarlo hay instrucciones en cola, la siguiente se entrega reanudando la sesión y el Attempt sigue
    // `running` con el run nuevo; solo cuando no queda nada se aplica el desenlace (LXO-143, `queue_runtime.rs`).
    let result = catch_unwind(AssertUnwindSafe(|| {
        let mut handle = handle;
        loop {
            let outcome = gated.events(&handle, &cancel, &mut sink);
            let at_turn_end = matches!(outcome, Ok(RunOutcome::Completed { .. })) && !state.timed_out.load(Ordering::SeqCst) && !cancel.is_cancelled();
            if !at_turn_end {
                return outcome;
            }
            let Some(next) = core.upgrade().and_then(|c| c.queue_next_turn(&task_id, &attempt, &gated, &cancel)) else { return outcome };
            // Turno nuevo: la espera de una respuesta del turno anterior ya no cuenta.
            *state.pending_until.lock().unwrap_or_else(|e| e.into_inner()) = None;
            handle = next;
        }
    }));
    state.finished.store(true, Ordering::SeqCst);

    let Some(core) = core.upgrade() else { return };
    // `events` devolvió: el adapter mató el proceso antes. Desde aquí nadie espera a que muera.
    core.finish_adapter_run(&task_id);
    match result {
        Ok(result) => core.finish_attempt(&task_id, &attempt, terminal_for(&result, state.timed_out.load(Ordering::SeqCst))),
        // Un pánico no inventa un desenlace: el Attempt queda `running` para la reconciliación de arranque.
        Err(_) => eprintln!("[core] el bombeo de una ejecución entró en pánico: no se infiere su desenlace"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn completed(summary: Option<&str>) -> Result<RunOutcome, AdapterError> {
        Ok(RunOutcome::Completed { summary: summary.map(str::to_owned) })
    }

    #[test]
    fn cada_resultado_de_events_tiene_su_desenlace() {
        assert_eq!(terminal_for(&completed(Some("ok")), false), Terminal::Done("ok".into()));
        assert_eq!(terminal_for(&completed(None), false), Terminal::Done(String::new()));
        let failure = AdapterError::provider("la CLI se cerró");
        assert_eq!(terminal_for(&Ok(RunOutcome::Failed(failure.clone())), false), Terminal::Failed("agent_reported", "provider: la CLI se cerró".into()));
        assert_eq!(terminal_for(&Err(failure), false), Terminal::Failed("agent_reported", "provider: la CLI se cerró".into()));
        assert!(matches!(terminal_for(&Ok(RunOutcome::Interrupted), false), Terminal::Exited(_)));
        assert!(matches!(terminal_for(&Ok(RunOutcome::Cancelled), false), Terminal::Stopped(_)));
        assert!(matches!(terminal_for(&Err(AdapterError::cancelled()), false), Terminal::Stopped(_)));
    }

    #[test]
    fn un_plazo_vencido_gana_a_cualquier_otro_desenlace() {
        for result in [completed(Some("ok")), Ok(RunOutcome::Cancelled), Ok(RunOutcome::Interrupted), Err(AdapterError::cancelled())] {
            assert_eq!(terminal_for(&result, true), Terminal::Failed("terminal_approval_timeout", "nadie respondió a la petición del proveedor antes del plazo".into()));
        }
    }

    #[test]
    fn el_resumen_sale_acotado_y_redactado() {
        let long = "x".repeat(MAX_SUMMARY_CHARS * 2);
        let Terminal::Done(summary) = terminal_for(&completed(Some(&long)), false) else { panic!("debía completar") };
        assert!(summary.chars().count() <= MAX_SUMMARY_CHARS, "{}", summary.chars().count());
    }
}
