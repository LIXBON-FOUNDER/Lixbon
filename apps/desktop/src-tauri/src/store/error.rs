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
    /// Se intentó una escritura autoritativa, o una migración posterior a la valla, en una base
    /// que no es autoritativa (o cuyo registro de autoridad no es válido).
    NotAuthoritative,
    /// La promoción a autoritativa no puede aplicarse tal como se planeó.
    PromotionConflict(String),
    /// Se intentó promocionar una base que no cruzó la valla de compatibilidad (migración 002).
    NotFenced,
    /// Una revisión persistida está fuera de rango (negativa, o `i64::MAX`: no se puede avanzar).
    RevOutOfRange { rev: i64 },
    /// El registro de proyectos no puede aplicar la operación (ruta ya de otro proyecto, proyecto inexistente).
    ProjectConflict(String),
    /// Un evento del Event Log no cumple el contrato (campos vacíos, payload que no es un objeto JSON
    /// o pasa de 8 KiB, cursor negativo…). Se rechaza ANTES de tocar la base.
    InvalidEvent(String),
    /// Una Attention no cumple el contrato (destino que parece una ruta, `facts` que no es un objeto JSON
    /// acotado, resolución anterior a la creación…). Se rechaza ANTES de tocar la base.
    InvalidAttention(String),
    /// Las tablas del modelo Task/Attempt existen pero siguen inertes: el corte (`meta.agentic_model`) aún no
    /// se ha hecho y la autoridad de las tareas es `legacy_state`. No se escribió nada.
    AgenticModelInactive,
    /// Una Task no admite la operación (padre descartado o inexistente, Run cerrado, hijas abiertas, raíz…).
    TaskConflict(String),
    /// Una Task no cumple el contrato (título vacío, cambio vacío…). Se rechaza ANTES de tocar la base.
    InvalidTask(String),
    /// Un Attempt no admite la operación (Task inexistente, descartada o de un Run cerrado; ya hay uno activo…).
    /// No se escribió nada.
    AttemptConflict(String),
    /// Un Attempt no cumple el contrato (proveedor vacío, resumen demasiado largo, motivo que no es un código…).
    /// Se rechaza ANTES de tocar la base.
    InvalidAttempt(String),
    /// La transición pedida no está en la tabla cerrada del ciclo de vida del Attempt. No se escribió nada.
    AttemptTransition { id: String, from: String, to: String },
    /// Una ProviderSession o un Thread no admite la operación (Attempt de otra Task o ya terminado, sesión cerrada o
    /// no resumible, referencia del proveedor ya fijada…). No se escribió nada.
    SessionConflict(String),
    /// Una ProviderSession o un Thread no cumple el contrato (referencia que no es opaca, resumen con un secreto…).
    /// Se rechaza ANTES de tocar la base.
    InvalidSession(String),
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
            StoreError::NotAuthoritative => f.write_str("la base de datos no es autoritativa todavía (o su registro de autoridad no es válido); no se puede escribir el estado ni aplicar migraciones posteriores a la valla"),
            StoreError::PromotionConflict(m) => write!(f, "la promoción a autoritativa no se puede aplicar: {m}"),
            StoreError::NotFenced => f.write_str(
                "la base de datos no ha cruzado la valla de compatibilidad (migración 002); no se puede promocionar a autoritativa sin ella",
            ),
            StoreError::RevOutOfRange { rev } => write!(f, "la revisión {rev} está fuera de rango y no se puede avanzar; los datos de autoridad no se dan por buenos"),
            StoreError::ProjectConflict(m) => write!(f, "registro de proyectos: {m}"),
            StoreError::InvalidEvent(m) => write!(f, "evento inválido: {m}"),
            StoreError::InvalidAttention(m) => write!(f, "attention inválida: {m}"),
            StoreError::AgenticModelInactive => f.write_str(
                "el modelo Task/Attempt todavía no está activo (falta el corte): las tareas siguen en el estado legacy y no se escribió nada",
            ),
            StoreError::TaskConflict(m) => write!(f, "tasks: {m}"),
            StoreError::InvalidTask(m) => write!(f, "task inválida: {m}"),
            StoreError::AttemptConflict(m) => write!(f, "attempts: {m}"),
            StoreError::InvalidAttempt(m) => write!(f, "attempt inválido: {m}"),
            StoreError::AttemptTransition { id, from, to } => write!(f, "attempts: el Attempt {id} no puede pasar de {from} a {to}"),
            StoreError::SessionConflict(m) => write!(f, "sesiones y threads: {m}"),
            StoreError::InvalidSession(m) => write!(f, "sesión o thread inválido: {m}"),
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
