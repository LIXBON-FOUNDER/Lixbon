//! Frontera de mutación del estado del Core (slice C2a de la Fase 1).
//!
//! Regla: **el estado en memoria nunca va por delante de la última persistencia
//! confirmada.** Toda escritura de `State` pasa por [`Core::mutate`]:
//!
//! ```text
//! candidato (clon del estado) -> aplicar la mutación -> persistir
//!       -> persistencia OK: sustituir la memoria y publicar
//!       -> persistencia falla: la memoria NO cambia
//! ```
//!
//! # Lectura y escritura
//! [`Core::lock`] devuelve un guard de **solo lectura** ([`StateRead`]). El
//! `Mutex<State>` vive dentro de [`StateCell`], cuyo campo es privado a este
//! módulo: ningún otro módulo de `orch/` puede tomar el estado en modo escritura,
//! así que escribirlo por fuera de esta frontera no compila. La prueba
//! `la_escritura_del_estado_solo_ocurre_en_mutation_rs` vigila además el código
//! fuente. Para esperar con `Condvar` reteniendo el guard existe
//! [`Core::mutate_locked`].
//!
//! # Persistencia (C2a)
//! Sigue siendo `state.json` ([`StateJsonFile`]), con los mismos bytes que antes.
//! El cambio de autoridad a SQLite es C2b: bastará con otra implementación de
//! [`Persistence`]; la frontera no cambia.
//!
//! # Fallos
//! * [`MutateError::Rejected`]: la mutación misma falló (precondición, `?`).
//!   Se descarta el candidato: ni memoria ni disco cambian, ni a medias.
//! * [`MutateError::Persist`]: no se pudo persistir. Los errores que parecen
//!   transitorios (contención de archivo, antivirus) se reintentan con una espera
//!   corta y acotada; los estructurales no. Agotado el intento, el Core entra en
//!   **solo lectura** (`degraded_read_only`): las lecturas siguen, las mutaciones
//!   nuevas se rechazan con [`MutateError::ReadOnly`] y se avisa a los clientes.
//!   No se sigue trabajando sobre una memoria que el disco no tiene.
//!
//! # Reintentos
//! La política vive en un solo sitio, [`RetryPolicy`]: ningún punto de llamada
//! decide esperas ni reintentos. Cambiarla no toca ninguna mutación. Regla:
//! errores estructurales -> sin reintento; transitorios -> reintento acotado.
//!
//! # Efectos externos
//! `git merge`, crear un worktree o lanzar una PTY **no** forman parte de la
//! transacción. El patrón es: validar (lectura) -> efecto -> UNA mutación que lo
//! registra ([`StateAccess::mutate_after_effect`], que SOLO se llama si el efecto ocurrió de verdad).
//! Si el registro falla por CUALQUIER motivo (también un rechazo), no se esconde: se deja constancia en
//! `unrecorded-effects.jsonl` y se avisa al arrancar. Ese archivo es un **diario
//! de recuperación temporal**, NO una segunda fuente de verdad: sirve para
//! diagnosticar y reconciliar a mano. Cuando existan Events y Attention, cada
//! línea debe converger en `Event(efecto externo sin registrar) -> Attention
//! crítica`. La reconciliación automática queda fuera de esta fase.
//!
//! # Eventos (slice E)
//! El candidato [`Tx`] lleva además un *outbox* de [`EventDraft`]: los hechos que describen la
//! mutación. Se finalizan UNA vez (id, hora, actor, payload) antes de persistir y viajan a
//! [`Persistence::persist`], que en SQLite los inserta en la MISMA transacción que la nueva `rev` de
//! `legacy_state`. Si algo falla, ni mutación ni eventos; los reintentos pasan siempre los mismos
//! eventos. El estado (`State`) no transporta nada de esto. Ver `events.rs`.
//!
//! # Quién actúa
//! Cada mutación lleva un [`MutationContext`] EXPLÍCITO (actor + canal + `client_id` reservado):
//! [`Core::mutate_as`] para lo que desencadena una persona o un agente, [`Core::mutate`] (contexto
//! del propio Core) para arranque, vigilantes y temporizadores. No hay contexto implícito por hilo ni
//! un «caller actual» global.
//!
//! # Lo que NO es una mutación de dominio
//! * [`Core::touch_activity`]: marca de actividad efímera (pista de liveness),
//!   solo en memoria. Es la única excepción y NO abre la puerta a otras.
//! * [`Core::adopt_state`]: carga del estado inicial en el arranque; exige un
//!   [`BootProof`] que solo `lifecycle.rs` puede fabricar.

use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

use super::events::{finalize_all, Actor, Channel, EventDraft, EventError, MutationContext};
use super::fsio::data_dir;
use super::lifecycle::BootProof;
use super::state::{Kind, State};
use super::Core;
use crate::store::{new_uuid_v7, NewEvent};

