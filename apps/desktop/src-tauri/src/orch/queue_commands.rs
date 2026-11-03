//! Command `attempt.queue` y Pending Queue (LXO-143, épica F5). Contrato y decisiones: `docs/core/COLA.md`.
//!
//! **Queue** es la semántica normalizada para una instrucción enviada mientras un Attempt está ocupado: el Core la guarda
//! en una cola durable por Attempt y la entrega como el SIGUIENTE turno cuando el adapter llega a un límite de turno.
//! No depende de cómo cada proveedor interprete un mensaje concurrente (Claude lo encola por su cuenta; Codex tiene
//! `turn/steer`): el Core nunca manda una instrucción en mitad de un turno.
//!
//! ```text
//! queue_attempt(st, port, ctx, cancel, req)
//!   1. leer el Attempt y autorizar (persona o quien coordina la Task)       <- antes de escribir
//!   2. ¿ya se atendió este request_id?  -> el item que existe, sin escribir ni entregar nada
//!   3. ¿el Attempt terminó? ¿el proveedor puede entregar en un límite de turno?   <- si no, error y NADA se escribe
//!   4. Store::queue_enqueue_recorded      <- item `queued` + `attempt.queued`, UNA transacción
//!   5. deliver_next(…)                    <- si el run YA está en un límite de turno (idle), se entrega ahora
//!
//! deliver_next(st, port, cancel, attempt)        (lo llama el runtime en cada límite de turno)
//!   1. Attempt terminado        -> settle_attempt_end: lo pendiente falla (`attempt_ended`)
//!   2. no `running`, o el run sigue en un turno -> nada (el item sigue `queued`)
//!   3. Store::queue_claim_next    <- el PRIMERO de la cola pasa a `delivering` (FIFO, uno en vuelo)
//!   4. port.deliver(…)            <- el ADAPTER confirma con un evento o con su resultado
//!        Ok(confirmación)  -> `delivered` + `attempt.queue_delivered`
//!        Err(error)        -> `failed`    + `attempt.queue_failed`  (+ Attention)
//! ```
//!
//! # Decisiones (D1..D7, detalle en `docs/core/COLA.md`)
//! 1. **Queue nunca es Steer.** No se llama a `steer` ni se inyecta en el turno en curso. Si el proveedor no puede entregar
//!    en un límite de turno, encolar es un ERROR (`unsupported`) y no se escribe nada: no se degrada a otra semántica.
//! 2. **Límite soportado = fin de turno de un run `running`.** Un Attempt `waiting` (espera la respuesta a una pregunta) o
//!    `awaiting_terminal_approval` NO es un límite de turno: lo que se le diga entonces es un `answer`, no una cola.
//!    `pending_approval` y `starting` aún no tienen turno que terminar. Es el [`QueuePort`] quien dice que el turno acabó.
//! 3. **FIFO por Attempt**, sin prioridades ni reordenación. Un item que falla NO bloquea a los siguientes: es final y la
//!    persona ya fue avisada (Attention); los demás siguen su orden.
//! 4. **Entrega a lo sumo una vez.** Un item `delivering` es el único caso ambiguo (el Core se cayó entre pedir la entrega y
//!    anotar el resultado). Nunca se reintenta: se marca `failed(interrupted)` y la persona decide si lo vuelve a enviar. Una
//!    instrucción duplicada es peor que una instrucción que hay que reenviar.
//! 5. **La confirmación es del adapter** ([`QueueConfirmation`]: un evento o el resultado de la llamada), no el éxito de
//!    escribir en el proceso. No existe un valor «se escribió».
//! 6. **Un fallo de entrega no falla el Attempt**: solo el item (`attempt.queue_failed`) y su Attention.
//! 7. **Recuperación** ([`recover`]): `delivering` -> `failed(interrupted)`; `queued` de un Attempt terminado ->
//!    `failed(attempt_ended)`; `queued` de un Attempt vivo se CONSERVA y se entrega en su próximo límite de turno.
//!
//! **Inerte hasta el corte**, como `attempt_ops` y `continuity`: sin conexión al RPC; el almacén rechaza escribir antes de
//! `meta.agentic_model`. El runtime (F5) implementa [`QueuePort`] sobre el adapter; hoy solo lo implementan las pruebas.

