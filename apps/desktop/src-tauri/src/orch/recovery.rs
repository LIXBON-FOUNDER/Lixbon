//! LXO-185 · recuperación al arrancar: el ORDEN en que un runtime nuevo resuelve lo que dejó el anterior, y el INFORME de cómo salió.
//!
//! Cada paso ya existía por separado (procesos, Attempts huérfanos, claims de despacho, cola de instrucciones, journal de efectos); lo que
//! faltaba era una sola secuencia con su contrato: un orden fijo, un desenlace por paso, una salud explícita y la garantía de que repetirla
//! converge al mismo estado.
//!
//! ```text
//!   arranque ──► 1 processes        procesos de un runtime anterior: identidad verificada, cerrar o dejar a la vista   (LXO-183)
//!            ──► 2 attempts         Attempts que el runtime anterior dejó en marcha: huérfanos (excepto los de una persona)
//!            ──► 3 dispatch_claims  claims en vuelo: se asientan con su evidencia o quedan `ambiguous`; nunca se relanzan
//!            ──► 4 queue            instrucciones en vuelo: `interrupted` (jamás se reintentan); lo encolado de un Attempt acabado falla
//!            ──► 5 effects          journal de efectos externos: solo AÑADE hechos al Event Log, nunca repite el efecto
//! ```
//!
//! # Por qué ese orden
//! * `processes` va primero: antes de decidir nada sobre un Attempt hay que saber si su proceso sigue ahí.
//! * `attempts` antes que `dispatch_claims`: un claim cuyo Attempt acabó con evidencia canónica se asienta; sin cerrar antes las huérfanas
//!   se confundiría con una ejecución viva.
//! * `queue` después de cerrar los Attempts: lo pendiente de un Attempt que ya no corre falla con motivo.
//! * `effects` al final: el Event Log ya refleja el estado cerrado, y los hechos recuperados se añaden sobre él.
//!
//! # Salud
//! Un paso termina `done`, `attention` (hay algo que una persona debe mirar, pero es seguro operar), `blocked` (no se pudo reconciliar con
//! seguridad) o `skipped` (no aplica en este modo). Mientras algún paso esté `blocked` la recuperación está **incompleta**: el despachador no
//! lanza Attempts nuevos y [`Core::recovery_report`] lo dice, con el motivo. Las lecturas y los comandos de una persona siguen funcionando: el
//! Core NO pasa a solo lectura por esto. El barrido periódico reintenta lo que se puede reintentar sin riesgo (procesos y journal).
//!
//! # Lo que NO hace
//! * No reejecuta nada: ni git, ni push, ni el lanzamiento de un proceso. Que falte un Event nunca es motivo para repetir un efecto.
//! * No adivina procesos por nombre. Un proceso que no se puede identificar con seguridad queda `unproven`, a la vista, sin matarlo.
//! * No adopta procesos vivos ni se reengancha a un proveedor: sus tuberías eran del Core que murió. Eso exige el daemon (rebanada 5 de la ADR).
//! * No emite un evento «recuperado»: lo que cambia ya deja SU hecho (`attempt.orphaned`, `attempt.dispatch_ambiguous`,
//!   `attempt.queue_failed`, `effect.observed`); un resumen sería un hecho duplicado.
//! * No resuelve conflictos de filesystem.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

use super::events::{Actor, MutationContext};
use super::process_ownership::ReconcileReport;
use super::state::now_ms;
use super::{Caller, Core};
use crate::proctable::Os;

/// Los pasos de la recuperación, en el orden en que se ejecutan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Processes,
    Attempts,
    DispatchClaims,
    Queue,
    Effects,
}

impl Phase {
    pub(super) const ORDER: [Phase; 5] = [Phase::Processes, Phase::Attempts, Phase::DispatchClaims, Phase::Queue, Phase::Effects];

    pub(super) fn name(self) -> &'static str {
        match self {
            Phase::Processes => "processes",
            Phase::Attempts => "attempts",
            Phase::DispatchClaims => "dispatch_claims",
            Phase::Queue => "queue",
            Phase::Effects => "effects",
        }
    }
}

