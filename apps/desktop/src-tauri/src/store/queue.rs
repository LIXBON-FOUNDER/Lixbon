//! Pending Queue de un Attempt (LXO-143, épica F5): lado del **almacén**. Contrato y decisiones: `docs/core/COLA.md`.
//!
//! Guarda `attempt_queue` (migración `018`): las instrucciones que se enviaron a un Attempt mientras estaba ocupado, en el
//! orden en que llegaron. Los eventos llegan de `orch::queue_commands`; la dirección sigue siendo `orch -> store`.
//!
//! # Garantías
//! * **Durable y FIFO.** `seq` es consecutivo por Attempt y la base lo impone; solo el primero de la cola pasa a
//!   `delivering` y como mucho hay uno en vuelo ([`Store::queue_claim_next`]).
//! * **Ciclo de vida cerrado.** `queued -> delivering -> delivered`, `queued -> cancelled`, `queued | delivering -> failed`.
//!   Los tres últimos son finales: un item cancelado NO se entrega jamás (lo impide el trigger, no solo este módulo).
//! * **Idempotente por `request_id`.** Repetir la petición en el mismo Attempt devuelve el item que existe
//!   ([`Enqueued::Replayed`]) y no escribe nada. El `request_digest` deja que quien llama distinga la repetición de una
//!   clave reutilizada para otra cosa.
//! * **Estado + evento, juntos.** Cada mutador con hecho es UNA transacción con su fila, su evento y la proyección de
//!   Attention. La excepción es [`Store::queue_claim_next`] (`queued -> delivering`): es un paso intermedio sin hecho
//!   propio; el hecho es el resultado (`delivered` o `failed`).
//! * **La entrega solo se confirma con un hecho del adapter.** `delivered` exige [`QueueConfirmation`], que no tiene un
//!   valor para «se escribió en la entrada del proceso».
//! * **Sin rutas ni referencias del proveedor.** Los adjuntos son ids de Artifacts de la misma Task.
//! * **Inerte hasta el corte**, como `store::attempts`.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: solo lo usa `orch::queue_commands` y las pruebas

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::attempts::{attempt_in, check_attempt_event, AttemptRow};
use super::error::{StoreError, StoreResult};
use super::events::{ActorKind, NewEvent};
use super::tasks::{insert_all, require_active, task_in, TaskRow};
use super::Store;

/// Máximo de caracteres de una instrucción en cola.
pub const MAX_QUEUE_BODY_CHARS: usize = 20_000;
/// Máximo de adjuntos (ids de Artifact) por instrucción.
pub const MAX_QUEUE_ATTACHMENTS: usize = 8;
/// Máximo de items pendientes (`queued` + `delivering`) por Attempt: la cola no crece sin límite.
pub const MAX_QUEUE_PENDING: i64 = 50;
const MAX_REQUEST_ID_CHARS: usize = 64;
const MAX_ATTACHMENT_CHARS: usize = 80;

/// Estado de un item de la cola. Los ids son los de `contracts/status-vocabulary.json` (`queue_state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueStatus {
    /// Esperando un límite de turno.
    Queued,
    /// Se está entregando (a la espera de la confirmación del adapter). Como mucho uno por Attempt.
    Delivering,
    /// El adapter confirmó la entrega.
    Delivered,
    /// Se canceló antes de entregarse.
    Cancelled,
    /// No se entregó (o no se sabe): ver [`QueueFailure`].
    Failed,
}

impl QueueStatus {
    pub const ALL: [QueueStatus; 5] = [QueueStatus::Queued, QueueStatus::Delivering, QueueStatus::Delivered, QueueStatus::Cancelled, QueueStatus::Failed];

    pub fn as_str(self) -> &'static str {
        match self {
            QueueStatus::Queued => "queued",
            QueueStatus::Delivering => "delivering",
            QueueStatus::Delivered => "delivered",
            QueueStatus::Cancelled => "cancelled",
            QueueStatus::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> StoreResult<QueueStatus> {
        QueueStatus::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidAttempt(format!("estado de la cola desconocido: {s}")))
    }

    /// Lo que «sigue pendiente»: espera su turno o se está entregando.
    pub fn is_pending(self) -> bool {
        matches!(self, QueueStatus::Queued | QueueStatus::Delivering)
    }

    pub fn is_final(self) -> bool {
        !self.is_pending()
    }
}

