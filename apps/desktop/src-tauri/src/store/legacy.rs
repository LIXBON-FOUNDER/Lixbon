//! Bootstrap del estado legacy (slice C1 de la Fase 1).
//!
//! Importa `state.json` a `legacy_state` como UNA instantánea inicial. Trabaja
//! con JSON crudo (texto): no conoce `orch::State` ni ningún tipo del dominio,
//! la dependencia es `orch → store` y no al revés.
//!
//! # Autoridad
//! (Nota C2b: el arranque ya no llama a este módulo; promociona con
//! `store::authority`. Queda para las pruebas y para un futuro slice de
//! recuperación desde la instantánea.)
//! Durante C1 la fuente operativa sigue siendo `state.json`; `commit()` no se ha
//! tocado y NADIE actualiza esta instantánea. Por eso se marca
//! `legacy_import_mode = bootstrap_snapshot`: SQLite contiene una fotografía de
//! arranque, no la persistencia autoritativa. C2 cambiará esa autoridad con una
//! transición explícita de ese modo, no deduciéndola de que el hash de
//! `state.json` difiera del guardado (diverge a propósito en cuanto el Core
//! escribe `state.json` otra vez).
//!
//! # Cuándo se importa
//! Solo si `legacy_state` todavía no tiene instantánea y existe un `state.json`
//! válido. NO depende de que `lixbon.db` sea nueva: un primer arranque sin
//! `state.json` crea la base vacía y un arranque posterior, ya con archivo,
//! importa. Con la instantánea presente nunca se reimporta, aunque `state.json`
//! haya cambiado.
//!
//! # Atomicidad
//! La fila de `legacy_state` y los cinco metadatos se escriben en una sola
//! transacción (`BEGIN IMMEDIATE`): o están todos o no hay ninguno.

use std::path::Path;

use sha2::{Digest, Sha256};

use super::error::{StoreError, StoreResult};
use super::{now_ms, Store};

/// Valor de `legacy_import_mode` mientras SQLite solo guarda la instantánea de C1.
pub const MODE_BOOTSTRAP_SNAPSHOT: &str = "bootstrap_snapshot";

/// Versión del formato de los metadatos de la importación.
const IMPORT_VERSION: &str = "1";

const META_IMPORTED_AT: &str = "legacy_imported_at";
const META_SHA256: &str = "legacy_import_sha256";
const META_BYTES: &str = "legacy_import_bytes";
const META_VERSION: &str = "legacy_import_version";
pub(super) const META_MODE: &str = "legacy_import_mode";

/// Qué pasó al intentar importar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImportOutcome {
    /// Se importó: SHA-256 y tamaño del contenido original.
    Imported { sha256: String, bytes: u64 },
    /// Ya había instantánea: no se toca, aunque el origen haya cambiado.
    AlreadyPresent,
    /// No existe el archivo origen: nada que importar todavía.
    NoSource,
    /// El origen existe pero no es JSON utilizable: no se inserta nada.
    SourceInvalid { reason: String },
}

/// Importa `source` (un `state.json`) a `legacy_state` si aún no hay instantánea.
/// No modifica `source`.
pub fn bootstrap_legacy_snapshot(store: &mut Store, source: &Path) -> StoreResult<ImportOutcome> {
    if store.legacy_state()?.is_some() {
        return Ok(ImportOutcome::AlreadyPresent);
    }
    let bytes = match std::fs::read(source) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ImportOutcome::NoSource),
        Err(e) => return Err(StoreError::io(format!("no se pudo leer {}", source.display()), e)),
    };
    // Si es UTF-8 válido, el texto son exactamente los bytes originales.
    let text = match String::from_utf8(bytes) {
        Ok(t) => t,
        Err(_) => return Ok(ImportOutcome::SourceInvalid { reason: "el archivo no es UTF-8".into() }),
    };
    if let Err(e) = serde_json::from_str::<serde::de::IgnoredAny>(&text) {
        return Ok(ImportOutcome::SourceInvalid { reason: e.to_string() });
    }
    let sha256 = format!("{:x}", Sha256::digest(text.as_bytes()));
    let len = text.len() as u64;

    store.write(|tx| {
        let now = now_ms();
        tx.execute(
            "INSERT INTO legacy_state (id, rev, doc_schema, doc, updated_at) VALUES (1, 1, 0, ?1, ?2)",
            rusqlite::params![text, now],
        )?;
        let meta = [
            (META_IMPORTED_AT, now.to_string()),
            (META_SHA256, sha256.clone()),
            (META_BYTES, len.to_string()),
            (META_VERSION, IMPORT_VERSION.to_string()),
            (META_MODE, MODE_BOOTSTRAP_SNAPSHOT.to_string()),
        ];
        for (k, v) in meta {
            tx.execute("INSERT INTO meta (key, value) VALUES (?1, ?2)", rusqlite::params![k, v])?;
        }
        Ok(())
    })?;
    Ok(ImportOutcome::Imported { sha256, bytes: len })
}

/// Resultado de comprobar la instantánea contra sus propios metadatos.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotCheck {
    /// Todavía no hay instantánea.
    Absent,
    /// El documento guardado coincide con el SHA-256 y el tamaño registrados.
    Verified { rev: i64, bytes: u64, sha256: String },
}

/// Comprueba que `legacy_state` es la instantánea de arranque íntegra: modo
/// `bootstrap_snapshot`, `rev = 1` y documento con el SHA-256 y el tamaño
/// registrados al importar. No compara con `state.json` (diverge a propósito).
pub fn verify_snapshot(store: &Store) -> StoreResult<SnapshotCheck> {
    let Some(row) = store.legacy_state()? else {
        return Ok(SnapshotCheck::Absent);
    };
    let bad = |m: String| Err(StoreError::InvalidDocument(m));
    match store.meta(META_MODE)?.as_deref() {
        Some(MODE_BOOTSTRAP_SNAPSHOT) => {}
        otro => return bad(format!("legacy_import_mode inesperado: {otro:?}")),
    }
    if row.rev != 1 {
        return bad(format!("la instantánea de arranque está en rev {} (se esperaba 1)", row.rev));
    }
    let want_sha = store.meta(META_SHA256)?.unwrap_or_default();
    let want_bytes = store.meta(META_BYTES)?.unwrap_or_default();
    let sha256 = format!("{:x}", Sha256::digest(row.doc.as_bytes()));
    let bytes = row.doc.len() as u64;
    if sha256 != want_sha || bytes.to_string() != want_bytes {
        return bad("la instantánea no coincide con el SHA-256 y el tamaño registrados al importar".into());
    }
    Ok(SnapshotCheck::Verified { rev: row.rev, bytes, sha256 })
}
