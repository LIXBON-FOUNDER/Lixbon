//! ContextPackage guardado (migración 025, LXO-138). Contrato: `docs/core/CONTEXT_PACKAGE.md` § Guardado, export e import.
//!
//! Aquí solo hay persistencia: guardar un paquete (y los bytes de sus adjuntos) una vez, leerlo por su `package_id` o por el Attempt
//! del que viene, y nada más. **No valida el paquete**: quien llama (`orch::context_store`) lo pasa por `context_package::parse`, la
//! misma puerta por la que entra un paquete a un Attempt; el almacén solo acota los valores con CHECK y hace inmutable lo guardado.
//!
//! * Guardar es idempotente: el `package_id` ya identifica el contenido, así que repetirlo no escribe nada (`Existing`).
//! * El paquete y sus adjuntos entran en UNA transacción: o está todo o no hay nada.
//! * Antes del corte no hay tablas: leer devuelve «no hay» y escribir es `AgenticModelInactive`.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};

use super::error::StoreResult;
use super::tasks::require_active;
use super::Store;

/// Cómo llegó el paquete a este almacén.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageOrigin {
    /// Lo construyó este Core desde un Attempt.
    Built,
    /// Llegó de fuera y pasó `parse` (identidad, formato y secretos).
    Imported,
}

impl PackageOrigin {
    pub fn code(self) -> &'static str {
        match self {
            PackageOrigin::Built => "built",
            PackageOrigin::Imported => "imported",
        }
    }

    fn parse(s: &str) -> PackageOrigin {
        if s == "built" {
            PackageOrigin::Built
        } else {
            PackageOrigin::Imported
        }
    }
}

/// Lo que se guarda: el documento exacto y los datos con que se busca.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewStoredPackage {
    pub package_id: String,
    pub origin: PackageOrigin,
    /// Los de `source` del paquete.
    pub task_id: String,
    pub attempt_id: String,
    pub created_at: i64,
    /// La forma canónica (`ContextPackage::to_json`).
    pub json: String,
    /// Bytes de los adjuntos que viajan, por id.
    pub blobs: BTreeMap<String, (String, Vec<u8>)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredPackage {
    pub package_id: String,
    pub origin: PackageOrigin,
    pub task_id: String,
    pub attempt_id: String,
    pub created_at: i64,
    pub stored_at: i64,
    pub json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutOutcome {
    Created,
    /// Ya estaba guardado: no se escribió nada y el origen que tenía se conserva.
    Existing,
}

fn has_tables(c: &Connection) -> StoreResult<bool> {
    Ok(c.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'context_packages'", [], |_| Ok(())).optional()?.is_some())
}

fn row_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<StoredPackage> {
    let origin: String = r.get(1)?;
    Ok(StoredPackage { package_id: r.get(0)?, origin: PackageOrigin::parse(&origin), task_id: r.get(2)?, attempt_id: r.get(3)?, created_at: r.get(4)?, stored_at: r.get(5)?, json: r.get(6)? })
}

const COLUMNS: &str = "package_id, origin, task_id, attempt_id, created_at, stored_at, json";

impl Store {
    /// Guarda un paquete y sus adjuntos. Repetir el mismo `package_id` no escribe nada.
    pub fn context_package_put(&mut self, p: &NewStoredPackage, at: i64) -> StoreResult<PutOutcome> {
        self.write(|tx| {
            require_active(tx)?;
            let exists: bool = tx.query_row("SELECT 1 FROM context_packages WHERE package_id = ?1", params![p.package_id], |_| Ok(())).optional()?.is_some();
            if exists {
                return Ok(PutOutcome::Existing);
            }
            tx.execute(
                "INSERT INTO context_packages (package_id, origin, task_id, attempt_id, created_at, stored_at, json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![p.package_id, p.origin.code(), p.task_id, p.attempt_id, p.created_at.max(0), at.max(0), p.json],
            )?;
            for (id, (sha256, data)) in &p.blobs {
                tx.execute("INSERT INTO context_package_blobs (package_id, attachment_id, sha256, data) VALUES (?1, ?2, ?3, ?4)", params![p.package_id, id, sha256, data])?;
            }
            Ok(PutOutcome::Created)
        })
    }

    /// Un paquete por su `package_id`. Sin tablas (antes del corte): `None`.
    pub fn context_package(&self, package_id: &str) -> StoreResult<Option<StoredPackage>> {
        self.read(|c| {
            if !has_tables(c)? {
                return Ok(None);
            }
            Ok(c.query_row(&format!("SELECT {COLUMNS} FROM context_packages WHERE package_id = ?1"), params![package_id], row_of).optional()?)
        })
    }

    /// El paquete más reciente cuyo `source.attempt_id` es este. Si hay varios en el mismo instante, el último por id.
    pub fn context_package_latest_of_attempt(&self, attempt_id: &str) -> StoreResult<Option<StoredPackage>> {
        self.read(|c| {
            if !has_tables(c)? {
                return Ok(None);
            }
            Ok(c
                .query_row(
                    &format!("SELECT {COLUMNS} FROM context_packages WHERE attempt_id = ?1 ORDER BY stored_at DESC, package_id DESC LIMIT 1"),
                    params![attempt_id],
                    row_of,
                )
                .optional()?)
        })
    }

    /// Los bytes de los adjuntos guardados de un paquete, por id.
    pub fn context_package_blobs(&self, package_id: &str) -> StoreResult<BTreeMap<String, Vec<u8>>> {
        self.read(|c| {
            if !has_tables(c)? {
                return Ok(BTreeMap::new());
            }
            let mut stmt = c.prepare("SELECT attachment_id, data FROM context_package_blobs WHERE package_id = ?1 ORDER BY attachment_id")?;
            let rows = stmt.query_map(params![package_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)))?.collect::<Result<BTreeMap<_, _>, _>>()?;
            Ok(rows)
        })
    }
}