/// Por qué no se entregó un item. Conjunto CERRADO: es lo que un cliente muestra, no un texto libre.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueFailure {
    /// El proveedor no ofrece entregar una instrucción en un límite de turno. Nunca se cae a Steer.
    Unsupported,
    /// El entorno del proveedor está bloqueado (no es un fallo del Attempt).
    EnvironmentBlocked,
    /// La ejecución o la capability no estaba disponible: la entrega no llegó al proveedor.
    AdapterUnavailable,
    /// El adapter o el proveedor devolvieron un error.
    AdapterError,
    /// El Attempt terminó antes de poder entregarla.
    AttemptEnded,
    /// La entrega quedó a medias (el Core se reinició con ella en vuelo): NO se sabe si llegó, así que no se reintenta.
    Interrupted,
}

impl QueueFailure {
    pub const ALL: [QueueFailure; 6] =
        [QueueFailure::Unsupported, QueueFailure::EnvironmentBlocked, QueueFailure::AdapterUnavailable, QueueFailure::AdapterError, QueueFailure::AttemptEnded, QueueFailure::Interrupted];

    pub fn as_str(self) -> &'static str {
        match self {
            QueueFailure::Unsupported => "unsupported",
            QueueFailure::EnvironmentBlocked => "environment_blocked",
            QueueFailure::AdapterUnavailable => "adapter_unavailable",
            QueueFailure::AdapterError => "adapter_error",
            QueueFailure::AttemptEnded => "attempt_ended",
            QueueFailure::Interrupted => "interrupted",
        }
    }

    pub fn parse(s: &str) -> StoreResult<QueueFailure> {
        QueueFailure::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidAttempt(format!("motivo de fallo de la cola desconocido: {s}")))
    }
}

/// Qué hecho del adapter confirmó la entrega. NO existe un valor «se escribió en stdin»: eso no confirma nada.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QueueConfirmation {
    /// Un evento del adapter (el turno empezó, el proveedor reconoció el mensaje…).
    AdapterEvent,
    /// El resultado de la llamada del adapter (su respuesta a la petición de entrega).
    AdapterResult,
}

impl QueueConfirmation {
    pub const ALL: [QueueConfirmation; 2] = [QueueConfirmation::AdapterEvent, QueueConfirmation::AdapterResult];

    pub fn as_str(self) -> &'static str {
        match self {
            QueueConfirmation::AdapterEvent => "adapter_event",
            QueueConfirmation::AdapterResult => "adapter_result",
        }
    }

    pub fn parse(s: &str) -> StoreResult<QueueConfirmation> {
        QueueConfirmation::ALL.into_iter().find(|v| v.as_str() == s).ok_or_else(|| StoreError::InvalidAttempt(format!("confirmación de la cola desconocida: {s}")))
    }
}

/// Un item de la cola.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct QueueItemRow {
    /// `<attempt_id>-q<seq>`.
    pub queue_id: String,
    pub attempt_id: String,
    pub task_id: String,
    /// Posición FIFO dentro del Attempt (1, 2, 3…); nunca se reutiliza.
    pub seq: i64,
    pub request_id: String,
    /// SHA-256 de cuerpo y adjuntos: distingue repetir una petición de reutilizar su clave.
    pub request_digest: String,
    /// Quién la envió (`person`, `agent`, `system`), su id (la Task del agente, la cuenta de la persona) y su cliente.
    pub author_kind: String,
    pub author_id: Option<String>,
    pub client_id: Option<String>,
    pub body: String,
    /// Ids de Artifacts de la misma Task.
    pub attachments: Vec<String>,
    pub status: QueueStatus,
    pub failure: Option<QueueFailure>,
    pub confirmed_by: Option<QueueConfirmation>,
    pub created_at: i64,
    pub updated_at: i64,
    pub delivered_at: Option<i64>,
    pub ended_at: Option<i64>,
}

/// Qué se encola. El Attempt, la Task, el `seq` y el id los fija el almacén.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewQueueItem {
    pub request_id: String,
    pub author_kind: ActorKind,
    pub author_id: Option<String>,
    pub client_id: Option<String>,
    pub body: String,
    pub attachments: Vec<String>,
}

/// Por qué no se pudo encolar. No se escribió nada.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    AttemptMissing,
    /// El Attempt ya terminó: no hay un turno futuro al que entregar.
    AttemptFinal,
    /// Ya hay [`MAX_QUEUE_PENDING`] pendientes.
    QueueFull,
    /// Un adjunto no es un Artifact de la Task.
    UnknownAttachment(String),
}

