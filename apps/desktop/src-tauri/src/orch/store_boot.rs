//! Puente entre el Core y el almacén SQLite (slices C1 y C2b de la Fase 1).
//!
//! Dirección de dependencias: `orch → store`. Aquí vive todo el contacto del
//! Core con el almacén, detrás de [`CoreStorage`] (un único campo de `Core`);
//! ningún otro módulo de `orch/` toca el `Store` directamente (lo vigila una
//! prueba de arquitectura). Las escrituras de estado entran por
//! [`SqlitePersistence`], que es una `Persistence` de la frontera de mutación
//! (`Core::mutate`): `candidato → transacción SQLite → COMMIT → memoria → espejo`.
//!
//! # Autoridad (C2b)
//! Una instalación pasa de `state.json` a SQLite una sola vez, con el protocolo de
//! `boot_authority.rs` (`LEGACY → FENCED → PROMOTING → COMMITTED → AUTHORITATIVE`).
//! Desde entonces SQLite es la única fuente de verdad y `state.json` es un espejo
//! (`mirror.rs`). Antes de promover, la política es la de bootstrap de C1.
//!
//! # Orden de apertura
//! `core.lock` → abrir la base SOLO hasta donde permite la valla (migración 002 sin
//! aplicar) → decidir con `decide_boot` → intentar la acción sobre el marcador → y SOLO ENTONCES
//! migraciones posteriores a la valla (003+). Que la publicación del marcador quede pendiente
//! (`marker_pending`) no impide migrar; que `decide_boot` encuentre una contradicción, sí. Un Core que no puede arrancar por
//! el lock, por incompatibilidad del almacén o por el protocolo de autoridad no
//! modifica `state.json` ni aplica ninguna migración de D en adelante.
//!
//! La política de apertura es mínima y vive aquí: el almacén recibe la lista completa de
//! migraciones para validar y un techo implícito (la valla); `orch` es quien decide cuándo
//! se levanta, con [`CoreStorage::migrate_authoritative`], y el almacén no conoce `Marker`.
//!
//! # Errores: bloqueantes y recuperables
//! [`OpenStoreError`] clasifica cada fallo:
//!
//! * **Bloqueantes** (el Core NO arranca): `AlreadyLocked`, `LockUnavailable`,
//!   `SchemaTooNew`, `MigrationChecksumMismatch`, `MigrationsInconsistent` y
//!   `Authority` (el protocolo de autoridad no permite arrancar: nunca se resuelve
//!   volviendo a `state.json`).
//! * **Recuperables** (el Core arranca *degradado* con `state.json`): solo ANTES de
//!   promover y con la valla sin aplicar. Con la valla cruzada o con evidencia de
//!   promoción, un fallo del almacén bloquea.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use super::adapter::CancelToken;
use super::attempt_ops;
use super::steer_commands;
use super::queue_commands::{self, Cancelled, DeliveryResult, ErrorKind as QueueErrorKind, PendingQueue, QueueError, QueuePort, QueueRequest, Queued};
use super::worktree_ops::attach as attempt_worktree_attach;
use super::dispatch::{DispatchSnapshot, ReserveOutcome};
use super::attempt_ops::DispatchAmbiguityCause;
use super::events::MutationContext;
use super::mirror;
use super::mutation::{PersistError, Persistence};
use super::state::State;
use super::Core;
/// Lo que el log dice de la procedencia de un Attempt (LXO-145): el payload de su `attempt.forked` y los Forks que nacieron de él.
pub(super) struct ForkLineageRows {
    pub origin: Option<String>,
    pub forks: Vec<ForkChildRow>,
}

pub(super) struct ForkChildRow {
    pub attempt_id: String,
    pub payload: String,
    pub status: String,
    pub provider: String,
    pub model: Option<String>,
    pub at: i64,
}

use crate::store::{self, InstructionMode, InstructionOutcome, AttentionPage, AttentionQuery, AttentionRow, EventPage, EventQuery, InstanceLock, Migration, MigrationReport, NewEvent, RuntimeDoc, Store, StoreError, StoreResult};

/// Por qué no se pudo abrir el almacén, ya clasificado.
#[derive(Debug)]
pub(super) enum OpenStoreError {
    // --- Bloqueantes ---
    /// Otro Core es el titular de `core.lock`.
    AlreadyLocked { lock_path: PathBuf },
    /// No se pudo crear o abrir `core.lock` (permisos, carpeta imposible…): sin
    /// él no se puede garantizar un único escritor.
    LockUnavailable { detail: String },
    /// La base es de una versión más nueva (o tiene migraciones que no conocemos).
    SchemaTooNew { detail: String },
    /// Una migración ya aplicada cambió de contenido.
    MigrationChecksumMismatch { detail: String },
    /// Migraciones fuera de orden o lista inválida.
    MigrationsInconsistent { detail: String },
    /// El protocolo de autoridad (C2b) no permite arrancar: marcador inválido, base y
    /// marcador contradictorios, legado ilegible o ausente, base inaccesible con
    /// evidencia de promoción… Nunca se resuelve volviendo a `state.json`.
    Authority { detail: String },
    // --- Recuperables (solo con `core.lock` ya adquirido) ---
    /// La base está dañada o no es SQLite.
    DatabaseCorrupt { detail: String },
    /// Fallo de E/S (disco lleno, permisos…).
    Io { detail: String },
    /// Cualquier otro fallo del almacén (SQLite, WAL, copia, instantánea…).
    Other { detail: String },
    /// Se intentó abrir dos veces en el mismo Core.
    AlreadyOpened,
}

impl OpenStoreError {
    /// `true` si el Core no debe arrancar.
    pub(super) fn is_blocking(&self) -> bool {
        matches!(
            self,
            OpenStoreError::AlreadyLocked { .. }
                | OpenStoreError::LockUnavailable { .. }
                | OpenStoreError::SchemaTooNew { .. }
                | OpenStoreError::MigrationChecksumMismatch { .. }
                | OpenStoreError::MigrationsInconsistent { .. }
                | OpenStoreError::Authority { .. }
        )
    }
}

