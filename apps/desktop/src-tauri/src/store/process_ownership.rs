//! Propiedad persistente de procesos (LXO-183, migración `028_process_ownership`): lado del **almacén**.
//!
//! Guarda QUIÉN sostiene el proceso de cada Attempt (el `runtime_instance` de un Core) y cómo reconocerlo después de un reinicio (pid + hora
//! de creación + grupo). No toca procesos: leer el sistema y cerrar lo que sobró lo decide `orch::process_ownership`, con la verificación de
//! identidad de `proctable`. La dirección sigue siendo `orch -> store`.
//!
//! # El ciclo de una fila
//! ```text
//!   (sin fila) ──ownership_sync──► held ──cierre sin probar──► unproven
//!                                   │  ▲ lease renovado           │
//!                                   │  └─ ownership_sync ◄────────┘ (reintento probado)
//!                                   ▼
//!        released(closed)   ← el runtime que lo sostenía lo cerró con prueba
//!        released(gone)     ← un runtime posterior comprobó que ya no existía
//!        released(reaped)   ← un runtime posterior lo encontró vivo, con su identidad, y lo cerró
//! ```
//! Una fila liberada es historia: la base impide que cambie o se borre.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;

use super::authority::new_uuid_v7;
use super::error::{StoreError, StoreResult};
use super::Store;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnershipState {
    Held,
    Unproven,
    Released,
}