/// Resultado de encolar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Enqueued {
    /// Nació el item. `position`: cuántos pendientes hay delante, contándolo a él (1 = el siguiente en entregarse).
    Created { item: QueueItemRow, position: i64 },
    /// Esa petición ya se había atendido: es el item que existe (con el estado que tenga), sin escribir nada.
    Replayed { item: QueueItemRow },
    Refused(Refusal),
}

/// Resultado de un cambio de estado de un item.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QueueChange {
    /// Cambió: la fila y el evento se confirmaron juntos. Lleva el item ya cambiado.
    Changed(QueueItemRow),
    /// Ya estaba como se pedía: no se escribió nada.
    Unchanged(QueueItemRow),
    /// El item no existe.
    Missing,
    /// El estado actual no admite el cambio (por ejemplo, cancelar uno que ya se entrega). No se escribió nada.
    Refused(QueueStatus),
}

/// SHA-256 (hex) de la instrucción y sus adjuntos, en orden. Lo guarda la fila; no es un secreto.
pub fn queue_digest(body: &str, attachments: &[String]) -> String {
    let mut h = Sha256::new();
    h.update(body.as_bytes());
    for a in attachments {
        h.update([0u8]);
        h.update(a.as_bytes());
    }
    format!("{:x}", h.finalize())
}

const COLS: &str = "queue_id, attempt_id, task_id, seq, request_id, request_digest, author_kind, author_id, client_id, body, attachments, status, failure_reason, confirmed_by,
                    created_at, updated_at, delivered_at, ended_at";

type Raw = (QueueItemRow, String, String, Option<String>, Option<String>);

fn from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Raw> {
    Ok((
        QueueItemRow {
            queue_id: r.get(0)?,
            attempt_id: r.get(1)?,
            task_id: r.get(2)?,
            seq: r.get(3)?,
            request_id: r.get(4)?,
            request_digest: r.get(5)?,
            author_kind: r.get(6)?,
            author_id: r.get(7)?,
            client_id: r.get(8)?,
            body: r.get(9)?,
            attachments: Vec::new(),
            status: QueueStatus::Queued,
            failure: None,
            confirmed_by: None,
            created_at: r.get(14)?,
            updated_at: r.get(15)?,
            delivered_at: r.get(16)?,
            ended_at: r.get(17)?,
        },
        r.get(10)?,
        r.get(11)?,
        r.get(12)?,
        r.get(13)?,
    ))
}

fn finish((mut item, attachments, status, failure, confirmed): Raw) -> StoreResult<QueueItemRow> {
    item.attachments = serde_json::from_str(&attachments).map_err(|e| StoreError::InvalidAttempt(format!("adjuntos de la cola ilegibles: {e}")))?;
    item.status = QueueStatus::parse(&status)?;
    item.failure = failure.as_deref().map(QueueFailure::parse).transpose()?;
    item.confirmed_by = confirmed.as_deref().map(QueueConfirmation::parse).transpose()?;
    Ok(item)
}

fn item_where(c: &Connection, filter: &str, args: &[&dyn rusqlite::ToSql]) -> StoreResult<Option<QueueItemRow>> {
    c.query_row(&format!("SELECT {COLS} FROM attempt_queue WHERE {filter}"), args, from_row).optional()?.map(finish).transpose()
}

fn items_where(c: &Connection, filter: &str, args: &[&dyn rusqlite::ToSql]) -> StoreResult<Vec<QueueItemRow>> {
    let mut stmt = c.prepare(&format!("SELECT {COLS} FROM attempt_queue WHERE {filter} ORDER BY attempt_id, seq"))?;
    let raws = stmt.query_map(args, from_row)?.collect::<Result<Vec<_>, _>>()?;
    raws.into_iter().map(finish).collect()
}

fn check_text(what: &str, v: &str, max: usize) -> StoreResult<()> {
    if v.trim().is_empty() || v.chars().count() > max || v.chars().any(char::is_control) {
        return Err(StoreError::InvalidAttempt(format!("{what}: texto no vacío, sin caracteres de control y de hasta {max} caracteres")));
    }
    Ok(())
}

