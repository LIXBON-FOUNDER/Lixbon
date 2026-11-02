//! Despachador del primer Attempt (LXO-141, fase 2c-1a): lleva un Attempt aprobado de `starting` a «lanzado» respetando el
//! claim de despacho (migración 020).
//!
//! ```text
//! dispatch_attempt(id, launcher)
//!   1. leer las filas durables y reconstruir la intención          <- solo de lo persistido, nunca de lo que diga quien llama
//!   2. reservar el claim (un solo uso; revalida aprobación, Run, Project)
//!   3. launcher.prepare(intención)                                 <- worktree, capability, entorno: SIN efectos del proveedor
//!        falla -> el Attempt se cierra desde `starting` y el claim se asienta
//!   4. Core::mutate: mark_running                                  <- `attempt.started` (Core), ANTES de llamar al proveedor
//!   5. claim `reserved -> started`
//!   6. prepared.start()                                            <- la llamada al proveedor
//!        Running -> lanzado · NotSpawned -> failed(launch_failed) y asentar · Unavailable -> stopped y asentar
//!        Unknown -> el claim se queda `started`
//! ```
//!
//! Como `attempt.started` se registra antes de llamar al proveedor, un claim sin él prueba que el proveedor nunca se llamó
//! (ver `store/dispatch_evidence.rs`): por eso un fallo en el paso 3 o 4 puede asentar el claim directamente.
//!
//! # Qué NO hace (todavía)
//! * No lanza nada por sí mismo: el [`Launcher`] lo inyecta quien llama (el real —worktree y adapter— llega en otra fase).
//! * No convierte los eventos del proveedor en `attempt.completed`/`failed`: un Attempt lanzado se queda `running`.
//! * No registra `attempt.dispatch_ambiguous`: un desenlace desconocido deja el claim `started`, que ya impide cualquier
//!   relanzamiento, pero no lo hace visible en Attention. Tampoco reconcilia los claims en vuelo al arrancar.
//!
//! **Inerte**: nada en producción lo llama; solo lo ejecutan las pruebas.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el RPC del primer Attempt (LXO-141, fase 2c)

use std::path::PathBuf;

use super::events::MutationContext;
use super::mutation::Health;
use super::state::Status;
use super::Core;
use crate::store::{AttemptRow, AttemptStatus, RunRow, TaskIntent, TaskOrigin, TaskRow};

/// Cuántos aprobados procesa una pasada de [`Core::dispatch_approved`].
const DISPATCH_BATCH_LIMIT: usize = 16;

/// Lo que el despachador lee de un Attempt: sus filas durables y su claim.
pub(super) struct DispatchSnapshot {
    pub attempt: AttemptRow,
    pub task: TaskRow,
    pub run: RunRow,
    pub claim: String,
}

/// Resultado de reservar el claim.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum ReserveOutcome {
    Reserved,
    /// Ya tenía claim: un claim nunca se repite.
    AlreadyClaimed,
    /// La elegibilidad durable cambió o no se cumple (falta la aprobación canónica, el Run se cerró…).
    Ineligible(String),
}

/// Todo lo que el lanzamiento necesita, reconstruido SOLO de filas persistidas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DispatchIntent {
    pub attempt_id: String,
    pub task_id: String,
    pub run_id: String,
    pub project_id: String,
    pub provider: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// Perfil de permisos del Core (`agents::Profile::id`).
    pub profile: String,
    pub prompt: String,
    /// Ubicación del Project en esta máquina, verificada por el Core (`Task.repo` no se usa: lo dice quien crea la Task).
    /// El [`Launcher`] decide el worktree a partir de ella.
    pub repo: PathBuf,
}

/// Por qué no se pudo preparar el lanzamiento. En ningún caso se llamó al proveedor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PrepareError {
    /// Falló algo que se esperaba que funcionara (p. ej. crear el worktree): `attempt.failed(launch_failed)`.
    Failed(String),
    /// No había nada que lanzar (capability ausente, entorno bloqueado, cancelación): `attempt.stopped`, nunca `failed`.
    Unavailable(String),
}

