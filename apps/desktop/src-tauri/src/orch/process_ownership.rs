//! LXO-183 · propiedad persistente de procesos: qué runtime sostiene el proceso de cada Attempt, y qué hace un runtime nuevo con lo que dejó el anterior.
//!
//! ```text
//!   adapters ── set_owner(attempt) ──► supervisor::HELD / custodia        (en memoria, como siempre)
//!                                              │  owned_snapshot()
//!   Core::process_ownership_sync ──────────────┘   tras lanzar · cada barrido · al apagar
//!        └─► process_ownership: registra · renueva el lease · libera lo cerrado       (SQLite)
//!
//!   arranque de un runtime nuevo:
//!   Core::process_ownership_reconcile ─► por cada fila viva de un runtime ANTERIOR
//!        identidad (pid + hora de creación) ── Gone    ─► released(gone)
//!                                          ├── Alive   ─► kill del árbol con identidad verificada ─► released(reaped)
//!                                          └── Unknown / no se puede probar ─────────────────────► unproven (a la vista)
//! ```
//!
//! # Qué NO hace (y dónde sigue)
//! * No reengancha un proceso vivo: sus tuberías de entrada y salida eran del Core que murió, así que un proceso que sobrevive a su Core ya no
//!   lo lee nadie. Adjuntarse a trabajo que sobrevive a Desktop exige el daemon (rebanada 5 de `ADR_RUNTIME_PERSISTENTE.md`). Hoy un
//!   proceso hallado vivo se CIERRA (con la misma verificación de identidad que el kill del árbol), nunca se «adopta».
//! * No decide el estado del Attempt: `close_orphans` ya lo cierra al arrancar. Esto cierra el PROCESO.
//! * No cambia el Job de Windows (`KILL_ON_JOB_CLOSE`): sigue matando al árbol si el Core muere; aquí queda la constancia.
//!
//! # Invariantes
//! * Un proceso solo se mata si su identidad (pid + hora de creación) se comprueba JUSTO antes; ante la duda, `unproven` y a la vista.
//! * Un runtime solo libera como `closed` lo que ÉL sostenía; lo de otro runtime lo resuelve el arranque, nunca el barrido.
//! * Escribir la propiedad nunca bloquea ni retrasa el cierre de un proceso: el cierre ocurre en el supervisor, esto lo anota después.

use serde_json::{json, Value};

use super::adapter::supervisor;
use super::mutation::Health;
use super::state::now_ms;
use super::Core;
use crate::proctable::{self, Os, Presence, Proc, RealOs, Tree};
use crate::store::{OwnedFact, OwnershipResolution, OwnershipRow, ReleaseReason, StoreResult, SyncReport};

/// Cuánto dura un lease: cuatro barridos. Si el latido (el barrido) falla durante todo ese tiempo, la fila figura con el lease vencido.
pub(super) fn lease_ms() -> i64 {
    (super::SWEEP_EVERY.as_millis() as i64).saturating_mul(4)
}

/// Lo que hizo un arranque con las filas vivas de un runtime anterior. Cada lista lleva los ids de Attempt.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct ReconcileReport {
    /// Ya no existían (o su pid es de otro proceso).
    pub gone: Vec<String>,
    /// Estaban vivos y se cerraron con la identidad verificada.
    pub reaped: Vec<String>,
    /// No se pudo probar ni su muerte ni su cierre: siguen a la vista.
    pub unproven: Vec<String>,
}

impl Core {
    /// Lo que el supervisor tiene abierto ahora, como hechos para el almacén.
    fn owned_facts() -> Vec<OwnedFact> {
        supervisor::owned_snapshot().into_iter().map(|p| OwnedFact { attempt_id: p.owner, root_pid: p.pid, root_start: p.start, pgid: p.pgid, in_custody: p.in_custody }).collect()
    }