#![cfg_attr(not(test), allow(dead_code))] // inerte hasta el corte: lo conectará el runtime de Attempt

use serde::Serialize;

use super::adapter::{AdapterError, CancelToken, ErrorCode};
use super::attempt_ops::{self, person_or_manager};
use super::events::{Actor, MutationContext};
use super::state::now_ms;
use crate::store::{
    ActorKind, AttemptRow, AttemptStatus, Enqueued, NewQueueItem, QueueChange, QueueConfirmation, QueueFailure, QueueItemRow, QueueRefusal, QueueStatus, Store, StoreError, MAX_QUEUE_PENDING,
};

// ── El puerto hacia el adapter ───────────────────────────────────────────────────────────────────────────────────────

/// Dónde está el run de un Attempt respecto a su turno.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Boundary {
    /// El proveedor está en mitad de un turno (o no se sabe): no se entrega nada.
    Busy,
    /// El proveedor acabó su turno y espera entrada: único límite soportado.
    TurnEnd,
}

/// Lo que se entrega: la instrucción tal cual la escribió quien la encoló.
#[derive(Clone, Copy, Debug)]
pub struct DeliveryRequest<'a> {
    pub queue_id: &'a str,
    pub body: &'a str,
    /// Ids de Artifacts de la Task.
    pub attachments: &'a [String],
}

/// Lo que el runtime ofrece al Core para entregar. Lo implementa sobre el adapter (a través de `Gated`); un puerto NO puede
/// devolver «se escribió»: solo [`QueueConfirmation`].
pub trait QueuePort {
    /// ¿Puede este proveedor entregar una instrucción en un límite de turno? `Err` si no (capability ausente, entorno
    /// bloqueado…). Se pregunta al ENCOLAR: sin esta capacidad no se promete una entrega que no va a ocurrir.
    fn capability(&self, attempt: &AttemptRow) -> Result<(), AdapterError>;

    /// ¿Está el run en un límite de turno AHORA?
    fn boundary(&self, attempt: &AttemptRow) -> Boundary;

    /// Entrega la instrucción como el siguiente turno y espera la confirmación DEL ADAPTER. `Err`: no se confirmó.
    fn deliver(&self, attempt: &AttemptRow, request: &DeliveryRequest<'_>, cancel: &CancelToken) -> Result<QueueConfirmation, AdapterError>;
}

// ── Petición y resultados ────────────────────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub struct QueueRequest<'a> {
    /// Clave de idempotencia (1 a 64 caracteres entre letras, dígitos, `_`, `.` y `-`), del Attempt.
    pub request_id: &'a str,
    pub attempt_id: &'a str,
    pub body: &'a str,
    /// Ids de Artifacts de la misma Task (como mucho [`crate::store::MAX_QUEUE_ATTACHMENTS`]).
    pub attachments: &'a [String],
}

/// Qué pasó al intentar entregar.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DeliveryResult {
    /// No tocaba: el run sigue en un turno, el Attempt espera otra cosa o no queda nada pendiente.
    Nothing,
    Delivered(QueueItemRow),
    /// Se intentó y no se confirmó: el item quedó `failed` (con su evento y su Attention).
    Failed(QueueItemRow),
}

