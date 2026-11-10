//! La cola de instrucciones conectada al runtime (LXO-143): entrega por REANUDACIÓN en cada fin de turno.
//!
//! `queue_commands.rs` guarda la cola (item durable, FIFO, cancelar, recuperación) y delega la entrega en un [`QueuePort`]. Este
//! módulo lo implementa sobre lo que el runtime ya tiene: un run es UN turno (el adapter lo cierra en el primer `result`), así que
//! el «siguiente turno» de un Attempt se entrega **reanudando la misma ProviderSession** con la instrucción, dentro del mismo
//! Attempt. No hace falta ninguna operación nueva en los adapters: sirve cualquiera que ofrezca `resume`.
//!
//! ```text
//! el bombeo (run_pump)                      Core::queue_next_turn(task, attempt)
//!   events(run) = Completed  ──────────────►  TurnPort en TurnEnd
//!                                               deliver_next: el primero de la cola pasa a `delivering`
//!                                               port.deliver: Gated::resume(sesión de la Task, instrucción)
//!                                                 Ok(run nuevo)  -> `delivered` (confirma el adapter) y el bombeo sigue con ESE run
//!                                                 Err            -> el item `failed`; se prueba el siguiente (uno que falla no bloquea)
//!                                               sin nada que entregar -> el Attempt termina como siempre
//! ```
//!
//! Mientras hay instrucciones, el Attempt sigue `running` entre turnos: `completed` llega solo cuando la cola se vacía. Nunca se
//! llama a `steer` ni se escribe en un proceso en marcha (Queue no es Steer): cada instrucción arranca su propio turno.
//!
//! # Quién pregunta y qué responde
//! * **Al encolar (RPC):** `boundary` es siempre `Busy` (un Attempt `running` está en mitad de un turno; el límite lo ve el bombeo) y
//!   `capability` es «el proveedor ofrece `resume` ahora». Sin ella se rechaza y no se escribe nada.
//! * **En el fin de turno (bombeo):** `boundary` es `TurnEnd` y `deliver` reanuda. La sesión, el worktree y el perfil se leen del estado
//!   ANTES de entrar al almacén: no se toma el lock del estado con el del almacén tomado.
//!
//! Lo que dice la entrega lo dice el adapter: `deliver` devuelve `AdapterResult` solo si `resume` aceptó (y devolvió el run).

use std::cell::RefCell;
use std::path::PathBuf;

use super::adapter::{AdapterError, CancelToken, Capability, CapabilityState, Gated, ProviderRef, ResumeRequest, RunHandle};
use super::provider_registry::{LiveRegistry, ProviderLookup};
use super::queue_commands::{Boundary, DeliveryRequest, DeliveryResult, QueuePort};
use super::Core;
use crate::store::{AttemptRow, QueueConfirmation};

/// Lo que hace falta para reanudar, leído del estado de la Task.
struct ResumeFacts {
    session_ref: Option<String>,
    worktree: Option<String>,
    profile: Option<String>,
}

pub(super) struct TurnPort<'a> {
    core: &'a Core,
    boundary: Boundary,
    /// El adapter del run que acaba de terminar. `None` al encolar: no se entrega nada desde el RPC.
    gated: Option<&'a Gated<'a>>,
    facts: Option<ResumeFacts>,
    /// El run que abrió la entrega: lo toma el bombeo para seguir escuchándolo.
    handoff: RefCell<Option<RunHandle>>,
}

