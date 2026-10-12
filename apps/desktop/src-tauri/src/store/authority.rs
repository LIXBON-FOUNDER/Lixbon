//! Cambio de autoridad del estado legacy a SQLite (slice C2b de la Fase 1).
//!
//! Este módulo es solo el lado del **almacén**: sabe promocionar la fila
//! `legacy_state` a autoritativa en UNA transacción, escribirla después con
//! concurrencia optimista, aplicar la valla de compatibilidad (migración 002) y
//! verificar copias de seguridad. No conoce `orch::State` ni el marcador
//! `authority.json`: la dirección es `orch -> store`.
//!
//! # Los `rev` son de la FILA de SQLite
//! `sqlite_bootstrap_rev` y `sqlite_target_rev` son revisiones de la fila
//! `legacy_state` (publicaciones en la base). **No** son el número histórico de
//! mutaciones que haya sufrido `state.json`, que no tiene `rev`: la identidad del
//! legado la dan sus bytes exactos (`source_hash`, `source_bytes`).
//! `sqlite_target_rev = sqlite_bootstrap_rev + 1`, siempre.
//!
//! # La valla
//! [`FENCE_VERSION`] es la versión de la migración `002_authority_fence`. Se aplica
//! con [`Store::apply_fence`], nunca al abrir (ver [`Store::open_boot_under_lock`]).

use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use super::crash::crash_point;
use super::error::{StoreError, StoreResult};
use super::legacy::{META_MODE, MODE_BOOTSTRAP_SNAPSHOT};
use super::migrate::{self, db_version, Migration, MigrationReport};
use super::{current_rev, now_ms, Store};

/// Versión de la migración que sirve de valla de compatibilidad.
pub const FENCE_VERSION: i64 = 2;

/// `source_hash` de una instalación sin legado (no había `state.json` que promocionar).
pub const NO_SOURCE: &str = "none";

/// Valor de `legacy_import_mode` cuando SQLite es la autoridad.
pub const MODE_SQLITE_AUTHORITATIVE: &str = "sqlite_authoritative";

const META_DB_ID: &str = "db_id";
const META_PROMOTION_ID: &str = "legacy_authority_promotion_id";
const META_SOURCE_HASH: &str = "legacy_authority_source_hash";
const META_SOURCE_BYTES: &str = "legacy_authority_source_bytes";
const META_BOOTSTRAP_REV: &str = "legacy_authority_sqlite_bootstrap_rev";
const META_TARGET_REV: &str = "legacy_authority_sqlite_target_rev";
const META_SINCE: &str = "legacy_authority_since";

/// La promoción concreta que se va a escribir (lo mismo que fija el marcador `promoting`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromotionPlan {
    pub promotion_id: String,
    /// SHA-256 de los bytes exactos de `state.json` que se promocionan, o `"none"`.
    pub source_hash: String,
    pub source_bytes: u64,
    /// `rev` de la fila de C1 cuando se fijó la intención (`0` = sin fila).
    pub sqlite_bootstrap_rev: i64,
    /// `sqlite_bootstrap_rev + 1`.
    pub sqlite_target_rev: i64,
}

impl PromotionPlan {
    /// Plan con `sqlite_target_rev = sqlite_bootstrap_rev + 1`. Falla (sin envolver ni
    /// hacer panic) si la revisión de partida es negativa o `i64::MAX`.
    pub fn new(promotion_id: String, source_hash: String, source_bytes: u64, sqlite_bootstrap_rev: i64) -> StoreResult<PromotionPlan> {
        let sqlite_target_rev = next_rev(sqlite_bootstrap_rev)?;
        Ok(PromotionPlan { promotion_id, source_hash, source_bytes, sqlite_bootstrap_rev, sqlite_target_rev })
    }
}

/// La revisión siguiente. Los datos persistidos pueden venir corruptos: se falla cerrado.
pub fn next_rev(rev: i64) -> StoreResult<i64> {
    if rev < 0 {
        return Err(StoreError::RevOutOfRange { rev });
    }
    rev.checked_add(1).ok_or(StoreError::RevOutOfRange { rev })
}

/// Metadatos de autoridad guardados en SQLite por la promoción (los cinco a la vez).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthMeta {
    pub promotion_id: String,
    pub source_hash: String,
    pub source_bytes: u64,
    pub sqlite_bootstrap_rev: i64,
    pub sqlite_target_rev: i64,
    pub since: i64,
}