impl fmt::Display for OpenStoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenStoreError::AlreadyLocked { lock_path } => write!(
                f,
                "otra instancia de Lixbon es la titular del Core (bloqueo en {}); ciérrala antes de abrir otra",
                lock_path.display()
            ),
            OpenStoreError::SchemaTooNew { detail }
            | OpenStoreError::MigrationChecksumMismatch { detail }
            | OpenStoreError::MigrationsInconsistent { detail }
            | OpenStoreError::Authority { detail } => f.write_str(detail),
            OpenStoreError::LockUnavailable { detail } => write!(f, "no se pudo obtener el bloqueo del Core: {detail}"),
            OpenStoreError::DatabaseCorrupt { detail } | OpenStoreError::Io { detail } | OpenStoreError::Other { detail } => {
                f.write_str(detail)
            }
            OpenStoreError::AlreadyOpened => f.write_str("el almacén del Core ya está abierto"),
        }
    }
}

impl From<StoreError> for OpenStoreError {
    fn from(e: StoreError) -> Self {
        let detail = e.to_string();
        match e {
            StoreError::AlreadyRunning { lock_path } => OpenStoreError::AlreadyLocked { lock_path },
            StoreError::DatabaseNewer { .. } | StoreError::UnknownMigration { .. } => OpenStoreError::SchemaTooNew { detail },
            StoreError::ChecksumMismatch { .. } => OpenStoreError::MigrationChecksumMismatch { detail },
            StoreError::OutOfOrderMigration { .. } | StoreError::InvalidMigrationList(_) => {
                OpenStoreError::MigrationsInconsistent { detail }
            }
            StoreError::Corrupt { .. } => OpenStoreError::DatabaseCorrupt { detail },
            StoreError::Io { .. } => OpenStoreError::Io { detail },
            _ => OpenStoreError::Other { detail },
        }
    }
}

/// Lo que dejó el arranque cuando SQLite es la autoridad.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StorageReport {
    /// `rev` de la fila de SQLite al terminar el arranque.
    pub rev: i64,
    pub promotion_id: String,
    /// ¿Este arranque ha hecho la promoción (frente a un arranque ya promovido)?
    pub promoted_now: bool,
    /// ¿Quedó pendiente publicar `authority.json` confirmado? (el marcador `promoting`
    /// ya impide el fallback; se reintenta en el siguiente arranque)
    pub marker_pending: bool,
}

/// Estado del almacén dentro del Core.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum StorageStatus {
    /// Antes de `init`, o `init` aún no llegó a abrirlo.
    NotOpened,
    /// SQLite es la autoridad y el Core la usa.
    Ready(StorageReport),
    /// Falló de forma recuperable ANTES de promocionar: el Core sigue con
    /// `state.json` (política de bootstrap de C1). Nunca ocurre con una instalación
    /// promovida ni con la valla ya aplicada.
    Degraded(String),
}

pub(super) struct Slot {
    // Orden de campos = orden de Drop: la base se cierra antes de soltar el bloqueo.
    pub(super) store: Option<Store>,
    lock: Option<InstanceLock>,
    status: StorageStatus,
    /// LXO-234: por qué el arranque no pudo usar la base, consultable en `core_model.storage` (`code`, `message`).
    rejection: Option<(String, String)>,
    /// Las migraciones del binario. En producción son las embebidas; las pruebas pueden
    /// añadir una migración ficticia para ejercitar el protocolo (ver `set_catalog`).
    catalog: Vec<Migration>,
}

/// Único punto de contacto del Core con el almacén.
pub(super) struct CoreStorage(Arc<Mutex<Slot>>);

impl Default for CoreStorage {
    fn default() -> Self {
        CoreStorage(Arc::new(Mutex::new(Slot { store: None, lock: None, status: StorageStatus::NotOpened, rejection: None, catalog: store::embedded() })))
    }
}