/// Cómo terminó la llamada al proveedor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum StartOutcome {
    /// El proveedor aceptó la ejecución.
    Running,
    /// El adapter prueba que el proveedor nunca se lanzó.
    NotSpawned(String),
    /// El adapter prueba que no se lanzó porque no había nada que lanzar (entorno bloqueado, capability ausente, cancelación):
    /// `attempt.stopped`, nunca `failed` (un entorno bloqueado no es un fallo del agente).
    Unavailable(String),
    /// No se sabe si el proveedor llegó a lanzarse. Nunca se reintenta solo.
    Unknown(String),
}

/// Un lanzamiento preparado: lo ya hecho sin efectos del proveedor (worktree, capability, entorno).
pub(super) trait PreparedLaunch: Send {
    /// La llamada al proveedor. Se invoca como mucho una vez y solo tras registrar `attempt.started`.
    fn start(self: Box<Self>) -> StartOutcome;
    /// No se llegó a llamar al proveedor: deshace lo preparado.
    fn abandon(self: Box<Self>);
}

/// Lo que el despachador pide al exterior. Se inyecta para poder probar sin proveedor ni git.
pub(super) trait Launcher: Send + Sync {
    /// Prepara el lanzamiento (worktree, capability, entorno) sin ningún efecto del proveedor.
    fn prepare(&self, intent: &DispatchIntent) -> Result<Box<dyn PreparedLaunch>, PrepareError>;

    /// El proveedor aceptó la ejecución del Attempt (`StartOutcome::Running`): ya es de quien la escucha. Por defecto no hace
    /// nada; el lanzador real arranca aquí el bombeo de eventos.
    fn started(&self, _attempt_id: &str) {}
}

/// Desenlace de [`Core::dispatch_attempt`].
#[derive(Debug, PartialEq, Eq)]
pub(super) enum DispatchResult {
    /// Ya tenía claim: no se hace nada.
    AlreadyClaimed,
    /// No es despachable (o dejó de serlo): no se reservó nada o la reserva se rechazó.
    Ineligible(String),
    /// La preparación falló: el Attempt se cerró desde `starting` (`failed` o `stopped`) y el claim se asentó.
    NotLaunched { stopped: bool },
    /// El proveedor aceptó la ejecución: el Attempt está `running` y el claim `started`.
    Launched,
    /// El adapter probó que el proveedor no se lanzó: el Attempt `failed(launch_failed)` y el claim asentado.
    NotSpawned,
    /// El adapter probó que no se lanzó porque no había nada que lanzar: el Attempt `stopped` y el claim asentado.
    Unavailable,
    /// No se sabe si el proveedor se lanzó: el claim queda `started` y el Attempt `running`. No se relanza.
    OutcomeUnknown,
}

/// Reconstruye la intención solo de filas persistidas y falla cerrado si algo no cuadra.
pub(super) fn intent_from_rows(attempt: &AttemptRow, task: &TaskRow, run: &RunRow, repo: PathBuf) -> Result<DispatchIntent, String> {
    let incomplete = |what: &str| Err(format!("el Attempt {} no se puede despachar: {what}", attempt.id));
    if attempt.origin != TaskOrigin::Core {
        return incomplete("no tiene origin core");
    }
    if attempt.status != AttemptStatus::Starting {
        return incomplete("no está starting");
    }
    if attempt.task_id != task.id || task.run_id != run.id {
        return incomplete("las filas no son de la misma Task y el mismo Run");
    }
    if task.intent != TaskIntent::Open {
        return incomplete("la Task no está vigente");
    }
    if run.closed {
        return incomplete("el Run está cerrado");
    }
    let Some(project_id) = task.project_id.clone().filter(|p| !p.is_empty()) else {
        return incomplete("la Task no tiene Project");
    };
    if attempt.provider.trim().is_empty() {
        return incomplete("no tiene provider");
    }
    let Some(profile) = attempt.profile.clone().filter(|p| !p.trim().is_empty()) else {
        return incomplete("no tiene un perfil de permisos");
    };
    if task.spec.trim().is_empty() {
        return incomplete("la Task no tiene un spec que lanzar");
    }
    Ok(DispatchIntent {
        attempt_id: attempt.id.clone(),
        task_id: task.id.clone(),
        run_id: run.id.clone(),
        project_id,
        provider: attempt.provider.clone(),
        model: attempt.model.clone(),
        effort: attempt.effort.clone(),
        profile,
        prompt: task.spec.clone(),
        repo,
    })
}

