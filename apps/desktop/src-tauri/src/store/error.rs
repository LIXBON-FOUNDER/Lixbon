//! Errores del almacén. Mensajes en español y accionables: el Core los
//! devolverá tal cual (`to_string()`) a quien llame.

use std::fmt;
use std::path::PathBuf;

#[derive(Debug)]
pub enum StoreError {
    /// Otro proceso (o este mismo) ya tiene el bloqueo de instancia.
    AlreadyRunning { lock_path: PathBuf },
    /// La base declara migraciones que este binario no conoce: es de una
    /// versión más nueva. Se rechaza SIN tocar nada.
    DatabaseNewer { db_version: i64, binary_version: i64 },
    /// Una migración aplicada no existe en este binario (hueco o rama distinta).
    UnknownMigration { version: i64, name: String },
    /// El texto de una migración ya aplicada cambió desde que se aplicó.
    ChecksumMismatch { version: i64, name: String },
    /// Hay una migración pendiente con un número menor que otra ya aplicada.
    OutOfOrderMigration { pending: i64, applied: i64 },
    /// La lista de migraciones del binario es inválida (duplicados, desorden…).
    InvalidMigrationList(String),
    /// Falló una migración concreta (se deshizo toda la tanda).
    MigrationFailed { version: i64, name: String, detail: String },
    /// Conflicto de concurrencia optimista sobre `legacy_state`.
    /// `actual = None` significa que la fila no existe.
    RevConflict { expected: i64, actual: Option<i64> },
    /// La base está corrupta, truncada o no es una base SQLite.
    Corrupt { path: PathBuf, detail: String },
    /// No se pudo activar el modo WAL (p. ej. carpeta de red).
    WalUnavailable { got: String },
    /// Documento rechazado por el almacén (p. ej. JSON inválido).
    InvalidDocument(String),
    /// Falló una copia de seguridad.
    Backup(String),
    /// El bloqueo entregado no es el de la carpeta que se quiere abrir.
    WrongLock { expected: PathBuf, got: PathBuf },
    /// Error de entrada/salida con contexto.
    Io { context: String, source: std::io::Error },
    /// Error de SQLite.
    Sqlite(rusqlite::Error),
    /// Se intentó una escritura autoritativa en una base que no lo es.
    NotAuthoritative,
    /// La promoción a autoritativa no puede aplicarse tal como se planeó.
    PromotionConflict(String),
    /// Se intentó promocionar una base que no cruzó la valla de compatibilidad (migración 002).
    NotFenced,
    /// Una revisión persistida está fuera de rango (negativa, o `i64::MAX`: no se puede avanzar).
    RevOutOfRange { rev: i64 },
}

impl StoreError {
    pub(crate) fn io(context: impl Into<String>, source: std::io::Error) -> Self {
        StoreError::Io { context: context.into(), source }
    }

    /// ¿Parece un fallo pasajero (vale reintentar con una espera corta)? Es la ÚNICA
    /// clasificación: la política de reintentos (`RetryPolicy`) no mira otra cosa.
    ///
    /// Transitorios: SQLite ocupada/bloqueada de forma inesperada y E/S temporal
    /// (interrupción, contención de archivo, antivirus; en Windows 5, 32 y 33).
    /// Estructurales (nunca se reintentan): esquema más nuevo, checksum, orden de
    /// migraciones, base corrupta, conflicto de `rev`, documento inválido,
    /// bloqueo equivocado, base no autoritativa, promoción imposible, base sin la
    /// valla y revisión fuera de rango.
    pub fn is_transient(&self) -> bool {
        use std::io::ErrorKind::*;
        match self {
            StoreError::Sqlite(_) => self.is_busy(),
            StoreError::Io { source, .. } => {
                matches!(source.kind(), Interrupted | WouldBlock | TimedOut | PermissionDenied)
                    || matches!(source.raw_os_error(), Some(5) | Some(32) | Some(33))
            }
            _ => false,
        }
    }

    /// `true` si SQLite informó de que la base está ocupada (otro escritor).
    pub fn is_busy(&self) -> bool {
        matches!(
            self,
            StoreError::Sqlite(rusqlite::Error::SqliteFailure(e, _))
                if matches!(e.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
        )
    }
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::AlreadyRunning { lock_path } => write!(
                f,
                "otra instancia de Lixbon ya está usando el almacén (bloqueo en {}); ciérrala antes de abrir otra",
                lock_path.display()
            ),
            StoreError::DatabaseNewer { db_version, binary_version } => write!(
                f,
                "la base de datos es de una versión más nueva de Lixbon (esquema {db_version}; este programa conoce hasta {binary_version}); actualiza Lixbon, no se ha modificado nada"
            ),
            StoreError::UnknownMigration { version, name } => write!(
                f,
                "la base tiene aplicada la migración {version:03}_{name}, que este programa no conoce; no se ha modificado nada"
            ),
            StoreError::ChecksumMismatch { version, name } => write!(
                f,
                "la migración {version:03}_{name} ya estaba aplicada pero su contenido ha cambiado; una migración publicada no se edita (cree una nueva)"
            ),
            StoreError::OutOfOrderMigration { pending, applied } => write!(
                f,
                "la migración pendiente {pending:03} es anterior a la ya aplicada {applied:03}; las migraciones solo avanzan, renumérala"
            ),
            StoreError::InvalidMigrationList(m) => write!(f, "lista de migraciones inválida: {m}"),
            StoreError::MigrationFailed { version, name, detail } => write!(
                f,
                "falló la migración {version:03}_{name}: {detail} (se deshizo toda la tanda; la base queda como estaba)"
            ),
            StoreError::RevConflict { expected, actual } => match actual {
                Some(a) => write!(
                    f,
                    "conflicto de revisión: se esperaba rev {expected} pero la base está en rev {a}; recarga el estado y reintenta"
                ),
                None => write!(f, "conflicto de revisión: se esperaba rev {expected} pero no hay estado guardado"),
            },
            StoreError::Corrupt { path, detail } => {
                write!(f, "la base de datos {} está dañada: {detail}", path.display())
            }
            StoreError::WalUnavailable { got } => write!(
                f,
                "no se pudo activar el modo WAL (SQLite devolvió «{got}»); ¿la carpeta es de red o está sincronizada?"
            ),
            StoreError::InvalidDocument(m) => write!(f, "documento inválido: {m}"),
            StoreError::Backup(m) => write!(f, "falló la copia de seguridad: {m}"),
            StoreError::WrongLock { expected, got } => write!(
                f,
                "el bloqueo {} no corresponde a la carpeta del almacén (se esperaba {})",
                got.display(),
                expected.display()
            ),
            StoreError::Io { context, source } => write!(f, "{context}: {source}"),
            StoreError::Sqlite(e) => write!(f, "error de SQLite: {e}"),
            StoreError::NotAuthoritative => f.write_str("la base de datos no es autoritativa todavía; no se puede escribir el estado en ella"),
            StoreError::PromotionConflict(m) => write!(f, "la promoción a autoritativa no se puede aplicar: {m}"),
            StoreError::NotFenced => f.write_str(
                "la base de datos no ha cruzado la valla de compatibilidad (migración 002); no se puede promocionar a autoritativa sin ella",
            ),
            StoreError::RevOutOfRange { rev } => write!(f, "la revisión {rev} está fuera de rango y no se puede avanzar; los datos de autoridad no se dan por buenos"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StoreError::Io { source, .. } => Some(source),
            StoreError::Sqlite(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

pub type StoreResult<T> = Result<T, StoreError>;
