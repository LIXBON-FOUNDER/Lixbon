//! La ejecución VIVA de una Task, vista desde el Core (LXO-144): lo único que Steer y Stop & Send necesitan para hablar con el
//! proveedor mientras el turno corre.
//!
//! El bombeo (`run_pump.rs`) es quien escucha la ejecución y quien sabe qué `RunHandle` está vivo (cambia en cada turno que la cola
//! reanuda). Este módulo guarda en el registro de ejecuciones de la Task una copia de lo que hace falta —el adapter, su matriz y el
//! handle actual— y un buzón de **Stop & Send pendiente**:
//!
//! ```text
//! Core::stop_and_send                          el bombeo (hilo de la ejecución)
//!   1. pending_send = Some(instrucción)  ───►
//!   2. Gated::interrupt(handle)                events(handle) devuelve (Interrupted)  <- el stop se CONFIRMA aquí
//!   3. espera el veredicto (acotada)     ◄───  take_pending_send -> resume(sesión, instrucción) -> handle nuevo
//!                                              veredicto Sent / SendFailed / StopFailed
//! ```
//!
//! Nada se envía hasta que `events` ha vuelto: el stop se conoce por el resultado del adapter, nunca por haberlo pedido (invariante 2).
//! Si el veredicto no llega a tiempo, quien pidió el stop RETIRA la instrucción pendiente: así un stop tardío no envía nada después
//! de que la persona haya visto «no se confirmó».

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use super::adapter::{CapabilityMatrix, ProviderAdapter, RunHandle};
use super::Core;
use crate::store::QueueFailure;

/// Lo que el bombeo cuenta de un Stop & Send.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum SendVerdict {
    /// El stop se confirmó y el adapter aceptó el turno nuevo con la instrucción.
    Sent,
    /// El stop se confirmó pero la instrucción no llegó (con el motivo cerrado de la cola).
    SendFailed(QueueFailure),
    /// La ejecución terminó de otra forma (falló, se canceló…): no hubo stop que confirmar ni se envió nada.
    StopFailed,
}

/// El veredicto que el bombeo deja y quien pidió el Stop & Send espera.
#[derive(Default)]
pub(super) struct Verdict {
    slot: Mutex<Option<SendVerdict>>,
    signal: Condvar,
}

impl Verdict {
    pub(super) fn set(&self, verdict: SendVerdict) {
        *self.slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(verdict);
        self.signal.notify_all();
    }

    /// Espera el veredicto hasta `wait`. `None`: no llegó.
    pub(super) fn wait(&self, wait: Duration) -> Option<SendVerdict> {
        let guard = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let (guard, _) = self.signal.wait_timeout_while(guard, wait, |v| v.is_none()).unwrap_or_else(|e| e.into_inner());
        *guard
    }
}

/// Un Stop & Send esperando a que el stop se confirme.
pub(super) struct PendingSend {
    pub(super) instruction: String,
    pub(super) verdict: Arc<Verdict>,
}

pub(super) struct LiveRun {
    pub(super) adapter: Arc<dyn ProviderAdapter>,
    pub(super) matrix: CapabilityMatrix,
    pub(super) handle: RunHandle,
    pub(super) attempt_id: String,
    pub(super) pending_send: Option<PendingSend>,
}

/// Lo que se saca del registro para hablar con el adapter SIN tener el registro tomado (`steer` / `interrupt` pueden tardar).
pub(super) struct LiveView {
    pub(super) adapter: Arc<dyn ProviderAdapter>,
    pub(super) matrix: CapabilityMatrix,
    pub(super) handle: RunHandle,
    pub(super) attempt_id: String,
}

pub(super) type LiveSlot = Arc<Mutex<Option<LiveRun>>>;

impl Core {
    fn live_slot(&self, task: &str) -> Option<LiveSlot> {
        self.adapter_runs_lock().get(task).map(|control| Arc::clone(&control.live))
    }

    /// El bombeo registra lo que hace falta para hablar con la ejecución.
    pub(super) fn set_live_run(&self, task: &str, live: LiveRun) {
        if let Some(slot) = self.live_slot(task) {
            *slot.lock().unwrap_or_else(|e| e.into_inner()) = Some(live);
        }
    }

    /// Un turno nuevo (la cola o un Stop & Send reanudaron la sesión): el handle vivo es otro.
    pub(super) fn set_live_handle(&self, task: &str, handle: &RunHandle) {
        if let Some(slot) = self.live_slot(task) {
            if let Some(live) = slot.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                live.handle = handle.clone();
            }
        }
    }

    /// La ejecución viva de la Task, si la tiene, para hablar con su adapter.
    pub(super) fn live_view(&self, task: &str) -> Option<LiveView> {
        let slot = self.live_slot(task)?;
        let guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        let live = guard.as_ref()?;
        Some(LiveView { adapter: Arc::clone(&live.adapter), matrix: live.matrix.clone(), handle: live.handle.clone(), attempt_id: live.attempt_id.clone() })
    }

    /// Deja un Stop & Send pendiente. `false`: no hay ejecución viva o ya hay otro pendiente (solo uno a la vez).
    pub(super) fn arm_pending_send(&self, task: &str, pending: PendingSend) -> bool {
        let Some(slot) = self.live_slot(task) else { return false };
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_mut() {
            Some(live) if live.pending_send.is_none() => {
                live.pending_send = Some(pending);
                true
            }
            _ => false,
        }
    }

    /// El bombeo recoge el Stop & Send pendiente cuando `events` ha vuelto. También lo usa quien lo pidió para RETIRARLO si el stop
    /// no se confirmó a tiempo (`None`: el bombeo ya lo había recogido).
    pub(super) fn take_pending_send(&self, task: &str) -> Option<PendingSend> {
        let slot = self.live_slot(task)?;
        let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_mut()?.pending_send.take()
    }
}