// ---------------------------------------------------------------------------
// Celda de estado: el Mutex es privado a este módulo.
// ---------------------------------------------------------------------------

pub(super) struct StateCell(Mutex<State>);

impl Default for StateCell {
    fn default() -> Self {
        StateCell(Mutex::new(State::default()))
    }
}

impl StateCell {
    fn raw(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Guard de solo lectura del estado.
pub(super) struct StateRead<'a>(MutexGuard<'a, State>);

impl Deref for StateRead<'_> {
    type Target = State;
    fn deref(&self) -> &State {
        &self.0
    }
}

impl<'a> StateRead<'a> {
    /// Espera en `cv` reteniendo el estado y devuelve el guard renovado.
    pub(super) fn wait(self, cv: &Condvar, dur: Duration) -> StateRead<'a> {
        StateRead(cv.wait_timeout(self.0, dur).map(|(g, _)| g).unwrap_or_else(|e| e.into_inner().0))
    }
}

/// Estado candidato: lo que ve el cierre de [`Core::mutate`]. Se descarta si la
/// mutación o la persistencia fallan.
pub(super) struct Tx {
    state: State,
    notify: Vec<u64>,
    unchanged: bool,
    /// Outbox de eventos del candidato. Vive aquí y no en `State`: el estado autoritativo no
    /// transporta metadatos de una transacción. Se descarta con el candidato si algo falla.
    events: Vec<EventDraft>,
    /// Un borrador que no se pudo construir (contrato roto): se convierte en `Rejected` al confirmar.
    event_error: Option<String>,
    /// Quién actúa y por dónde llegó la orden: valor por defecto de los eventos de esta mutación (un
    /// borrador puede traer el suyo).
    ctx: MutationContext,
    /// Efecto externo ya observado en esta mutación (`Tx::observe_effect`): las decisiones que se registren
    /// dentro de `mutate_after_effect` lo llevan como `correlation_id`. Efímero: no es estado.
    active_effect: Option<String>,
}

impl Deref for Tx {
    type Target = State;
    fn deref(&self) -> &State {
        &self.state
    }
}

impl DerefMut for Tx {
    fn deref_mut(&mut self) -> &mut State {
        &mut self.state
    }
}

impl Tx {
    /// Mensajes nuevos que, confirmada la mutación, pueden generar notificación.
    pub(super) fn notify(&mut self, ids: &[u64]) {
        self.notify.extend_from_slice(ids);
    }

    pub(super) fn notify_opt(&mut self, id: Option<u64>) {
        self.notify.extend(id);
    }

    /// La mutación resultó no cambiar nada: se descarta el candidato y no se
    /// persiste ni se publica (evita reescribir el estado por una no-operación). También descarta
    /// los eventos emitidos hasta aquí: sin cambio no hay hecho que contar.
    pub(super) fn no_change(&mut self) {
        self.unchanged = true;
        self.events.clear();
        self.event_error = None;
    }

