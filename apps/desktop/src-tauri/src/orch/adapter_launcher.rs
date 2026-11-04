//! El `Launcher` real del primer Attempt (LXO-246, PR B): worktree + `adapter.start` por el registro de proveedores.
//!
//! ```text
//! prepare(intención)                                          <- SIN ningún efecto del proveedor
//!   1. adapter + matriz del registro vivo (una copia: no se retiene el registro)
//!   2. capability `start` y `events` disponibles AHORA        <- pudieron cambiar desde task_create
//!   3. worktree del Attempt (PR A: `Core::provision_worktree`)
//! start()                                                     <- la llamada al proveedor, tras `attempt.started`
//!   Gated::start -> Ok(handle)  => Running; la ejecución queda en `started` para el bombeo de eventos (PR C)
//!                -> Err(e)      => NO se lanzó: se libera el worktree y se clasifica el error
//!                -> pánico      => Unknown: puede haberse lanzado, así que NO se libera nada
//! abandon()                                                   <- no se llegó a llamar: se libera el worktree
//! ```
//!
//! # Por qué un `Err` de `start` prueba que no se lanzó
//! El contrato del adapter es que un `Err` es «la operación no se pudo atender» y los dos adapters reales lo cumplen: si algo
//! falla tras crear el proceso (no se pudo enviar el mensaje, el apretón de manos de Codex) matan o cierran el proceso antes
//! de devolverlo. El pánico es el único caso en que no se sabe.
//!
//! # Clasificación (sin comodín: un código nuevo obliga a decidir)
//! * **Nada que lanzar** (`Unavailable` / `stopped`, nunca `failed`): entorno bloqueado, capability ausente o no disponible,
//!   capability desconocida, cancelación.
//! * **No se pudo lanzar** (`Failed` / `NotSpawned` / `failed(launch_failed)`): petición inválida, proveedor o ejecución
//!   desconocidos, sesión inexistente, fallo del proveedor o del adapter.
//!
//! **Inerte**: ni se instala en producción ni nada lo llama todavía.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el PR D de LXO-246

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use super::adapter::{AdapterError, CancelToken, Capability, CapabilityMatrix, ErrorCode, Gated, ProviderAdapter, ProviderRef, ResumeRequest, RunHandle, StartRequest};
use super::dispatch::{DispatchIntent, Launcher, PrepareError, PreparedLaunch, StartOutcome};
use super::provider_registry::{AdapterLookup, LiveRegistry};
use super::worktree_provision::ProvisionedWorktree;
use super::Core;

/// Una ejecución que el proveedor aceptó, a la espera del bombeo de eventos (PR C).
pub(super) struct StartedRun {
    pub(super) task_id: String,
    pub(super) adapter: Arc<dyn ProviderAdapter>,
    pub(super) matrix: CapabilityMatrix,
    pub(super) handle: RunHandle,
    /// Cancela la ejecución (`stop`, cierre de Run, apagado).
    pub(super) cancel: CancelToken,
    pub(super) worktree: ProvisionedWorktree,
}

type Started = Arc<Mutex<HashMap<String, StartedRun>>>;

pub(super) struct AdapterLauncher {
    core: Weak<Core>,
    registry: Arc<LiveRegistry>,
    started: Started,
    /// Cuánto se espera una respuesta humana a una petición del proveedor antes de cancelar la ejecución.
    approval_ttl: Duration,
}

/// Lo que el adapter no pudo hacer, por tipo: la decisión es de este `match`, sin comodín.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Disposition {
    /// No había nada que lanzar.
    Unavailable,
    /// Se intentó y no se pudo.
    Failed,
}

pub(super) fn disposition(code: ErrorCode) -> Disposition {
    match code {
        ErrorCode::EnvironmentBlocked | ErrorCode::UnsupportedCapability | ErrorCode::CapabilityUnavailable | ErrorCode::UnknownCapability | ErrorCode::Cancelled => Disposition::Unavailable,
        ErrorCode::InvalidRequest | ErrorCode::UnknownProvider | ErrorCode::UnknownRun | ErrorCode::SessionNotFound | ErrorCode::Provider | ErrorCode::Internal => Disposition::Failed,
    }
}

/// El texto del error para el hecho que lo registra: código y mensaje ya redactados; nunca el diagnóstico crudo del proveedor.
fn describe(e: &AdapterError) -> String {
    format!("{}: {}", e.code.code(), e.message)
}

fn prepare_error(e: &AdapterError) -> PrepareError {
    match disposition(e.code) {
        Disposition::Unavailable => PrepareError::Unavailable(describe(e)),
        Disposition::Failed => PrepareError::Failed(describe(e)),
    }
}

