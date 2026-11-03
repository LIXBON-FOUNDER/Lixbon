//! El despachador del primer Attempt (LXO-141, fase 2c-1a) con un Core real, SQLite y un `Launcher` falso.
//! Cada prueba comprueba lo durable (filas, claim, eventos), no solo el valor devuelto.

use std::sync::{Arc, Mutex};

use super::dispatch::{DispatchIntent, DispatchResult, Launcher, PrepareError, PreparedLaunch, StartOutcome};
use super::initial_approval_tests::e2e::core_with_pending_attempt;
use super::state::Status;
use super::Core;

/// Lo que el `Launcher` falso registra: el orden de las llamadas.
pub(in crate::orch) type Calls = Arc<Mutex<Vec<String>>>;

pub(in crate::orch) struct FakeLauncher {
    prepare: Result<(), PrepareError>,
    start: StartOutcome,
    calls: Calls,
    /// Se ejecuta DENTRO de `prepare` (p. ej. para cambiar el mundo entre el claim y `attempt.started`).
    during_prepare: Option<Box<dyn Fn() + Send + Sync>>,
    /// Las intenciones que recibió `prepare`.
    pub(in crate::orch) intents: Arc<Mutex<Vec<DispatchIntent>>>,
}

struct FakePrepared {
    start: StartOutcome,
    calls: Calls,
}

impl PreparedLaunch for FakePrepared {
    fn start(self: Box<Self>) -> StartOutcome {
        self.calls.lock().unwrap().push("start".into());
        self.start
    }
    fn abandon(self: Box<Self>) {
        self.calls.lock().unwrap().push("abandon".into());
    }
}

impl Launcher for FakeLauncher {
    fn prepare(&self, intent: &DispatchIntent) -> Result<Box<dyn PreparedLaunch>, PrepareError> {
        self.calls.lock().unwrap().push(format!("prepare:{}", intent.attempt_id));
        self.intents.lock().unwrap().push(intent.clone());
        if let Some(hook) = &self.during_prepare {
            hook();
        }
        self.prepare.clone().map(|()| Box::new(FakePrepared { start: self.start.clone(), calls: self.calls.clone() }) as Box<dyn PreparedLaunch>)
    }
}

pub(in crate::orch) fn launcher(prepare: Result<(), PrepareError>, start: StartOutcome) -> (FakeLauncher, Calls) {
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    (FakeLauncher { prepare, start, calls: calls.clone(), during_prepare: None, intents: Arc::new(Mutex::new(Vec::new())) }, calls)
}

pub(in crate::orch) fn calls(calls: &Calls) -> Vec<String> {
    calls.lock().unwrap().clone()
}

/// (estado, claim, motivo del fallo) del Attempt en SQLite.
pub(in crate::orch) fn row(core: &Core, attempt: &str) -> (String, String, Option<String>) {
    core.storage
        .with_store(|store| {
            store.read(|c| {
                Ok(c.query_row("SELECT status, dispatch_claim, failure_reason FROM attempts WHERE id = ?1", [attempt], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?)
            })
        })
        .unwrap()
        .unwrap()
}

pub(in crate::orch) fn event_count(core: &Core, attempt: &str, kind: &str) -> i64 {
    core.storage
        .with_store(|store| store.read(|c| Ok(c.query_row("SELECT count(*) FROM events WHERE kind = ?1 AND entity_id = ?2", [kind, attempt], |r| r.get(0))?)))
        .unwrap()
        .unwrap()
}

/// Un Core con su primer Attempt ya aprobado por la Person (`starting`, claim `none`).
fn approved() -> (Arc<Core>, String, String) {
    let (core, ctx, task, attempt) = core_with_pending_attempt();
    core.mutate_as(&ctx, |tx| tx.approve_attempt(&attempt)).unwrap();
    assert_eq!(row(&core, &attempt).0, "starting");
    (core, task, attempt)
}

#[test]
fn un_attempt_aprobado_se_lanza_una_sola_vez_y_su_claim_nunca_se_repite() {
    let (core, task, attempt) = approved();
    let (launcher, log) = launcher(Ok(()), StartOutcome::Running);

    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::Launched);
    assert_eq!(calls(&log), vec![format!("prepare:{attempt}"), "start".to_string()]);
    assert_eq!(row(&core, &attempt), ("running".into(), "started".into(), None));
    assert_eq!(core.lock().tasks[&task].status, Status::Running);
    assert_eq!(event_count(&core, &attempt, "attempt.started"), 1, "attempt.started se registra una vez, antes de llamar al proveedor");

    // Un segundo intento (un reintento del cliente, otra pasada, un reinicio) no vuelve a llamar al proveedor.
    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::AlreadyClaimed);
    assert_eq!(calls(&log).len(), 2, "el proveedor no se relanza");
    assert_eq!(event_count(&core, &attempt, "attempt.started"), 1);
}