    /// ÚNICO punto de entrada de un evento a la transacción: lo emite quien describe el hecho (los
    /// mutadores semánticos), nunca una capa superior que ya vio el resultado. Una prueba de
    /// arquitectura vigila quién lo llama.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn push_event(&mut self, draft: EventDraft) {
        self.events.push(draft);
    }

    /// Como [`Tx::push_event`], a partir del resultado de un constructor del catálogo. Si el borrador
    /// no se pudo construir se recuerda el error y la mutación se rechaza al confirmar (con SQLite y
    /// con state.json por igual): un error de instrumentación nunca se pierde en silencio.
    pub(super) fn try_push_event(&mut self, draft: Result<EventDraft, EventError>) {
        match draft {
            Ok(d) => self.events.push(d),
            Err(e) => {
                self.event_error.get_or_insert_with(|| e.to_string());
            }
        }
    }

    /// Fija el actor y el canal por defecto de los eventos de esta mutación.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn acting_as(&mut self, actor: Actor, channel: Channel) {
        self.ctx.actor = actor;
        self.ctx.channel = channel;
    }

    /// Quién actúa y por dónde, tal como lo ve ahora esta mutación.
    pub(super) fn context(&self) -> &MutationContext {
        &self.ctx
    }

    /// Identidad del efecto observado en esta mutación, si lo hay (la consulta `Tx::record_decision`).
    pub(super) fn active_effect(&self) -> Option<&str> {
        self.active_effect.as_deref()
    }

    pub(super) fn set_active_effect(&mut self, effect_id: Option<String>) {
        self.active_effect = effect_id;
    }

    /// ¿Se llamó a [`Tx::no_change`]?
    fn is_unchanged(&self) -> bool {
        self.unchanged
    }

    /// Fija el contexto completo (lo usa `mutate_as`).
    pub(super) fn set_context(&mut self, ctx: MutationContext) {
        self.ctx = ctx;
    }

    /// Finaliza y VALIDA los borradores de esta mutación (una sola vez). El `project_id` de un
    /// borrador con `project_from_task` sale del candidato, sin git ni registro.
    fn finalize_events(&mut self) -> Result<Vec<NewEvent>, String> {
        if let Some(e) = self.event_error.take() {
            return Err(e);
        }
        let drafts = std::mem::take(&mut self.events);
        if drafts.is_empty() {
            return Ok(Vec::new());
        }
        let state = &self.state;
        finalize_all(drafts, &self.ctx, super::state::now_ms() as i64, &|task| state.tasks.get(task).and_then(|t| t.project_id.clone()))
    }

    /// Prueba: un `Tx` sin `Core` (los adaptadores de prueba de `review` e `integration`).
    #[cfg(test)]
    pub(super) fn detached(state: State) -> Tx {
        Tx { state, notify: Vec::new(), unchanged: false, events: Vec::new(), event_error: None, ctx: MutationContext::core(), active_effect: None }
    }

    /// Prueba: devuelve el estado del `Tx` detached.
    #[cfg(test)]
    pub(super) fn into_state(self) -> State {
        self.state
    }

    /// Prueba: valida los borradores igual que producción y descarta el resultado (no hay SQLite).
    #[cfg(test)]
    pub(super) fn validate_events(&mut self) -> Result<(), String> {
        self.finalize_events().map(|_| ())
    }

    /// Prueba: borradores pendientes en el candidato.
    #[cfg(test)]
    pub(super) fn pending_events(&self) -> &[EventDraft] {
        &self.events
    }
}

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum MutateError {
    /// La mutación fue rechazada (precondición, error del mutador): nada cambió.
    Rejected(String),
    /// No se pudo persistir: nada cambió en memoria.
    Persist(String),
    /// El Core está en solo lectura por un fallo de almacenamiento anterior.
    ReadOnly(String),
}

impl std::fmt::Display for MutateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MutateError::Rejected(m) => f.write_str(m),
            MutateError::Persist(m) => write!(f, "No se pudo guardar el estado de Lixbon: {m}. El Core pasa a solo lectura; reinicia Lixbon tras resolverlo."),
            MutateError::ReadOnly(m) => write!(f, "El Core está en solo lectura por un fallo de almacenamiento ({m}); reinicia Lixbon tras resolverlo."),
        }
    }
}

impl From<MutateError> for String {
    fn from(e: MutateError) -> String {
        e.to_string()
    }
}

/// Error de una persistencia, con la clasificación que decide si se reintenta.
#[derive(Debug, Clone)]
pub(super) struct PersistError {
    /// Parece transitorio (contención de archivo, interrupción): vale reintentar.
    pub transient: bool,
    pub message: String,
}

impl PersistError {
    /// Hoy solo lo usan las pruebas de inyección de fallos; C2b lo usará para SQLite (`SQLITE_BUSY`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn transient(message: impl Into<String>) -> Self {
        PersistError { transient: true, message: message.into() }
    }

    pub(super) fn structural(message: impl Into<String>) -> Self {
        PersistError { transient: false, message: message.into() }
    }
}

/// Dónde se confirma una mutación. Antes de promocionar (o degradado): `state.json`
/// ([`StateJsonFile`]). Tras la promoción (C2b): SQLite (`SqlitePersistence`), con
/// `state.json` como espejo.
pub(super) trait Persistence: Send + Sync {
    /// Confirma el candidato (en SQLite: `BEGIN IMMEDIATE .. COMMIT`) junto con sus `events`, ya
    /// materializados. Si falla, la memoria NO cambia y no queda ningún evento. En cada reintento
    /// llegan exactamente los mismos `events`.
    fn persist(&self, state: &State, events: &[NewEvent]) -> Result<(), PersistError>;

    /// ¿Esta persistencia guarda el Event Log? Solo SQLite: en `state.json` (arranque legacy o
    /// degradado) no hay Event Log. Los borradores se finalizan y validan SIEMPRE (la semántica de una
    /// mutación no depende del backend); donde no hay Event Log, el resultado materializado se descarta
    /// antes de persistir.
    fn records_events(&self) -> bool {
        false
    }

    /// Tras confirmar Y publicar en memoria: copia de compatibilidad (el espejo
    /// `state.json`). Mejor esfuerzo: un fallo aquí NO invalida lo confirmado.
    fn after_publish(&self, _state: &State) -> Result<(), String> {
        Ok(())
    }
}

/// `state.json` en la carpeta de datos: los mismos bytes que escribía `commit()`.
pub(super) struct StateJsonFile;