/// Lo que devuelve un `queue_attempt` que salió bien.
#[derive(Clone, Debug)]
pub struct Queued {
    pub item: QueueItemRow,
    /// Pendientes delante, contándolo (1 = el siguiente en entregarse). `None` en una repetición.
    pub position: Option<i64>,
    /// `true`: esta petición ya se había atendido y es el item que existe (con el estado que tenga).
    pub replayed: bool,
    /// Qué pasó al intentar entregar justo después de encolar. En una repetición, `Nothing`: no se vuelve a intentar.
    pub delivery: Result<DeliveryResult, QueueError>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cancelled {
    Cancelled(QueueItemRow),
    /// Ya estaba cancelado: no se escribió nada.
    AlreadyCancelled(QueueItemRow),
}

/// Lo que sigue pendiente de un Attempt, en el orden en que se entregará.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PendingQueue {
    pub attempt_id: String,
    pub task_id: String,
    pub items: Vec<PendingItem>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct PendingItem {
    /// 1 = el siguiente en entregarse.
    pub position: usize,
    #[serde(flatten)]
    pub item: QueueItemRow,
}

/// Lo que dejó una recuperación.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Recovery {
    /// `delivering` -> `failed(interrupted)`.
    pub interrupted: usize,
    /// `queued` de un Attempt terminado -> `failed(attempt_ended)`.
    pub ended: usize,
    /// `queued` de un Attempt vivo: se conservan para su próximo límite de turno.
    pub kept: usize,
}

// ── Errores ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Conjunto CERRADO: un cliente decide por la categoría, no por el texto.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    /// El proveedor no puede entregar en un límite de turno. Nunca se cae a Steer.
    Unsupported,
    /// El entorno impide usar el proveedor.
    EnvironmentBlocked,
    /// La petición no vale: Attempt terminado, clave reutilizada, item que no se puede cancelar, cola llena…
    Invalid,
    /// No se pudo leer o escribir el estado.
    Failed,
}

impl ErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            ErrorKind::Unsupported => "unsupported",
            ErrorKind::EnvironmentBlocked => "environment_blocked",
            ErrorKind::Invalid => "invalid",
            ErrorKind::Failed => "failed",
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct QueueError {
    pub kind: ErrorKind,
    /// Código estable dentro de la categoría (`attempt_final`, `request_conflict`, `not_cancellable`…).
    pub code: &'static str,
    pub message: String,
    /// El item al que se refiere, si ya existe (una clave reutilizada, un item que no se puede cancelar).
    pub queue_id: Option<String>,
}

impl QueueError {
    fn new(kind: ErrorKind, code: &'static str, message: impl Into<String>) -> QueueError {
        QueueError { kind, code, message: message.into(), queue_id: None }
    }

    fn invalid(code: &'static str, message: impl Into<String>) -> QueueError {
        QueueError::new(ErrorKind::Invalid, code, message)
    }

    fn for_item(mut self, id: &str) -> QueueError {
        self.queue_id = Some(id.to_string());
        self
    }
}

impl std::fmt::Display for QueueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}: {}", self.kind.code(), self.code, self.message)
    }
}

impl std::error::Error for QueueError {}

fn from_store(e: StoreError) -> QueueError {
    match e {
        StoreError::AttemptConflict(m) => QueueError::invalid("conflict", m),
        StoreError::InvalidAttempt(m) => QueueError::invalid("invalid_request", m),
        StoreError::AgenticModelInactive => QueueError::invalid("model_inactive", "el modelo Task/Attempt todavía no está activo"),
        // El resto (E/S, SQLite…) no se cuenta al cliente: puede llevar rutas o detalles internos.
        _ => QueueError::new(ErrorKind::Failed, "store", "no se pudo leer o escribir la cola del Attempt"),
    }
}

/// El error con que se rechaza encolar cuando el proveedor no puede entregar.
fn capability_error(e: &AdapterError) -> QueueError {
    match e.code {
        ErrorCode::EnvironmentBlocked => QueueError::new(ErrorKind::EnvironmentBlocked, "environment_blocked", e.message.clone()),
        ErrorCode::UnsupportedCapability | ErrorCode::CapabilityUnavailable | ErrorCode::UnknownCapability => QueueError::new(ErrorKind::Unsupported, "queue_unsupported", e.message.clone()),
        ErrorCode::UnknownProvider | ErrorCode::UnknownRun | ErrorCode::SessionNotFound | ErrorCode::InvalidRequest | ErrorCode::Cancelled | ErrorCode::Provider | ErrorCode::Internal => {
            QueueError::new(ErrorKind::Failed, "adapter_error", e.message.clone())
        }
    }
}