fn check_new_item(new: &NewQueueItem) -> StoreResult<()> {
    check_text("request_id", &new.request_id, MAX_REQUEST_ID_CHARS)?;
    if !new.request_id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')) {
        return Err(StoreError::InvalidAttempt("request_id inválido: solo letras, dígitos, `_`, `.` y `-`".into()));
    }
    // La instrucción es texto de una persona o de un agente: admite saltos de línea y tabuladores, no otros controles.
    if new.body.trim().is_empty() || new.body.chars().count() > MAX_QUEUE_BODY_CHARS || new.body.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) {
        return Err(StoreError::InvalidAttempt(format!("la instrucción: texto no vacío, sin caracteres de control y de hasta {MAX_QUEUE_BODY_CHARS} caracteres")));
    }
    if new.attachments.len() > MAX_QUEUE_ATTACHMENTS {
        return Err(StoreError::InvalidAttempt(format!("como mucho {MAX_QUEUE_ATTACHMENTS} adjuntos por instrucción")));
    }
    for (i, a) in new.attachments.iter().enumerate() {
        check_text("adjunto", a, MAX_ATTACHMENT_CHARS)?;
        if new.attachments[..i].contains(a) {
            return Err(StoreError::InvalidAttempt(format!("adjunto repetido: {a}")));
        }
    }
    for (what, v) in [("author_id", &new.author_id), ("client_id", &new.client_id)] {
        if let Some(v) = v {
            check_text(what, v, 200)?;
        }
    }
    if new.author_kind == ActorKind::System && new.author_id.is_some() {
        return Err(StoreError::InvalidAttempt("el sistema no lleva author_id".into()));
    }
    Ok(())
}

fn task_of(tx: &Connection, a: &AttemptRow) -> StoreResult<TaskRow> {
    task_in(tx, &a.task_id)?.ok_or_else(|| StoreError::AttemptConflict(format!("el Attempt {} apunta a la Task inexistente {}", a.id, a.task_id)))
}

fn insert_event(tx: &rusqlite::Transaction<'_>, e: &NewEvent, projector: Option<&dyn super::events::EventProjector>) -> StoreResult<()> {
    insert_all(tx, std::slice::from_ref(e), projector).map_err(|err| match err {
        StoreError::TaskConflict(m) => StoreError::AttemptConflict(m),
        otro => otro,
    })
}

/// Lo que fija cada paso además del estado.
enum Step {
    Delivered(QueueConfirmation),
    Cancelled,
    Failed(QueueFailure),
}

impl Step {
    fn to(&self) -> QueueStatus {
        match self {
            Step::Delivered(_) => QueueStatus::Delivered,
            Step::Cancelled => QueueStatus::Cancelled,
            Step::Failed(_) => QueueStatus::Failed,
        }
    }

    fn allowed_from(&self) -> &'static [QueueStatus] {
        match self {
            Step::Delivered(_) => &[QueueStatus::Delivering],
            Step::Cancelled => &[QueueStatus::Queued],
            Step::Failed(_) => &[QueueStatus::Queued, QueueStatus::Delivering],
        }
    }
}