#[test]
fn un_attempt_pendiente_de_aprobacion_no_se_despacha() {
    let (core, _ctx, _task, attempt) = core_with_pending_attempt();
    let (launcher, log) = launcher(Ok(()), StartOutcome::Running);

    assert!(matches!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::Ineligible(_)));
    assert!(calls(&log).is_empty(), "sin aprobación no se prepara nada");
    assert_eq!(row(&core, &attempt), ("pending_approval".into(), "none".into(), None));
    assert!(core.dispatch_approved(&launcher).is_empty());
}

#[test]
fn un_attempt_que_no_existe_no_se_despacha() {
    let (core, _task, _attempt) = approved();
    let (launcher, log) = launcher(Ok(()), StartOutcome::Running);
    assert!(matches!(core.dispatch_attempt("no-existe-a1", &launcher).unwrap(), DispatchResult::Ineligible(_)));
    assert!(calls(&log).is_empty());
}

#[test]
fn si_la_preparacion_falla_el_attempt_falla_desde_starting_y_el_claim_se_asienta_sin_attempt_started() {
    let (core, task, attempt) = approved();
    let (launcher, log) = launcher(Err(PrepareError::Failed("no se pudo crear el worktree".into())), StartOutcome::Running);

    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::NotLaunched { stopped: false });
    assert_eq!(calls(&log), vec![format!("prepare:{attempt}")], "el proveedor no se llamó");
    assert_eq!(row(&core, &attempt), ("failed".into(), "settled".into(), Some("launch_failed".into())));
    assert_eq!(core.lock().tasks[&task].status, Status::Failed);
    assert_eq!(event_count(&core, &attempt, "attempt.started"), 0, "no hubo arranque");
    assert_eq!(event_count(&core, &attempt, "attempt.failed"), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.dispatch_ambiguous"), 0);

    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::AlreadyClaimed);
    assert_eq!(calls(&log).len(), 1);
}

#[test]
fn si_no_hay_nada_que_lanzar_el_attempt_se_detiene_y_nunca_falla() {
    let (core, task, attempt) = approved();
    let (launcher, log) = launcher(Err(PrepareError::Unavailable("el proveedor no ofrece la capability".into())), StartOutcome::Running);

    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::NotLaunched { stopped: true });
    assert_eq!(calls(&log), vec![format!("prepare:{attempt}")]);
    assert_eq!(row(&core, &attempt), ("stopped".into(), "settled".into(), None));
    assert_eq!(core.lock().tasks[&task].status, Status::Stopped);
    assert_eq!(event_count(&core, &attempt, "attempt.started"), 0);
    assert_eq!(event_count(&core, &attempt, "attempt.stopped"), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.failed"), 0);
}

#[test]
fn si_el_adapter_prueba_que_no_lanzo_el_attempt_falla_y_el_claim_se_asienta() {
    let (core, _task, attempt) = approved();
    let (launcher, log) = launcher(Ok(()), StartOutcome::NotSpawned("el CLI no arrancó".into()));

    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::NotSpawned);
    assert_eq!(calls(&log), vec![format!("prepare:{attempt}"), "start".to_string()]);
    assert_eq!(row(&core, &attempt), ("failed".into(), "settled".into(), Some("launch_failed".into())));
    assert_eq!(event_count(&core, &attempt, "attempt.started"), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.failed"), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.dispatch_ambiguous"), 0);
}

#[test]
fn un_desenlace_desconocido_deja_el_claim_started_y_no_se_relanza() {
    let (core, task, attempt) = approved();
    let (launcher, log) = launcher(Ok(()), StartOutcome::Unknown("el adapter se cayó tras lanzar".into()));

    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::OutcomeUnknown);
    assert_eq!(row(&core, &attempt), ("running".into(), "started".into(), None), "ni se da por fallido ni se asienta: no se sabe");
    assert_eq!(core.lock().tasks[&task].status, Status::Running);

    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::AlreadyClaimed);
    assert_eq!(calls(&log).iter().filter(|c| *c == "start").count(), 1, "el proveedor se llamó una sola vez");
}

