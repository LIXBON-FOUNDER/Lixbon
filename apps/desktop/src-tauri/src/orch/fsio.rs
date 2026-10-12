//! Rutas de `~/.lixbon` y lectura/escritura de JSON (con la variante privada para `orch.json`).

use std::hash::{BuildHasher, Hasher};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use super::{skill, state};

pub fn random_token() -> String {
    let part = || {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(state::now_ms() as u128 ^ std::process::id() as u128);
        h.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

pub(super) fn lixbon_dir() -> PathBuf {
    skill::home().unwrap_or_else(std::env::temp_dir).join(".lixbon")
}

pub(super) fn data_dir() -> PathBuf {
    // Las pruebas nunca tocan el state.json real del usuario.
    #[cfg(test)]
    {
        // Cada hilo de prueba tiene su carpeta: un fallo al escribir `state.json` ya no
        // se ignora, y dos pruebas en paralelo no deben pisarse el mismo archivo.
        return TEST_DATA_DIR.with(|d| {
            d.borrow_mut()
                .get_or_insert_with(|| {
                    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    std::env::temp_dir().join(format!("lixbon-orch-test-{}-{n}", std::process::id()))
                })
                .clone()
        });
    }
    #[cfg(not(test))]
    lixbon_dir().join("orch")
}

/// `~/.lixbon/core`: el almacén SQLite del Core (`lixbon.db`, `core.lock`,
/// `backups/`). Aparte de `orch/`, donde siguen `state.json` y `settings.json`.
pub(super) fn core_dir() -> PathBuf {
    #[cfg(test)]
    {
        return std::env::temp_dir().join(format!("lixbon-core-test-{}", std::process::id()));
    }
    #[cfg(not(test))]
    lixbon_dir().join("core")
}

#[cfg(test)]
thread_local! {
    static TEST_DATA_DIR: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Solo pruebas: fija la carpeta de datos del hilo actual (cada prueba corre en
/// su propio hilo), para que `commit()` escriba en una carpeta propia en vez de
/// la compartida del proceso.
#[cfg(test)]
pub(super) fn set_test_data_dir(dir: &Path) {
    TEST_DATA_DIR.with(|d| *d.borrow_mut() = Some(dir.to_path_buf()));
}

pub(super) fn discovery_file() -> PathBuf {
    lixbon_dir().join("orch.json")
}

/// `lxo` viaja junto al ejecutable de Lixbon (sidecar de Tauri).
pub fn lxo_path() -> PathBuf {
    let dir = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)).unwrap_or_default();
    dir.join(if cfg!(windows) { "lxo.exe" } else { "lxo" })
}

pub(super) fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Como `write_json`, pero el archivo queda legible solo por su propietario antes de
/// publicarse: lleva el token del host y `~/.lixbon` hereda permisos más anchos (en
/// Windows, el sandbox de Codex lo podía leer).
pub(super) fn write_private_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    restrict_to_owner(&tmp);
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Publicación atómica y durable (C2b): marcador de autoridad y espejo
// ---------------------------------------------------------------------------
//
// Dos garantías DISTINTAS (ver `LIXBON-C2-diseno.md` §11.9):
//
// * **Atomicidad ante caída de proceso:** el destino es siempre el contenido
//   anterior o el nuevo, nunca uno a medias (`rename` / `MoveFileExW`).
// * **Durabilidad ante fallo del SO / pérdida de energía:** mitigación, no
//   garantía absoluta. Unix: `fsync` del archivo, `rename` y `fsync` de la
//   carpeta. Windows: `FlushFileBuffers` del archivo y `MoveFileExW` con
//   `MOVEFILE_WRITE_THROUGH`. Depende de que el sistema de archivos y el disco
//   honren el vaciado; ninguna prueba simula un corte de energía.
//
// Este es el ÚNICO archivo con código específico de plataforma para esto.

/// Ruta del temporal de un destino: `<destino>.tmp` (conserva la extensión).
pub(super) fn staging_path(dest: &Path) -> PathBuf {
    let mut name = dest.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".tmp");
    dest.with_file_name(name)
}

/// Escribe `bytes` en el temporal de `dest` y lo deja vaciado a disco
/// (`fsync`). Con `private`, el temporal queda accesible solo por su propietario
/// ANTES de recibir el contenido. Devuelve la ruta del temporal; falta publicarlo
/// con [`publish_durable`].
pub(super) fn stage_durable(dest: &Path, bytes: &[u8], private: bool) -> std::io::Result<PathBuf> {
    use std::io::Write;
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = staging_path(dest);
    let mut f = std::fs::File::create(&tmp)?;
    if private {
        restrict_to_owner(&tmp);
    }
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(tmp)
}

/// Publica `tmp` como `dest` reemplazando el destino de forma atómica y, en la
/// medida del SO, durable. Si falla, `tmp` queda donde estaba.
pub(super) fn publish_durable(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        move_file_write_through(tmp, dest)
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(tmp, dest)?;
        // Sin esto el `rename` puede perderse en un corte aunque el archivo esté en disco.
        // Una ruta relativa sin carpeta (`x.json`) tiene por padre `""`: la carpeta es `.`.
        let dir = match dest.parent() {
            Some(d) if !d.as_os_str().is_empty() => d,
            _ => Path::new("."),
        };
        std::fs::File::open(dir)?.sync_all()?;
        Ok(())
    }
}

