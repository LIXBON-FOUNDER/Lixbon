//! Continuidad de un Attempt (LXO-134, épica F4): lado del **almacén**. Contrato: `docs/core/CONTINUIDAD.md`.
//!
//! Guarda `attempt_continuations` (migración `016`): cómo y desde dónde continúa un Attempt al anterior de su Task. Los
//! eventos llegan de `orch::continuity`; la dirección sigue siendo `orch -> store`.
//!
//! # Garantías
//! * **Todo o nada.** El Attempt nuevo, su fila de continuidad, la reanudación de la sesión (si es nativa) y los eventos
//!   se confirman en UNA transacción: no queda un Attempt sin su procedencia ni una sesión reanudada sin Attempt.
//! * **Idempotente por `request_id`.** Repetir la petición en la misma Task devuelve la continuidad que ya existe
//!   ([`Continued::Replayed`]) y no escribe nada: no hay Attempts duplicados.
//! * **El Attempt anterior no se toca.** Ni su estado ni su resumen cambian; solo se crea uno posterior.
//! * **Sin referencias del proveedor.** La fila nombra la sesión por su id de Lixbon (`ps-…`), no por la referencia
//!   opaca del proveedor, y el paquete por su `package_id`, no por su contenido.
//! * **Inerte hasta el corte**, como `store::attempts`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: solo lo usa `orch::continuity` y las pruebas

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use super::attempts::{attempt_in, attempt_insert_in, check_attempt_event, check_new_attempt, AttemptRow, NewAttempt};
use super::error::{StoreError, StoreResult};
use super::events::NewEvent;
use super::sessions::{session_in, session_resume_in, ProviderSessionRow, SessionStatus};
use super::tasks::{insert_all, require_active, TaskRow};
use super::Store;

/// Máximo de caracteres del `request_id` (clave de idempotencia).
pub const MAX_REQUEST_ID_CHARS: usize = 64;

/// De qué forma continúa el trabajo.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    /// Reanuda la ProviderSession del Attempt anterior: conserva lo que el proveedor guarda de la conversación.
    NativeResume,
    /// Arranca limpio con un ContextPackage: lleva intención y evidencia verificable, no el estado interno del proveedor.
    ContextPackage,
}

impl Strategy {
    pub const ALL: [Strategy; 2] = [Strategy::NativeResume, Strategy::ContextPackage];

    pub fn as_str(self) -> &'static str {
        match self {
            Strategy::NativeResume => "native_resume",
            Strategy::ContextPackage => "context_package",
        }
    }

    pub fn parse(s: &str) -> StoreResult<Strategy> {
        Strategy::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidAttempt(format!("estrategia de continuidad desconocida: {s}")))
    }
}

/// Por qué se eligió esa estrategia. Conjunto CERRADO: es lo que un cliente muestra, no un texto libre.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// Resume nativo: el proveedor lo ofrece, la sesión sirve y es el mismo proveedor.
    Preferred,
    /// Quien llamó pidió el paquete (Attempt limpio, otro host…).
    Requested,
    /// El Attempt nuevo es de otro proveedor: una ProviderSession no se comparte entre proveedores.
    ProviderChanged,
    /// El proveedor no ofrece `resume`.
    ResumeUnsupported,
    /// No hay una sesión resumible: no se guardó, no es resumible o está cerrada.
    SessionUnavailable,
    /// La sesión caducó (se cerró, pasó el plazo o el proveedor ya no la tiene).
    SessionExpired,
}

impl Reason {
    pub const ALL: [Reason; 6] = [Reason::Preferred, Reason::Requested, Reason::ProviderChanged, Reason::ResumeUnsupported, Reason::SessionUnavailable, Reason::SessionExpired];

    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Preferred => "preferred",
            Reason::Requested => "requested",
            Reason::ProviderChanged => "provider_changed",
            Reason::ResumeUnsupported => "resume_unsupported",
            Reason::SessionUnavailable => "session_unavailable",
            Reason::SessionExpired => "session_expired",
        }
    }

    pub fn parse(s: &str) -> StoreResult<Reason> {
        Reason::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidAttempt(format!("motivo de continuidad desconocido: {s}")))
    }
}

