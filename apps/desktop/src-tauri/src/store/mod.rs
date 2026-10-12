//! Almacén SQLite del Core (slice B de la Fase 1).
//!
//! Base del Core: **un único escritor** (el proceso Core), garantizado por el
//! bloqueo de instancia ([`lock`]). Una conexión, WAL, `synchronous=FULL`,
//! `foreign_keys=ON`, `busy_timeout=5000`. Las escrituras van siempre en
//! `BEGIN IMMEDIATE` ([`Store::write`]): el bloqueo de escritura se toma de
//! entrada y no hay upgrades de lectura a escritura que fallen a mitad.
//!
//! Estado actual (C1): el Core SIGUE usando `state.json` como fuente operativa.
//! El almacén existe, aplica su esquema inicial (migración 001) y guarda en
//! `legacy_state` una instantánea inicial del `State` (un único documento JSON
//! con `rev`), importada por [`legacy`] con `legacy_import_mode =
//! bootstrap_snapshot`. Nadie la actualiza todavía: C2 cambiará la autoridad.
//! No se normaliza Task/Attempt/Thread.
//!
//! Distribución de la carpeta del almacén (`dir`):
//! ```text
//! dir/core.lock       bloqueo de instancia
//! dir/lixbon.db       la base (+ -wal / -shm mientras está abierta)
//! dir/backups/        copias VACUUM INTO (antes de migrar, o a petición)
//! ```
//! El Core usa `~/.lixbon/core` como `dir`. `lixbon.db`, `-wal`, `-shm` y `backups/` quedan accesibles solo por el
//! propietario ([`private`]); `dir` no se modifica porque lo comparte el Core.
//!
//! # Referencias blandas de `events`
//! `events.project_id`, `client_id`, `entity_kind` y `entity_id` (migración
//! 003, slice E) NO llevan clave foránea de SQLite: los eventos históricos
//! deben sobrevivir al archivado de un Project o a revocar un Client. El
//! dominio valida al emitir (el Project/Client existe si el evento lo
//! referencia); la base no lo impone. El resto de relaciones del esquema SÍ
//! son FK reales. Detalle en `migrations/001_core.sql`.

mod backup;
mod error;
mod legacy;
mod lock;
mod migrate;
mod private;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior};

pub use backup::backup_to;
pub use error::{StoreError, StoreResult};
pub use legacy::{bootstrap_legacy_snapshot, verify_snapshot, ImportOutcome, SnapshotCheck};
pub use lock::InstanceLock;
pub use migrate::{embedded, migrate, Migration, MigrationReport};
use migrate::now_ms;

const LOCK_FILE: &str = "core.lock";
const DB_FILE: &str = "lixbon.db";
const BACKUP_DIR: &str = "backups";
const BUSY_TIMEOUT_MS: u64 = 5000;

/// El `State` legado como documento: revisión + JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyState {
    pub rev: i64,
    pub doc_schema: i64,
    pub doc: String,
}

/// Almacén abierto: conexión única + bloqueo de instancia.
#[derive(Debug)]
pub struct Store {
    // Orden de campos = orden de Drop: la conexión se cierra ANTES de soltar
    // el bloqueo, así nadie entra mientras SQLite aún tiene la base abierta.
    conn: Connection,
    db_path: PathBuf,
    backup_dir: PathBuf,
    report: MigrationReport,
    // `None` cuando quien abre ya tenía el bloqueo (ver `open_under_lock`).
    _lock: Option<InstanceLock>,
}

/// Ruta del bloqueo de instancia dentro de la carpeta del almacén.
pub fn lock_path(dir: &Path) -> PathBuf {
    dir.join(LOCK_FILE)
}

impl Store {
    /// Abre (o crea) el almacén en `dir` con las migraciones embebidas.
    pub fn open(dir: &Path, app_version: &str) -> StoreResult<Store> {
        Store::open_with(dir, &embedded(), app_version)
    }

    /// Como [`Store::open`] con una lista de migraciones explícita (pruebas).
    pub fn open_with(dir: &Path, migrations: &[Migration], app_version: &str) -> StoreResult<Store> {
        let lock = InstanceLock::acquire(&lock_path(dir))?;
        Store::open_inner(dir, Some(lock), migrations, app_version)
    }

    /// Abre el almacén con el bloqueo de instancia ya adquirido por quien llama.
    /// Quien llama conserva el bloqueo aunque esta apertura falle: así un Core
    /// que no puede usar la base (corrupta, disco lleno…) sigue siendo el único
    /// titular de la carpeta. `lock` debe ser el de `dir`.
    pub fn open_under_lock(dir: &Path, lock: &InstanceLock, migrations: &[Migration], app_version: &str) -> StoreResult<Store> {
        if lock.path() != lock_path(dir) {
            return Err(StoreError::WrongLock { expected: lock_path(dir), got: lock.path().to_path_buf() });
        }
        Store::open_inner(dir, None, migrations, app_version)
    }

    fn open_inner(dir: &Path, lock: Option<InstanceLock>, migrations: &[Migration], app_version: &str) -> StoreResult<Store> {
        let db_path = dir.join(DB_FILE);
        let backup_dir = dir.join(BACKUP_DIR);
        // Permisos de propietario (ver `private`): la base y las copias llevan el
        // estado completo del Core. `backups/` se crea privada con la primera copia.
        private::create_private_file(&db_path);
        let mut conn = open_connection(&db_path)?;
        let report = migrate(&mut conn, migrations, app_version, &backup_dir)?;
        // `-wal` y `-shm` los crea SQLite con el primer acceso real (la migración):
        // se restringen ya existentes y siguen vivos mientras la conexión esté abierta.
        for ext in ["-wal", "-shm"] {
            let side = dir.join(format!("{DB_FILE}{ext}"));
            if side.exists() {
                private::restrict_file(&side);
            }
        }
        Ok(Store { conn, db_path, backup_dir, report, _lock: lock })
    }