/// Cómo terminó un paso.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Status {
    Done,
    /// Hay algo que una persona debe revisar, pero es seguro seguir operando.
    Attention,
    /// No se pudo reconciliar con seguridad: no se lanza trabajo nuevo hasta resolverlo.
    Blocked,
    /// No aplica en este modo (antes del corte, estado promovido ya cerrado…).
    Skipped,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Status::Done => "done",
            Status::Attention => "attention",
            Status::Blocked => "blocked",
            Status::Skipped => "skipped",
        }
    }
}

/// El desenlace de UN paso: cuánto cambió, cómo terminó y, si hace falta, el porqué (sin rutas ni datos sensibles).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Step {
    pub changed: usize,
    pub status: Status,
    pub note: Option<String>,
}

impl Step {
    pub(super) fn done(changed: usize) -> Step {
        Step { changed, status: Status::Done, note: None }
    }
    pub(super) fn attention(changed: usize, note: impl Into<String>) -> Step {
        Step { changed, status: Status::Attention, note: Some(note.into()) }
    }
    pub(super) fn blocked(note: impl Into<String>) -> Step {
        Step { changed: 0, status: Status::Blocked, note: Some(note.into()) }
    }
    pub(super) fn skipped(note: impl Into<String>) -> Step {
        Step { changed: 0, status: Status::Skipped, note: Some(note.into()) }
    }
    /// Un paso que terminó bien pero con una nota informativa (no pide revisión).
    pub(super) fn done_with(changed: usize, note: impl Into<String>) -> Step {
        Step { changed, status: Status::Done, note: Some(note.into()) }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct PhaseReport {
    pub phase: Phase,
    pub step: Step,
}

/// Cómo salió la recuperación de este runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RecoveryReport {
    pub runtime_instance: String,
    pub started_at: i64,
    pub finished_at: i64,
    pub phases: Vec<PhaseReport>,
    /// Solo pruebas: la secuencia se interrumpió tras este paso (simula una caída en esa frontera).
    pub halted_after: Option<Phase>,
}

impl RecoveryReport {
    /// Los motivos por los que la recuperación está incompleta. Vacío: completa.
    pub(super) fn blocking(&self) -> Vec<String> {
        self.phases
            .iter()
            .filter(|p| p.step.status == Status::Blocked)
            .map(|p| format!("{}: {}", p.phase.name(), p.step.note.as_deref().unwrap_or("sin detalle")))
            .collect()
    }

    pub(super) fn phase(&self, phase: Phase) -> Option<&PhaseReport> {
        self.phases.iter().find(|p| p.phase == phase)
    }
}

/// Lo que guarda el Core: el informe del arranque y la carpeta de datos, para poder reintentar el journal.
#[derive(Default)]
pub(super) struct RecoveryCell {
    inner: Mutex<RecoveryInner>,
}

#[derive(Default)]
struct RecoveryInner {
    report: Option<RecoveryReport>,
    data: Option<PathBuf>,
}

impl RecoveryCell {
    fn with<R>(&self, f: impl FnOnce(&mut RecoveryInner) -> R) -> R {
        f(&mut self.inner.lock().unwrap_or_else(|e| e.into_inner()))
    }
}

#[cfg(test)]
thread_local! {
    /// Solo pruebas: la secuencia de arranque se detiene tras este paso, como si el proceso hubiera caído en esa frontera.
    static CRASH_AFTER: std::cell::Cell<Option<Phase>> = const { std::cell::Cell::new(None) };
}

/// Solo pruebas: fija (o quita) el paso tras el cual «cae» el siguiente arranque de ESTE hilo.
#[cfg(test)]
pub(super) fn crash_after(phase: Option<Phase>) {
    CRASH_AFTER.with(|c| c.set(phase));
}

impl Core {
    /// Abre el informe de ESTE arranque. Idempotente: si ya hay uno de este runtime, lo conserva (el arranque lo completa por etapas).
    fn recovery_open(&self, data: &Path) {
        let instance = self.runtime_instance.clone();
        self.recovery.with(|inner| {
            inner.data = Some(data.to_path_buf());
            if inner.report.as_ref().is_none_or(|r| r.runtime_instance != instance) {
                let now = now_ms() as i64;
                inner.report = Some(RecoveryReport { runtime_instance: instance, started_at: now, finished_at: now, phases: Vec::new(), halted_after: None });
            }
        });
    }