/// La procedencia de un Attempt que continúa a otro.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContinuationRow {
    pub attempt_id: String,
    pub task_id: String,
    pub request_id: String,
    pub strategy: Strategy,
    pub reason: Reason,
    /// El Attempt al que continúa.
    pub from_attempt_id: String,
    /// El número de ese Attempt dentro de su Task (para los eventos y las pantallas, que hablan de «intento N»).
    pub from_n: i64,
    /// Solo con `native_resume`: la sesión de Lixbon (`ps-…`) que reanuda.
    pub provider_session_id: Option<String>,
    /// Solo con `context_package`: el `package_id` (`sha256:…`) del paquete con el que arrancó.
    pub package_id: Option<String>,
    pub created_at: i64,
}

/// Qué continuidad se registra. La Task y el número del Attempt los fija el almacén.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewContinuation {
    pub request_id: String,
    pub from_attempt_id: String,
    pub strategy: Strategy,
    pub reason: Reason,
    pub provider_session_id: Option<String>,
    pub package_id: Option<String>,
}

/// Resultado de continuar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Continued {
    /// Nació el Attempt nuevo con su continuidad.
    Created { attempt: AttemptRow, continuation: ContinuationRow },
    /// Esa petición ya se había atendido: es la continuidad que existe, sin escribir nada.
    Replayed { attempt: AttemptRow, continuation: ContinuationRow },
}

impl Continued {
    pub fn attempt(&self) -> &AttemptRow {
        match self {
            Continued::Created { attempt, .. } | Continued::Replayed { attempt, .. } => attempt,
        }
    }

    pub fn continuation(&self) -> &ContinuationRow {
        match self {
            Continued::Created { continuation, .. } | Continued::Replayed { continuation, .. } => continuation,
        }
    }
}

const COLS: &str = "attempt_id, task_id, request_id, strategy, reason, from_attempt_id, provider_session_id, package_id, created_at,
    (SELECT f.n FROM attempts f WHERE f.id = attempt_continuations.from_attempt_id)";

type Raw = (ContinuationRow, String, String);

fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Raw> {
    Ok((
        ContinuationRow {
            attempt_id: r.get(0)?,
            task_id: r.get(1)?,
            request_id: r.get(2)?,
            strategy: Strategy::NativeResume,
            reason: Reason::Preferred,
            from_attempt_id: r.get(5)?,
            from_n: r.get(9)?,
            provider_session_id: r.get(6)?,
            package_id: r.get(7)?,
            created_at: r.get(8)?,
        },
        r.get(3)?,
        r.get(4)?,
    ))
}

fn finish((mut c, strategy, reason): Raw) -> StoreResult<ContinuationRow> {
    c.strategy = Strategy::parse(&strategy)?;
    c.reason = Reason::parse(&reason)?;
    Ok(c)
}

fn continuation_where(c: &Connection, filter: &str, args: &[&dyn rusqlite::ToSql]) -> StoreResult<Option<ContinuationRow>> {
    c.query_row(&format!("SELECT {COLS} FROM attempt_continuations WHERE {filter}"), args, from_row).optional()?.map(finish).transpose()
}

fn check_request_id(id: &str) -> StoreResult<()> {
    let ok = !id.is_empty() && id.chars().count() <= MAX_REQUEST_ID_CHARS && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if ok {
        Ok(())
    } else {
        Err(StoreError::InvalidAttempt(format!("request_id inválido: 1 a {MAX_REQUEST_ID_CHARS} caracteres entre letras, dígitos, `_`, `.` y `-`")))
    }
}