/// El motivo (cerrado) con que queda `failed` un item cuya entrega no se confirmó. Sin rama comodín: un código nuevo del
/// adapter obliga a decidir aquí qué significa para la cola.
pub(super) fn failure_of(e: &AdapterError) -> QueueFailure {
    match e.code {
        ErrorCode::UnsupportedCapability => QueueFailure::Unsupported,
        ErrorCode::EnvironmentBlocked => QueueFailure::EnvironmentBlocked,
        // No llegó al proveedor: la capability no está ahora, el run ya no existe o el proveedor no está registrado.
        ErrorCode::CapabilityUnavailable | ErrorCode::UnknownCapability | ErrorCode::UnknownRun | ErrorCode::UnknownProvider | ErrorCode::SessionNotFound => QueueFailure::AdapterUnavailable,
        ErrorCode::Provider | ErrorCode::Internal | ErrorCode::InvalidRequest | ErrorCode::Cancelled => QueueFailure::AdapterError,
    }
}

// ── Utilidades ───────────────────────────────────────────────────────────────────────────────────────────────────────

fn check_request_id(v: &str) -> Result<(), QueueError> {
    let ok = !v.is_empty() && v.chars().count() <= 64 && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if ok {
        Ok(())
    } else {
        Err(QueueError::invalid("invalid_request", "request_id: de 1 a 64 caracteres entre letras, dígitos, `_`, `.` y `-`"))
    }
}

fn author_of(ctx: &MutationContext) -> (ActorKind, Option<String>) {
    match &ctx.actor {
        Actor::Person => (ActorKind::Person, None),
        Actor::PersonId(id) => (ActorKind::Person, Some(id.clone())),
        Actor::Agent(task) => (ActorKind::Agent, Some(task.clone())),
        Actor::System => (ActorKind::System, None),
    }
}

fn not_allowed(what: &str, ctx: &MutationContext) -> QueueError {
    QueueError::invalid("not_allowed", format!("{what}: no lo puede hacer {:?} por {:?}", ctx.actor, ctx.channel))
}

fn attempt_of(st: &Store, id: &str) -> Result<AttemptRow, QueueError> {
    st.attempt_row(id).map_err(from_store)?.ok_or_else(|| QueueError::invalid("attempt_missing", format!("no existe el Attempt {id}")))
}

/// Una persona, el que coordina la Task del Attempt o el Core.
fn may_read(st: &Store, ctx: &MutationContext, task: &str) -> Result<bool, QueueError> {
    Ok(ctx.actor == Actor::System || person_or_manager(st, ctx, task).map_err(from_store)?)
}

