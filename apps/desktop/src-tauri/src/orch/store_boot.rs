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
//! aplicar) → decidir con `decide_boot` → actuar. Un Core que no puede arrancar por
//! el lock, por incompatibilidad del almacén o por el protocolo de autoridad no
//! modifica `state.json`.
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

use super::mirror;
use super::mutation::{PersistError, Persistence};
use super::state::State;
use super::Core;
use crate::store::{self, InstanceLock, Store, StoreError};

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
}

/// Único punto de contacto del Core con el almacén.
pub(super) struct CoreStorage(Arc<Mutex<Slot>>);

impl Default for CoreStorage {
    fn default() -> Self {
        CoreStorage(Arc::new(Mutex::new(Slot { store: None, lock: None, status: StorageStatus::NotOpened })))
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
        let Slot { store: store_slot, lock: lock_slot, .. } = &mut *guard;
        if store_slot.is_some() {
            return Err(OpenStoreError::AlreadyOpened);
        }
        if lock_slot.is_none() {
            *lock_slot = Some(acquire(core_dir)?);
        }
        let lock = lock_slot.as_ref().expect("bloqueo adquirido arriba");
        *store_slot = Some(Store::open_boot_under_lock(core_dir, lock, &store::embedded(), env!("CARGO_PKG_VERSION"))?);
        Ok(())
    }

    /// Marca el almacén como degradado (decisión explícita de `init`): suelta la
    /// base pero CONSERVA `core.lock`, así que la exclusión mutua se mantiene.
    pub(super) fn degrade(&self, reason: String) {
        let mut slot = self.slot();
        slot.store = None;
        slot.status = StorageStatus::Degraded(reason);
    }

    /// Fija el estado `Ready` tras un arranque autoritativo.
    pub(super) fn set_ready(&self, report: StorageReport) {
        self.slot().status = StorageStatus::Ready(report);
    }

    /// Acceso al `Store` abierto. Solo lo usan el arranque (`boot_authority`) y las
    /// pruebas; las escrituras de estado entran por [`SqlitePersistence`].
    pub(super) fn with_store<R>(&self, f: impl FnOnce(&mut Store) -> R) -> Option<R> {
        self.slot().store.as_mut().map(f)
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
    fn persist(&self, state: &State) -> Result<(), PersistError> {
        let doc = serde_json::to_string(state).map_err(|e| PersistError::structural(format!("no se pudo serializar el estado: {e}")))?;
        let mut committed = self.committed.lock().unwrap_or_else(|e| e.into_inner());
        let mut slot = self.slot.lock().unwrap_or_else(|e| e.into_inner());
        let Some(store) = slot.store.as_mut() else {
            return Err(PersistError::structural("el almacén SQLite no está abierto"));
        };
        match store.commit_authoritative(committed.rev, &doc) {
            Ok(rev) => {
                committed.rev = rev;
                committed.pending_mirror = Some((rev, doc));
                Ok(())
            }
            // La ÚNICA clasificación de transitorios vive en el almacén.
            Err(e) => Err(PersistError { transient: e.is_transient(), message: e.to_string() }),
        }
    }

    fn after_publish(&self, _state: &State) -> Result<(), String> {
        let pending = self.committed.lock().unwrap_or_else(|e| e.into_inner()).pending_mirror.take();
        let Some((rev, doc)) = pending else { return Ok(()) };
        store::crash_point("mutate_after_commit");
        mirror::write_mirror(&self.data_dir, &doc, rev).map_err(|e| e.to_string())
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