impl<'a> TurnPort<'a> {
    /// Para quien encola: el run está en mitad de un turno y de aquí no se entrega nada.
    pub(super) fn for_enqueue(core: &'a Core) -> TurnPort<'a> {
        TurnPort { core, boundary: Boundary::Busy, gated: None, facts: None, handoff: RefCell::new(None) }
    }

    /// Para el bombeo en un fin de turno. Lee del estado lo que la reanudación necesita.
    fn at_turn_end(core: &'a Core, gated: &'a Gated<'a>, task_id: &str) -> TurnPort<'a> {
        let facts = core.lock().tasks.get(task_id).map(|t| ResumeFacts { session_ref: t.session_ref.clone(), worktree: t.worktree.clone(), profile: t.profile.clone() });
        TurnPort { core, boundary: Boundary::TurnEnd, gated: Some(gated), facts, handoff: RefCell::new(None) }
    }

    fn take_handoff(&self) -> Option<RunHandle> {
        self.handoff.borrow_mut().take()
    }
}

impl QueuePort for TurnPort<'_> {
    fn capability(&self, attempt: &AttemptRow) -> Result<(), AdapterError> {
        match LiveRegistry::lookup(&self.core.provider_registry, &attempt.provider) {
            ProviderLookup::Found(entry) => match entry.matrix.capabilities.get(&Capability::Resume) {
                Some(CapabilityState::Available) => Ok(()),
                Some(CapabilityState::Unavailable { reason }) => Err(AdapterError::unavailable(Capability::Resume, reason)),
                Some(CapabilityState::EnvironmentBlocked { block }) => Err(AdapterError::environment_blocked(block.clone())),
                Some(CapabilityState::Unsupported) | None => Err(AdapterError::unsupported(Capability::Resume)),
            },
            ProviderLookup::Probing => Err(AdapterError::unavailable(Capability::Resume, "el proveedor todavía se está sondeando")),
            ProviderLookup::Unknown => Err(AdapterError::unavailable(Capability::Resume, "el proveedor no está registrado en este Core")),
        }
    }

    fn boundary(&self, _attempt: &AttemptRow) -> Boundary {
        self.boundary
    }

    fn deliver(&self, attempt: &AttemptRow, request: &DeliveryRequest<'_>, cancel: &CancelToken) -> Result<QueueConfirmation, AdapterError> {
        let handle = self.resume_with(attempt, request.body, cancel)?;
        *self.handoff.borrow_mut() = Some(handle);
        Ok(QueueConfirmation::AdapterResult)
    }
}

impl TurnPort<'_> {
    /// Reanuda la sesión de la Task con `body` como el turno nuevo. Lo comparten la cola (un fin de turno) y Stop & Send (tras el stop).
    fn resume_with(&self, attempt: &AttemptRow, body: &str, cancel: &CancelToken) -> Result<RunHandle, AdapterError> {
        let gated = self.gated.ok_or_else(|| AdapterError::unavailable(Capability::Resume, "no hay un run en un fin de turno al que entregar"))?;
        let facts = self.facts.as_ref().ok_or_else(AdapterError::session_not_found)?;
        let session_ref = facts.session_ref.as_deref().filter(|r| !r.trim().is_empty()).ok_or_else(AdapterError::session_not_found)?;
        let worktree = facts.worktree.as_deref().filter(|w| !w.trim().is_empty()).ok_or_else(|| AdapterError::unavailable(Capability::Resume, "la Task no tiene su worktree"))?;
        let profile = attempt.profile.clone().or_else(|| facts.profile.clone()).ok_or_else(|| AdapterError::invalid("el Attempt no tiene un perfil de permisos"))?;
        gated.resume(
            ResumeRequest {
                attempt_id: attempt.id.clone(),
                provider_ref: ProviderRef::new(session_ref)?,
                worktree: PathBuf::from(worktree),
                prompt: Some(body.to_string()),
                profile,
                model: attempt.model.clone(),
                effort: attempt.effort.clone(),
            },
            cancel,
        )
    }
}

impl Core {
    /// Stop & Send (LXO-144): el stop se confirmó; abre el turno nuevo reanudando la sesión de la Task con `instruction`. Devuelve el run
    /// NUEVO para que el bombeo siga con él. `Err`: el adapter no la aceptó (la instrucción no llegó).
    pub(super) fn resume_with_instruction(&self, task_id: &str, attempt_id: &str, gated: &Gated<'_>, cancel: &CancelToken, instruction: &str) -> Result<RunHandle, AdapterError> {
        let attempt = self.attempt_row_for_resume(attempt_id).map_err(|_| AdapterError::unavailable(Capability::Resume, "no se pudo leer el Attempt"))?.ok_or_else(|| AdapterError::unavailable(Capability::Resume, "el Attempt ya no existe"))?;
        TurnPort::at_turn_end(self, gated, task_id).resume_with(&attempt, instruction, cancel)
    }

    /// El run de `attempt_id` acabó su turno: si hay instrucciones en cola, entrega la primera reanudando la sesión y devuelve el
    /// run NUEVO para que el bombeo siga con él. `None`: no había nada (o nada se pudo entregar) y el Attempt termina como siempre.
    /// Un item que falla es final y no bloquea a los demás (D3): se prueba el siguiente.
    pub(super) fn queue_next_turn(&self, task_id: &str, attempt_id: &str, gated: &Gated<'_>, cancel: &CancelToken) -> Option<RunHandle> {
        let port = TurnPort::at_turn_end(self, gated, task_id);
        loop {
            match self.queue_deliver_next(&port, cancel, attempt_id) {
                Ok(DeliveryResult::Delivered(_)) => {
                    let next = port.take_handoff();
                    if next.is_none() {
                        eprintln!("[core] la entrega de la cola de {attempt_id} se confirmó sin un run que escuchar");
                    }
                    return next;
                }
                Ok(DeliveryResult::Failed(_)) => continue,
                Ok(DeliveryResult::Nothing) => return None,
                Err(why) => {
                    eprintln!("[core] no se pudo entregar la cola de {attempt_id}: {why}");
                    return None;
                }
            }
        }
    }
}