impl CoreStorage {
    fn slot(&self) -> MutexGuard<'_, Slot> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn status(&self) -> StorageStatus {
        self.slot().status.clone()
    }

    /// Adquiere `core.lock` (idempotente si este Core ya lo tiene). El bloqueo se
    /// conserva mientras viva el Core, funcione o no la base.
    pub(super) fn acquire_lock(&self, core_dir: &Path) -> Result<(), OpenStoreError> {
        let mut slot = self.slot();
        if slot.lock.is_some() {
            return Ok(());
        }
        slot.lock = Some(acquire(core_dir)?);
        Ok(())
    }

    /// Abre la base para el ARRANQUE de C2b: solo hasta donde permite la valla (ver
    /// [`Store::open_boot_under_lock`]). Un error se devuelve ya clasificado; quien
    /// llama decide si es bloqueante o si equivale a «la base no se puede consultar».
    pub(super) fn open_for_boot(&self, core_dir: &Path) -> Result<(), OpenStoreError> {
        let mut guard = self.slot();
        let Slot { store: store_slot, lock: lock_slot, catalog, .. } = &mut *guard;
        if store_slot.is_some() {
            return Err(OpenStoreError::AlreadyOpened);
        }
        if lock_slot.is_none() {
            *lock_slot = Some(acquire(core_dir)?);
        }
        let lock = lock_slot.as_ref().expect("bloqueo adquirido arriba");
        let mut store = Store::open_boot_under_lock(core_dir, lock, catalog, env!("CARGO_PKG_VERSION"))?;
        // Attention (LXO-88): cada inserción de Events del Core proyecta en su misma transacción.
        store.set_event_projector(Arc::new(store::AttentionProjection::new(Arc::new(super::attention_rules::EventRules))));
        *store_slot = Some(store);
        Ok(())
    }

    /// Levanta el techo de la valla: aplica las migraciones posteriores (003+), hasta el corte Task/Attempt, que este
    /// camino nunca aplica (`migrate::plan`). Solo la llama el arranque, cuando `decide_boot` ya dio por coherente la
    /// instalación (ver `boot_authority`). `None` = el almacén no está abierto.
    pub(super) fn migrate_authoritative(&self) -> Option<Result<MigrationReport, StoreError>> {
        let mut guard = self.slot();
        let Slot { store, catalog, .. } = &mut *guard;
        store.as_mut().map(|s| s.migrate_authoritative(catalog, env!("CARGO_PKG_VERSION")))
    }

    /// La carpeta del almacén abierto (`core/`): la de `lixbon.db`. `None` = cerrado.
    pub(super) fn dir(&self) -> Option<PathBuf> {
        self.slot().store.as_ref().and_then(|s| s.db_path().parent().map(Path::to_path_buf))
    }

    /// El estado del runtime reconstruido desde las tablas, si la base ya está cortada (LXO-232). `None` = sin cortar:
    /// el estado sigue en `legacy_state`.
    pub(super) fn load_from_tables(&self) -> Result<Option<State>, OpenStoreError> {
        let slot = self.slot();
        let Some(store) = slot.store.as_ref() else { return Ok(None) };
        if !store.runtime_on_tables().map_err(OpenStoreError::from)? {
            return Ok(None);
        }
        let load = store.runtime_load().map_err(OpenStoreError::from)?;
        let mut state: State = serde_json::from_value(load.doc).map_err(|e| OpenStoreError::Authority {
            detail: format!("el estado de las tablas Task/Attempt no se puede interpretar: {e}. No se usa legacy_state ni state.json en su lugar"),
        })?;
        state.decision_floor = load.decision_floor.max(0) as u64;
        state.attempt_n = load.attempts.into_iter().map(|(task, n)| (task, n.max(1) as u32)).collect();
        Ok(Some(state))
    }

    /// La persistencia del runtime sobre las tablas (LXO-232), a partir del estado cargado de ellas.
    pub(super) fn tables_persistence(&self, loaded: &State) -> Arc<dyn Persistence> {
        let doc = serde_json::to_value(loaded).ok().and_then(|v| RuntimeDoc::from_value(v).ok()).unwrap_or_default();
        Arc::new(TablesPersistence { slot: Arc::clone(&self.0), committed: Mutex::new(doc) })
    }

    /// Solo pruebas: sustituye la lista de migraciones del binario (p. ej. añade una 003 ficticia).
    #[cfg(test)]
    pub(super) fn set_catalog(&self, catalog: Vec<Migration>) {
        self.slot().catalog = catalog;
    }

    /// Marca el almacén como degradado (decisión explícita de `init`): suelta la
    /// base pero CONSERVA `core.lock`, así que la exclusión mutua se mantiene.
    pub(super) fn degrade(&self, reason: String) {
        let mut slot = self.slot();
        slot.store = None;
        slot.status = StorageStatus::Degraded(reason);
    }

    /// El arranque no pudo usar la base (LXO-234): deja el motivo consultable. No cambia `status`.
    pub(super) fn reject(&self, code: String, message: String) {
        self.slot().rejection = Some((code, message));
    }

    /// `(code, message)` si el arranque no pudo usar la base.
    pub(super) fn rejection(&self) -> Option<(String, String)> {
        self.slot().rejection.clone()
    }

    /// Nombre corto del estado del almacén para `core_model.storage.status`.
    pub(super) fn status_name(&self) -> &'static str {
        let slot = self.slot();
        if slot.rejection.is_some() {
            return "rejected";
        }
        match &slot.status {
            StorageStatus::NotOpened => "not_opened",
            StorageStatus::Ready(_) => "ready",
            StorageStatus::Degraded(_) => "degraded",
        }
    }

    /// Fija el estado `Ready` tras un arranque autoritativo.
    pub(super) fn set_ready(&self, report: StorageReport) {
        self.slot().status = StorageStatus::Ready(report);
    }

    /// La `rev` realmente confirmada en la fila de SQLite ahora mismo (no la cargada al abrir).
    pub(super) fn confirmed_rev(&self) -> Result<Option<i64>, String> {
        match self.slot().store.as_ref() {
            Some(store) if store.runtime_on_tables().map_err(|e| e.to_string())? => store.runtime_rev().map(Some).map_err(|e| e.to_string()),
            Some(store) => store.row_rev().map_err(|e| e.to_string()),
            None => Err("el almacén no está abierto".into()),
        }
    }

    /// Acceso al `Store` abierto. Solo lo usan el arranque (`boot_authority`) y las
    /// pruebas; las escrituras de estado entran por [`SqlitePersistence`].
    pub(super) fn with_store<R>(&self, f: impl FnOnce(&mut Store) -> R) -> Option<R> {
        self.slot().store.as_mut().map(f)
    }

    /// Una página del Event Log. `None` = el almacén no está abierto. Solo lee.
    pub(super) fn events_page(&self, q: &EventQuery) -> Option<StoreResult<EventPage>> {
        self.slot().store.as_ref().map(|s| s.events_page(q))
    }

    /// Lectura del `Store` abierto (`None` = cerrado). A diferencia de `with_store`, el closure no puede escribir.
    pub(super) fn read_store<R>(&self, f: impl FnOnce(&Store) -> R) -> Option<R> {
        self.slot().store.as_ref().map(f)
    }

    /// Una página de Attention activa, solo lectura.
    pub(super) fn attention_page(&self, q: &AttentionQuery) -> Option<StoreResult<AttentionPage>> {
        self.slot().store.as_ref().map(|s| s.attention_page(q))
    }

    /// Detalle de Attention limitado al Task autenticado de un Agent, si aplica.
    pub(super) fn attention_get_scoped(&self, id: &str, scope_task_id: Option<&str>) -> Option<StoreResult<Option<AttentionRow>>> {
        self.slot().store.as_ref().map(|s| s.attention_get_scoped(id, scope_task_id))
    }

    /// La persistencia autoritativa: escribe en SQLite (y, después de publicar, el espejo).
    pub(super) fn sqlite_persistence(&self, data_dir: &Path, rev: i64) -> Arc<dyn Persistence> {
        Arc::new(SqlitePersistence {
            slot: Arc::clone(&self.0),
            data_dir: data_dir.to_path_buf(),
            committed: Mutex::new(Committed { rev, pending_mirror: None }),
        })
    }
}

