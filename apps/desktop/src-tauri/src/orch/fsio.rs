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
        if let Some(dir) = TEST_DATA_DIR.with(|d| d.borrow().clone()) {
            return dir;
        }
        return std::env::temp_dir().join(format!("lixbon-orch-test-{}", std::process::id()));
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