    /// Anota en la base lo que este runtime sostiene: registra lo nuevo, renueva el lease y libera lo que ya se cerró. Idempotente y barato.
    /// Sin el modelo Task/Attempt activo (antes del corte), con el Core en solo lectura o sin almacén no hace nada.
    pub(super) fn process_ownership_sync(&self) -> Option<SyncReport> {
        if !matches!(self.health(), Health::Normal) {
            return None;
        }
        let facts = Self::owned_facts();
        let (now, instance) = (now_ms() as i64, self.runtime_instance.clone());
        match self.storage.with_store(|st| -> StoreResult<Option<SyncReport>> {
            if !st.ownership_available()? {
                return Ok(None);
            }
            let host = super::host_identity::machine_id_of(st)?;
            st.ownership_sync(&host, &instance, &facts, now, lease_ms()).map(Some)
        }) {
            Some(Ok(report)) => report,
            Some(Err(error)) => {
                eprintln!("[core] no se pudo anotar la propiedad de los procesos: {error}");
                None
            }
            None => None,
        }
    }

    /// Al arrancar: resuelve las filas vivas que dejó un runtime anterior, con el sistema operativo real.
    #[cfg_attr(not(test), allow(dead_code))] // el arranque pasa por `recovery::recover_at_boot`; esto lo usan las pruebas
    pub(super) fn process_ownership_reconcile(&self) -> ReconcileReport {
        self.process_ownership_reconcile_with(&mut RealOs::default())
    }

    /// Como [`Core::process_ownership_reconcile`], con el sistema operativo que se le dé (las pruebas inyectan fallos).
    pub(super) fn process_ownership_reconcile_with(&self, os: &mut dyn Os) -> ReconcileReport {
        let mut report = ReconcileReport::default();
        if !matches!(self.health(), Health::Normal) {
            return report;
        }
        let instance = self.runtime_instance.clone();
        let rows = match self.storage.with_store(|st| -> StoreResult<Vec<OwnershipRow>> {
            if !st.ownership_available()? {
                return Ok(Vec::new());
            }
            st.ownership_live()
        }) {
            Some(Ok(rows)) => rows,
            Some(Err(error)) => {
                eprintln!("[core] no se pudo leer la propiedad de procesos del runtime anterior: {error}");
                return report;
            }
            None => return report,
        };
        for row in rows.into_iter().filter(|r| r.runtime_instance != instance) {
            let (resolution, bucket) = resolve_row(&row, os);
            let applied = self.storage.with_store(|st| st.ownership_resolve(&row.process_id, resolution, now_ms() as i64));
            if !matches!(applied, Some(Ok(true))) {
                eprintln!("[core] no se pudo anotar el desenlace del proceso de {}: queda como estaba", row.attempt_id);
                continue;
            }
            match bucket {
                Bucket::Gone => report.gone.push(row.attempt_id),
                Bucket::Reaped => report.reaped.push(row.attempt_id),
                Bucket::Unproven => {
                    eprintln!("[core] el proceso del Attempt {} (pid {}) de un runtime anterior no se pudo probar ni cerrar: queda a la vista", row.attempt_id, row.root_pid);
                    report.unproven.push(row.attempt_id);
                }
            }
        }
        report
    }

    /// La propiedad viva ahora mismo, para diagnóstico y pruebas: cada fila con su lease y si pertenece a este runtime. Solo lectura.
    pub(super) fn process_ownership_report(&self) -> Result<Value, String> {
        let now = now_ms() as i64;
        let rows = self
            .storage
            .read_store(|st| st.ownership_live())
            .ok_or_else(|| "ownership_unavailable: el Core no tiene almacén abierto".to_string())?
            .map_err(|e| format!("ownership_read_failed: {e}"))?;
        let procs: Vec<Value> = rows
            .iter()
            .map(|r| {
                let mine = r.runtime_instance == self.runtime_instance;
                json!({
                    "attempt_id": r.attempt_id,
                    "pid": r.root_pid,
                    "state": r.state,
                    "this_runtime": mine,
                    // Un proceso de OTRO runtime sin resolver, o el lease vencido de uno propio: algo no está latiendo.
                    "stale": !mine || r.lease_until < now,
                    "lease_until": r.lease_until,
                    "heartbeat_at": r.heartbeat_at,
                })
            })
            .collect();
        Ok(json!({ "runtime_instance": self.runtime_instance, "processes": procs }))
    }
}

