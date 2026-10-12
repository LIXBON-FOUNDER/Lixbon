//! Puente entre el Core y el almacén SQLite (slice C1 de la Fase 1).
//!
//! Dirección de dependencias: `orch → store`. Aquí vive todo el contacto del
//! Core con el almacén, detrás de [`CoreStorage`] (un único campo de `Core`);
//! ningún otro módulo de `orch/` toca el `Store` directamente. C2 extenderá esta
//! pieza (el `commit()` transaccional entrará por [`CoreStorage::with_store`]).
//!
//! # Autoridad en C1
//! `state.json` sigue siendo la fuente operativa. SQLite guarda una instantánea
//! de arranque (`legacy_import_mode = bootstrap_snapshot`) que nadie actualiza.
//!
//! # Errores: bloqueantes y recuperables
//! [`OpenStoreError`] clasifica cada fallo y `init` decide con esa clasificación:
//!
//! * **Bloqueantes** (el Core NO arranca): `AlreadyLocked` (otro Core es el
//!   titular de `core.lock`), `SchemaTooNew`, `MigrationChecksumMismatch` y
//!   `MigrationsInconsistent` (la base y este binario no se entienden). Seguir
//!   escribiendo `state.json` en esos casos permitiría dos escritores o escribir
//!   con una versión desconocida.
//! * **Recuperables** (el Core arranca *degradado*, con `state.json` como hoy):
//!   disco lleno o permisos, base corrupta, fallos de E/S o de SQLite. El
//!   bloqueo de instancia se conserva aunque la base no se pueda usar, así que
//!   la exclusión mutua se mantiene. La excepción es `LockUnavailable` (ni
//!   siquiera se pudo crear `core.lock`): no se puede garantizar la exclusión,
//!   igual que antes de C1; queda registrado como degradado.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde_json::Value;

use super::Core;
use crate::store::{self, ImportOutcome, InstanceLock, SnapshotCheck, Store, StoreError};

/// Por qué no se pudo abrir el almacén, ya clasificado.
#[derive(Debug)]
pub(super) enum OpenStoreError {
    // --- Bloqueantes ---
    /// Otro Core es el titular de `core.lock`.
    AlreadyLocked { lock_path: PathBuf },
    /// La base es de una versión más nueva (o tiene migraciones que no conocemos).
    SchemaTooNew { detail: String },
    /// Una migración ya aplicada cambió de contenido.
    MigrationChecksumMismatch { detail: String },
    /// Migraciones fuera de orden o lista inválida.
    MigrationsInconsistent { detail: String },
    // --- Recuperables ---
    /// No se pudo crear o abrir `core.lock` (permisos, carpeta imposible…).
    LockUnavailable { detail: String },
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
                | OpenStoreError::SchemaTooNew { .. }
                | OpenStoreError::MigrationChecksumMismatch { .. }
                | OpenStoreError::MigrationsInconsistent { .. }
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
            | OpenStoreError::MigrationsInconsistent { detail } => f.write_str(detail),
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

/// Lo que dejó una apertura correcta.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct StorageReport {
    pub import: ImportOutcome,
    pub snapshot: SnapshotCheck,
    /// Solo si se acaba de importar: ¿la instantánea es el mismo estado que el
    /// Core adoptó tras `orphan_all()`? (`None` si no hubo importación.)
    pub matches_adopted: Option<bool>,
}

/// Estado del almacén dentro del Core.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum StorageStatus {
    /// Antes de `init`, o `init` aún no llegó a abrirlo.
    NotOpened,
    Ready(StorageReport),
    /// Falló de forma recuperable: el Core sigue con `state.json`.
    Degraded(String),
}

struct Slot {
    // Orden de campos = orden de Drop: la base se cierra antes de soltar el bloqueo.
    store: Option<Store>,
    lock: Option<InstanceLock>,
    status: StorageStatus,
}

/// Único punto de contacto del Core con el almacén.
pub(super) struct CoreStorage(Mutex<Slot>);

impl Default for CoreStorage {
    fn default() -> Self {
        CoreStorage(Mutex::new(Slot { store: None, lock: None, status: StorageStatus::NotOpened }))
    }
}

impl CoreStorage {
    fn slot(&self) -> MutexGuard<'_, Slot> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

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

    /// Abre la base bajo el bloqueo, aplica las migraciones, importa la
    /// instantánea de arranque y la verifica. `adopted` es el estado que el Core
    /// acaba de adoptar (para comprobar que la instantánea lo representa).
    pub(super) fn open(&self, core_dir: &Path, legacy_source: &Path, adopted: &Value) -> Result<StorageReport, OpenStoreError> {
        let mut guard = self.slot();
        let Slot { store: store_slot, lock: lock_slot, status } = &mut *guard;
        if store_slot.is_some() {
            return Err(OpenStoreError::AlreadyOpened);
        }
        if lock_slot.is_none() {
            *lock_slot = Some(acquire(core_dir)?);
        }
        let lock = lock_slot.as_ref().expect("bloqueo adquirido arriba");
        let mut store = Store::open_under_lock(core_dir, lock, &store::embedded(), env!("CARGO_PKG_VERSION"))?;
        let import = store::bootstrap_legacy_snapshot(&mut store, legacy_source)?;
        let snapshot = store::verify_snapshot(&store)?;
        let matches_adopted = match import {
            ImportOutcome::Imported { .. } => {
                let doc = store.legacy_state()?.map(|s| s.doc).unwrap_or_default();
                Some(serde_json::from_str::<Value>(&doc).map(|v| &v == adopted).unwrap_or(false))
            }
            _ => None,
        };
        let report = StorageReport { import, snapshot, matches_adopted };
        *store_slot = Some(store);
        *status = StorageStatus::Ready(report.clone());
        Ok(report)
    }

    /// Marca el almacén como degradado (decisión explícita de `init`).
    pub(super) fn degrade(&self, reason: String) {
        self.slot().status = StorageStatus::Degraded(reason);
    }

    /// Acceso al `Store` abierto. Es el punto por el que entrará `commit()` en C2;
    /// en C1 solo lo usan las pruebas.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(super) fn with_store<R>(&self, f: impl FnOnce(&mut Store) -> R) -> Option<R> {
        self.slot().store.as_mut().map(f)
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
    /// `state.json`, para que un segundo Core no llegue a tocarlo.
    pub(super) fn acquire_instance_lock(&self, core_dir: &Path) -> Result<(), OpenStoreError> {
        self.storage.acquire_lock(core_dir)
    }

    /// Abre el almacén e importa la instantánea de arranque desde `legacy_source`.
    /// Devuelve errores tipados; la decisión de continuar o no es de quien llama.
    pub(super) fn open_store(&self, core_dir: &Path, legacy_source: &Path) -> Result<StorageReport, OpenStoreError> {
        let adopted = serde_json::to_value(&*self.lock()).unwrap_or(Value::Null);
        self.storage.open(core_dir, legacy_source, &adopted)
    }

    pub(super) fn storage_status(&self) -> StorageStatus {
        self.storage.status()
    }

    /// Fallback explícito para errores recuperables: el Core sigue con `state.json`.
    pub(super) fn degrade_storage(&self, e: &OpenStoreError) {
        eprintln!("[core] el almacén SQLite no está disponible; el Core sigue con state.json: {e}");
        self.storage.degrade(e.to_string());
    }
}