#[test]
fn si_el_attempt_se_cierra_entre_el_claim_y_attempt_started_se_abandona_lo_preparado_y_el_claim_se_asienta() {
    let (core, task, attempt) = approved();
    let (mut launcher, log) = launcher(Ok(()), StartOutcome::Running);
    // Otro actor detiene la Task mientras se prepara el worktree.
    let hook_core = core.clone();
    let hook_task = task.clone();
    launcher.during_prepare = Some(Box::new(move || {
        hook_core.mutate_as(&super::events::MutationContext::core(), |tx| tx.close(&hook_task, Status::Stopped, "detenida").map(|_| ())).unwrap();
    }));

    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::NotLaunched { stopped: true });
    assert_eq!(calls(&log), vec![format!("prepare:{attempt}"), "abandon".to_string()], "lo preparado se deshace y el proveedor no se llama");
    assert_eq!(row(&core, &attempt), ("stopped".into(), "settled".into(), None));
    assert_eq!(event_count(&core, &attempt, "attempt.started"), 0);
}

#[test]
fn la_pasada_de_aprobados_despacha_cada_attempt_una_vez() {
    let (core, _task, attempt) = approved();
    let (launcher, log) = launcher(Ok(()), StartOutcome::Running);

    let first = core.dispatch_approved(&launcher);
    assert_eq!(first, vec![(attempt.clone(), DispatchResult::Launched)]);
    assert!(core.dispatch_approved(&launcher).is_empty(), "un Attempt ya reclamado sale de la cola");
    assert_eq!(calls(&log).iter().filter(|c| *c == "start").count(), 1);
}

#[test]
fn la_intencion_usa_la_ubicacion_verificada_del_project_y_no_el_repo_que_dijo_quien_creo_la_task() {
    let (core, task, attempt) = approved();
    // El `repo` de la Task es la ubicación verificada del Project (no lo que mande el cliente): el Worktree se registra con él.
    assert_eq!(core.lock().tasks[&task].repo, ".");
    let (launcher, _log) = launcher(Ok(()), StartOutcome::Running);

    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::Launched);
    let intents = launcher.intents.lock().unwrap();
    assert_eq!(intents.len(), 1);
    assert_eq!(intents[0].repo, std::path::PathBuf::from("."), "la ubicación del registro de proyectos de esta máquina");
    assert_eq!(intents[0].prompt, "haz algo", "el prompt sale del spec persistido");
    assert_eq!(intents[0].profile, "explorar");
    assert_eq!(intents[0].provider, "fake");
}

#[test]
fn sin_una_ubicacion_del_project_en_esta_maquina_no_se_reclama_ni_se_prepara_nada() {
    let (core, _task, attempt) = approved();
    // Otra máquina: el Project no tiene ubicación aquí.
    core.storage.with_store(|store| store.meta_set("machine_id", "otra-maquina").unwrap()).unwrap();
    let (launcher, log) = launcher(Ok(()), StartOutcome::Running);

    assert!(matches!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::Ineligible(_)));
    assert!(calls(&log).is_empty());
    assert_eq!(row(&core, &attempt), ("starting".into(), "none".into(), None), "sin claim: se podrá despachar cuando haya ubicación");
}

#[test]
fn si_el_adapter_prueba_que_no_habia_nada_que_lanzar_el_attempt_se_detiene_y_el_claim_se_asienta() {
    let (core, _task, attempt) = approved();
    let (launcher, log) = launcher(Ok(()), StartOutcome::Unavailable("environment_blocked: la CLI no está".into()));

    assert_eq!(core.dispatch_attempt(&attempt, &launcher).unwrap(), DispatchResult::Unavailable);
    assert_eq!(calls(&log), vec![format!("prepare:{attempt}"), "start".to_string()]);
    assert_eq!(row(&core, &attempt), ("stopped".into(), "settled".into(), None));
    assert_eq!(event_count(&core, &attempt, "attempt.started"), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.stopped"), 1);
    assert_eq!(event_count(&core, &attempt, "attempt.failed"), 0, "un entorno bloqueado no es un fallo del agente");
}