    /// Anota el desenlace de un paso (reemplaza el anterior del mismo paso: reintentar no duplica filas) y avisa de si la secuencia debe seguir.
    fn recovery_record(&self, phase: Phase, step: Step) -> bool {
        if step.status == Status::Blocked {
            eprintln!("[core] recuperación: {} no se pudo reconciliar con seguridad ({})", phase.name(), step.note.as_deref().unwrap_or("sin detalle"));
        }
        let keep_going = self.recovery_continue(phase);
        self.recovery.with(|inner| {
            let Some(report) = inner.report.as_mut() else { return };
            match report.phases.iter_mut().find(|p| p.phase == phase) {
                Some(existing) => existing.step = step,
                None => {
                    report.phases.push(PhaseReport { phase, step });
                    report.phases.sort_by_key(|p| Phase::ORDER.iter().position(|o| *o == p.phase));
                }
            }
            report.finished_at = now_ms() as i64;
            if !keep_going {
                report.halted_after = Some(phase);
            }
        });
        keep_going
    }

    /// ¿Sigue la secuencia tras `phase`? Solo una prueba puede detenerla (simulando una caída en esa frontera).
    #[cfg(test)]
    fn recovery_continue(&self, phase: Phase) -> bool {
        CRASH_AFTER.with(|c| c.get() != Some(phase))
    }

    #[cfg(not(test))]
    fn recovery_continue(&self, _phase: Phase) -> bool {
        true
    }

    fn recovery_halted(&self) -> bool {
        self.recovery.with(|inner| inner.report.as_ref().is_some_and(|r| r.halted_after.is_some()))
    }

    /// Los pasos 1 a 4 del arranque. `on_tables`: el modelo Task/Attempt manda (sin él no hay claims ni cola); `needs_orphan`: el estado se
    /// cargó de SQLite (el promovido ya viene con las tareas cerradas).
    pub(super) fn recover_at_boot(&self, data: &Path, needs_orphan: bool, on_tables: bool) {
        self.recover_at_boot_with(data, needs_orphan, on_tables, &mut crate::proctable::RealOs::default());
    }

    /// Como [`Core::recover_at_boot`], con el sistema operativo que se le dé (las pruebas inyectan fallos).
    pub(super) fn recover_at_boot_with(&self, data: &Path, needs_orphan: bool, on_tables: bool, os: &mut dyn Os) {
        self.recovery_open(data);
        if !self.recovery_record(Phase::Processes, self.recover_processes_with(os)) {
            return;
        }
        let attempts = if needs_orphan { self.close_orphans() } else { Step::skipped("el estado promovido ya viene cerrado") };
        if !self.recovery_record(Phase::Attempts, attempts) {
            return;
        }
        let claims = if on_tables { self.reconcile_dispatch_claims_at_boot() } else { Step::skipped("sin el modelo Task/Attempt no hay claims de despacho") };
        if !self.recovery_record(Phase::DispatchClaims, claims) {
            return;
        }
        let queue = if on_tables { self.queue_recover_at_boot() } else { Step::skipped("sin el modelo Task/Attempt no hay cola de instrucciones") };
        self.recovery_record(Phase::Queue, queue);
    }

    /// El último paso: el journal de efectos. Va aparte porque el arranque lo ejecuta tras dejar el Core operativo (necesita el Event Log
    /// instalado) y porque en modo legacy es lo único que corre.
    pub(super) fn recover_effects(&self, data: &Path) {
        self.recovery_open(data);
        if self.recovery_halted() {
            return;
        }
        let step = self.effects_step(data);
        self.recovery_record(Phase::Effects, step);
        self.recovery_announce();
    }