struct Committed {
    /// `rev` de la última fila confirmada (la siguiente escritura espera esta).
    rev: i64,
    /// (rev, documento) confirmados cuyo espejo falta por escribir.
    pending_mirror: Option<(i64, String)>,
}

/// `Persistence` de SQLite: cada mutación es UNA transacción `BEGIN IMMEDIATE .. COMMIT`
/// sobre `legacy_state`, con concurrencia optimista por `rev`. Tras publicar en
/// memoria, escribe el espejo `state.json`.
struct SqlitePersistence {
    slot: Arc<Mutex<Slot>>,
    data_dir: PathBuf,
    committed: Mutex<Committed>,
}

impl Persistence for SqlitePersistence {
    fn records_events(&self) -> bool {
        true
    }

    fn persist(&self, state: &State, events: &[NewEvent]) -> Result<(), PersistError> {
        let doc = serde_json::to_string(state).map_err(|e| PersistError::structural(format!("no se pudo serializar el estado: {e}")))?;
        let mut committed = self.committed.lock().unwrap_or_else(|e| e.into_inner());
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(store) = slot.store.as_mut() else {
            return Err(PersistError::structural("el almacén SQLite no está abierto"));
        };
        // UPDATE legacy_state + INSERT events: UNA transacción, o ninguna de las dos cosas.
        match store.commit_authoritative_with_events(committed.rev, &doc, events) {
            Ok(rev) => {
                committed.rev = rev;
                committed.pending_mirror = Some((rev, doc));
                Ok(())
            }
            // La ÚNICA clasificación de transitorios vive en el almacén.
            Err(e) => Err(PersistError { transient: e.is_transient(), message: e.to_string(), rejected: false }),
        }
    }

    /// Hechos que NO modifican `legacy_state`: `Store::append_events` (su propia transacción, `state_rev = NULL`).
    /// No toca `committed` (la `rev` no avanza) ni el espejo. Repetir la misma `(kind, idem_key)` es un éxito.
    fn append(&self, events: &[NewEvent]) -> Result<(), PersistError> {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(store) = slot.store.as_mut() else {
            return Err(PersistError::structural("el almacén SQLite no está abierto"));
        };
        store.append_events(events).map(|_| ()).map_err(|e| PersistError { transient: e.is_transient(), message: e.to_string(), rejected: false })
    }

    fn after_publish(&self, _state: &State) -> Result<(), String> {
        let pending = self.committed.lock().unwrap_or_else(|e| e.into_inner()).pending_mirror.take();
        let Some((rev, doc)) = pending else { return Ok(()) };
        store::crash_point("mutate_after_commit");
        mirror::write_mirror(&self.data_dir, &doc, rev).map_err(|e| e.to_string())
    }
}

/// `Persistence` del runtime sobre las tablas Task/Attempt (LXO-232): cada mutación compara el documento confirmado con
/// el candidato y lo traduce a las tablas, con sus eventos, en UNA transacción (`Store::runtime_commit_recorded`). La
/// vista legacy reconstruida de lo que cambió debe ser el candidato; si no, no se confirma nada. Sin espejo: desde el
/// corte `state.json` no se escribe (ADR D4) y `legacy_state` está congelado.
struct TablesPersistence {
    slot: Arc<Mutex<Slot>>,
    /// El documento de la última confirmación (o el cargado al arrancar): contra él se compara el siguiente. Los
    /// latidos de actividad que solo viven en memoria viajan así en la siguiente mutación.
    committed: Mutex<RuntimeDoc>,
}

impl Persistence for TablesPersistence {
    fn records_events(&self) -> bool {
        true
    }

    fn attempt_model(&self) -> bool {
        true
    }

    fn lookup_idempotent(&self, identity_scope: &str, request_id: &str, payload_sha256: &str)
        -> Result<Option<crate::store::RuntimeResultIds>, PersistError> {
        let slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(store) = slot.store.as_ref() else {
            return Err(PersistError::structural("el almacén SQLite no está abierto"));
        };
        store.runtime_lookup_idempotent_recorded(identity_scope, request_id, payload_sha256).map_err(|e| match e {
            // Reutilizar el request_id con otro payload o un ledger incoherente no es un fallo de disco.
            StoreError::TaskConflict(_) | StoreError::InvalidTask(_) => PersistError::rejected(e.to_string()),
            e => PersistError { transient: e.is_transient(), message: e.to_string(), rejected: false },
        })
    }

    fn persist_idempotent(
        &self,
        state: &State,
        events: &[NewEvent],
        identity_scope: &str,
        request_id: &str,
        payload_sha256: &str,
        result_ids: &crate::store::RuntimeResultIds,
    ) -> Result<crate::store::RuntimeCommitOutcome, PersistError> {
        let next = serde_json::to_value(state)
            .map_err(|e| PersistError::structural(format!("no se pudo serializar el estado: {e}")))
            .and_then(|v| RuntimeDoc::from_value(v).map_err(|e| PersistError::structural(e.to_string())))?;
        let mut committed = self.committed.lock().unwrap_or_else(|e| e.into_inner());
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(store) = slot.store.as_mut() else {
            return Err(PersistError::structural("el almacén SQLite no está abierto"));
        };
        match store.runtime_commit_idempotent_recorded(
            &committed, &next, events, identity_scope, request_id, payload_sha256, result_ids,
            |view, changes| super::agentic_cut::verify_runtime_view(view, changes, state),
        ) {
            Ok(outcome) => {
                if matches!(outcome, crate::store::RuntimeCommitOutcome::Committed { .. }) {
                    *committed = next;
                }
                Ok(outcome)
            }
            // Lo que las tablas no representan, o un conflicto del ledger, se rechaza sin degradar el Core: la
            // transacción se deshizo entera.
            Err(e @ (StoreError::RuntimeMapping(_) | StoreError::TaskConflict(_) | StoreError::InvalidTask(_))) => {
                Err(PersistError::rejected(e.to_string()))
            }
            Err(e) => Err(PersistError { transient: e.is_transient(), message: e.to_string(), rejected: false }),
        }
    }