fn start_outcome(e: &AdapterError) -> StartOutcome {
    match disposition(e.code) {
        Disposition::Unavailable => StartOutcome::Unavailable(describe(e)),
        Disposition::Failed => StartOutcome::NotSpawned(describe(e)),
    }
}

impl AdapterLauncher {
    pub(super) fn new(core: &Arc<Core>, registry: Arc<LiveRegistry>) -> AdapterLauncher {
        AdapterLauncher { core: Arc::downgrade(core), registry, started: Arc::new(Mutex::new(HashMap::new())), approval_ttl: super::approval::ttl_from_env(super::approval::APPROVAL_TTL_ENV, super::approval::DEFAULT_APPROVAL_TTL) }
    }

    /// Con otro plazo para las peticiones del proveedor (las pruebas no esperan minutos).
    #[cfg(test)]
    pub(super) fn with_approval_ttl(mut self, ttl: Duration) -> AdapterLauncher {
        self.approval_ttl = ttl;
        self
    }

    /// El registro de proveedores del lanzador, para que una prueba lo vuelva a sondear.
    #[cfg(test)]
    pub(super) fn registry_for_tests(&self) -> Arc<LiveRegistry> {
        Arc::clone(&self.registry)
    }

    /// La ejecución aceptada de un Attempt, una sola vez: quien la toma (el bombeo) se hace cargo de ella.
    pub(super) fn take_started(&self, attempt_id: &str) -> Option<StartedRun> {
        self.started.lock().unwrap_or_else(|e| e.into_inner()).remove(attempt_id)
    }
}

impl Launcher for AdapterLauncher {
    fn prepare(&self, intent: &DispatchIntent) -> Result<Box<dyn PreparedLaunch>, PrepareError> {
        let core = self.core.upgrade().ok_or_else(|| PrepareError::Unavailable("el Core se está apagando".into()))?;
        let (adapter, matrix) = match LiveRegistry::adapter_for(&self.registry, &intent.provider) {
            AdapterLookup::Probing => return Err(PrepareError::Unavailable(format!("provider_probing: el proveedor {} todavía se está sondeando", intent.provider))),
            AdapterLookup::Unknown => return Err(PrepareError::Unavailable(format!("provider_unknown: el proveedor {} no está registrado en este Core", intent.provider))),
            AdapterLookup::Found(adapter, matrix) => (adapter, matrix),
        };
        // Lo que se comprobó al crear la Task pudo cambiar (CLI desinstalada, sesión caducada): se vuelve a mirar ANTES de
        // crear nada. Sin `events` no habría quien escuchara la ejecución. Un Attempt que continúa una sesión la REANUDA
        // (`resume`); cualquier otro arranca (`start`).
        let launch = if intent.resume.is_some() { Capability::Resume } else { Capability::Start };
        for capability in [launch, Capability::Events] {
            matrix.require(capability).map_err(|e| prepare_error(&e))?;
        }
        // La referencia se valida ANTES de crear nada: una que el adapter no acepte no deja un worktree a medias.
        let provider_ref = intent.resume.as_deref().map(ProviderRef::new).transpose().map_err(|e| prepare_error(&e))?;
        let worktree = core.provision_worktree(intent)?;
        let request = match provider_ref {
            Some(provider_ref) => LaunchRequest::Resume(ResumeRequest {
                attempt_id: intent.attempt_id.clone(),
                provider_ref,
                worktree: worktree.dir.clone(),
                prompt: Some(intent.prompt.clone()),
                profile: intent.profile.clone(),
                model: intent.model.clone(),
                effort: intent.effort.clone(),
            }),
            None => LaunchRequest::Start(StartRequest {
                attempt_id: intent.attempt_id.clone(),
                worktree: worktree.dir.clone(),
                prompt: intent.prompt.clone(),
                profile: intent.profile.clone(),
                model: intent.model.clone(),
                effort: intent.effort.clone(),
            }),
        };
        Ok(Box::new(AdapterPrepared { core: self.core.clone(), task_id: intent.task_id.clone(), adapter, matrix, request, cancel: CancelToken::new(), worktree, started: Arc::clone(&self.started) }))
    }

    /// El proveedor aceptó la ejecución: se toma y se escucha en su propio hilo.
    fn started(&self, attempt_id: &str) {
        let Some(run) = self.take_started(attempt_id) else { return };
        match self.core.upgrade() {
            Some(core) => super::run_pump::spawn_pump(&core, run, self.approval_ttl),
            None => {
                eprintln!("[core] el Core ya no existe: una ejecución aceptada queda sin escuchar");
                run.cancel.cancel();
            }
        }
    }
}

