//! Framework de migraciones: numeradas, embebidas, solo hacia adelante.
//!
//! * La lista sale de `src/store/migrations/NNN_nombre.sql`, generada por
//!   `build.rs` en compilación: añadir la 002, 003… es soltar un archivo, sin
//!   tocar este módulo ni una lista común (slices en paralelo no chocan).
//! * Cada migración lleva checksum SHA-256 (sobre el texto sin `\r`, para que
//!   `core.autocrlf` no cambie el hash). Se guarda en `schema_migrations`.
//! * Toda la tanda pendiente se aplica en UNA transacción `BEGIN IMMEDIATE`:
//!   o se aplican todas o ninguna, y reabrir después es idempotente.
//! * Antes de migrar una base que ya tenía datos se hace copia con
//!   `VACUUM INTO` (nunca copia de archivos).
//! * Una base con migraciones que este binario no conoce (o con
//!   `user_version` mayor) se rechaza sin tocarla.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, TransactionBehavior};
use sha2::{Digest, Sha256};

use super::backup;
use super::error::{StoreError, StoreResult};

// Define `EMBEDDED_MIGRATIONS: &[(i64, &str, &str)]` = (versión, nombre, SQL).
include!(concat!(env!("OUT_DIR"), "/store_migrations.rs"));

/// Una migración: número, nombre y texto SQL.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub sql: &'static str,
}

impl Migration {
    pub const fn new(version: i64, name: &'static str, sql: &'static str) -> Self {
        Migration { version, name, sql }
    }

    /// SHA-256 hexadecimal del texto sin `\r`.
    pub fn checksum(&self) -> String {
        let normalized: String = self.sql.chars().filter(|c| *c != '\r').collect();
        format!("{:x}", Sha256::digest(normalized.as_bytes()))
    }
}

/// Las migraciones embebidas en este binario, ordenadas por versión.
pub fn embedded() -> Vec<Migration> {
    EMBEDDED_MIGRATIONS.iter().map(|(v, n, s)| Migration::new(*v, n, s)).collect()
}

/// Resultado de una llamada a [`migrate`].
#[derive(Debug, Clone, Default)]
pub struct MigrationReport {
    /// Versión máxima aplicada antes (0 = base nueva).
    pub from_version: i64,
    /// Versión máxima aplicada después.
    pub to_version: i64,
    /// Versiones aplicadas en esta llamada (vacío = ya estaba al día).
    pub applied: Vec<i64>,
    /// Copia previa a la migración, si se hizo.
    pub backup: Option<PathBuf>,
}

fn validate_list(migrations: &[Migration]) -> StoreResult<()> {
    let mut prev = 0;
    for m in migrations {
        if m.version <= 0 {
            return Err(StoreError::InvalidMigrationList(format!("la versión de {} debe ser > 0", m.name)));
        }
        if m.version <= prev {
            return Err(StoreError::InvalidMigrationList(format!(
                "las versiones deben ser únicas y crecientes (tras {prev:03} viene {:03}_{})",
                m.version, m.name
            )));
        }
        prev = m.version;
    }
    Ok(())
}

fn table_exists(conn: &Connection, name: &str) -> StoreResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn has_user_tables(conn: &Connection) -> StoreResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        [],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Filas de `schema_migrations` (vacío si la tabla aún no existe).
/// Las filas de `schema_migrations` sin la del corte (versión reservada): la numeración publicada.
fn published(rows: &[(i64, String, String)]) -> impl Iterator<Item = &(i64, String, String)> {
    rows.iter().filter(|r| r.0 != super::cut::CUT_VERSION)
}

/// Una base cortada con la numeración anterior a LXO-234 (el corte como «última + 1»): se rechaza sin escribir.
fn reject_legacy_cut(rows: &[(i64, String, String)]) -> StoreResult<()> {
    match rows.iter().find(|r| r.1 == super::cut::CUT_NAME && r.0 != super::cut::CUT_VERSION) {
        Some(r) => Err(StoreError::CutLegacyNumbering { version: r.0 }),
        None => Ok(()),
    }
}

/// Antes de abrir la base para escribir (y antes de que pase a `journal_mode = WAL`): una base cortada con la
/// numeración vieja se rechaza leyéndola en SOLO LECTURA, así el archivo queda idéntico byte a byte. Cualquier otro
/// problema al leer aquí se deja para la apertura normal, que lo clasifica.
pub(super) fn reject_legacy_cut_readonly(db: &Path) -> StoreResult<()> {
    if !db.exists() {
        return Ok(());
    }
    let Ok(conn) = Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX) else { return Ok(()) };
    match applied_rows(&conn) {
        Ok(rows) => reject_legacy_cut(&rows),
        Err(_) => Ok(()),
    }
}