enum Bucket {
    Gone,
    Reaped,
    Unproven,
}

/// El desenlace de UNA fila de un runtime anterior. Nunca mata sin comprobar la identidad; la duda es `Unproven`.
fn resolve_row(row: &OwnershipRow, os: &mut dyn Os) -> (OwnershipResolution, Bucket) {
    // Sin hora de creación registrada no hay forma de distinguir el proceso de un pid reutilizado: no se toca.
    let Some(start) = row.root_start else {
        return (OwnershipResolution::Unproven, Bucket::Unproven);
    };
    let presence = proctable::presence(os, Proc { pid: row.root_pid, start });
    if presence == Presence::Unknown {
        return (OwnershipResolution::Unproven, Bucket::Unproven);
    }
    // Viva o ya muerta, se cierra el ÁRBOL con la misma prueba de propiedad de siempre: una raíz muerta puede haber dejado descendientes, y lo
    // que no se pueda atribuir con seguridad termina en `Err` (a la vista), no en un kill ajeno.
    let mut tree = Tree::adopt(row.root_pid, Some(start), row.pgid);
    let mut seen = KillObserver { inner: os, root: row.root_pid, killed_root: false };
    match proctable::kill_tree(&mut tree, &mut seen) {
        // «Cerrado» (`reaped`) solo si ESTE arranque terminó a la raíz. Un proceso que existía pero ya había terminado (Windows lo sigue
        // mostrando mientras alguien conserve su handle) es `gone`: no se mató nada.
        Ok(()) if seen.killed_root => (OwnershipResolution::Release(ReleaseReason::Reaped), Bucket::Reaped),
        Ok(()) => (OwnershipResolution::Release(ReleaseReason::Gone), Bucket::Gone),
        Err(_) => (OwnershipResolution::Unproven, Bucket::Unproven),
    }
}

/// Delega TODO en el sistema operativo que envuelve y solo anota si se terminó a la raíz registrada.
pub(super) struct KillObserver<'a> {
    pub(super) inner: &'a mut dyn Os,
    pub(super) root: u32,
    pub(super) killed_root: bool,
}

impl Os for KillObserver<'_> {
    fn table(&mut self) -> Option<Vec<(u32, u32)>> {
        self.inner.table()
    }
    fn start(&mut self, pid: u32) -> Option<u64> {
        self.inner.start(pid)
    }
    fn terminate(&mut self, p: Proc) -> proctable::Fate {
        let fate = self.inner.terminate(p);
        if p.pid == self.root && fate == proctable::Fate::Killed {
            self.killed_root = true;
        }
        fate
    }
    fn settle(&mut self) {
        self.inner.settle()
    }
    fn ordered_starts(&self) -> bool {
        self.inner.ordered_starts()
    }
    fn make_group(&mut self, pid: u32, start: Option<u64>) -> Option<std::sync::Arc<dyn proctable::Group>> {
        self.inner.make_group(pid, start)
    }
    fn leads_group(&mut self, pid: u32) -> bool {
        self.inner.leads_group(pid)
    }
    fn group_view(&mut self, pgid: u32) -> Option<proctable::GroupView> {
        self.inner.group_view(pgid)
    }
    fn opaque(&mut self) -> Vec<u32> {
        self.inner.opaque()
    }
    fn children(&mut self, pid: u32) -> Option<Vec<u32>> {
        self.inner.children(pid)
    }
}