impl Store {
    /// Encola una instrucción para `attempt_id` y registra su evento, en UNA transacción.
    ///
    /// 1. Si `new.request_id` ya se atendió en el Attempt, devuelve [`Enqueued::Replayed`] y no escribe nada (aunque el
    ///    Attempt ya haya terminado: es el item que existe).
    /// 2. Rechaza ([`Enqueued::Refused`], sin escribir) un Attempt inexistente o terminado, la cola llena y un adjunto que
    ///    no sea un Artifact de la Task.
    /// 3. Asigna el siguiente `seq` (FIFO), inserta el item `queued` y su evento. El closure recibe el item, su posición y
    ///    el Attempt y su Task.
    pub fn queue_enqueue_recorded(
        &mut self,
        attempt_id: &str,
        new: &NewQueueItem,
        at: i64,
        event: impl FnOnce(&QueueItemRow, i64, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<Enqueued> {
        check_new_item(new)?;
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(attempt) = attempt_in(tx, attempt_id)? else { return Ok(Enqueued::Refused(Refusal::AttemptMissing)) };
            if let Some(item) = item_where(tx, "attempt_id = ?1 AND request_id = ?2", &[&attempt_id, &new.request_id])? {
                return Ok(Enqueued::Replayed { item });
            }
            if attempt.status.is_final() {
                return Ok(Enqueued::Refused(Refusal::AttemptFinal));
            }
            let pending: i64 = tx.query_row("SELECT COUNT(*) FROM attempt_queue WHERE attempt_id = ?1 AND status IN ('queued', 'delivering')", [attempt_id], |r| r.get(0))?;
            if pending >= MAX_QUEUE_PENDING {
                return Ok(Enqueued::Refused(Refusal::QueueFull));
            }
            for a in &new.attachments {
                let known: i64 = tx.query_row("SELECT COUNT(*) FROM artifacts a JOIN attempts t ON t.id = a.attempt_id WHERE a.id = ?1 AND t.task_id = ?2", params![a, attempt.task_id], |r| r.get(0))?;
                if known != 1 {
                    return Ok(Enqueued::Refused(Refusal::UnknownAttachment(a.clone())));
                }
            }
            let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM attempt_queue WHERE attempt_id = ?1", [attempt_id], |r| r.get(0))?;
            let queue_id = format!("{attempt_id}-q{seq}");
            let attachments = serde_json::to_string(&new.attachments).map_err(|e| StoreError::InvalidAttempt(format!("adjuntos: {e}")))?;
            let digest = queue_digest(&new.body, &new.attachments);
            tx.execute(
                "INSERT INTO attempt_queue (queue_id, attempt_id, task_id, seq, request_id, request_digest, author_kind, author_id, client_id, body, attachments, status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'queued', ?12, ?12)",
                params![queue_id, attempt_id, attempt.task_id, seq, new.request_id, digest, new.author_kind.as_str(), new.author_id, new.client_id, new.body, attachments, at],
            )?;
            let item = item_where(tx, "queue_id = ?1", &[&queue_id])?.ok_or_else(|| StoreError::AttemptConflict("el item recién encolado no existe".into()))?;
            let task = task_of(tx, &attempt)?;
            let position = pending + 1;
            let e = event(&item, position, &attempt, &task)?;
            check_attempt_event(&attempt, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(Enqueued::Created { item, position })
        })
    }

    /// Toma el SIGUIENTE item de la cola de `attempt_id` para entregarlo: `queued -> delivering`. Es el primero (FIFO) y solo
    /// si no hay otra entrega en vuelo y el Attempt no ha terminado; si no, `None` y no se escribe nada.
    ///
    /// Es un paso intermedio sin hecho propio (el hecho es `delivered` o `failed`): se llama dentro del flujo de entrega
    /// del Core, nunca solo. Si el Core se cae con un item `delivering`, la recuperación lo da por `interrupted`.
    pub fn queue_claim_next(&mut self, attempt_id: &str, at: i64) -> StoreResult<Option<QueueItemRow>> {
        self.write(|tx| {
            require_active(tx)?;
            let Some(attempt) = attempt_in(tx, attempt_id)? else { return Ok(None) };
            if attempt.status.is_final() {
                return Ok(None);
            }
            if item_where(tx, "attempt_id = ?1 AND status = 'delivering'", &[&attempt_id])?.is_some() {
                return Ok(None);
            }
            let Some(next) = item_where(tx, "attempt_id = ?1 AND status = 'queued' ORDER BY seq LIMIT 1", &[&attempt_id])? else { return Ok(None) };
            tx.execute("UPDATE attempt_queue SET status = 'delivering', updated_at = ?2 WHERE queue_id = ?1", params![next.queue_id, at.max(next.updated_at)])?;
            item_where(tx, "queue_id = ?1", &[&next.queue_id])
        })
    }

    /// El adapter confirmó la entrega: `delivering -> delivered`, con su evento, en UNA transacción.
    pub fn queue_delivered_recorded(
        &mut self,
        queue_id: &str,
        confirmed_by: QueueConfirmation,
        at: i64,
        event: impl FnOnce(&QueueItemRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>,
    ) -> StoreResult<QueueChange> {
        self.queue_step(queue_id, Step::Delivered(confirmed_by), at, event)
    }

    /// Cancela un item antes de su entrega: `queued -> cancelled`, con su evento. Cancelar uno ya cancelado es `Unchanged`;
    /// uno que se entrega, se entregó o falló es [`QueueChange::Refused`] (no se puede dar marcha atrás).
    pub fn queue_cancel_recorded(&mut self, queue_id: &str, at: i64, event: impl FnOnce(&QueueItemRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>) -> StoreResult<QueueChange> {
        self.queue_step(queue_id, Step::Cancelled, at, event)
    }

    /// No se entregó: `queued | delivering -> failed` con su motivo y su evento. Ya fallado: `Unchanged`.
    pub fn queue_failed_recorded(&mut self, queue_id: &str, reason: QueueFailure, at: i64, event: impl FnOnce(&QueueItemRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>) -> StoreResult<QueueChange> {
        self.queue_step(queue_id, Step::Failed(reason), at, event)
    }

    fn queue_step(&mut self, queue_id: &str, step: Step, at: i64, event: impl FnOnce(&QueueItemRow, &AttemptRow, &TaskRow) -> StoreResult<NewEvent>) -> StoreResult<QueueChange> {
        let projector = self.projector.clone();
        self.write(|tx| {
            require_active(tx)?;
            let Some(current) = item_where(tx, "queue_id = ?1", &[&queue_id])? else { return Ok(QueueChange::Missing) };
            if current.status == step.to() {
                return Ok(QueueChange::Unchanged(current));
            }
            if !step.allowed_from().contains(&current.status) {
                return Ok(QueueChange::Refused(current.status));
            }
            let stamp = at.max(current.updated_at);
            let changed = match &step {
                Step::Delivered(by) => tx.execute(
                    "UPDATE attempt_queue SET status = 'delivered', confirmed_by = ?2, updated_at = ?3, delivered_at = ?3, ended_at = ?3 WHERE queue_id = ?1",
                    params![queue_id, by.as_str(), stamp],
                )?,
                Step::Cancelled => tx.execute("UPDATE attempt_queue SET status = 'cancelled', updated_at = ?2, ended_at = ?2 WHERE queue_id = ?1", params![queue_id, stamp])?,
                Step::Failed(reason) => {
                    tx.execute("UPDATE attempt_queue SET status = 'failed', failure_reason = ?2, updated_at = ?3, ended_at = ?3 WHERE queue_id = ?1", params![queue_id, reason.as_str(), stamp])?
                }
            };
            if changed != 1 {
                return Err(StoreError::AttemptConflict(format!("no se pudo actualizar el item {queue_id}")));
            }
            let item = item_where(tx, "queue_id = ?1", &[&queue_id])?.ok_or_else(|| StoreError::AttemptConflict(format!("el item {queue_id} desapareció")))?;
            let attempt = attempt_in(tx, &item.attempt_id)?.ok_or_else(|| StoreError::AttemptConflict(format!("el Attempt {} del item {queue_id} no existe", item.attempt_id)))?;
            let task = task_of(tx, &attempt)?;
            let e = event(&item, &attempt, &task)?;
            check_attempt_event(&attempt, &task, &e)?;
            insert_event(tx, &e, projector.as_deref())?;
            Ok(QueueChange::Changed(item))
        })
    }

    pub fn queue_item(&self, queue_id: &str) -> StoreResult<Option<QueueItemRow>> {
        self.read(|c| item_where(c, "queue_id = ?1", &[&queue_id]))
    }

    /// El item que atendió `request_id` en el Attempt.
    pub fn queue_by_request(&self, attempt_id: &str, request_id: &str) -> StoreResult<Option<QueueItemRow>> {
        self.read(|c| item_where(c, "attempt_id = ?1 AND request_id = ?2", &[&attempt_id, &request_id]))
    }

    /// Todos los items del Attempt, en orden FIFO: la historia completa de la cola.
    pub fn queue_of_attempt(&self, attempt_id: &str) -> StoreResult<Vec<QueueItemRow>> {
        self.read(|c| items_where(c, "attempt_id = ?1", &[&attempt_id]))
    }

    /// La Pending Queue del Attempt: lo que sigue sin entregarse (`queued` y `delivering`), en orden FIFO.
    pub fn queue_pending_of_attempt(&self, attempt_id: &str) -> StoreResult<Vec<QueueItemRow>> {
        self.read(|c| items_where(c, "attempt_id = ?1 AND status IN ('queued', 'delivering')", &[&attempt_id]))
    }

    /// Todo lo pendiente de todos los Attempts, por Attempt y orden FIFO. Para la recuperación al arrancar.
    pub fn queue_pending_all(&self) -> StoreResult<Vec<QueueItemRow>> {
        self.read(|c| items_where(c, "status IN ('queued', 'delivering')", &[]))
    }
}