impl Core {
    /// El lanzador instalado, si lo hay.
    pub(super) fn launcher(&self) -> Option<std::sync::Arc<dyn Launcher>> {
        self.launcher.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Instala el lanzador de los primeros Attempts. Hasta que exista el real (worktree + adapter) solo lo instalan las
    /// pruebas: sin lanzador, `task_create` rechaza `attempt`.
    pub(super) fn install_launcher(&self, launcher: std::sync::Arc<dyn Launcher>) {
        *self.launcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(launcher);
    }

    /// Despierta al despachador en segundo plano (p. ej. tras aprobar): el despacho hace E/S y no debe correr en el hilo del RPC.
    pub(super) fn wake_dispatcher(self: &std::sync::Arc<Self>) {
        let Some(launcher) = self.launcher() else { return };
        let weak = std::sync::Arc::downgrade(self);
        let spawned = std::thread::Builder::new().name("dispatcher".into()).spawn(move || {
            if let Some(core) = weak.upgrade() {
                core.dispatch_approved(launcher.as_ref());
            }
        });
        if let Err(why) = spawned {
            eprintln!("[core] no se pudo crear el hilo del despachador: {why}");
        }
    }

    /// Despacha los aprobados que esperan, si hay lanzador. Lo ejecuta el barrido periódico.
    pub(super) fn dispatch_waiting_approved(&self) {
        if let Some(launcher) = self.launcher() {
            self.dispatch_approved(launcher.as_ref());
        }
    }

    /// Despacha UN Attempt. Cada paso con efectos va después del claim y deja el estado coherente si el siguiente falla; un
    /// `Err` significa que el almacén no pudo confirmar un paso y el claim, si existe, queda tal cual (nunca se repite).
    pub(super) fn dispatch_attempt(&self, attempt_id: &str, launcher: &dyn Launcher) -> Result<DispatchResult, String> {
        if !matches!(self.health(), Health::Normal) {
            return Err("el Core no está en estado normal: no se despacha".into());
        }
        let Some(snapshot) = self.dispatch_snapshot(attempt_id)? else {
            return Ok(DispatchResult::Ineligible("el Attempt no existe".into()));
        };
        if snapshot.claim != "none" {
            return Ok(DispatchResult::AlreadyClaimed);
        }
        // La ubicación se verifica antes de reservar: si no hay un sitio desde el que lanzar, no se reclama nada.
        let Some(project_id) = snapshot.task.project_id.as_deref() else {
            return Ok(DispatchResult::Ineligible(format!("el Attempt {attempt_id} no se puede despachar: la Task no tiene Project")));
        };
        let repo = match self.project_launch_location(project_id) {
            Ok(repo) => repo,
            Err(why) => return Ok(DispatchResult::Ineligible(why)),
        };
        let intent = match intent_from_rows(&snapshot.attempt, &snapshot.task, &snapshot.run, repo) {
            Ok(intent) => intent,
            Err(why) => return Ok(DispatchResult::Ineligible(why)),
        };

        match self.dispatch_reserve(attempt_id)? {
            ReserveOutcome::Reserved => {}
            ReserveOutcome::AlreadyClaimed => return Ok(DispatchResult::AlreadyClaimed),
            ReserveOutcome::Ineligible(why) => return Ok(DispatchResult::Ineligible(why)),
        }

        let prepared = match launcher.prepare(&intent) {
            Ok(prepared) => prepared,
            Err(error) => return self.close_unlaunched(&intent, error),
        };

        // `attempt.started` se registra ANTES de llamar al proveedor.
        let started = self.mutate_as(&MutationContext::core(), |tx| tx.mark_running(&intent.task_id));
        if let Err(why) = started {
            prepared.abandon();
            return self.close_unlaunched(&intent, PrepareError::Unavailable(format!("no se pudo registrar attempt.started: {why}")));
        }
        if !self.dispatch_mark_started(attempt_id)? {
            // `attempt.started` es durable pero el claim no avanzó: sin ese traspaso no se llama al proveedor.
            prepared.abandon();
            return Err(format!("el claim de {attempt_id} no pudo pasar a started: no se llama al proveedor"));
        }

        match prepared.start() {
            StartOutcome::Running => {
                launcher.started(attempt_id);
                Ok(DispatchResult::Launched)
            }
            StartOutcome::NotSpawned(why) => {
                self.mutate_as(&MutationContext::core(), |tx| tx.fail_with(&intent.task_id, "launch_failed", &why).map(|_| ()))?;
                self.settle_after_close(attempt_id)?;
                Ok(DispatchResult::NotSpawned)
            }
            StartOutcome::Unavailable(why) => {
                self.mutate_as(&MutationContext::core(), |tx| tx.close(&intent.task_id, Status::Stopped, &why).map(|_| ())).map_err(|e| e.to_string())?;
                self.settle_after_close(attempt_id)?;
                Ok(DispatchResult::Unavailable)
            }
            StartOutcome::Unknown(why) => {
                eprintln!("[core] el despacho de {attempt_id} tiene un desenlace desconocido ({why}): el claim queda started y no se relanza");
                Ok(DispatchResult::OutcomeUnknown)
            }
        }
    }

    /// Despacha los Attempts aprobados que esperan (como mucho un lote). Devuelve el desenlace de cada uno.
    pub(super) fn dispatch_approved(&self, launcher: &dyn Launcher) -> Vec<(String, DispatchResult)> {
        let candidates = match self.approved_dispatch_candidates(DISPATCH_BATCH_LIMIT) {
            Ok(candidates) => candidates,
            Err(why) => {
                eprintln!("[core] no se pudo leer la cola de despacho: {why}");
                return Vec::new();
            }
        };
        let mut out = Vec::new();
        for id in candidates {
            if !matches!(self.health(), Health::Normal) {
                break;
            }
            match self.dispatch_attempt(&id, launcher) {
                Ok(result) => out.push((id, result)),
                Err(why) => eprintln!("[core] no se pudo despachar {id}: {why}"),
            }
        }
        out
    }

    /// El Attempt sigue `starting` con el claim `reserved` y el proveedor no se llamó: se cierra y se asienta el claim.
    fn close_unlaunched(&self, intent: &DispatchIntent, error: PrepareError) -> Result<DispatchResult, String> {
        let stopped = matches!(error, PrepareError::Unavailable(_));
        let why = match &error {
            PrepareError::Failed(why) | PrepareError::Unavailable(why) => why.clone(),
        };
        self.mutate_as(&MutationContext::core(), |tx| {
            if stopped {
                tx.close(&intent.task_id, Status::Stopped, &why).map(|_| ())
            } else {
                tx.fail_with(&intent.task_id, "launch_failed", &why).map(|_| ())
            }
        })?;
        self.settle_after_close(&intent.attempt_id)?;
        Ok(DispatchResult::NotLaunched { stopped })
    }

    /// Asienta el claim tras cerrar el Attempt. Que no se asiente es una incoherencia: el claim se queda como está.
    fn settle_after_close(&self, attempt_id: &str) -> Result<(), String> {
        if self.dispatch_settle(attempt_id)? {
            Ok(())
        } else {
            Err(format!("el Attempt {attempt_id} se cerró pero su claim no se pudo asentar con evidencia canónica"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{AttemptRow, RunRow, TaskRow};

    fn rows() -> (AttemptRow, TaskRow, RunRow) {
        let attempt = AttemptRow {
            id: "t-1-a1".into(),
            task_id: "t-1".into(),
            n: 1,
            status: AttemptStatus::Starting,
            external: false,
            provider: "fake".into(),
            model: Some("m".into()),
            effort: None,
            role: None,
            profile: Some("explorar".into()),
            worktree_id: None,
            provider_session_id: None,
            summary: String::new(),
            failure_reason: None,
            created_at: 1,
            started_at: None,
            ended_at: None,
            updated_at: 1,
            origin: TaskOrigin::Core,
        };
        let task = TaskRow {
            id: "t-1".into(),
            run_id: "r-1".into(),
            parent_task_id: None,
            depth: 0,
            project_id: Some("p-1".into()),
            title: "t".into(),
            spec: "haz algo".into(),
            repo: "C:/repo".into(),
            intent: TaskIntent::Open,
            origin: TaskOrigin::Core,
            created_at: 1,
            updated_at: 1,
            discarded_at: None,
        };
        let run = RunRow { id: "r-1".into(), objective: "o".into(), root_task_id: "t-1".into(), created_at: 1, closed: false, last_activity: 1 };
        (attempt, task, run)
    }

    #[test]
    fn la_intencion_sale_solo_de_las_filas_persistidas() {
        let (a, t, r) = rows();
        let intent = intent_from_rows(&a, &t, &r, PathBuf::from("C:/repo")).unwrap();
        assert_eq!(intent.attempt_id, "t-1-a1");
        assert_eq!(intent.project_id, "p-1");
        assert_eq!(intent.provider, "fake");
        assert_eq!(intent.model.as_deref(), Some("m"));
        assert_eq!(intent.profile, "explorar");
        assert_eq!(intent.prompt, "haz algo");
        assert_eq!(intent.repo, PathBuf::from("C:/repo"));
    }

    #[test]
    fn una_fila_incompleta_o_incoherente_falla_cerrada() {
        let cases: Vec<(&str, Box<dyn Fn(&mut AttemptRow, &mut TaskRow, &mut RunRow)>)> = vec![
            ("legacy", Box::new(|a, _, _| a.origin = TaskOrigin::Legacy)),
            ("no starting", Box::new(|a, _, _| a.status = AttemptStatus::Running)),
            ("otra task", Box::new(|a, _, _| a.task_id = "t-2".into())),
            ("otro run", Box::new(|_, t, _| t.run_id = "r-2".into())),
            ("task descartada", Box::new(|_, t, _| t.intent = TaskIntent::Discarded)),
            ("run cerrado", Box::new(|_, _, r| r.closed = true)),
            ("sin project", Box::new(|_, t, _| t.project_id = None)),
            ("project vacío", Box::new(|_, t, _| t.project_id = Some(String::new()))),
            ("sin provider", Box::new(|a, _, _| a.provider = "  ".into())),
            ("sin perfil", Box::new(|a, _, _| a.profile = None)),
            ("perfil en blanco", Box::new(|a, _, _| a.profile = Some(" ".into()))),
            ("sin spec", Box::new(|_, t, _| t.spec = " \n".into())),
        ];
        for (name, mutate) in cases {
            let (mut a, mut t, mut r) = rows();
            mutate(&mut a, &mut t, &mut r);
            assert!(intent_from_rows(&a, &t, &r, PathBuf::from("C:/repo")).is_err(), "{name} debía rechazarse");
        }
    }
}