    fn effects_step(&self, data: &Path) -> Step {
        match self.reconcile_unrecorded_effects(data) {
            Ok(report) => {
                self.announce_reconciled_effects(&report);
                let mut notes = Vec::new();
                if report.conflicting_ids > 0 {
                    notes.push(format!("{} efecto(s) con el mismo id y datos distintos", report.conflicting_ids));
                }
                if report.ack_failed.is_some() {
                    notes.push("no se pudo compactar el journal tras confirmar los eventos (se reintenta)".to_string());
                }
                if report.legacy_v1 + report.malformed > 0 {
                    notes.push(format!("{} línea(s) antigua(s) o ilegibles conservadas para revisión", report.legacy_v1 + report.malformed));
                }
                if report.pending > 0 && notes.is_empty() {
                    notes.push(format!("{} acción(es) sin registrar pendientes de revisión", report.pending));
                }
                if notes.is_empty() {
                    Step::done(report.recovered)
                } else {
                    Step::attention(report.recovered, notes.join("; "))
                }
            }
            // Sin poder leer el journal no se sabe si hay acciones externas sin registrar: se dice, y se reintenta en el barrido.
            Err(error) => Step::blocked(format!("no se pudo leer el journal de efectos ({:?})", error.kind())),
        }
    }

    /// El paso de procesos con el sistema operativo que se le dé (las pruebas inyectan fallos).
    pub(super) fn recover_processes_with(&self, os: &mut dyn Os) -> Step {
        let report = self.process_ownership_reconcile_with(os);
        step_of_processes(&report)
    }

    /// Los motivos por los que la recuperación está incompleta (vacío: completa o sin informe).
    pub(super) fn recovery_blocking(&self) -> Vec<String> {
        self.recovery.with(|inner| inner.report.as_ref().map(RecoveryReport::blocking).unwrap_or_default())
    }

    /// `Some(motivo)` mientras la recuperación esté incompleta: el despachador no lanza Attempts nuevos.
    pub(super) fn recovery_blocks_launch(&self) -> Option<String> {
        let reasons = self.recovery_blocking();
        (!reasons.is_empty()).then(|| reasons.join("; "))
    }

    /// El informe del arranque (una copia), si lo hay.
    #[cfg(test)]
    pub(super) fn recovery_snapshot(&self) -> Option<RecoveryReport> {
        self.recovery.with(|inner| inner.report.clone())
    }

    /// La carpeta de datos con la que arrancó este Core (donde vive el journal de efectos).
    #[cfg(test)]
    pub(super) fn recovery_data_dir(&self) -> Option<PathBuf> {
        self.recovery.with(|inner| inner.data.clone())
    }

    /// Solo pruebas: deja un paso `blocked` con el motivo dado (para probar lo que depende de la salud sin montar el fallo real).
    #[cfg(test)]
    pub(super) fn recovery_force_blocked_for_tests(&self, phase: Phase, note: &str) {
        self.recovery_open(Path::new("."));
        self.recovery_replace(phase, Step::blocked(note));
    }

    /// Avisa a la persona UNA vez por arranque si la recuperación quedó incompleta.
    fn recovery_announce(&self) {
        let reasons = self.recovery_blocking();
        if reasons.is_empty() {
            return;
        }
        let msg = format!("La recuperación al arrancar no pudo reconciliar todo con seguridad: {}. No se lanzarán Attempts nuevos hasta resolverlo; el estado y los artefactos se conservan.", reasons.join("; "));
        eprintln!("[core] {msg}");
        if let Some(host) = self.host.get() {
            host.notify("Lixbon: recuperación incompleta", &msg);
        }
    }

    /// Reintenta, con el sistema operativo real, lo que quedó bloqueado y se puede repetir sin riesgo. Lo llama el barrido periódico.
    pub(super) fn recovery_retry(&self) {
        self.recovery_retry_with(&mut crate::proctable::RealOs::default());
    }

