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
//! # Efectos externos
//! `git merge`, crear un worktree o lanzar una PTY **no** forman parte de la
//! transacción. El patrón es: validar (lectura) -> efecto -> UNA mutación que lo
//! registra ([`StateAccess::mutate_after_effect`]). Si el efecto ocurrió y el
//! registro falla, no se esconde: se deja constancia en
//! `unrecorded-effects.jsonl` para reconciliar y se avisa al arrancar.

use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use serde_json::{json, Value};

use super::fsio::data_dir;
use super::state::{Kind, State};
use super::Core;

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
    /// persiste ni se publica (evita reescribir el estado por una no-operación).
    pub(super) fn no_change(&mut self) {
        self.unchanged = true;
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

/// Dónde se confirma una mutación. C2a: `state.json`; C2b: SQLite.
pub(super) trait Persistence: Send + Sync {
    fn persist(&self, state: &State) -> Result<(), PersistError>;
}

/// `state.json` en la carpeta de datos: los mismos bytes que escribía `commit()`.
pub(super) struct StateJsonFile;

impl Persistence for StateJsonFile {
    fn persist(&self, state: &State) -> Result<(), PersistError> {
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

/// Persistencia + política de reintentos + salud, juntas: un solo campo de `Core`.
pub(super) struct Persister {
    backend: Mutex<Arc<dyn Persistence>>,
    backoffs: Mutex<Vec<Duration>>,
    health: Mutex<Health>,
}

impl Default for Persister {
    fn default() -> Self {
        Persister {
            backend: Mutex::new(Arc::new(StateJsonFile)),
            // Esperas cortas y acotadas: a lo sumo ~0,7 s en el peor caso.
            backoffs: Mutex::new(vec![Duration::from_millis(50), Duration::from_millis(150), Duration::from_millis(500)]),
            health: Mutex::new(Health::Normal),
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

    /// Persiste con reintentos para los fallos transitorios. `Err` ya incluye el
    /// mensaje definitivo; quien llama decide el paso a solo lectura.
    fn persist(&self, state: &State) -> Result<(), PersistError> {
        let backend = lock(&self.backend).clone();
        let backoffs = lock(&self.backoffs).clone();
        let mut attempt = 0;
        loop {
            match backend.persist(state) {
                Ok(()) => return Ok(()),
                Err(e) if e.transient && attempt < backoffs.len() => {
                    std::thread::sleep(backoffs[attempt]);
                    attempt += 1;
                }
                Err(e) => return Err(e),
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
    /// que se adopta ya viene de la persistencia. Solo `lifecycle.rs` debe usarlo.
    pub(super) fn adopt_state(&self, state: State) {
        *self.state.raw() = state;
    }

    /// ÚNICA excepción a «toda escritura pasa por `mutate`»: la marca de actividad
    /// de un run (latido que decide cuándo un run lleva 30 min inactivo). Se aplica
    /// en memoria y NO se persiste por sí sola, porque sucedería en cada llamada de
    /// cada agente (`lxo check`, `list`…); viaja en la siguiente mutación, igual que
    /// antes de C2a. Perder el latido en una caída es inocuo.
    pub(super) fn touch_activity(&self, task_id: &str) {
        self.state.raw().touch_run(task_id);
    }

    /// Única vía de escritura del estado. Ver la documentación del módulo.
    pub(super) fn mutate<R>(&self, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, MutateError> {
        let mut guard = self.lock();
        self.mutate_locked(&mut guard, f)
    }

    /// Como [`Core::mutate`] sobre un guard ya tomado (la espera con `Condvar`
    /// de `wait_for`).
    pub(super) fn mutate_locked<R>(&self, st: &mut StateRead<'_>, f: impl FnOnce(&mut Tx) -> Result<R, String>) -> Result<R, MutateError> {
        if let Health::DegradedReadOnly(reason) = self.persister.health() {
            return Err(MutateError::ReadOnly(reason));
        }
        let mut tx = Tx { state: (*st.0).clone(), notify: Vec::new(), unchanged: false };
        let value = f(&mut tx).map_err(MutateError::Rejected)?;
        if tx.unchanged {
            return Ok(value);
        }
        if let Err(e) = self.persister.persist(&tx.state) {
            self.enter_read_only(&e.message);
            return Err(MutateError::Persist(e.message));
        }
        let Tx { state, notify, .. } = tx;
        *st.0 = state;
        self.publish(&st.0, &notify);
        Ok(value)
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

    /// Anota un efecto externo ya ocurrido cuyo registro en el estado falló.
    fn journal_unrecorded_effect(&self, effect: &Value, cause: &str) {
        let line = json!({ "at": super::state::now_ms(), "effect": effect, "cause": cause });
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

    /// Prueba: fija las esperas de reintento (vacío = sin reintentos).
    #[cfg(test)]
    pub(super) fn set_retry_backoffs(&self, b: Vec<Duration>) {
        *lock(&self.persister.backoffs) = b;
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
// StateAccess: lo mínimo que necesitan `review` e `integration`
// ---------------------------------------------------------------------------

/// Lectura y mutación del estado, sin que el llamador conozca el `Mutex`.
/// Implementado por [`Core`] (persistente) y por `Mutex<State>` (sin persistir:
/// las pruebas de `review`/`integration`).
pub(super) trait StateAccess {
    fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R;
    fn mutate<R>(&self, f: impl FnOnce(&mut State) -> Result<R, String>) -> Result<R, String>;

    /// Registra en el estado un efecto externo YA ocurrido (p. ej. un `git merge`).
    /// Si el registro falla no se esconde: el error lo dice con claridad y, en el
    /// `Core`, el efecto queda anotado para reconciliar.
    fn mutate_after_effect<R>(&self, effect: Value, f: impl FnOnce(&mut State) -> Result<R, String>) -> Result<R, String> {
        let _ = &effect;
        self.mutate(f)
    }
}

impl StateAccess for Core {
    fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.lock())
    }

    fn mutate<R>(&self, f: impl FnOnce(&mut State) -> Result<R, String>) -> Result<R, String> {
        Core::mutate(self, |tx| f(tx)).map_err(String::from)
    }

    fn mutate_after_effect<R>(&self, effect: Value, f: impl FnOnce(&mut State) -> Result<R, String>) -> Result<R, String> {
        match Core::mutate(self, |tx| f(tx)) {
            Ok(v) => Ok(v),
            // El efecto no ocurrió o la mutación lo rechazó por sí misma: nada que reconciliar.
            Err(MutateError::Rejected(m)) => Err(m),
            Err(e) => {
                self.journal_unrecorded_effect(&effect, &e.to_string());
                Err(format!(
                    "La acción se ejecutó pero NO quedó registrada en Lixbon ({e}). Queda anotada en unrecorded-effects.jsonl para reconciliarla; no la repitas sin comprobarlo."
                ))
            }
        }
    }
}

impl StateAccess for Mutex<State> {
    fn read<R>(&self, f: impl FnOnce(&State) -> R) -> R {
        f(&self.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn mutate<R>(&self, f: impl FnOnce(&mut State) -> Result<R, String>) -> Result<R, String> {
        f(&mut self.lock().unwrap_or_else(|e| e.into_inner()))
    }
}