impl Persistence for StateJsonFile {
    /// No guarda eventos: `state.json` no tiene Event Log (ni se crea un `events.json`).
    fn persist(&self, state: &State, _events: &[NewEvent]) -> Result<(), PersistError> {
        let path = data_dir().join("state.json");
        let bytes = serde_json::to_vec_pretty(state).map_err(|e| PersistError::structural(e.to_string()))?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(io_error)?;
        }
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, bytes).map_err(io_error)?;
        std::fs::rename(&tmp, &path).map_err(io_error)
    }
}

/// Un fallo de E/S es transitorio si es contención de archivo (antivirus,
/// indexadores, otro proceso: en Windows 5, 32 y 33) o una interrupción.
/// Disco lleno, ruta imposible, etc. son estructurales: reintentar no sirve.
fn io_error(e: std::io::Error) -> PersistError {
    use std::io::ErrorKind::*;
    let transient = matches!(e.kind(), Interrupted | WouldBlock | TimedOut | PermissionDenied)
        || matches!(e.raw_os_error(), Some(5) | Some(32) | Some(33));
    PersistError { transient, message: e.to_string() }
}

// ---------------------------------------------------------------------------
// Salud y persistencia del Core
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Health {
    Normal,
    /// Las lecturas siguen; las mutaciones nuevas se rechazan.
    DegradedReadOnly(String),
}

/// Política de reintentos de la persistencia: lo único que decide si se vuelve a
/// intentar y cuánto se espera. Los puntos de llamada no conocen nada de esto.
///
/// * Error estructural (`transient == false`): nunca se reintenta. En C2b son
///   `SchemaTooNew`, `MigrationChecksumMismatch`, base incompatible o invariantes rotas.
/// * Error transitorio: se reintenta tras cada espera de `backoffs`, y se rinde al agotarlas.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RetryPolicy {
    backoffs: Vec<Duration>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        // Esperas cortas y acotadas: a lo sumo ~0,7 s en el peor caso.
        RetryPolicy { backoffs: vec![Duration::from_millis(50), Duration::from_millis(150), Duration::from_millis(500)] }
    }
}

impl RetryPolicy {
    /// Sin reintentos.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn none() -> Self {
        RetryPolicy { backoffs: Vec::new() }
    }

    #[cfg(test)]
    pub(super) fn with_backoffs(backoffs: Vec<Duration>) -> Self {
        RetryPolicy { backoffs }
    }

    /// Espera antes del reintento número `attempt` (0 = primer reintento), o
    /// `None` si el error no se reintenta o ya se agotaron.
    pub(super) fn delay_for(&self, error: &PersistError, attempt: usize) -> Option<Duration> {
        if !error.transient {
            return None;
        }
        self.backoffs.get(attempt).copied()
    }
}

/// Estado del espejo `state.json` (distinto de la salud del Core: un espejo caído
/// no pone al Core en solo lectura).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum MirrorHealth {
    Ok,
    Failed(String),
}

/// Persistencia + política de reintentos + salud, juntas: un solo campo de `Core`.
pub(super) struct Persister {
    backend: Mutex<Arc<dyn Persistence>>,
    retry: Mutex<RetryPolicy>,
    health: Mutex<Health>,
    mirror: Mutex<MirrorHealth>,
}