/// Lo que dice la base sobre su propia autoridad. Es la entrada de `decide_boot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorityFacts {
    pub db_version: i64,
    /// ¿Ya cruzó la valla (`db_version >= FENCE_VERSION`)?
    pub fenced: bool,
    pub db_id: Option<String>,
    /// `rev` de la fila `legacy_state`, si existe.
    pub row_rev: Option<i64>,
    /// `legacy_import_mode`, si existe.
    pub mode: Option<String>,
    /// `Some` solo si están TODAS las claves `legacy_authority_*`.
    pub auth: Option<AuthMeta>,
    /// ¿Hay claves `legacy_import_*`? (rastro de una instalación previa)
    pub has_import_meta: bool,
}

fn meta_get(conn: &Connection, key: &str) -> StoreResult<Option<String>> {
    Ok(conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

fn meta_put(conn: &Connection, key: &str, value: &str) -> StoreResult<()> {
    conn.execute("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", rusqlite::params![key, value])?;
    Ok(())
}

/// ¿`legacy_import_mode` ya es `sqlite_authoritative`? Solo se consulta con la base cruzada
/// (la tabla `meta` existe desde la 001).
/// Una base sin tabla `meta` (de una versión futura u otra cosa) no es autoritativa: la
/// apertura seguirá y `migrate` dará el error que corresponda (`DatabaseNewer`...).
pub(super) fn is_authoritative(conn: &Connection) -> StoreResult<bool> {
    let has_meta: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'meta'", [], |r| r.get(0))?;
    if has_meta == 0 {
        return Ok(false);
    }
    Ok(meta_get(conn, META_MODE)?.as_deref() == Some(MODE_SQLITE_AUTHORITATIVE))
}

fn parse_i64(v: Option<String>) -> Option<i64> {
    v.and_then(|s| s.parse().ok())
}

/// SHA-256 hexadecimal.
pub fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

impl Store {
    /// Versión del esquema de la base (mayor entre migraciones aplicadas y `user_version`).
    pub fn schema_version(&self) -> StoreResult<i64> {
        db_version(&self.conn)
    }

    /// ¿La base ya cruzó la valla de compatibilidad?
    pub fn is_fenced(&self) -> StoreResult<bool> {
        Ok(self.schema_version()? >= FENCE_VERSION)
    }

    /// `rev` actual de la fila `legacy_state` (la revisión realmente confirmada), si hay fila.
    pub fn row_rev(&self) -> StoreResult<Option<i64>> {
        current_rev(&self.conn)
    }

    /// Todo lo que la base sabe sobre su autoridad, en una lectura.
    pub fn authority_facts(&self) -> StoreResult<AuthorityFacts> {
        let version = self.schema_version()?;
        let c = &self.conn;
        let auth = match (
            meta_get(c, META_PROMOTION_ID)?,
            meta_get(c, META_SOURCE_HASH)?,
            parse_i64(meta_get(c, META_SOURCE_BYTES)?),
            parse_i64(meta_get(c, META_BOOTSTRAP_REV)?),
            parse_i64(meta_get(c, META_TARGET_REV)?),
            parse_i64(meta_get(c, META_SINCE)?),
        ) {
            // Solo se dan por buenos metadatos coherentes: revisiones en rango con
            // target = bootstrap + 1, y «sin legado» implica cero bytes.
            (Some(promotion_id), Some(source_hash), Some(bytes), Some(boot), Some(target), Some(since))
                if bytes >= 0 && next_rev(boot).ok() == Some(target) && (source_hash != NO_SOURCE || bytes == 0) =>
            {
                Some(AuthMeta { promotion_id, source_hash, source_bytes: bytes as u64, sqlite_bootstrap_rev: boot, sqlite_target_rev: target, since })
            }
            _ => None,
        };
        let has_import_meta: i64 = c.query_row("SELECT COUNT(*) FROM meta WHERE key LIKE 'legacy_import_%'", [], |r| r.get(0))?;
        Ok(AuthorityFacts {
            db_version: version,
            fenced: version >= FENCE_VERSION,
            db_id: meta_get(c, META_DB_ID)?,
            row_rev: current_rev(c)?,
            mode: meta_get(c, META_MODE)?,
            auth,
            has_import_meta: has_import_meta > 0,
        })
    }

    /// Identidad estable de ESTA base (`meta.db_id`). La crea si no existe; si ya
    /// existe la devuelve sin cambiarla.
    pub fn ensure_db_id(&mut self) -> StoreResult<String> {
        self.write(|tx| {
            if let Some(id) = meta_get(tx, META_DB_ID)? {
                return Ok(id);
            }
            let id = new_uuid();
            tx.execute("INSERT INTO meta (key, value) VALUES (?1, ?2)", rusqlite::params![META_DB_ID, id])?;
            Ok(id)
        })
    }

    /// Aplica la valla de compatibilidad (migración 002) y NADA más allá: las
    /// migraciones posteriores a la valla se aplicarán en los arranques siguientes,
    /// ya con la instalación cruzada. Idempotente. Si falla, la transacción se
    /// deshace entera y la base queda sin cruzar.
    pub fn apply_fence(&mut self, all: &[Migration], app_version: &str) -> StoreResult<MigrationReport> {
        let upto: Vec<Migration> = all.iter().filter(|m| m.version <= FENCE_VERSION).copied().collect();
        crash_point("before_fence");
        let report = migrate::migrate(&mut self.conn, &upto, app_version, &self.backup_dir)?;
        crash_point("after_fence");
        Ok(report)
    }

    /// T2: promociona la fila `legacy_state` a autoritativa en **una** transacción.
    ///
    /// Sustituye el documento por `doc` (derivado del legado que fijó la intención),
    /// sube la fila a `sqlite_target_rev`, cambia el modo de `bootstrap_snapshot` a
    /// `sqlite_authoritative` y registra los datos de la promoción. Solo ocurre una
    /// vez: si la fila no está exactamente en `sqlite_bootstrap_rev` o el modo no es
    /// el de bootstrap, se deshace todo con [`StoreError::PromotionConflict`].
    pub fn promote_to_authoritative(&mut self, plan: &PromotionPlan, doc: &str) -> StoreResult<i64> {
        if next_rev(plan.sqlite_bootstrap_rev)? != plan.sqlite_target_rev {
            return Err(StoreError::PromotionConflict(format!(
                "sqlite_target_rev ({}) debe ser sqlite_bootstrap_rev + 1 ({})",
                plan.sqlite_target_rev, plan.sqlite_bootstrap_rev
            )));
        }
        let plan = plan.clone();
        let doc = doc.to_string();
        let target = self.write(move |tx| {
            // Invariante del almacén: `sqlite_authoritative ⇒ valla 002 aplicada`. No depende
            // de que quien orquesta se acuerde de aplicarla; se comprueba antes de escribir nada.
            if db_version(tx)? < FENCE_VERSION {
                return Err(StoreError::NotFenced);
            }
            let now = now_ms();
            let row = current_rev(tx)?;
            let mode = meta_get(tx, META_MODE)?;
            if mode.as_deref() == Some(MODE_SQLITE_AUTHORITATIVE) {
                return Err(StoreError::PromotionConflict("la base ya es autoritativa".into()));
            }
            match row {
                None => {
                    if plan.sqlite_bootstrap_rev != 0 {
                        return Err(StoreError::RevConflict { expected: plan.sqlite_bootstrap_rev, actual: None });
                    }
                    if mode.is_some() {
                        return Err(StoreError::PromotionConflict("hay modo de importación pero no hay fila de estado".into()));
                    }
                    insert_doc(tx, plan.sqlite_target_rev, &doc, now)?;
                }
                Some(actual) => {
                    if actual != plan.sqlite_bootstrap_rev {
                        return Err(StoreError::RevConflict { expected: plan.sqlite_bootstrap_rev, actual: Some(actual) });
                    }
                    if mode.as_deref() != Some(MODE_BOOTSTRAP_SNAPSHOT) {
                        return Err(StoreError::PromotionConflict(format!("el modo es {mode:?}, no {MODE_BOOTSTRAP_SNAPSHOT}")));
                    }
                    let changed = tx
                        .execute(
                            "UPDATE legacy_state SET rev = ?1, doc = ?2, updated_at = ?3 WHERE id = 1 AND rev = ?4",
                            rusqlite::params![plan.sqlite_target_rev, doc, now, plan.sqlite_bootstrap_rev],
                        )
                        .map_err(invalid_doc)?;
                    if changed != 1 {
                        return Err(StoreError::RevConflict { expected: plan.sqlite_bootstrap_rev, actual: current_rev(tx)? });
                    }
                }
            }
            meta_put(tx, META_MODE, MODE_SQLITE_AUTHORITATIVE)?;
            meta_put(tx, META_PROMOTION_ID, &plan.promotion_id)?;
            meta_put(tx, META_SOURCE_HASH, &plan.source_hash)?;
            meta_put(tx, META_SOURCE_BYTES, &plan.source_bytes.to_string())?;
            meta_put(tx, META_BOOTSTRAP_REV, &plan.sqlite_bootstrap_rev.to_string())?;
            meta_put(tx, META_TARGET_REV, &plan.sqlite_target_rev.to_string())?;
            meta_put(tx, META_SINCE, &now.to_string())?;
            crash_point("promote_in_tx");
            Ok(plan.sqlite_target_rev)
        })?;
        crash_point("promote_committed");
        Ok(target)
    }

    /// Escritura autoritativa del estado (una por `Core::mutate`): sube la fila de
    /// `expected_rev` a `expected_rev + 1` en una transacción, solo si la base ya es
    /// autoritativa. Devuelve la nueva `rev`. Una `rev` fuera de rango falla sin escribir.
    pub fn commit_authoritative(&mut self, expected_rev: i64, doc: &str) -> StoreResult<i64> {
        let next = next_rev(expected_rev)?;
        self.write(|tx| {
            if meta_get(tx, META_MODE)?.as_deref() != Some(MODE_SQLITE_AUTHORITATIVE) {
                return Err(StoreError::NotAuthoritative);
            }
            let changed = tx
                .execute(
                    "UPDATE legacy_state SET rev = ?4, doc = ?1, updated_at = ?2 WHERE id = 1 AND rev = ?3",
                    rusqlite::params![doc, now_ms(), expected_rev, next],
                )
                .map_err(invalid_doc)?;
            if changed != 1 {
                return Err(StoreError::RevConflict { expected: expected_rev, actual: current_rev(tx)? });
            }
            crash_point("mutate_in_tx");
            Ok(next)
        })
    }

    /// Verifica una copia hecha con [`Store::backup`] contra la base viva: abre la
    /// copia en solo lectura, `integrity_check`, y comprueba que lleva las mismas
    /// migraciones, el mismo `db_id` y la misma fila `legacy_state` (`rev` y SHA-256
    /// del documento). La copia es válida solo si es una foto fiel de la base.
    pub fn verify_backup(&self, path: &std::path::Path) -> StoreResult<()> {
        use rusqlite::OpenFlags;
        let fail = |m: String| StoreError::Backup(format!("la copia {} no es fiel: {m}", path.display()));
        let copy = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| StoreError::Backup(format!("la copia no se puede abrir: {e}")))?;
        let res: String = copy
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| StoreError::Backup(format!("la copia no se puede verificar: {e}")))?;
        if res != "ok" {
            return Err(fail(format!("integrity_check = {res}")));
        }
        let migrations = |c: &Connection| -> StoreResult<Vec<(i64, String)>> {
            let mut st = c.prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        };
        if migrations(&copy)? != migrations(&self.conn)? {
            return Err(fail("las migraciones aplicadas difieren".into()));
        }
        if meta_get(&copy, META_DB_ID)? != meta_get(&self.conn, META_DB_ID)? {
            return Err(fail("el db_id difiere".into()));
        }
        let row = |c: &Connection| -> StoreResult<Option<(i64, String)>> {
            Ok(c.query_row("SELECT rev, doc FROM legacy_state WHERE id = 1", [], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).optional()?)
        };
        let (a, b) = (row(&copy)?, row(&self.conn)?);
        let digest = |r: &Option<(i64, String)>| r.as_ref().map(|(rev, doc)| (*rev, sha256_hex(doc.as_bytes())));
        if digest(&a) != digest(&b) {
            return Err(fail("la fila legacy_state (rev o documento) difiere".into()));
        }
        Ok(())
    }
}

