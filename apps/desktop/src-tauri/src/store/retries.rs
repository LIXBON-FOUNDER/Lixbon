//! Reintento de un Attempt (LXO-142, épica F5): lado del **almacén**. Contrato: `docs/core/REINTENTO.md`.
//!
//! Guarda `attempt_retries` (migración `021`): de qué Attempt sale el reintento y qué parámetros se cambiaron a propósito.
//! Los eventos llegan de `orch::attempt_commands`; la dirección sigue siendo `orch -> store`.
//!
//! # Garantías
//! * **Retry = Attempt nuevo.** Se inserta `n + 1`; el Attempt anterior no cambia ni de estado ni de resumen.
//! * **Todo o nada.** El Attempt nuevo, su fila de procedencia y sus dos eventos se confirman en UNA transacción.
//! * **Idempotente por `request_id`.** Repetir la petición en la misma Task devuelve el reintento que ya existe
//!   ([`Retried::Replayed`]) sin escribir nada: no hay Attempts duplicados.
//! * **Solo lo que terminó mal, y solo el último.** El origen es el último Attempt de la Task y está `failed`, `stopped` o
//!   `exited`; con otro Attempt activo (o posterior) se rechaza sin escribir.
//! * **Inerte hasta el corte**, como `store::attempts`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: solo lo usa `orch::attempt_commands` y las pruebas

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::attempts::{attempt_in, attempt_insert_in, check_attempt_event, check_new_attempt, AttemptRow, AttemptStatus, NewAttempt};
use super::continuity::{check_request_id, continuation_where};
use super::error::{StoreError, StoreResult};
use super::events::NewEvent;
use super::tasks::{insert_all, require_active, TaskRow};
use super::Store;

/// Un parámetro del Attempt que el reintento puede cambiar. Conjunto CERRADO: es lo que un cliente muestra («con otro modelo»).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Override {
    Provider,
    Model,
    Effort,
    Profile,
}

impl Override {
    pub const ALL: [Override; 4] = [Override::Provider, Override::Model, Override::Effort, Override::Profile];

    pub fn as_str(self) -> &'static str {
        match self {
            Override::Provider => "provider",
            Override::Model => "model",
            Override::Effort => "effort",
            Override::Profile => "profile",
        }
    }

    pub fn parse(s: &str) -> StoreResult<Override> {
        Override::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidAttempt(format!("parámetro de reintento desconocido: {s}")))
    }
}

/// Con qué contexto arranca un Fork (LXO-145). Conjunto CERRADO: lo que un cliente muestra y lo que `attempt.forked` registra.
/// No hay una tercera vía «reanudar la sesión del origen»: ningún adapter ofrece `fork` y una sesión no se comparte entre Attempts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ForkStrategy {
    /// Solo el encargo de la Task: el Attempt nuevo no hereda nada de lo que hizo el origen.
    Clean,
    /// El encargo más un ContextPackage del Attempt origen, verificado antes de crear nada.
    ContextPackage,
}

impl ForkStrategy {
    pub const ALL: [ForkStrategy; 2] = [ForkStrategy::Clean, ForkStrategy::ContextPackage];

    pub fn as_str(self) -> &'static str {
        match self {
            ForkStrategy::Clean => "clean",
            ForkStrategy::ContextPackage => "context_package",
        }
    }
}

/// La procedencia de un Attempt que reintenta a otro.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RetryRow {
    pub attempt_id: String,
    pub task_id: String,
    pub request_id: String,
    /// El Attempt reintentado.
    pub from_attempt_id: String,
    /// Su número dentro de la Task (las pantallas hablan de «intento N»).
    pub from_n: i64,
    /// Qué parámetros se pidieron a propósito (en orden fijo). El resto se heredó del Attempt anterior.
    pub overrides: Vec<Override>,
    pub created_at: i64,
}

/// Qué reintento se registra. La Task y el número del Attempt los fija el almacén.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRetry {
    pub request_id: String,
    pub from_attempt_id: String,
    pub overrides: Vec<Override>,
}

/// Resultado de reintentar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Retried {
    /// Nació el Attempt nuevo con su procedencia.
    Created { attempt: AttemptRow, retry: RetryRow },
    /// Esa petición ya se había atendido: es el reintento que existe, sin escribir nada.
    Replayed { attempt: AttemptRow, retry: RetryRow },
}

const COLS: &str = "attempt_id, task_id, request_id, from_attempt_id, overrides, created_at,
    (SELECT f.n FROM attempts f WHERE f.id = attempt_retries.from_attempt_id)";

fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(RetryRow, String)> {
    Ok((
        RetryRow {
            attempt_id: r.get(0)?,
            task_id: r.get(1)?,
            request_id: r.get(2)?,
            from_attempt_id: r.get(3)?,
            from_n: r.get(6)?,
            overrides: Vec::new(),
            created_at: r.get(5)?,
        },
        r.get(4)?,
    ))
}

fn finish((mut row, overrides): (RetryRow, String)) -> StoreResult<RetryRow> {
    let names: Vec<String> = serde_json::from_str(&overrides).map_err(|_| StoreError::InvalidAttempt("overrides del reintento ilegibles".into()))?;
    row.overrides = names.iter().map(|n| Override::parse(n)).collect::<StoreResult<_>>()?;
    Ok(row)
}

fn retry_where(c: &Connection, filter: &str, args: &[&dyn rusqlite::ToSql]) -> StoreResult<Option<RetryRow>> {
    c.query_row(&format!("SELECT {COLS} FROM attempt_retries WHERE {filter}"), args, from_row).optional()?.map(finish).transpose()
}

/// Los parámetros en orden fijo y sin repetir: el mismo reintento se guarda y se cuenta siempre igual.
fn canonical(overrides: &[Override]) -> Vec<Override> {
    let mut v = overrides.to_vec();
    v.sort();
    v.dedup();
    v
}