fn applied_rows(conn: &Connection) -> StoreResult<Vec<(i64, String, String)>> {
    if !table_exists(conn, "schema_migrations")? {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

struct Plan {
    applied_max: i64,
    /// Índices (en la lista del binario) de las migraciones pendientes.
    pending: Vec<usize>,
    /// ¿La base ya contenía algo que merezca copia previa?
    has_data: bool,
}

/// Compara la base con la lista del binario. No escribe nada.
///
/// La lista COMPLETA sirve para validar (checksums, migraciones desconocidas, base más nueva);
/// `ceiling` solo limita cuáles se APLICAN: las pendientes con versión mayor se dejan sin tocar.
fn plan(conn: &Connection, migrations: &[Migration], ceiling: i64) -> StoreResult<Plan> {
    // La versión de esquema es la de las migraciones publicadas: la fila reservada del corte no cuenta.
    let binary_max = migrations.iter().filter(|m| m.version != super::cut::CUT_VERSION).map(|m| m.version).max().unwrap_or(0);
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let rows = applied_rows(conn)?;
    reject_legacy_cut(&rows)?;
    let applied_max = published(&rows).last().map(|r| r.0).unwrap_or(0);

    let db_version = applied_max.max(user_version);
    if db_version > binary_max {
        return Err(StoreError::DatabaseNewer { db_version, binary_version: binary_max });
    }
    for (version, name, checksum) in &rows {
        match migrations.iter().find(|m| m.version == *version) {
            None => return Err(StoreError::UnknownMigration { version: *version, name: name.clone() }),
            Some(m) => {
                if m.name != name || m.checksum() != *checksum {
                    return Err(StoreError::ChecksumMismatch { version: *version, name: name.clone() });
                }
            }
        }
    }
    let mut pending = vec![];
    for (i, m) in migrations.iter().enumerate() {
        if rows.iter().any(|r| r.0 == m.version) {
            continue;
        }
        if m.version < applied_max {
            return Err(StoreError::OutOfOrderMigration { pending: m.version, applied: applied_max });
        }
        if m.version > ceiling {
            continue;
        }
        pending.push(i);
    }
    let has_data = !rows.is_empty() || has_user_tables(conn)?;
    Ok(Plan { applied_max, pending, has_data })
}

/// Versión del esquema de la base: la mayor entre las migraciones aplicadas y
/// `PRAGMA user_version`. Es la misma cuenta que usa `plan` para rechazar una base
/// más nueva que el binario.
pub(super) fn db_version(conn: &Connection) -> StoreResult<i64> {
    let user_version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    let rows = applied_rows(conn)?;
    reject_legacy_cut(&rows)?;
    let applied_max = published(&rows).last().map(|r| r.0).unwrap_or(0);
    Ok(applied_max.max(user_version))
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lleva la base al esquema de `migrations`. Idempotente.
///
/// `backup_dir`: carpeta donde dejar la copia previa si la base ya tenía datos
/// y hay algo que migrar.
pub fn migrate(
    conn: &mut Connection,
    migrations: &[Migration],
    app_version: &str,
    backup_dir: &Path,
) -> StoreResult<MigrationReport> {
    migrate_capped(conn, migrations, i64::MAX, app_version, backup_dir)
}

/// Como [`migrate`], pero solo APLICA las migraciones de versión <= `ceiling`. La lista completa
/// se valida igual: una base más nueva que el binario, o con una migración que no conoce, se
/// rechaza aunque el techo no la fuera a tocar. Es lo que permite abrir una base que ya tiene la
/// 003 sin aplicarle nada más allá de lo que el protocolo de autoridad ha autorizado.
pub fn migrate_capped(
    conn: &mut Connection,
    migrations: &[Migration],
    ceiling: i64,
    app_version: &str,
    backup_dir: &Path,
) -> StoreResult<MigrationReport> {
    validate_list(migrations)?;
    let first = plan(conn, migrations, ceiling)?;
    let mut report = MigrationReport { from_version: first.applied_max, to_version: first.applied_max, ..Default::default() };
    if first.pending.is_empty() {
        return Ok(report);
    }

    // Copia previa (solo si hay algo que proteger), ANTES de abrir la transacción.
    if first.has_data {
        report.backup = Some(backup::backup_to(conn, backup_dir, &format!("pre-migracion-v{}", first.applied_max))?);
    }

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    // Se vuelve a planificar ya con el bloqueo de escritura: si otro proceso
    // migró entre medias, esto es la fuente de verdad.
    let plan = plan(&tx, migrations, ceiling)?;
    report.from_version = plan.applied_max;
    report.to_version = plan.applied_max;
    for &i in &plan.pending {
        let m = &migrations[i];
        let fail = |detail: String| StoreError::MigrationFailed { version: m.version, name: m.name.to_string(), detail };
        tx.execute_batch(m.sql).map_err(|e| fail(e.to_string()))?;
        if tx.is_autocommit() {
            return Err(fail("el SQL cerró la transacción (BEGIN/COMMIT/ROLLBACK no están permitidos en una migración)".into()));
        }
        tx.execute(
            "INSERT INTO schema_migrations (version, name, checksum, app_version, applied_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![m.version, m.name, m.checksum(), app_version, now_ms()],
        )
        .map_err(|e| fail(e.to_string()))?;
        report.applied.push(m.version);
        report.to_version = m.version;
    }
    tx.pragma_update(None, "user_version", report.to_version)?;
    tx.commit()?;
    Ok(report)
}