// ── Encolar ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/// `attempt.queue`: encola una instrucción para un Attempt ocupado y, si su run YA está en un límite de turno, la entrega.
/// Ver el diagrama del módulo. Persona o el agente que coordina la Task (el Core no encola: la automatización es F9).
pub(super) fn queue_attempt(st: &mut Store, port: &dyn QueuePort, ctx: &MutationContext, cancel: &CancelToken, req: &QueueRequest<'_>) -> Result<Queued, QueueError> {
    // 1. Autorizar y validar, antes de escribir.
    let attempt = attempt_of(st, req.attempt_id)?;
    if !person_or_manager(st, ctx, &attempt.task_id).map_err(from_store)? {
        return Err(not_allowed(&format!("encolar en {}", attempt.id), ctx));
    }
    check_request_id(req.request_id)?;

    // 2. ¿Ya se atendió? Es la misma petición, o una clave reutilizada para otra cosa.
    if let Some(existing) = st.queue_by_request(&attempt.id, req.request_id).map_err(from_store)? {
        return replay(existing, req);
    }

    // 3. Un Attempt terminado no tiene un turno futuro. Y sin capability no se promete una entrega que no va a ocurrir:
    //    se rechaza, NO se degrada a otra semántica (invariante 1: Queue nunca es Steer).
    if attempt.status.is_final() {
        return Err(QueueError::invalid("attempt_final", format!("el Attempt {} ya terminó: no admite instrucciones", attempt.id)));
    }
    port.capability(&attempt).map_err(|e| capability_error(&e))?;

    // 4. Todo o nada: el item y su evento.
    let author = author_of(ctx);
    let new = NewQueueItem { request_id: req.request_id.to_string(), author_kind: author.0, author_id: author.1, client_id: ctx.client_id.clone(), body: req.body.to_string(), attachments: req.attachments.to_vec() };
    let at = now_ms() as i64;
    let done = st.queue_enqueue_recorded(&attempt.id, &new, at, |item, position, a, t| attempt_ops::queued_fact(a, t, item, position, ctx, at)).map_err(from_store)?;
    let (item, position) = match done {
        Enqueued::Created { item, position } => (item, position),
        // Otro hilo la atendió entre la comprobación y la transacción: es la misma petición.
        Enqueued::Replayed { item } => return replay(item, req),
        Enqueued::Refused(r) => return Err(refusal_error(&r, &attempt.id)),
    };

    // 5. Si el run ya está en un límite de turno, ahora mismo toca el primero de la cola (que puede ser uno más antiguo).
    let delivery = deliver_next(st, port, cancel, &attempt.id);
    let item = st.queue_item(&item.queue_id).map_err(from_store)?.unwrap_or(item);
    Ok(Queued { item, position: Some(position), replayed: false, delivery })
}

fn replay(existing: QueueItemRow, req: &QueueRequest<'_>) -> Result<Queued, QueueError> {
    if existing.request_digest != crate::store::queue_digest(req.body, req.attachments) {
        return Err(QueueError::invalid("request_conflict", "ese request_id ya se usó para otra instrucción").for_item(&existing.queue_id));
    }
    Ok(Queued { item: existing, position: None, replayed: true, delivery: Ok(DeliveryResult::Nothing) })
}

fn refusal_error(r: &QueueRefusal, attempt_id: &str) -> QueueError {
    match r {
        QueueRefusal::AttemptMissing => QueueError::invalid("attempt_missing", format!("no existe el Attempt {attempt_id}")),
        QueueRefusal::AttemptFinal => QueueError::invalid("attempt_final", format!("el Attempt {attempt_id} ya terminó: no admite instrucciones")),
        QueueRefusal::QueueFull => QueueError::invalid("queue_full", format!("el Attempt {attempt_id} ya tiene {MAX_QUEUE_PENDING} instrucciones pendientes")),
        QueueRefusal::UnknownAttachment(a) => QueueError::invalid("attachment_unknown", format!("el adjunto {a} no es un Artifact de la Task")),
    }
}

// ── Cancelar ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Cancela un item ANTES de su entrega: `attempt.queue_cancelled`. Una persona o el que coordina la Task. Repetirlo sobre
/// uno ya cancelado no escribe nada. Uno que se está entregando, se entregó o falló no se cancela (`not_cancellable`).
pub(super) fn cancel_queued(st: &mut Store, ctx: &MutationContext, queue_id: &str) -> Result<Cancelled, QueueError> {
    let item = st.queue_item(queue_id).map_err(from_store)?.ok_or_else(|| QueueError::invalid("queue_missing", format!("no existe el item {queue_id}")))?;
    if !person_or_manager(st, ctx, &item.task_id).map_err(from_store)? {
        return Err(not_allowed(&format!("cancelar {queue_id}"), ctx));
    }
    let at = now_ms() as i64;
    match st.queue_cancel_recorded(queue_id, at, |i, a, t| attempt_ops::queue_cancelled_fact(a, t, i, ctx, at)).map_err(from_store)? {
        QueueChange::Changed(i) => Ok(Cancelled::Cancelled(i)),
        QueueChange::Unchanged(i) => Ok(Cancelled::AlreadyCancelled(i)),
        QueueChange::Missing => Err(QueueError::invalid("queue_missing", format!("no existe el item {queue_id}"))),
        QueueChange::Refused(status) => Err(QueueError::invalid("not_cancellable", format!("el item {queue_id} está {}: ya no se puede cancelar", status.as_str())).for_item(queue_id)),
    }
}

