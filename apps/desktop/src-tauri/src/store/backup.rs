//! Copias de seguridad consistentes con `VACUUM INTO`.
//!
//! NUNCA se copia el archivo `.db` en caliente: con WAL, parte de los datos
//! confirmados vive en `-wal` y una copia del `.db` suelto sería una foto rota.
//! `VACUUM INTO` genera, dentro de una lectura consistente, una base nueva,
//! compacta y autosuficiente.
//!
//! La copia se escribe como `*.db.tmp`, se verifica (`integrity_check`) y solo
//! entonces se renombra a `*.db`: un `*.db` en la carpeta de copias siempre es
//! una copia completa y sana.
//!
//! `VACUUM INTO` no puede ejecutarse dentro de una transacción: llámese con la
//! conexión en autocommit (el [`Store`](super::Store) lo garantiza).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::{Connection, OpenFlags};

use super::error::{StoreError, StoreResult};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn sanitize(label: &str) -> String {
    let s: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    if s.is_empty() {
        "copia".to_string()
    } else {
        s
    }
}

/// Crea una copia consistente de la base de `conn` en `dir` y devuelve su ruta.
/// `label` va en el nombre (`lixbon-<ms>-<n>-<label>.db`); nunca sobrescribe.
pub fn backup_to(conn: &Connection, dir: &Path, label: &str) -> StoreResult<PathBuf> {
    if !conn.is_autocommit() {
        return Err(StoreError::Backup("no se puede copiar dentro de una transacción".into()));
    }
    let nueva = !dir.exists();
    std::fs::create_dir_all(dir)
        .map_err(|e| StoreError::Backup(format!("no se pudo crear {}: {e}", dir.display())))?;
    if nueva {
        super::private::restrict_dir(dir);
    }
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let stem = format!("lixbon-{ms}-{n}-{}", sanitize(label));
    let final_path = dir.join(format!("{stem}.db"));
    let tmp_path = dir.join(format!("{stem}.db.tmp"));
    if final_path.exists() || tmp_path.exists() {
        return Err(StoreError::Backup(format!("ya existe {}", final_path.display())));
    }
    let tmp_str = tmp_path
        .to_str()
        .ok_or_else(|| StoreError::Backup("la ruta de la copia no es UTF-8".into()))?;

    let result = (|| -> StoreResult<()> {
        conn.execute("VACUUM INTO ?1", [tmp_str])
            .map_err(|e| StoreError::Backup(format!("VACUUM INTO falló: {e}")))?;
        verify(&tmp_path)?;
        std::fs::rename(&tmp_path, &final_path)
            .map_err(|e| StoreError::Backup(format!("no se pudo renombrar la copia: {e}")))?;
        super::private::restrict_file(&final_path);
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(e);
    }
    Ok(final_path)
}

/// Abre la copia en solo lectura y comprueba su integridad.
fn verify(path: &Path) -> StoreResult<()> {
    let c = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| StoreError::Backup(format!("la copia no se puede abrir: {e}")))?;
    let res: String = c
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| StoreError::Backup(format!("la copia no se puede verificar: {e}")))?;
    if res != "ok" {
        return Err(StoreError::Backup(format!("la copia no pasa integrity_check: {res}")));
    }
    Ok(())
}