    /// Valor de una clave de `meta`, si existe.
    pub fn meta(&self, key: &str) -> StoreResult<Option<String>> {
        Ok(self
            .conn
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub fn backup_dir(&self) -> &Path {
        &self.backup_dir
    }

    /// Qué hizo la migración al abrir.
    pub fn migration_report(&self) -> &MigrationReport {
        &self.report
    }

    /// Lectura. Solo para consultas: las escrituras pasan por [`Store::write`].
    pub fn read<T>(&self, f: impl FnOnce(&Connection) -> StoreResult<T>) -> StoreResult<T> {
        f(&self.conn)
    }

    /// Escritura atómica: `BEGIN IMMEDIATE`, `COMMIT` si `f` devuelve `Ok`,
    /// `ROLLBACK` si devuelve `Err` (o hace panic).
    pub fn write<T>(&mut self, f: impl FnOnce(&Transaction<'_>) -> StoreResult<T>) -> StoreResult<T> {
        let tx = self.conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }

    /// Copia de seguridad consistente (`VACUUM INTO`) en `backups/`.
    pub fn backup(&self, label: &str) -> StoreResult<PathBuf> {
        backup_to(&self.conn, &self.backup_dir, label)
    }

    /// `PRAGMA integrity_check`; `Ok(())` si la base está sana.
    pub fn integrity_check(&self) -> StoreResult<()> {
        let res: String = self.conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if res == "ok" {
            Ok(())
        } else {
            Err(StoreError::Corrupt { path: self.db_path.clone(), detail: res })
        }
    }

    /// El `State` legado guardado, si hay.
    pub fn legacy_state(&self) -> StoreResult<Option<LegacyState>> {
        Ok(self
            .conn
            .query_row("SELECT rev, doc_schema, doc FROM legacy_state WHERE id = 1", [], |r| {
                Ok(LegacyState { rev: r.get(0)?, doc_schema: r.get(1)?, doc: r.get(2)? })
            })
            .optional()?)
    }

    /// Guarda el `State` legado con concurrencia optimista y devuelve la nueva
    /// `rev`. `expected_rev = 0` significa "aún no hay fila" (la crea con rev 1);
    /// otro valor exige que la fila esté exactamente en esa revisión.
    /// `doc` debe ser JSON válido (lo exige la propia tabla).
    pub fn save_legacy_state(&mut self, expected_rev: i64, doc: &str) -> StoreResult<i64> {
        self.write(|tx| {
            let now = now_ms();
            if expected_rev == 0 {
                match tx.execute(
                    "INSERT INTO legacy_state (id, rev, doc_schema, doc, updated_at) VALUES (1, 1, 0, ?1, ?2)",
                    rusqlite::params![doc, now],
                ) {
                    Ok(_) => Ok(1),
                    Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
                        // ¿Choque de clave (ya hay fila) o JSON inválido?
                        match current_rev(tx)? {
                            Some(actual) => Err(StoreError::RevConflict { expected: 0, actual: Some(actual) }),
                            None => Err(StoreError::InvalidDocument("el estado legado no es JSON válido".into())),
                        }
                    }
                    Err(e) => Err(e.into()),
                }
            } else {
                let changed = match tx.execute(
                    "UPDATE legacy_state SET rev = rev + 1, doc = ?1, updated_at = ?2 WHERE id = 1 AND rev = ?3",
                    rusqlite::params![doc, now, expected_rev],
                ) {
                    Ok(n) => n,
                    Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
                        return Err(StoreError::InvalidDocument("el estado legado no es JSON válido".into()));
                    }
                    Err(e) => return Err(e.into()),
                };
                if changed == 1 {
                    Ok(expected_rev + 1)
                } else {
                    Err(StoreError::RevConflict { expected: expected_rev, actual: current_rev(tx)? })
                }
            }
        })
    }
}

fn current_rev(conn: &Connection) -> StoreResult<Option<i64>> {
    Ok(conn.query_row("SELECT rev FROM legacy_state WHERE id = 1", [], |r| r.get(0)).optional()?)
}

/// Abre la conexión del Core y fija los PRAGMA del diseño.
fn open_connection(path: &Path) -> StoreResult<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags).map_err(|e| classify(path, e))?;
    conn.busy_timeout(std::time::Duration::from_millis(BUSY_TIMEOUT_MS))?;
    // El primer acceso real a la base: aquí aflora «file is not a database».
    let mode: String = conn
        .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
        .map_err(|e| classify(path, e))?;
    if !mode.eq_ignore_ascii_case("wal") {
        return Err(StoreError::WalUnavailable { got: mode });
    }
    conn.pragma_update(None, "synchronous", "FULL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

/// Distingue «base dañada / no es una base» del resto de errores de SQLite.
fn classify(path: &Path, e: rusqlite::Error) -> StoreError {
    if let rusqlite::Error::SqliteFailure(f, _) = &e {
        if matches!(f.code, rusqlite::ErrorCode::NotADatabase | rusqlite::ErrorCode::DatabaseCorrupt) {
            return StoreError::Corrupt { path: path.to_path_buf(), detail: e.to_string() };
        }
    }
    StoreError::Sqlite(e)
}