    fn persist(&self, state: &State, events: &[NewEvent]) -> Result<(), PersistError> {
        let next = serde_json::to_value(state)
            .map_err(|e| PersistError::structural(format!("no se pudo serializar el estado: {e}")))
            .and_then(|v| RuntimeDoc::from_value(v).map_err(|e| PersistError::structural(e.to_string())))?;
        let mut committed = self.committed.lock().unwrap_or_else(|e| e.into_inner());
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(store) = slot.store.as_mut() else {
            return Err(PersistError::structural("el almacén SQLite no está abierto"));
        };
        match store.runtime_commit_recorded(&committed, &next, events, |view, changes| super::agentic_cut::verify_runtime_view(view, changes, state)) {
            Ok(_) => {
                *committed = next;
                Ok(())
            }
            // Lo que las tablas no representan se rechaza sin degradar el Core: la transacción se deshizo entera.
            Err(e @ StoreError::RuntimeMapping(_)) => Err(PersistError::rejected(e.to_string())),
            Err(e) => Err(PersistError { transient: e.is_transient(), message: e.to_string(), rejected: false }),
        }
    }

    fn append(&self, events: &[NewEvent]) -> Result<(), PersistError> {
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(store) = slot.store.as_mut() else {
            return Err(PersistError::structural("el almacén SQLite no está abierto"));
        };
        store.append_events(events).map(|_| ()).map_err(|e| PersistError { transient: e.is_transient(), message: e.to_string(), rejected: false })
    }
}

fn acquire(core_dir: &Path) -> Result<InstanceLock, OpenStoreError> {
    match InstanceLock::acquire(&store::lock_path(core_dir)) {
        Ok(lock) => Ok(lock),
        Err(StoreError::Io { .. }) => {
            let detail = format!("no se pudo crear {}", store::lock_path(core_dir).display());
            Err(OpenStoreError::LockUnavailable { detail })
        }
        Err(e) => Err(e.into()),
    }
}

impl Core {
    /// Ids de los Attempts con aprobación inicial pendiente cuyo plazo durable ya venció (a lo sumo `limit`).
    ///
    /// `None`: no hay SQLite autoritativa, así que no existe un plazo durable que expirar. Solo entrega candidatos: cada
    /// cambio pasa por `Core::mutate`, donde el commit vuelve a validar el plazo bajo la transacción.
    pub(super) fn initial_approval_expiry_candidates(&self, now: i64, limit: usize) -> Option<crate::store::StoreResult<Vec<String>>> {
        self.storage.with_store(|store| {
            store.runtime_on_tables().and_then(|active| {
                if active {
                    store.attempt_initial_approval_expiry_candidates(now, limit)
                } else {
                    Ok(Vec::new())
                }
            })
        })
    }

    /// Estado, plazo durable y decisión canónica de la aprobación inicial de un Attempt. `None`: no existe.
    pub(super) fn initial_approval_snapshot(&self, attempt_id: &str) -> Result<Option<crate::store::InitialApprovalSnapshot>, String> {
        self.storage
            .read_store(|store| {
                if !store.runtime_on_tables().map_err(|e| e.to_string())? {
                    return Err("el runtime Task/Attempt no está activo".to_string());
                }
                store.attempt_initial_approval_snapshot(attempt_id).map_err(|e| e.to_string())
            })
            .ok_or_else(|| "el almacén del Core no está abierto".to_string())?
    }

    /// Lo que el despachador lee de un Attempt: sus filas durables y su claim. `None`: el Attempt no existe.
    pub(super) fn dispatch_snapshot(&self, attempt_id: &str) -> Result<Option<DispatchSnapshot>, String> {
        let read = self
            .storage
            .with_store(|store| -> crate::store::StoreResult<Option<DispatchSnapshot>> {
                let Some(attempt) = store.attempt_row(attempt_id)? else { return Ok(None) };
                let Some(task) = store.task_row(&attempt.task_id)? else { return Ok(None) };
                let Some(run) = store.run_row(&task.run_id)? else { return Ok(None) };
                let claim = store.read(|c| Ok(c.query_row("SELECT dispatch_claim FROM attempts WHERE id = ?1", [attempt_id], |r| r.get::<_, String>(0))?))?;
                let session = match attempt.provider_session_id.as_deref() {
                    Some(id) => store.provider_session_row(id)?,
                    None => None,
                };
                Ok(Some(DispatchSnapshot { attempt, task, run, claim, session }))
            })
            .ok_or_else(|| "el almacén no está abierto".to_string())?;
        read.map_err(|e| e.to_string())
    }

    // ── La policy de autonomía (LXO-209): el almacén solo se toca desde aquí ──────────────────────────────────────────────────

    /// La policy guardada AHORA. Se lee en cada Command: nunca se cachea ni se confía en lo que la interfaz vio. Sin almacén abierto o con un
    /// error de lectura devuelve `Err`: quien decide falla CERRADO.
    pub(super) fn policy_snapshot(&self) -> Result<crate::store::PolicySnapshot, String> {
        match self.storage.read_store(|st| st.policy_snapshot()) {
            Some(Ok(snapshot)) => Ok(snapshot),
            Some(Err(e)) => Err(format!("No se pudo leer la policy: {e}")),
            None => Err("El almacén del Core no está abierto".into()),
        }
    }

    /// Los eventos de un Race (entidad `race`), del más antiguo al más nuevo: `(kind, payload, at)`. Solo lectura.
    pub(super) fn race_events(&self, race_id: &str) -> Result<Vec<(String, String, i64)>, String> {
        let q = EventQuery { entity_kind: Some("race".into()), entity_id: Some(race_id.into()), ..EventQuery::default() };
        match self.storage.events_page(&q) {
            Some(Ok(page)) => Ok(page.events.into_iter().map(|e| (e.kind, e.payload, e.at)).collect()),
            Some(Err(e)) => Err(format!("No se pudo leer el Race: {e}")),
            None => Err("El almacén del Core no está abierto".into()),
        }
    }

