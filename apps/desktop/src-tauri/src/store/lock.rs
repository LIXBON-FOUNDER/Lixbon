//! Bloqueo de instancia: UN solo Core puede tener abierto el almacén.
//!
//! SQLite no evita por sí solo dos Cores sobre la misma base (solo serializa
//! escrituras). El bloqueo es de **apertura exclusiva** de un archivo:
//!   * Windows: `share_mode(0)` → el segundo `open` falla con
//!     `ERROR_SHARING_VIOLATION` (os error 32). Verificado en el spike.
//!   * Unix: `flock(LOCK_EX | LOCK_NB)` sobre el descriptor.
//!
//! No se usa `File::try_lock` de la biblioteca estándar: exige Rust 1.89 y el
//! proyecto declara `rust-version = "1.87"`.
//!
//! El sistema operativo libera el bloqueo al cerrar el manejador, también
//! cuando el proceso muere (kill, caída): no quedan bloqueos huérfanos que
//! limpiar a mano. El contenido del archivo (el PID) es solo informativo; en
//! Windows otro proceso no puede ni leerlo mientras el titular vive.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use super::error::{StoreError, StoreResult};

/// Titular del bloqueo. Se libera al soltarlo (`Drop`) o al morir el proceso.
///
/// En Unix `Drop` hace un `flock(LOCK_UN)` EXPLÍCITO antes de cerrar el descriptor: un `flock`
/// pertenece a la descripción de archivo abierta y no a este descriptor, así que si otro hilo del
/// proceso hace `fork` mientras el bloqueo está tomado (para lanzar `git`, un agente...), el hijo
/// hereda una copia y el bloqueo seguiría ocupado hasta su `exec` aunque este titular ya se haya
/// soltado. Sin el `LOCK_UN`, «se libera al soltarlo» no se cumple.
#[derive(Debug)]
pub struct InstanceLock {
    // Se mantiene abierto mientras viva el bloqueo.
    _file: File,
    path: PathBuf,
}

impl InstanceLock {
    /// Intenta adquirir el bloqueo sin esperar. `AlreadyRunning` si otro lo tiene.
    pub fn acquire(path: &Path) -> StoreResult<InstanceLock> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| StoreError::io(format!("no se pudo crear {}", parent.display()), e))?;
        }
        let mut file = open_exclusive(path)?;
        // Informativo; si falla no importa.
        let _ = file.set_len(0);
        let _ = write!(file, "{}", std::process::id());
        let _ = file.flush();
        Ok(InstanceLock { _file: file, path: path.to_path_buf() })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(unix)]
impl Drop for InstanceLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: el descriptor es válido mientras `_file` viva (se cierra después de este `drop`).
        unsafe { sys::flock(self._file.as_raw_fd(), sys::LOCK_UN) };
    }
}

#[cfg(unix)]
mod sys {
    extern "C" {
        // Declarada aquí para no añadir la dependencia `libc` solo por esto;
        // `flock` ya está en la libc contra la que enlaza `std`.
        pub fn flock(fd: i32, operation: i32) -> i32;
    }
    pub const LOCK_EX: i32 = 2;
    pub const LOCK_NB: i32 = 4;
    pub const LOCK_UN: i32 = 8;
}

#[cfg(windows)]
fn open_exclusive(path: &Path) -> StoreResult<File> {
    use std::os::windows::fs::OpenOptionsExt;
    match OpenOptions::new().read(true).write(true).create(true).share_mode(0).open(path) {
        Ok(f) => Ok(f),
        // 32 = ERROR_SHARING_VIOLATION, 33 = ERROR_LOCK_VIOLATION.
        Err(e) if matches!(e.raw_os_error(), Some(32) | Some(33)) => {
            Err(StoreError::AlreadyRunning { lock_path: path.to_path_buf() })
        }
        Err(e) => Err(StoreError::io(format!("no se pudo abrir el bloqueo {}", path.display()), e)),
    }
}

#[cfg(unix)]
fn open_exclusive(path: &Path) -> StoreResult<File> {
    use std::os::fd::AsRawFd;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| StoreError::io(format!("no se pudo abrir el bloqueo {}", path.display()), e))?;
    // SAFETY: el descriptor es válido mientras `file` viva.
    let rc = unsafe { sys::flock(file.as_raw_fd(), sys::LOCK_EX | sys::LOCK_NB) };
    if rc == 0 {
        return Ok(file);
    }
    let err = std::io::Error::last_os_error();
    if err.kind() == std::io::ErrorKind::WouldBlock {
        Err(StoreError::AlreadyRunning { lock_path: path.to_path_buf() })
    } else {
        Err(StoreError::io(format!("no se pudo bloquear {}", path.display()), err))
    }
}