    /// Como [`Core::recovery_retry`] con el sistema operativo que se le dé. Solo toca procesos de OTROS runtimes y el journal: ninguno puede
    /// afectar a lo que este runtime tiene en marcha, así que repetirlos es seguro. Los pasos de estado (`attempts`, `dispatch_claims`,
    /// `queue`) NO se reintentan aquí: cerrar «huérfanos» con el runtime en marcha mataría trabajo vivo.
    pub(super) fn recovery_retry_with(&self, os: &mut dyn Os) {
        let (blocked_processes, blocked_effects, data) = self.recovery.with(|inner| {
            let blocked = |phase| inner.report.as_ref().and_then(|r| r.phase(phase)).is_some_and(|p| p.step.status == Status::Blocked);
            (blocked(Phase::Processes), blocked(Phase::Effects), inner.data.clone())
        });
        let mut recovered = false;
        if blocked_processes {
            let step = self.recover_processes_with(os);
            recovered |= step.status != Status::Blocked;
            self.recovery_replace(Phase::Processes, step);
        }
        if blocked_effects {
            if let Some(data) = data {
                let step = self.effects_step(&data);
                recovered |= step.status != Status::Blocked;
                self.recovery_replace(Phase::Effects, step);
            }
        }
        if recovered && self.recovery_blocking().is_empty() {
            eprintln!("[core] recuperación: lo que estaba bloqueado se resolvió; se vuelve a lanzar trabajo");
        }
    }

    /// Reemplaza el desenlace de un paso sin pasar por la secuencia del arranque.
    fn recovery_replace(&self, phase: Phase, step: Step) {
        self.recovery.with(|inner| {
            if let Some(report) = inner.report.as_mut() {
                if let Some(existing) = report.phases.iter_mut().find(|p| p.phase == phase) {
                    existing.step = step;
                    report.finished_at = now_ms() as i64;
                }
            }
        });
    }
}

fn step_of_processes(report: &ReconcileReport) -> Step {
    let changed = report.gone.len() + report.reaped.len();
    if report.unproven.is_empty() {
        return Step::done(changed);
    }
    Step { changed, status: Status::Blocked, note: Some(format!("{} proceso(s) de un runtime anterior no se pudieron probar ni cerrar (Attempts: {})", report.unproven.len(), report.unproven.join(", "))) }
}

// ---------------------------------------------------------------------------------------------
// Query `recovery_report`
// ---------------------------------------------------------------------------------------------

fn require_person(caller: &Caller, context: Option<&MutationContext>) -> Result<(), String> {
    let context = context.ok_or_else(|| "recovery_report_auth_required: la lectura requiere un cliente autenticado".to_string())?;
    match (&context.actor, caller) {
        (Actor::PersonId(id), Caller::User) if !id.is_empty() => Ok(()),
        _ => Err("recovery_report_auth_required: solo una Person autenticada puede leer el informe de recuperación".into()),
    }
}

/// `recovery_report`: cómo salió la recuperación del último arranque y si el Core puede lanzar trabajo nuevo. Solo lectura, sin argumentos.
pub(super) fn report_query(core: &Core, caller: &Caller, context: Option<&MutationContext>, args: &Value) -> Result<Value, String> {
    require_person(caller, context)?;
    if let Some(object) = args.as_object() {
        if let Some(key) = object.keys().next() {
            return Err(format!("recovery_report_invalid_request: `{key}` no es un parámetro conocido (esta consulta no tiene)"));
        }
    } else if !args.is_null() {
        return Err("recovery_report_invalid_request: los argumentos deben ser un objeto".into());
    }
    let report = core.recovery.with(|inner| inner.report.clone());
    let Some(report) = report else {
        return Ok(json!({ "health": "unknown", "launch_allowed": true, "blocking": [], "phases": [] }));
    };
    let blocking = report.blocking();
    let phases: Vec<Value> = report
        .phases
        .iter()
        .map(|p| json!({ "phase": p.phase.name(), "status": p.step.status.label(), "changed": p.step.changed, "note": p.step.note }))
        .collect();
    Ok(json!({
        "runtime_instance": report.runtime_instance,
        "health": if blocking.is_empty() { "complete" } else { "incomplete" },
        "launch_allowed": blocking.is_empty(),
        "blocking": blocking,
        "started_at": report.started_at,
        "finished_at": report.finished_at,
        "phases": phases,
    }))
}