/// Atajo: `stage_durable` + `publish_durable`.
pub(super) fn write_atomic_durable(dest: &Path, bytes: &[u8], private: bool) -> std::io::Result<()> {
    let tmp = stage_durable(dest, bytes, private)?;
    publish_durable(&tmp, dest).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(windows)]
fn move_file_write_through(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
    let wide = |p: &Path| -> Vec<u16> { p.as_os_str().encode_wide().chain(std::iter::once(0)).collect() };
    let (from, to) = (wide(tmp), wide(dest));
    // SAFETY: ambos buffers son cadenas UTF-16 terminadas en 0 que viven durante la llamada.
    let ok = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) };
    if ok == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(super) fn restrict_to_owner(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap_or_default();
        if user.is_empty() {
            return;
        }
        let who = match std::env::var("USERDOMAIN") {
            Ok(d) if !d.is_empty() => format!("{d}\\{user}"),
            _ => user,
        };
        let mut c = std::process::Command::new("icacls");
        c.arg(path).args(["/inheritance:r", "/grant:r"]).arg(format!("{who}:F"));
        let _ = crate::hide_console(&mut c).output();
    }
}

pub(super) fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

#[cfg(test)]
mod durable_tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("lixbon-fsio-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn publica_un_archivo_nuevo_y_no_deja_temporal() {
        let d = dir("nuevo");
        let dest = d.join("authority.json");
        write_atomic_durable(&dest, b"{\"v\":1}", true).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"{\"v\":1}");
        assert!(!staging_path(&dest).exists(), "el temporal no debe quedar");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn reemplaza_un_destino_existente() {
        let d = dir("reemplazo");
        let dest = d.join("state.json");
        std::fs::write(&dest, b"viejo").unwrap();
        write_atomic_durable(&dest, b"nuevo", false).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"nuevo");
        assert!(!staging_path(&dest).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn el_temporal_conserva_la_extension_del_destino() {
        assert_eq!(staging_path(Path::new("/x/state.json")), PathBuf::from("/x/state.json.tmp"));
        assert_eq!(staging_path(Path::new("/x/authority.json")), PathBuf::from("/x/authority.json.tmp"));
    }

    #[test]
    fn si_falta_el_temporal_publicar_falla_y_deja_el_destino_intacto() {
        let d = dir("falla");
        let dest = d.join("x.json");
        std::fs::write(&dest, b"intacto").unwrap();
        assert!(publish_durable(&d.join("no-existe.tmp"), &dest).is_err());
        assert_eq!(std::fs::read(&dest).unwrap(), b"intacto");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn un_temporal_huerfano_no_impide_la_siguiente_publicacion() {
        let d = dir("huerfano");
        let dest = d.join("authority.json");
        std::fs::write(staging_path(&dest), b"basura de una caida").unwrap();
        write_atomic_durable(&dest, b"limpio", true).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"limpio");
        let _ = std::fs::remove_dir_all(&d);
    }
}