impl OwnershipState {
    fn as_str(self) -> &'static str {
        match self {
            OwnershipState::Held => "held",
            OwnershipState::Unproven => "unproven",
            OwnershipState::Released => "released",
        }
    }

    fn parse(text: &str) -> OwnershipState {
        match text {
            "held" => OwnershipState::Held,
            "unproven" => OwnershipState::Unproven,
            _ => OwnershipState::Released,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReleaseReason {
    /// El runtime que lo sostenía lo cerró con prueba.
    Closed,
    /// Un runtime posterior comprobó que ya no existía (o que su pid es de otro proceso).
    Gone,
    /// Un runtime posterior lo encontró vivo, con su identidad, y lo cerró con prueba.
    Reaped,
}

impl ReleaseReason {
    fn as_str(self) -> &'static str {
        match self {
            ReleaseReason::Closed => "closed",
            ReleaseReason::Gone => "gone",
            ReleaseReason::Reaped => "reaped",
        }
    }

    fn parse(text: &str) -> Option<ReleaseReason> {
        match text {
            "closed" => Some(ReleaseReason::Closed),
            "gone" => Some(ReleaseReason::Gone),
            "reaped" => Some(ReleaseReason::Reaped),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OwnershipRow {
    pub process_id: String,
    pub attempt_id: String,
    pub host_id: String,
    pub runtime_instance: String,
    pub root_pid: u32,
    /// Hora de creación de la raíz (token opaco); `None` = no se pudo probar y el proceso no se podrá reconocer.
    pub root_start: Option<u64>,
    pub pgid: Option<u32>,
    pub state: OwnershipState,
    pub lease_until: i64,
    pub heartbeat_at: i64,
    pub registered_at: i64,
    pub released_at: Option<i64>,
    pub release_reason: Option<ReleaseReason>,
}

/// Un proceso con dueño que el supervisor tiene abierto AHORA (lo que el Core entrega para registrar o renovar).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedFact {
    pub attempt_id: String,
    pub root_pid: u32,
    pub root_start: Option<u64>,
    pub pgid: Option<u32>,
    /// Su último cierre no se pudo probar: sigue en custodia.
    pub in_custody: bool,
}

/// Cómo se resuelve una fila viva al arrancar un runtime nuevo.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OwnershipResolution {
    Release(ReleaseReason),
    /// No se pudo probar ni que murió ni cerrarlo: sigue a la vista.
    Unproven,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub registered: usize,
    pub renewed: usize,
    pub released: usize,
    /// De los renovados o registrados, cuántos están `unproven` (custodia).
    pub unproven: usize,
    /// Hechos de un Attempt que esta base no conoce (otro Core del mismo proceso): ni se registran ni fallan.
    pub skipped: usize,
}

const COLS: &str = "process_id, attempt_id, host_id, runtime_instance, root_pid, root_start, pgid, state, lease_until, heartbeat_at, registered_at, released_at, release_reason";

fn row_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<OwnershipRow> {
    let start: Option<String> = r.get(5)?;
    let state: String = r.get(7)?;
    let reason: Option<String> = r.get(12)?;
    Ok(OwnershipRow {
        process_id: r.get(0)?,
        attempt_id: r.get(1)?,
        host_id: r.get(2)?,
        runtime_instance: r.get(3)?,
        root_pid: r.get::<_, i64>(4)? as u32,
        root_start: start.and_then(|s| s.parse::<u64>().ok()),
        pgid: r.get::<_, Option<i64>>(6)?.map(|g| g as u32),
        state: OwnershipState::parse(&state),
        lease_until: r.get(8)?,
        heartbeat_at: r.get(9)?,
        registered_at: r.get(10)?,
        released_at: r.get(11)?,
        release_reason: reason.as_deref().and_then(ReleaseReason::parse),
    })
}

fn live_of_attempt(c: &Connection, attempt_id: &str) -> StoreResult<Option<OwnershipRow>> {
    Ok(c.query_row(&format!("SELECT {COLS} FROM process_ownership WHERE attempt_id = ?1 AND state <> 'released'"), [attempt_id], row_from).optional()?)
}

fn release_in(tx: &Transaction<'_>, process_id: &str, reason: ReleaseReason, now: i64) -> StoreResult<()> {
    tx.execute("UPDATE process_ownership SET state = 'released', released_at = ?2, release_reason = ?3 WHERE process_id = ?1 AND state <> 'released'", params![process_id, now, reason.as_str()])?;
    Ok(())
}

impl Store {
    /// ¿Existe la propiedad de procesos? Hace falta el modelo Task/Attempt (el corte) Y la tabla: durante el propio corte hay un instante en que
    /// el modelo ya figura activo y la migración 028 todavía no se aplicó.
    pub fn ownership_available(&self) -> StoreResult<bool> {
        if !self.agentic_model_active()? {
            return Ok(false);
        }
        self.read(|c| Ok(c.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'process_ownership'", [], |r| r.get::<_, i64>(0))? > 0))
    }

    /// Las filas vivas (`held` y `unproven`), las más antiguas primero.
    pub fn ownership_live(&self) -> StoreResult<Vec<OwnershipRow>> {
        self.read(|c| {
            let mut stmt = c.prepare(&format!("SELECT {COLS} FROM process_ownership WHERE state <> 'released' ORDER BY registered_at, process_id"))?;
            let rows = stmt.query_map([], row_from)?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Todas las filas de un Attempt, vivas e historia, de la más antigua a la más reciente.
    pub fn ownership_of_attempt(&self, attempt_id: &str) -> StoreResult<Vec<OwnershipRow>> {
        self.read(|c| {
            let mut stmt = c.prepare(&format!("SELECT {COLS} FROM process_ownership WHERE attempt_id = ?1 ORDER BY registered_at, process_id"))?;
            let rows = stmt.query_map([attempt_id], row_from)?.collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Pone al día la propiedad de ESTE runtime con lo que el supervisor tiene abierto ahora, en UNA transacción:
    /// registra lo nuevo, renueva el lease de lo que sigue y libera (`closed`) lo que este runtime sostenía y ya no está.
    ///
    /// Una fila viva de OTRO runtime no se toca aquí: la resuelve [`Store::ownership_resolve`] al arrancar. Si un Attempt tiene un proceso
    /// vivo de otro runtime y este runtime sostiene otro distinto, es un conflicto (el arranque no resolvió lo anterior): nada se escribe.
    pub fn ownership_sync(&mut self, host_id: &str, instance: &str, facts: &[OwnedFact], now: i64, lease_ms: i64) -> StoreResult<SyncReport> {
        self.write(|tx| {
            let mut report = SyncReport::default();
            let mut kept: Vec<&str> = Vec::new();
            for fact in facts {
                let known: i64 = tx.query_row("SELECT COUNT(*) FROM attempts WHERE id = ?1", [&fact.attempt_id], |r| r.get(0))?;
                if known == 0 {
                    report.skipped += 1;
                    continue;
                }
                kept.push(&fact.attempt_id);
                let state = if fact.in_custody { OwnershipState::Unproven } else { OwnershipState::Held };
                let start = fact.root_start.map(|s| s.to_string());
                match live_of_attempt(tx, &fact.attempt_id)? {
                    Some(row) if row.root_pid == fact.root_pid && row.root_start == fact.root_start => {
                        tx.execute(
                            "UPDATE process_ownership SET state = ?2, runtime_instance = ?3, lease_until = ?4, heartbeat_at = ?5 WHERE process_id = ?1",
                            params![row.process_id, state.as_str(), instance, now + lease_ms, now],
                        )?;
                        report.renewed += 1;
                    }
                    Some(row) if row.runtime_instance == instance => {
                        // Este runtime sostiene OTRO proceso para el mismo Attempt (un reintento): el anterior ya se cerró.
                        release_in(tx, &row.process_id, ReleaseReason::Closed, now)?;
                        report.released += 1;
                        insert(tx, host_id, instance, fact, start.as_deref(), state, now, lease_ms)?;
                        report.registered += 1;
                    }
                    Some(row) => {
                        return Err(StoreError::OwnershipConflict(format!(
                            "{}: ya tiene un proceso vivo del runtime {} (pid {}); no se registra otro hasta resolverlo",
                            fact.attempt_id, row.runtime_instance, row.root_pid
                        )));
                    }
                    None => {
                        insert(tx, host_id, instance, fact, start.as_deref(), state, now, lease_ms)?;
                        report.registered += 1;
                    }
                }
                if fact.in_custody {
                    report.unproven += 1;
                }
            }
            // Lo que ESTE runtime sostenía y el supervisor ya no tiene abierto: se cerró.
            let mut stmt = tx.prepare(&format!("SELECT {COLS} FROM process_ownership WHERE state <> 'released' AND runtime_instance = ?1"))?;
            let mine = stmt.query_map([instance], row_from)?.collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            for row in mine {
                if !kept.contains(&row.attempt_id.as_str()) {
                    release_in(tx, &row.process_id, ReleaseReason::Closed, now)?;
                    report.released += 1;
                }
            }
            Ok(report)
        })
    }

    /// Resuelve una fila viva de un runtime anterior: la libera con su motivo, o la deja `unproven`. `false` si la fila ya no estaba viva.
    pub fn ownership_resolve(&mut self, process_id: &str, resolution: OwnershipResolution, now: i64) -> StoreResult<bool> {
        self.write(|tx| {
            let live: i64 = tx.query_row("SELECT COUNT(*) FROM process_ownership WHERE process_id = ?1 AND state <> 'released'", [process_id], |r| r.get(0))?;
            if live == 0 {
                return Ok(false);
            }
            match resolution {
                OwnershipResolution::Release(reason) => release_in(tx, process_id, reason, now)?,
                OwnershipResolution::Unproven => {
                    tx.execute("UPDATE process_ownership SET state = 'unproven' WHERE process_id = ?1", [process_id])?;
                }
            }
            Ok(true)
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn insert(tx: &Transaction<'_>, host_id: &str, instance: &str, fact: &OwnedFact, start: Option<&str>, state: OwnershipState, now: i64, lease_ms: i64) -> StoreResult<()> {
    tx.execute(
        "INSERT INTO process_ownership (process_id, attempt_id, host_id, runtime_instance, root_pid, root_start, pgid, state, lease_until, heartbeat_at, registered_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![new_uuid_v7(), fact.attempt_id, host_id, instance, fact.root_pid as i64, start, fact.pgid.map(|g| g as i64), state.as_str(), now + lease_ms, now],
    )?;
    Ok(())
}