impl Default for Persister {
    fn default() -> Self {
        Persister {
            backend: Mutex::new(Arc::new(StateJsonFile)),
            retry: Mutex::new(RetryPolicy::default()),
            health: Mutex::new(Health::Normal),
            mirror: Mutex::new(MirrorHealth::Ok),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl Persister {
    fn health(&self) -> Health {
        lock(&self.health).clone()
    }

    fn records_events(&self) -> bool {
        lock(&self.backend).records_events()
    }

    /// Persiste con reintentos para los fallos transitorios. `Err` ya incluye el
    /// mensaje definitivo; quien llama decide el paso a solo lectura.
    fn persist(&self, state: &State, events: &[NewEvent]) -> Result<(), PersistError> {
        let backend = lock(&self.backend).clone();
        let retry = lock(&self.retry).clone();
        let mut attempt = 0;
        loop {
            // `events` se materializó antes del bucle: cada intento persiste EXACTAMENTE los mismos.
            match backend.persist(state, events) {
                Ok(()) => return Ok(()),
                Err(e) => match retry.delay_for(&e, attempt) {
                    Some(wait) => {
                        std::thread::sleep(wait);
                        attempt += 1;
                    }
                    None => return Err(e),
                },
            }
        }
    }

    /// Escribe el espejo. Devuelve `Some(motivo)` solo la primera vez que falla
    /// (para avisar una vez); cualquier éxito lo da por restablecido.
    fn after_publish(&self, state: &State) -> Option<String> {
        let backend = lock(&self.backend).clone();
        let result = backend.after_publish(state);
        let mut h = lock(&self.mirror);
        match result {
            Ok(()) => {
                *h = MirrorHealth::Ok;
                None
            }
            Err(e) => {
                let first = matches!(*h, MirrorHealth::Ok);
                *h = MirrorHealth::Failed(e.clone());
                first.then_some(e)
            }
        }
    }

    /// Entra en solo lectura. `true` si es la primera vez (para avisar una vez).
    fn degrade(&self, reason: &str) -> bool {
        let mut h = lock(&self.health);
        if matches!(*h, Health::Normal) {
            *h = Health::DegradedReadOnly(reason.to_string());
            return true;
        }
        false
    }
}

// ---------------------------------------------------------------------------
// La frontera
// ---------------------------------------------------------------------------

impl Core {
    /// Estado en **solo lectura**. Para escribir: [`Core::mutate`].
    pub(super) fn lock(&self) -> StateRead<'_> {
        StateRead(self.state.raw())
    }

    /// Carga inicial del estado en el arranque (`init`). No es una mutación: lo
    /// que se adopta ya viene de la persistencia. No sirve para reemplazar el
    /// estado en ejecución normal: exige un [`BootProof`], que solo el arranque
    /// (`lifecycle.rs`) puede crear.
    pub(super) fn adopt_state(&self, _boot: &BootProof, state: State) {
        *self.state.raw() = state;
    }

    /// **Actividad efímera / pista de liveness**, NO una mutación de dominio
    /// (`touch_activity != mutación`). Marca la última actividad de un run (decide
    /// cuándo lleva 30 min inactivo). Se aplica en memoria y NO se persiste por sí
    /// sola, porque sucedería en cada llamada de cada agente (`lxo check`,
    /// `list`…); viaja en la siguiente mutación, igual que antes de C2a. Perder el
    /// latido en una caída es inocuo. Es la única escritura permitida fuera de
    /// `mutate` y no es precedente para otras. Pendiente (C2b / Events): decidir si
    /// pasa a Event efímero, a otro estado no durable o sigue como caché en memoria.
    pub(super) fn touch_activity(&self, task_id: &str) {
        self.state.raw().touch_run(task_id);
    }

    /// Única vía de escritura del estado. Ver la documentación del módulo. Los eventos de esta
    /// mutación se atribuyen al propio Core (arranque, vigilantes, temporizadores); lo que provoca una
    /// persona o un agente usa [`Core::mutate_as`].
    pub(super) fn mutate<R>(&self, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, MutateError> {
        let mut guard = self.lock();
        self.mutate_locked(&mut guard, f)
    }

    /// Como [`Core::mutate`], con el contexto EXPLÍCITO de quien actúa (actor + canal).
    pub(super) fn mutate_as<R>(&self, ctx: &MutationContext, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, MutateError> {
        self.mutate(|tx| {
            tx.set_context(ctx.clone());
            f(tx)
        })
    }

    /// Como [`Core::mutate`] sobre un guard ya tomado (la espera con `Condvar`
    /// de `wait_for`).
    pub(super) fn mutate_locked<R>(&self, st: &mut StateRead<'_>, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, MutateError> {
        if let Health::DegradedReadOnly(reason) = self.persister.health() {
            return Err(MutateError::ReadOnly(reason));
        }
        let mut tx = Tx { state: (*st.0).clone(), notify: Vec::new(), unchanged: false, events: Vec::new(), event_error: None, ctx: MutationContext::core(), active_effect: None };
        let value = f(&mut tx).map_err(MutateError::Rejected)?;
        if tx.unchanged {
            return Ok(value);
        }
        // Los eventos se finalizan y VALIDAN siempre, UNA vez, aquí y antes del bucle de reintentos:
        // un evento inválido rechaza la mutación entera (`Rejected`) con SQLite y con state.json por
        // igual. Solo DESPUÉS se decide si hay Event Log donde persistirlos; si no (state.json), el
        // resultado materializado se descarta y el backend recibe una lista vacía.
        let finalized = tx.finalize_events().map_err(MutateError::Rejected)?;
        let events = if self.persister.records_events() { finalized } else { Vec::new() };
        if let Err(e) = self.persister.persist(&tx.state, &events) {
            self.enter_read_only(&e.message);
            return Err(MutateError::Persist(e.message));
        }
        let Tx { state, notify, .. } = tx;
        *st.0 = state;
        self.publish(&st.0, &notify);
        // El espejo va DESPUÉS de confirmar y publicar: SQLite manda, el espejo es copia.
        if let Some(reason) = self.persister.after_publish(&st.0) {
            eprintln!("[core] el espejo state.json no se pudo escribir (SQLite sigue siendo la fuente): {reason}");
            self.emit("orch:degraded", &json!({ "mode": "mirror_failed", "reason": reason }));
        }
        Ok(value)
    }

    /// Instala la persistencia autoritativa de SQLite al terminar el arranque.
    /// Exige un [`BootProof`]: ningún otro código cambia de persistencia en marcha.
    pub(super) fn install_persistence(&self, _boot: &BootProof, p: Arc<dyn Persistence>) {
        *lock(&self.persister.backend) = p;
    }

    /// El espejo no se pudo reconciliar en el arranque (solo el arranque lo llama).
    pub(super) fn mirror_failed_at_boot(&self, _boot: &BootProof, reason: &str) {
        *lock(&self.persister.mirror) = MirrorHealth::Failed(reason.to_string());
        eprintln!("[core] el espejo state.json no se pudo escribir (SQLite sigue siendo la fuente): {reason}");
        self.emit("orch:degraded", &json!({ "mode": "mirror_failed", "reason": reason }));
    }

    /// Estado del espejo `state.json` (diagnóstico).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn mirror_health(&self) -> MirrorHealth {
        lock(&self.persister.mirror).clone()
    }

    /// Estado de salud del almacenamiento del Core (diagnóstico; la UI lo consumirá con el aviso `orch:degraded`).
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn health(&self) -> Health {
        self.persister.health()
    }

    fn enter_read_only(&self, reason: &str) {
        if self.persister.degrade(reason) {
            eprintln!("[core] fallo de almacenamiento; el Core pasa a solo lectura: {reason}");
            self.emit("orch:degraded", &json!({ "mode": "read_only", "reason": reason }));
        }
    }

    /// Tras una mutación confirmada y ya publicada en memoria: despierta a los
    /// que esperan en `wait`/`ask`, avisa a la UI y notifica los mensajes nuevos.
    fn publish(&self, st: &State, new: &[u64]) {
        self.cv.notify_all();
        let Some(host) = self.host.get() else { return };
        host.emit("orch:changed", &Value::Null);
        let cfg = self.settings();
        for m in st.messages.iter().filter(|m| new.contains(&m.id)) {
            let wanted = match m.kind {
                Kind::Phase => cfg.notify_phases,
                Kind::Done | Kind::Exited => cfg.notify_done,
                Kind::Question => cfg.notify_questions,
                Kind::Reply | Kind::Note => false,
            };
            if !wanted {
                continue;
            }
            let who = st.tasks.get(&m.from).map(|t| format!("{} · {}", t.agent, t.title)).unwrap_or_default();
            let title = match m.kind {
                Kind::Question => format!("Pregunta de {who}"),
                Kind::Exited => format!("Se cerró {who}"),
                _ => format!("Orquestador · {who}"),
            };
            host.notify(&title, &m.body);
        }
    }

    /// Anota un efecto externo ya ocurrido cuyo registro en el estado falló. Una
    /// línea JSON por efecto: `v`, `at`, `operation`, `kind`, `repo`, `task`,
    /// `run`, `expected`, `observed`, `error`.
    fn journal_unrecorded_effect(&self, effect: Effect, error: &str) {
        let (repo, run) = effect.task.as_deref().map_or((None, None), |id| {
            let st = self.lock();
            let t = st.tasks.get(id);
            (t.map(|t| t.repo.clone()), t.map(|t| t.run.clone()))
        });
        let line = json!({
            "v": 1,
            "at": super::state::now_ms(),
            "operation": effect.operation,
            "kind": effect.kind,
            "repo": effect.repo.or(repo),
            "task": effect.task,
            "run": effect.run.or(run),
            "expected": effect.expected,
            "observed": effect.observed,
            "error": error,
        });
        let path = data_dir().join("unrecorded-effects.jsonl");
        let write = || -> std::io::Result<()> {
            use std::io::Write;
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
            writeln!(f, "{line}")
        };
        if let Err(e) = write() {
            eprintln!("[core] no se pudo anotar el efecto sin registrar ({e}): {line}");
        }
    }

    /// Efectos externos ocurridos cuyo registro falló en una sesión anterior.
    pub(super) fn unrecorded_effects(data: &Path) -> usize {
        std::fs::read_to_string(data.join("unrecorded-effects.jsonl"))
            .map(|t| t.lines().filter(|l| !l.trim().is_empty()).count())
            .unwrap_or(0)
    }

    /// Prueba: sustituye la persistencia (para inyectar fallos).
    #[cfg(test)]
    pub(super) fn set_persistence(&self, p: Arc<dyn Persistence>) {
        *lock(&self.persister.backend) = p;
    }

    /// Prueba: envuelve la persistencia instalada (p. ej. para inyectar fallos transitorios delante
    /// de la de SQLite sin cambiar lo que se confirma).
    #[cfg(test)]
    pub(super) fn wrap_persistence(&self, wrap: impl FnOnce(Arc<dyn Persistence>) -> Arc<dyn Persistence>) {
        let mut backend = lock(&self.persister.backend);
        let inner = backend.clone();
        *backend = wrap(inner);
    }

    /// Prueba: sustituye la política de reintentos.
    #[cfg(test)]
    pub(super) fn set_retry_policy(&self, p: RetryPolicy) {
        *lock(&self.persister.retry) = p;
    }

    /// Prueba: ¿el lock del estado está libre ahora mismo?
    #[cfg(test)]
    pub(super) fn state_is_free(&self) -> bool {
        self.state.0.try_lock().is_ok()
    }

    /// Prueba: acceso de escritura SIN persistir, para preparar estados.
    #[cfg(test)]
    pub(super) fn lock_unpersisted(&self) -> MutexGuard<'_, State> {
        self.state.raw()
    }
}

// ---------------------------------------------------------------------------
// Efectos externos sin registrar: diario de recuperación temporal
// ---------------------------------------------------------------------------

/// Un efecto externo (git, PTY, filesystem) que YA ocurrió y cuyo registro en el
/// estado se va a intentar. Si el registro falla, esto es lo que queda en
/// `unrecorded-effects.jsonl`: lo justo para diagnosticar y reconciliar, sin
/// secretos (nunca env, argv ni credenciales) ni datos de más.
///
/// `effect_id` (UUID v7) identifica ESTA ocurrencia observada: es el `effect_id` de `effect.observed`.
/// No es un protocolo intención/confirmación: `Effect` se construye cuando el efecto ya ocurrió, así que
/// sigue existiendo la ventana «efecto externo -> caída antes de construir o registrar el `Effect`»; E1b
/// no pretende cerrarla. El diario `unrecorded-effects.jsonl` sigue en `v = 1` y todavía no lo persiste.
pub(super) struct Effect {
    /// Identidad estable de la ocurrencia.
    effect_id: String,
    /// Operación de alto nivel («integrate», «publish_pr», «spawn»).
    operation: &'static str,
    /// Efecto concreto («git_merge», «git_push_pr», «git_worktree», «pty_process»).
    kind: &'static str,
    /// `task` y `run` pertenecen al **modelo legacy actual** (Run -> tarea raíz ->
    /// hijas) y NO fijan el diseño futuro Task -> Attempt. El esquema del diario
    /// lleva `v` justamente para poder evolucionar (p. ej. una `v: 2` con `attempt`).
    task: Option<String>,
    /// Si no se indica, el Core lo completa desde el estado por `task`.
    repo: Option<String>,
    run: Option<String>,
    /// Qué iba a anotar el registro que falló.
    expected: Value,
    /// Qué se observó al ejecutar el efecto.
    observed: Value,
}

impl Effect {
    pub(super) fn new(operation: &'static str, kind: &'static str) -> Self {
        Effect { effect_id: new_uuid_v7(), operation, kind, task: None, repo: None, run: None, expected: Value::Null, observed: Value::Null }
    }
    pub(super) fn effect_id(&self) -> &str {
        &self.effect_id
    }
    pub(super) fn operation(&self) -> &'static str {
        self.operation
    }
    pub(super) fn kind(&self) -> &'static str {
        self.kind
    }
    pub(super) fn task_id(&self) -> Option<&str> {
        self.task.as_deref()
    }
    pub(super) fn observed_value(&self) -> &Value {
        &self.observed
    }
    pub(super) fn task(mut self, id: &str) -> Self {
        self.task = Some(id.to_string());
        self
    }
    pub(super) fn repo(mut self, repo: &str) -> Self {
        self.repo = Some(repo.to_string());
        self
    }
    pub(super) fn expected(mut self, v: Value) -> Self {
        self.expected = v;
        self
    }
    pub(super) fn observed(mut self, v: Value) -> Self {
        self.observed = v;
        self
    }
}