fn check_package_id(id: &str) -> StoreResult<()> {
    let ok = id.len() == 71 && id.strip_prefix("sha256:").is_some_and(|h| h.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
    if ok {
        Ok(())
    } else {
        Err(StoreError::InvalidAttempt("package_id inválido: `sha256:` y 64 caracteres hexadecimales en minúscula".into()))
    }
}

fn check_new_continuation(c: &NewContinuation) -> StoreResult<()> {
    check_request_id(&c.request_id)?;
    match c.strategy {
        Strategy::NativeResume => {
            if c.provider_session_id.is_none() || c.package_id.is_some() || c.reason != Reason::Preferred {
                return Err(StoreError::InvalidAttempt("un resume nativo lleva su sesión, no lleva paquete y su motivo es `preferred`".into()));
            }
        }
        Strategy::ContextPackage => {
            let Some(pkg) = &c.package_id else {
                return Err(StoreError::InvalidAttempt("la continuidad con paquete necesita el package_id".into()));
            };
            check_package_id(pkg)?;
            if c.provider_session_id.is_some() || c.reason == Reason::Preferred {
                return Err(StoreError::InvalidAttempt("la continuidad con paquete no lleva sesión y su motivo no es `preferred`".into()));
            }
        }
    }
    Ok(())
}

/// La sesión nativa sirve para continuar: es de esta Task, está en espera, es resumible y el proveedor entregó su referencia.
fn check_native_session(tx: &Connection, c: &NewContinuation, task_id: &str, provider: &str) -> StoreResult<ProviderSessionRow> {
    let id = c.provider_session_id.as_deref().ok_or_else(|| StoreError::InvalidAttempt("falta la sesión".into()))?;
    let s = session_in(tx, id)?.ok_or_else(|| StoreError::SessionConflict(format!("no existe la sesión {id}")))?;
    if s.task_id != task_id || s.provider != provider {
        return Err(StoreError::SessionConflict(format!("la sesión {id} no es de la Task {task_id} y el proveedor {provider}")));
    }
    if s.status != SessionStatus::Idle || !s.resumable || s.external_ref.is_none() {
        return Err(StoreError::SessionConflict(format!("la sesión {id} no se puede reanudar: tiene que estar en espera, ser resumible y tener su referencia")));
    }
    // El Attempt anterior tiene que ser uno de los que corrieron en ella: no se reanuda una sesión con otro Attempt.
    let ran: i64 = tx.query_row("SELECT COUNT(*) FROM attempts WHERE id = ?1 AND provider_session_id = ?2", params![c.from_attempt_id, id], |r| r.get(0))?;
    if ran != 1 {
        return Err(StoreError::SessionConflict(format!("el Attempt {} no corrió en la sesión {id}", c.from_attempt_id)));
    }
    Ok(s)
}

impl Store {
    /// La continuidad del Attempt `attempt_id`, si continúa a otro.
    pub fn continuation_of_attempt(&self, attempt_id: &str) -> StoreResult<Option<ContinuationRow>> {
        continuation_where(&self.conn, "attempt_id = ?1", &[&attempt_id])
    }

    /// La continuidad que atendió `request_id` en la Task `task_id`.
    pub fn continuation_by_request(&self, task_id: &str, request_id: &str) -> StoreResult<Option<ContinuationRow>> {
        continuation_where(&self.conn, "task_id = ?1 AND request_id = ?2", &[&task_id, &request_id])
    }

    /// Los Attempts que continúan al `from_attempt_id`, por fecha.
    pub fn continuations_from(&self, from_attempt_id: &str) -> StoreResult<Vec<ContinuationRow>> {
        let mut stmt = self.conn.prepare(&format!("SELECT {COLS} FROM attempt_continuations WHERE from_attempt_id = ?1 ORDER BY created_at, attempt_id"))?;
        let raws = stmt.query_map([from_attempt_id], from_row)?.collect::<Result<Vec<_>, _>>()?;
        raws.into_iter().map(finish).collect()
    }

    /// Crea el Attempt que continúa a `new.from_attempt_id` y registra cómo, en UNA transacción:
    ///
    /// 1. si `request_id` ya se atendió en la Task, devuelve [`Continued::Replayed`] y no escribe nada;
    /// 2. comprueba que el Attempt anterior es de la Task y ya terminó;
    /// 3. crea el Attempt (mismas reglas que `attempt_create_recorded`: Task y Run abiertos, ningún otro activo);
    /// 4. escribe la fila de continuidad;
    /// 5. con `native_resume`, reanuda la sesión (`idle -> open`) y la enlaza al Attempt nuevo;
    /// 6. escribe los eventos: `requested` del Attempt, `continued` y, si fue nativo, el de la sesión.
    ///
    /// Cualquier fallo deshace todo: el Attempt anterior y su sesión quedan como estaban.
    #[allow(clippy::too_many_arguments)]
    pub fn attempt_continue_recorded(
        &mut self,
        task_id: &str,
        new_attempt: &NewAttempt,
        new: &NewContinuation,
        at: i64,
        requested: impl FnOnce(&AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
        continued: impl FnOnce(&AttemptRow, &ContinuationRow, &TaskRow) -> StoreResult<NewEvent>,
        resumed: impl FnOnce(&ProviderSessionRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<Continued> {
        check_new_attempt(new_attempt)?;
        check_new_continuation(new)?;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            if let Some(existing) = continuation_where(tx, "task_id = ?1 AND request_id = ?2", &[&task_id, &new.request_id])? {
                let attempt = attempt_in(tx, &existing.attempt_id)?.ok_or_else(|| StoreError::AttemptConflict(format!("el Attempt {} de la continuidad no existe", existing.attempt_id)))?;
                return Ok(Continued::Replayed { attempt, continuation: existing });
            }
            let from = attempt_in(tx, &new.from_attempt_id)?.ok_or_else(|| StoreError::AttemptConflict(format!("no existe el Attempt {}", new.from_attempt_id)))?;
            if from.task_id != task_id {
                return Err(StoreError::AttemptConflict(format!("el Attempt {} no es de la Task {task_id}", from.id)));
            }
            if !from.status.is_final() {
                return Err(StoreError::AttemptConflict(format!("el Attempt {} sigue activo: no se continúa a la vez que corre", from.id)));
            }
            let (attempt, task) = attempt_insert_in(tx, task_id, new_attempt, at)?;
            let session = match new.strategy {
                Strategy::NativeResume => Some(check_native_session(tx, new, task_id, &attempt.provider)?),
                Strategy::ContextPackage => None,
            };
            tx.execute(
                "INSERT INTO attempt_continuations (attempt_id, task_id, request_id, strategy, reason, from_attempt_id, provider_session_id, package_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![attempt.id, task_id, new.request_id, new.strategy.as_str(), new.reason.as_str(), new.from_attempt_id, new.provider_session_id, new.package_id, at],
            )?;
            let continuation = continuation_where(tx, "attempt_id = ?1", &[&attempt.id])?.ok_or_else(|| StoreError::AttemptConflict("la continuidad recién creada no existe".into()))?;

            let e1 = requested(&attempt, &task)?;
            check_attempt_event(&attempt, &task, &e1)?;
            let e2 = continued(&attempt, &continuation, &task)?;
            check_attempt_event(&attempt, &task, &e2)?;
            insert_all(tx, &[e1, e2], projector.as_deref())?;

            if let Some(s) = session {
                session_resume_in(tx, projector.as_deref(), &s.id, &attempt.id, at, resumed)?;
            }
            let attempt = attempt_in(tx, &attempt.id)?.ok_or_else(|| StoreError::AttemptConflict("el Attempt recién creado no existe".into()))?;
            Ok(Continued::Created { attempt, continuation })
        })
    }
}