// ── Entregar ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// Entrega EL SIGUIENTE item de la cola de `attempt_id` si el run está en un límite de turno. Una entrega por límite: el
/// item entregado abre un turno nuevo y el run vuelve a estar ocupado. Solo el Core (el runtime), en cada límite de turno
/// y justo después de encolar.
pub(super) fn deliver_next(st: &mut Store, port: &dyn QueuePort, cancel: &CancelToken, attempt_id: &str) -> Result<DeliveryResult, QueueError> {
    let core = MutationContext::core();
    let attempt = attempt_of(st, attempt_id)?;
    if attempt.status.is_final() {
        settle_attempt_end(st, attempt_id)?;
        return Ok(DeliveryResult::Nothing);
    }
    // Solo un run `running` en un límite de turno. `waiting` espera una respuesta (eso es un `answer`, no una cola).
    if attempt.status != AttemptStatus::Running || cancel.is_cancelled() || port.boundary(&attempt) != Boundary::TurnEnd {
        return Ok(DeliveryResult::Nothing);
    }
    let at = now_ms() as i64;
    let Some(item) = st.queue_claim_next(attempt_id, at).map_err(from_store)? else { return Ok(DeliveryResult::Nothing) };

    // A partir de aquí el item es `delivering`: hay que dejarlo `delivered` o `failed`. Si el Core se cae entre medias, la
    // recuperación lo da por `interrupted` (a lo sumo una vez).
    let request = DeliveryRequest { queue_id: &item.queue_id, body: &item.body, attachments: &item.attachments };
    match port.deliver(&attempt, &request, cancel) {
        Ok(by) => {
            let at = now_ms() as i64;
            match st.queue_delivered_recorded(&item.queue_id, by, at, |i, a, t| attempt_ops::queue_delivered_fact(a, t, i, by, &core, at)).map_err(from_store)? {
                QueueChange::Changed(i) | QueueChange::Unchanged(i) => Ok(DeliveryResult::Delivered(i)),
                QueueChange::Missing | QueueChange::Refused(_) => Err(QueueError::new(ErrorKind::Failed, "store", "no se pudo anotar la entrega confirmada").for_item(&item.queue_id)),
            }
        }
        Err(e) => fail_item(st, &core, &item.queue_id, failure_of(&e)).map(DeliveryResult::Failed),
    }
}

fn fail_item(st: &mut Store, core: &MutationContext, queue_id: &str, reason: QueueFailure) -> Result<QueueItemRow, QueueError> {
    let at = now_ms() as i64;
    match st.queue_failed_recorded(queue_id, reason, at, |i, a, t| attempt_ops::queue_failed_fact(a, t, i, reason, core, at)).map_err(from_store)? {
        QueueChange::Changed(i) | QueueChange::Unchanged(i) => Ok(i),
        QueueChange::Missing => Err(QueueError::invalid("queue_missing", format!("no existe el item {queue_id}"))),
        QueueChange::Refused(status) => Err(QueueError::invalid("conflict", format!("el item {queue_id} está {}: no puede fallar", status.as_str())).for_item(queue_id)),
    }
}

// ── Cierre y recuperación ────────────────────────────────────────────────────────────────────────────────────────────