    /// Los `race.requested` más recientes (de cualquier Race), para listar los de un Attempt. Solo lectura.
    pub(super) fn race_requests(&self, limit: usize) -> Result<Vec<(String, String, i64)>, String> {
        let q = EventQuery { kind: Some("race.requested".into()), newest_first: true, limit: Some(limit), ..EventQuery::default() };
        match self.storage.events_page(&q) {
            Some(Ok(page)) => Ok(page.events.into_iter().map(|e| (e.entity_id, e.payload, e.at)).collect()),
            Some(Err(e)) => Err(format!("No se pudo leer los Races: {e}")),
            None => Err("El almacén del Core no está abierto".into()),
        }
    }

    /// ¿Existe el Project en el registro? (Para no crear overrides huérfanos de un id inventado.)
    pub(super) fn project_exists(&self, project_id: &str) -> Result<bool, String> {
        match self.storage.read_store(|st| st.project(project_id)) {
            Some(Ok(row)) => Ok(row.is_some()),
            Some(Err(e)) => Err(format!("No se pudo leer el registro de proyectos: {e}")),
            None => Err("El almacén del Core no está abierto".into()),
        }
    }

    /// Escribe un cambio de policy con su Event de auditoría (una transacción). `event` recibe el nivel anterior y la revisión nueva.
    pub(super) fn policy_apply(
        &self,
        expected_revision: i64,
        write: &crate::store::PolicyWrite,
        set_by: &str,
        at: i64,
        event: impl FnOnce(Option<&str>, i64) -> crate::store::StoreResult<crate::store::NewEvent>,
    ) -> Result<crate::store::PolicyChange, String> {
        match self.storage.with_store(|st| st.policy_apply_recorded(expected_revision, write, set_by, at, event)) {
            Some(Ok(change)) => Ok(change),
            Some(Err(crate::store::StoreError::AgenticModelInactive)) => Err("core_model_inactive: la policy se puede editar tras el corte Task/Attempt".into()),
            Some(Err(e)) => Err(format!("No se pudo guardar la policy: {e}")),
            None => Err("El almacén del Core no está abierto".into()),
        }
    }

    /// Guarda un ContextPackage ya validado (LXO-138): el paquete y los bytes de sus adjuntos en una transacción. Repetirlo no escribe nada.
    pub(super) fn context_package_store(&self, p: &crate::store::NewStoredPackage, at: i64) -> Result<crate::store::PutOutcome, String> {
        match self.storage.with_store(|st| st.context_package_put(p, at)) {
            Some(Ok(outcome)) => Ok(outcome),
            Some(Err(crate::store::StoreError::AgenticModelInactive)) => Err("core_model_inactive: el Core aún sirve el modelo legacy; los paquetes guardados llegan tras el corte Task/Attempt".into()),
            Some(Err(e)) => Err(format!("context_store_unavailable: {e}")),
            None => Err("context_store_unavailable: el almacén no está abierto".into()),
        }
    }

    // ── La cola de instrucciones (LXO-143): el almacén solo se toca desde aquí ───────────────────────────────────────────────

    fn queue_store<R>(&self, f: impl FnOnce(&mut Store) -> Result<R, QueueError>) -> Result<R, QueueError> {
        self.storage.with_store(f).unwrap_or_else(|| Err(QueueError::new(QueueErrorKind::Failed, "store", "el almacén del Core no está abierto")))
    }

    /// `attempt.queue`: encola y, si el run ya está en un límite de turno, entrega (nunca desde el RPC: ahí es `Busy`).
    pub(super) fn queue_enqueue(&self, port: &dyn QueuePort, ctx: &MutationContext, cancel: &CancelToken, req: &QueueRequest<'_>) -> Result<Queued, QueueError> {
        self.queue_store(|st| queue_commands::queue_attempt(st, port, ctx, cancel, req))
    }

    pub(super) fn queue_cancel(&self, ctx: &MutationContext, queue_id: &str) -> Result<Cancelled, QueueError> {
        self.queue_store(|st| queue_commands::cancel_queued(st, ctx, queue_id))
    }

    pub(super) fn queue_pending(&self, ctx: &MutationContext, attempt_id: &str) -> Result<PendingQueue, QueueError> {
        self.queue_store(|st| queue_commands::pending(st, ctx, attempt_id))
    }

    /// Lo que ya NO está pendiente (`delivered`, `cancelled`, `failed`), en el orden en que se encoló, como mucho los últimos.
    pub(super) fn queue_finished(&self, ctx: &MutationContext, attempt_id: &str, limit: usize) -> Result<Vec<crate::store::QueueItemRow>, QueueError> {
        self.queue_store(|st| queue_commands::finished(st, ctx, attempt_id, limit))
    }

    // ── Fork (LXO-145): la procedencia de un Attempt sale del log, y solo se lee desde aquí ────────────────────────────────────