fn insert_doc(conn: &Connection, rev: i64, doc: &str, now: i64) -> StoreResult<()> {
    conn.execute(
        "INSERT INTO legacy_state (id, rev, doc_schema, doc, updated_at) VALUES (1, ?1, 0, ?2, ?3)",
        rusqlite::params![rev, doc, now],
    )
    .map_err(invalid_doc)?;
    Ok(())
}

/// El CHECK `json_valid(doc)` falla con ConstraintViolation: se dice con claridad.
fn invalid_doc(e: rusqlite::Error) -> StoreError {
    match &e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            StoreError::InvalidDocument("el estado no es JSON válido".into())
        }
        _ => StoreError::Sqlite(e),
    }
}

/// UUID v4 (aleatorio) sin dependencias nuevas: 16 bytes del generador del SO.
pub fn new_uuid() -> String {
    let mut b = [0u8; 16];
    // `RandomState` se siembra con aleatoriedad del SO; con el reloj y un contador
    // da identificadores únicos, que es lo único que se pide (no son secretos).
    use std::hash::{BuildHasher, Hasher};
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    for chunk in 0..2 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u64(now_ms() as u64);
        h.write_u64(N.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
        h.write_u32(std::process::id());
        b[chunk * 8..chunk * 8 + 8].copy_from_slice(&h.finish().to_le_bytes());
    }
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}