/// Lo que se hace con un item pendiente cuando ya no hay un turno al que entregarlo (D4 y D7). `None`: se conserva.
fn leftover(item: &QueueItemRow, attempt_final: bool) -> Option<QueueFailure> {
    match item.status {
        // En vuelo: no se sabe si llegó. Nunca se reintenta.
        QueueStatus::Delivering => Some(QueueFailure::Interrupted),
        QueueStatus::Queued if attempt_final => Some(QueueFailure::AttemptEnded),
        QueueStatus::Queued | QueueStatus::Delivered | QueueStatus::Cancelled | QueueStatus::Failed => None,
    }
}

/// El Attempt `attempt_id` terminó: lo que seguía pendiente ya no se entregará. Los `queued` fallan con `attempt_ended`
/// (sin Attention: el Attempt ya terminó) y uno `delivering` con `interrupted`. Idempotente; no hace nada con un Attempt
/// vivo. Lo llama el runtime tras cerrar el Attempt, y `deliver_next` si lo encuentra cerrado. Devuelve cuántos cerró.
pub(super) fn settle_attempt_end(st: &mut Store, attempt_id: &str) -> Result<usize, QueueError> {
    let attempt = attempt_of(st, attempt_id)?;
    if !attempt.status.is_final() {
        return Ok(0);
    }
    let core = MutationContext::core();
    let mut closed = 0;
    for item in st.queue_pending_of_attempt(attempt_id).map_err(from_store)? {
        if let Some(reason) = leftover(&item, true) {
            fail_item(st, &core, &item.queue_id, reason)?;
            closed += 1;
        }
    }
    Ok(closed)
}

/// Recuperación al arrancar el Core (policy D7). Se ejecuta DESPUÉS de reconciliar los Attempts huérfanos (los que el
/// proceso dejó `running` y ahora son `exited`), para que lo pendiente de un Attempt que ya no existe falle con motivo.
///
/// | item | Attempt | qué pasa |
/// |---|---|---|
/// | `delivering` | cualquiera | `failed(interrupted)`: no se sabe si llegó; no se reintenta |
/// | `queued` | terminado | `failed(attempt_ended)` |
/// | `queued` | vivo | se conserva: se entrega en su próximo límite de turno |
///
/// Idempotente: una segunda pasada no encuentra nada que cerrar.
pub(super) fn recover(st: &mut Store) -> Result<Recovery, QueueError> {
    let core = MutationContext::core();
    let mut report = Recovery::default();
    for item in st.queue_pending_all().map_err(from_store)? {
        let attempt = attempt_of(st, &item.attempt_id)?;
        match leftover(&item, attempt.status.is_final()) {
            Some(reason) => {
                fail_item(st, &core, &item.queue_id, reason)?;
                if reason == QueueFailure::Interrupted {
                    report.interrupted += 1;
                } else {
                    report.ended += 1;
                }
            }
            None => report.kept += 1,
        }
    }
    Ok(report)
}

// ── Consulta ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/// La Pending Queue de un Attempt: qué sigue sin entregarse y en qué orden (`queued` y `delivering`; la historia de los
/// finales está en los Events y en [`Store::queue_of_attempt`]). Una persona, el que coordina la Task o el Core.
pub(super) fn pending(st: &Store, ctx: &MutationContext, attempt_id: &str) -> Result<PendingQueue, QueueError> {
    let attempt = attempt_of(st, attempt_id)?;
    if !may_read(st, ctx, &attempt.task_id)? {
        return Err(not_allowed(&format!("ver la cola de {attempt_id}"), ctx));
    }
    let items = st.queue_pending_of_attempt(attempt_id).map_err(from_store)?;
    Ok(PendingQueue { attempt_id: attempt.id, task_id: attempt.task_id, items: items.into_iter().enumerate().map(|(i, item)| PendingItem { position: i + 1, item }).collect() })
}