struct AdapterPrepared {
    core: Weak<Core>,
    task_id: String,
    adapter: Arc<dyn ProviderAdapter>,
    matrix: CapabilityMatrix,
    request: LaunchRequest,
    cancel: CancelToken,
    worktree: ProvisionedWorktree,
    started: Started,
}

/// Lo que se le pide al adapter: arrancar de cero o reanudar la sesión de un Attempt anterior.
enum LaunchRequest {
    Start(StartRequest),
    Resume(ResumeRequest),
}

impl LaunchRequest {
    fn attempt_id(&self) -> &str {
        match self {
            LaunchRequest::Start(r) => &r.attempt_id,
            LaunchRequest::Resume(r) => &r.attempt_id,
        }
    }
}

impl AdapterPrepared {
    /// Libera el worktree; un fallo no cambia el desenlace (lo limpiará la reconciliación de arranque), solo se dice.
    fn release(&self) {
        match self.core.upgrade() {
            Some(core) => {
                // El motivo no se imprime aquí: un fallo del registro lleva la identidad del efecto, y un fallo de git ya lo
                // dice `release_worktree`. Si no se pudo liberar, queda anotado como efecto sin registrar.
                if core.release_worktree(&self.worktree).is_err() {
                    eprintln!("[core] no se pudo liberar el worktree de un Attempt no lanzado: queda para la reconciliación de arranque");
                }
            }
            None => eprintln!("[core] el Core ya no existe: el worktree de un Attempt no lanzado queda para la reconciliación de arranque"),
        }
    }
}

impl PreparedLaunch for AdapterPrepared {
    fn start(self: Box<Self>) -> StartOutcome {
        let gated = Gated::new(self.adapter.as_ref(), &self.matrix);
        let called = catch_unwind(AssertUnwindSafe(|| match &self.request {
            LaunchRequest::Start(request) => gated.start(request.clone(), &self.cancel),
            LaunchRequest::Resume(request) => gated.resume(request.clone(), &self.cancel),
        }));
        match called {
            Ok(Ok(handle)) => {
                let attempt_id = self.request.attempt_id().to_string();
                let AdapterPrepared { task_id, adapter, matrix, cancel, worktree, started, .. } = *self;
                started.lock().unwrap_or_else(|e| e.into_inner()).insert(attempt_id, StartedRun { task_id, adapter, matrix, handle, cancel, worktree });
                StartOutcome::Running
            }
            Ok(Err(error)) => {
                // El adapter no atendió la operación y, si llegó a crear un proceso, lo cerró: no hay nada que conservar.
                self.release();
                start_outcome(&error)
            }
            // Un pánico dentro del adapter: pudo haber lanzado el proceso. No se libera nada (el worktree puede estar en uso).
            Err(_) => StartOutcome::Unknown("el adapter entró en pánico al lanzar: no se sabe si el proveedor llegó a arrancar".into()),
        }
    }

    fn abandon(self: Box<Self>) {
        self.release();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cada_codigo_de_error_tiene_su_desenlace() {
        use Disposition::{Failed, Unavailable};
        let table = [
            (ErrorCode::EnvironmentBlocked, Unavailable),
            (ErrorCode::UnsupportedCapability, Unavailable),
            (ErrorCode::CapabilityUnavailable, Unavailable),
            (ErrorCode::UnknownCapability, Unavailable),
            (ErrorCode::Cancelled, Unavailable),
            (ErrorCode::InvalidRequest, Failed),
            (ErrorCode::UnknownProvider, Failed),
            (ErrorCode::UnknownRun, Failed),
            (ErrorCode::SessionNotFound, Failed),
            (ErrorCode::Provider, Failed),
            (ErrorCode::Internal, Failed),
        ];
        for (code, expected) in table {
            assert_eq!(disposition(code), expected, "{}", code.code());
        }
    }

    #[test]
    fn el_texto_lleva_el_codigo_y_el_mensaje_pero_nunca_el_diagnostico_crudo() {
        let error = AdapterError::provider("la CLI se cerró").with_diagnostic("salida cruda del proveedor");
        let text = describe(&error);
        assert!(text.starts_with("provider: la CLI se cerró"), "{text}");
        assert!(!text.contains("salida cruda"));
        assert!(matches!(prepare_error(&error), PrepareError::Failed(_)));
        assert!(matches!(start_outcome(&error), StartOutcome::NotSpawned(_)));
        let blocked = AdapterError::environment_blocked(super::super::agents::EnvBlock::CliMissing);
        assert!(matches!(prepare_error(&blocked), PrepareError::Unavailable(_)));
        assert!(matches!(start_outcome(&blocked), StartOutcome::Unavailable(_)));
    }
}