// ---------------------------------------------------------------------------
// StateAccess: lo mínimo que necesitan `review`, `integration`, `release` y `spawn`
// ---------------------------------------------------------------------------

/// Lectura y mutación del estado, sin que el llamador conozca el `Mutex`. Los cierres mutadores
/// reciben un [`Tx`] (no un `State`): así usan los mismos mutadores semánticos y producen eventos.
///
/// Implementado por [`Acting`] (el `Core` con el contexto EXPLÍCITO de quien actúa: no hay una
/// versión «sin contexto») y, solo en pruebas, por `Mutex<State>` con un `Tx` detached.
pub(super) trait StateAccess {
    fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R;
    fn mutate<R>(&self, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, String>;

    /// Registra en el estado un efecto externo YA ocurrido (p. ej. un `git merge`).
    ///
    /// **Contrato**: SOLO se llama si hubo un efecto externo real; la única forma de decir «no hubo
    /// efecto» es no llamarla (`mutate` normal). Una vez dentro, CUALQUIER fallo del registro
    /// (`Rejected`, `Persist`, `ReadOnly` o un `no_change` del cierre) deja el candidato sin publicar, sin
    /// estado y sin eventos, y en el `Core` el efecto queda anotado para reconciliar. Esta implementación
    /// por defecto (la del adaptador de pruebas) solo aplica las mismas reglas sobre el `Tx`.
    fn mutate_after_effect<R>(&self, effect: Effect, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, String> {
        self.mutate(|tx| register_effect(tx, &effect, f))
    }
}

/// El `Core` actuando con un contexto explícito (quién y por dónde). Lo construye
/// [`Core::acting`] quien conoce la superficie real.
pub(super) struct Acting<'a> {
    core: &'a Core,
    ctx: MutationContext,
}

/// El registro de un efecto ya ocurrido, dentro del `Tx`: 1) `effect.observed` entra ANTES de ejecutar el
/// cierre (el efecto ocurrió antes que cualquier hecho que lo registre), así que el orden canónico es
/// `effect.observed`, `decision.recorded`, resto de hechos de estado; 2) el cierre registra el estado;
/// 3) un `no_change` es inválido: un efecto observado no puede quedar en un no-op silencioso.
/// Si algo falla, el llamador descarta el candidato entero (ni estado ni eventos).
fn register_effect<R>(tx: &mut Tx, effect: &Effect, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, String> {
    tx.observe_effect(effect)?;
    let value = f(tx)?;
    if tx.is_unchanged() {
        return Err("no_change dentro de mutate_after_effect: un efecto ya ocurrido no puede quedar sin registrar".into());
    }
    tx.set_active_effect(None);
    Ok(value)
}

impl Core {
    pub(super) fn acting(&self, ctx: MutationContext) -> Acting<'_> {
        Acting { core: self, ctx }
    }
}

impl StateAccess for Acting<'_> {
    fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.core.lock())
    }

    fn mutate<R>(&self, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, String> {
        self.core.mutate_as(&self.ctx, f).map_err(String::from)
    }

    fn mutate_after_effect<R>(&self, effect: Effect, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, String> {
        let core = self.core;
        // Desde aquí el efecto YA ocurrió: cualquier fallo del registro (también `Rejected`) es un efecto sin
        // registrar. Que no hubo efecto se dice no llamando a esta función.
        match core.mutate_as(&self.ctx, |tx| register_effect(tx, &effect, f)) {
            Ok(v) => Ok(v),
            Err(e) => {
                core.journal_unrecorded_effect(effect, &e.to_string());
                Err(format!(
                    "La acción se ejecutó pero NO quedó registrada en Lixbon ({e}). Queda anotada en unrecorded-effects.jsonl para reconciliarla; no la repitas sin comprobarlo."
                ))
            }
        }
    }
}

/// SOLO pruebas: un `Mutex<State>` sin persistencia. Replica la semántica de `mutate_locked`: construye
/// un `Tx` detached y ejecuta el cierre. NO publica si el cierre devuelve `Err`, ni si llamó a
/// `Tx::no_change` (se descarta el candidato, sin validar nada), ni si los borradores son inválidos
/// (una instrumentación inválida también falla aquí). Solo un `Tx` válido y cambiado sustituye el
/// estado; sus eventos se descartan (no hay SQLite).
#[cfg(test)]
impl StateAccess for Mutex<State> {
    fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn mutate<R>(&self, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, String> {
        mutate_detached(self, MutationContext::core(), f)
    }
}

#[cfg(test)]
fn mutate_detached<R>(state: &Mutex<State>, ctx: MutationContext, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, String> {
    let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
    let mut tx = Tx::detached((*guard).clone());
    tx.set_context(ctx);
    let value = f(&mut tx)?;
    if tx.unchanged {
        return Ok(value);
    }
    tx.validate_events()?;
    *guard = tx.into_state();
    Ok(value)
}

/// SOLO pruebas: un `Mutex<State>` con el contexto EXPLÍCITO de quien actúa (como `Acting`, sin Core).
/// Las pruebas de decisiones de una persona lo usan para representar de verdad a una persona en la
/// interfaz, en vez de debilitar la validación de actor de producción.
#[cfg(test)]
pub(super) struct ConContexto<'a> {
    state: &'a Mutex<State>,
    ctx: MutationContext,
}

#[cfg(test)]
impl<'a> ConContexto<'a> {
    pub(super) fn new(state: &'a Mutex<State>, ctx: MutationContext) -> ConContexto<'a> {
        ConContexto { state, ctx }
    }

    /// Una persona desde la interfaz (`Person / Ui`).
    pub(super) fn persona(state: &'a Mutex<State>) -> ConContexto<'a> {
        ConContexto::new(state, MutationContext::person(Channel::Ui))
    }
}

#[cfg(test)]
impl StateAccess for ConContexto<'_> {
    fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.state.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn mutate<R>(&self, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, String> {
        mutate_detached(self.state, self.ctx.clone(), f)
    }
}