    /// Lo que el log dice de la procedencia de un Attempt: su `attempt.forked` (si nació de otro) y los Forks que nacieron de él, con
    /// el estado y el proveedor que tienen AHORA. Solo lectura.
    pub(super) fn fork_lineage_rows(&self, attempt_id: &str) -> Result<ForkLineageRows, String> {
        self.storage
            .with_store(|store| {
                store.read(|c| {
                    let mut first = c.prepare("SELECT payload FROM events WHERE kind = 'attempt.forked' AND entity_id = ?1 ORDER BY seq LIMIT 1")?;
                    let origin = first.query_map([attempt_id], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?.into_iter().next();
                    let mut stmt = c.prepare(
                        "SELECT e.entity_id, e.payload, a.status, a.provider, a.model, e.at FROM events e JOIN attempts a ON a.id = e.entity_id                          WHERE e.kind = 'attempt.forked' AND json_extract(e.payload, '$.source') = ?1 ORDER BY e.seq",
                    )?;
                    let forks = stmt
                        .query_map([attempt_id], |r| {
                            Ok(ForkChildRow { attempt_id: r.get(0)?, payload: r.get(1)?, status: r.get(2)?, provider: r.get(3)?, model: r.get(4)?, at: r.get(5)? })
                        })?
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(ForkLineageRows { origin, forks })
                })
            })
            .ok_or_else(|| "el almacén no está abierto".to_string())?
            .map_err(|e| e.to_string())
    }

    // ── Steer y Stop & Send (LXO-144): el almacén solo se toca desde aquí ────────────────────────────────────────────────────

    /// Lee el Attempt y comprueba que `ctx` puede instruirlo.
    pub(super) fn instruction_authorize(&self, ctx: &MutationContext, attempt_id: &str) -> Result<crate::store::AttemptRow, QueueError> {
        self.queue_store(|st| steer_commands::authorize(st, ctx, attempt_id))
    }

    /// Lee el Attempt para responder a una petición del proveedor (LXO-247). Solo lectura; quién puede responder lo decide el RPC.
    pub(super) fn attempt_for_answer(&self, attempt_id: &str) -> Result<crate::store::AttemptRow, QueueError> {
        self.queue_store(|st| queue_commands::attempt_of(st, attempt_id))
    }

    /// `attempt.request_answered` (LXO-247): lo que una persona respondió a una petición del proveedor, ya aceptada por este.
    pub(super) fn request_answered(&self, ctx: &MutationContext, attempt_id: &str, request_id: &str, kind: &'static str, decision: Option<&'static str>) -> Result<(), QueueError> {
        self.queue_store(|st| {
            let event = steer_commands::answered_event(st, ctx, attempt_id, request_id, kind, decision)?;
            st.append_events(&[event]).map_err(queue_commands::from_store)?;
            Ok(())
        })
    }

    /// `attempt.usage_reported` (LXO-249): el uso que el proveedor declaró en un turno del Attempt. Un turno sin nada declarado no deja hecho.
    pub(super) fn usage_reported(&self, attempt_id: &str, usage: &super::attempt_ops::ReportedUsage) -> Result<(), QueueError> {
        if !usage.any() {
            return Ok(());
        }
        self.queue_store(|st| {
            let (attempt, task) = steer_commands::rows(st, attempt_id)?;
            let event = attempt_ops::usage_reported_fact(&attempt, &task, usage, &MutationContext::core(), super::state::now_ms() as i64).map_err(queue_commands::from_store)?;
            st.append_events(&[event]).map_err(queue_commands::from_store)?;
            Ok(())
        })
    }

    /// `attempt.instruction_requested`.
    pub(super) fn instruction_requested(&self, ctx: &MutationContext, attempt_id: &str, request_id: &str, mode: InstructionMode, chars: i64) -> Result<(), QueueError> {
        self.queue_store(|st| {
            let event = steer_commands::requested_event(st, ctx, attempt_id, request_id, mode, chars)?;
            st.append_events(&[event]).map_err(queue_commands::from_store)?;
            Ok(())
        })
    }

    /// `attempt.instruction_result`.
    pub(super) fn instruction_record_result(&self, ctx: &MutationContext, attempt_id: &str, request_id: &str, mode: InstructionMode, outcome: InstructionOutcome, reason: Option<crate::store::QueueFailure>) -> Result<(), QueueError> {
        self.queue_store(|st| {
            let event = steer_commands::result_event(st, ctx, attempt_id, request_id, mode, outcome, reason)?;
            st.append_events(&[event]).map_err(queue_commands::from_store)?;
            Ok(())
        })
    }

    /// Entrega el siguiente item si el run está en un límite de turno (lo llama el bombeo).
    pub(super) fn queue_deliver_next(&self, port: &dyn QueuePort, cancel: &CancelToken, attempt_id: &str) -> Result<DeliveryResult, QueueError> {
        self.queue_store(|st| queue_commands::deliver_next(st, port, cancel, attempt_id))
    }

    /// El Attempt terminó: lo que seguía pendiente ya no se entregará (falla con `attempt_ended`).
    pub(super) fn queue_settle(&self, attempt_id: &str) {
        match self.queue_store(|st| queue_commands::settle_attempt_end(st, attempt_id)) {
            Ok(_) => {}
            Err(why) => eprintln!("[core] no se pudo cerrar la cola de {attempt_id} al terminar el Attempt: {why}"),
        }
    }

    /// Arranque: lo `delivering` falla (`interrupted`: nunca se reintenta) y lo `queued` de un Attempt terminado también.
    pub(super) fn queue_recover_at_boot(&self) {
        match self.queue_store(queue_commands::recover) {
            Ok(r) if r.interrupted + r.ended == 0 => {}
            Ok(r) => eprintln!("[core] cola de instrucciones: {} interrumpida(s), {} de Attempts terminados; {} se conservan", r.interrupted, r.ended, r.kept),
            Err(why) => eprintln!("[core] no se pudo recuperar la cola de instrucciones al arrancar: {why}"),
        }
    }

    /// La fila del Attempt (la reanudación necesita su perfil, modelo y esfuerzo).
    pub(super) fn attempt_row_for_resume(&self, attempt_id: &str) -> Result<Option<crate::store::AttemptRow>, String> {
        self.storage.with_store(|store| store.attempt_row(attempt_id)).ok_or_else(|| "el almacén no está abierto".to_string())?.map_err(|e| e.to_string())
    }

    /// La ProviderSession a la que está enlazado un Attempt (la que dejó en espera al terminar), si la tiene.
    pub(super) fn attempt_session_record(&self, attempt_id: &str) -> Result<Option<crate::store::ProviderSessionRow>, String> {
        let read = self
            .storage
            .with_store(|store| -> crate::store::StoreResult<Option<crate::store::ProviderSessionRow>> {
                let Some(attempt) = store.attempt_row(attempt_id)? else { return Ok(None) };
                match attempt.provider_session_id.as_deref() {
                    Some(id) => store.provider_session_row(id),
                    None => Ok(None),
                }
            })
            .ok_or_else(|| "el almacén no está abierto".to_string())?;
        read.map_err(|e| e.to_string())
    }

    /// `(id, estado)` del Worktree que la Task ya tiene registrado, si lo hay (lo registró un Attempt anterior). `None`: es su
    /// primer Attempt. Lo usa el lanzador para decidir entre crear el Worktree o adjuntarse al de la Task.
    pub(super) fn task_worktree_record(&self, task_id: &str) -> Result<Option<(String, String)>, String> {
        let read = self
            .storage
            .with_store(|store| {
                store.read(|c| {
                    let mut stmt = c.prepare("SELECT id, state FROM worktrees WHERE task_id = ?1 ORDER BY rowid LIMIT 1")?;
                    let rows = stmt.query_map([task_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
                    Ok(rows.collect::<Result<Vec<_>, _>>()?.into_iter().next())
                })
            })
            .ok_or_else(|| "el almacén no está abierto".to_string())?;
        read.map_err(|e| e.to_string())
    }

    /// Enlaza el Attempt al Worktree de su Task (un reintento trabaja en él). Si el proyector ya lo enlazó no cambia nada.
    pub(super) fn attach_attempt_to_worktree(&self, worktree_id: &str, attempt_id: &str) -> Result<(), String> {
        let attached = self
            .storage
            .with_store(|store| attempt_worktree_attach(store, &MutationContext::core(), worktree_id, attempt_id))
            .ok_or_else(|| "el almacén no está abierto".to_string())?;
        attached.map(|_| ()).map_err(|e| e.to_string())
    }

    /// Reserva el claim de despacho (un solo uso). Una elegibilidad que cambió es `Ineligible`, no un error del almacén.
    pub(super) fn dispatch_reserve(&self, attempt_id: &str) -> Result<ReserveOutcome, String> {
        let result = self.storage.with_store(|store| store.attempt_dispatch_reserve(attempt_id)).ok_or_else(|| "el almacén no está abierto".to_string())?;
        match result {
            Ok(true) => Ok(ReserveOutcome::Reserved),
            Ok(false) => Ok(ReserveOutcome::AlreadyClaimed),
            Err(crate::store::StoreError::AttemptConflict(why)) => Ok(ReserveOutcome::Ineligible(why)),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Marca el claim `ambiguous` y deja constancia (`attempt.dispatch_ambiguous`) en la misma transacción. Si el Attempt ya
    /// tiene evidencia terminal canónica se asienta en su lugar, sin un falso hecho de ambigüedad. `false`: no había claim en vuelo.
    pub(super) fn dispatch_mark_ambiguous(&self, attempt_id: &str, cause: DispatchAmbiguityCause) -> Result<bool, String> {
        let ctx = MutationContext::core();
        let at = super::state::now_ms() as i64;
        self.storage
            .with_store(|store| store.attempt_dispatch_mark_ambiguous_recorded(attempt_id, |a, t, from| attempt_ops::dispatch_ambiguous_fact(a, t, from, cause, &ctx, at)))
            .ok_or_else(|| "el almacén no está abierto".to_string())?
            .map_err(|e| e.to_string())
    }

    /// Arranque: reconcilia en UNA transacción todo claim `reserved` o `started` que quedó en vuelo. Con evidencia terminal
    /// canónica se asienta; sin ella pasa a `ambiguous` con su hecho. Devuelve cuántos cambió.
    pub(super) fn dispatch_reconcile_in_flight(&self) -> Result<usize, String> {
        let ctx = MutationContext::core();
        let at = super::state::now_ms() as i64;
        self.storage
            .with_store(|store| {
                if !store.runtime_on_tables()? {
                    return Ok(0);
                }
                store.attempt_dispatch_reconcile_ambiguous_recorded(|a, t, from| attempt_ops::dispatch_ambiguous_fact(a, t, from, DispatchAmbiguityCause::CoreRestart, &ctx, at))
            })
            .ok_or_else(|| "el almacén no está abierto".to_string())?
            .map_err(|e| e.to_string())
    }

    /// `reserved -> started`, solo si el `attempt.started` canónico ya es durable.
    pub(super) fn dispatch_mark_started(&self, attempt_id: &str) -> Result<bool, String> {
        self.storage
            .with_store(|store| store.attempt_dispatch_started(attempt_id))
            .ok_or_else(|| "el almacén no está abierto".to_string())?
            .map_err(|e| e.to_string())
    }

    /// Asienta el claim de un Attempt terminal con evidencia canónica (también uno que terminó sin `attempt.started`).
    pub(super) fn dispatch_settle(&self, attempt_id: &str) -> Result<bool, String> {
        self.storage
            .with_store(|store| store.attempt_dispatch_settled(attempt_id))
            .ok_or_else(|| "el almacén no está abierto".to_string())?
            .map_err(|e| e.to_string())
    }

    /// Attempts aprobados que esperan despacho (cola de recuperación). Solo lista: reservar el claim es la única puerta.
    pub(super) fn approved_dispatch_candidates(&self, limit: usize) -> Result<Vec<String>, String> {
        self.storage
            .with_store(|store| store.runtime_on_tables().and_then(|active| if active { store.attempt_approved_dispatch_candidates(limit) } else { Ok(Vec::new()) }))
            .ok_or_else(|| "el almacén no está abierto".to_string())?
            .map_err(|e| e.to_string())
    }

    /// Primer paso de `init`: adquirir `core.lock` ANTES de leer o reescribir
    /// `state.json`, para que un segundo Core no llegue a tocarlo. Todo fallo aquí
    /// es bloqueante: sin el bloqueo no hay garantía de un único escritor.
    pub(super) fn acquire_instance_lock(&self, core_dir: &Path) -> Result<(), OpenStoreError> {
        self.storage.acquire_lock(core_dir)
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn storage_status(&self) -> StorageStatus {
        self.storage.status()
    }

    /// Fallback explícito para errores recuperables: el Core sigue con `state.json`.
    pub(super) fn degrade_storage(&self, e: &OpenStoreError) {
        eprintln!("[core] el almacén SQLite no está disponible; el Core sigue con state.json: {e}");
        self.storage.degrade(e.to_string());
    }
}