/// Solo se reintenta lo que no llegó a buen término.
pub fn retryable(status: AttemptStatus) -> bool {
    matches!(status, AttemptStatus::Failed | AttemptStatus::Stopped | AttemptStatus::Exited)
}

impl Store {
    /// El reintento que creó `attempt_id`, si es un reintento.
    pub fn retry_of_attempt(&self, attempt_id: &str) -> StoreResult<Option<RetryRow>> {
        retry_where(&self.conn, "attempt_id = ?1", &[&attempt_id])
    }

    /// El reintento que atendió `request_id` en la Task `task_id`.
    pub fn retry_by_request(&self, task_id: &str, request_id: &str) -> StoreResult<Option<RetryRow>> {
        retry_where(&self.conn, "task_id = ?1 AND request_id = ?2", &[&task_id, &request_id])
    }

    /// Los reintentos del `from_attempt_id`, por fecha.
    pub fn retries_from(&self, from_attempt_id: &str) -> StoreResult<Vec<RetryRow>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {COLS} FROM attempt_retries WHERE from_attempt_id = ?1 ORDER BY created_at, attempt_id"))?;
        let raws = stmt.query_map([from_attempt_id], from_row)?.collect::<Result<Vec<_>, _>>()?;
        raws.into_iter().map(finish).collect()
    }

    /// Crea el Attempt que reintenta a `new.from_attempt_id` y registra de dónde sale, en UNA transacción:
    ///
    /// 1. si `request_id` ya se atendió en la Task, devuelve [`Retried::Replayed`] y no escribe nada;
    /// 2. comprueba que el Attempt anterior es de la Task, el último y que terminó mal;
    /// 3. crea el Attempt (mismas reglas que `attempt_create_recorded`: Task y Run abiertos, ningún otro activo);
    /// 4. escribe la fila de procedencia;
    /// 5. escribe los eventos: `attempt.requested` y `attempt.retried`.
    ///
    /// Cualquier fallo deshace todo: el Attempt anterior queda como estaba.
    pub fn attempt_retry_recorded(
        &mut self,
        task_id: &str,
        new_attempt: &NewAttempt,
        new: &NewRetry,
        at: i64,
        requested: impl FnOnce(&AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
        retried: impl FnOnce(&AttemptRow, &RetryRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<Retried> {
        check_new_attempt(new_attempt)?;
        check_request_id(&new.request_id)?;
        let overrides = canonical(&new.overrides);
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            if let Some(existing) = retry_where(tx, "task_id = ?1 AND request_id = ?2", &[&task_id, &new.request_id])? {
                let attempt = attempt_in(tx, &existing.attempt_id)?.ok_or_else(|| StoreError::AttemptConflict(format!("el Attempt {} del reintento no existe", existing.attempt_id)))?;
                return Ok(Retried::Replayed { attempt, retry: existing });
            }
            if continuation_where(tx, "task_id = ?1 AND request_id = ?2", &[&task_id, &new.request_id])?.is_some() {
                return Err(StoreError::AttemptConflict(format!("el request_id {} ya identifica una continuidad de la Task {task_id}", new.request_id)));
            }
            let from = attempt_in(tx, &new.from_attempt_id)?.ok_or_else(|| StoreError::AttemptConflict(format!("no existe el Attempt {}", new.from_attempt_id)))?;
            if from.task_id != task_id {
                return Err(StoreError::AttemptConflict(format!("el Attempt {} no es de la Task {task_id}", from.id)));
            }
            let activo: Option<String> =
                tx.query_row("SELECT id FROM attempts WHERE task_id = ?1 AND status NOT IN ('done', 'failed', 'stopped', 'exited')", [task_id], |r| r.get(0)).optional()?;
            if let Some(activo) = activo {
                return Err(StoreError::AttemptConflict(format!("la Task {task_id} ya tiene el Attempt activo {activo}: un reintento no reabre ni corre a la vez que otro")));
            }
            if !retryable(from.status) {
                return Err(StoreError::AttemptConflict(format!("el Attempt {} terminó bien: no se reintenta", from.id)));
            }
            let latest: i64 = tx.query_row("SELECT COALESCE(MAX(n), 0) FROM attempts WHERE task_id = ?1", [task_id], |r| r.get(0))?;
            if from.n != latest {
                return Err(StoreError::AttemptConflict(format!("el Attempt {} no es el último de la Task {task_id}: solo se reintenta el último", from.id)));
            }
            let (attempt, task) = attempt_insert_in(tx, task_id, new_attempt, at)?;
            let names: Vec<&str> = overrides.iter().map(|o| o.as_str()).collect();
            let json = serde_json::to_string(&names).map_err(|_| StoreError::InvalidAttempt("overrides del reintento".into()))?;
            tx.execute(
                "INSERT INTO attempt_retries (attempt_id, task_id, request_id, from_attempt_id, overrides, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![attempt.id, task_id, new.request_id, new.from_attempt_id, json, at],
            )?;
            let retry = retry_where(tx, "attempt_id = ?1", &[&attempt.id])?.ok_or_else(|| StoreError::AttemptConflict("el reintento recién creado no existe".into()))?;

            let e1 = requested(&attempt, &task)?;
            check_attempt_event(&attempt, &task, &e1)?;
            let e2 = retried(&attempt, &retry, &task)?;
            check_attempt_event(&attempt, &task, &e2)?;
            insert_all(tx, &[e1, e2], projector.as_deref())?;
            let attempt = attempt_in(tx, &attempt.id)?.ok_or_else(|| StoreError::AttemptConflict("el Attempt recién creado no existe".into()))?;
            Ok(Retried::Created { attempt, retry })
        })
    }
}
