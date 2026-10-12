//! Permisos privados para la base y sus copias.
//!
//! `legacy_state` contiene el `State` completo (prompts, salidas de agentes) y
//! `backups/` lo duplica; la carpeta de datos (`~/.lixbon`) hereda permisos más
//! anchos (en Windows, el sandbox de Codex podía leerla). Mismo criterio que
//! `orch.json` desde la Fase 0: archivos legibles solo por su propietario.
//!
//! Es de mejor esfuerzo, como allí: si no se pueden aplicar, el almacén sigue
//! funcionando. No se toca la carpeta `dir` del almacén (la comparte el resto
//! del Core): solo `lixbon.db`, sus `-wal`/`-shm` y `backups/`.
//!
//! Pendiente (otro slice): hay un ayudante equivalente en `orch/fsio.rs`; ambos
//! deberían vivir en un módulo `platform` compartido.

use std::path::Path;

/// Deja `path` (un archivo) legible solo por su propietario.
pub(super) fn restrict_file(path: &Path) {
    restrict(path, false);
}

/// Deja `path` (una carpeta) accesible solo por su propietario. En Windows lo que
/// se cree dentro hereda ese permiso; en Unix la carpeta (0700) basta para
/// cerrar el paso a lo que contiene.
pub(super) fn restrict_dir(path: &Path) {
    restrict(path, true);
}

/// Crea `path` vacío y privado si no existe, para que SQLite lo adopte ya
/// protegido (y en Unix copie su modo a `-wal` y `-shm`). Si existe, lo restringe.
pub(super) fn create_private_file(path: &Path) {
    if !path.exists() {
        let mut o = std::fs::OpenOptions::new();
        o.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let _ = o.open(path);
    }
    restrict_file(path);
}

fn restrict(path: &Path, dir: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if dir { 0o700 } else { 0o600 };
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
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
        // (OI)(CI): los archivos y subcarpetas nuevos heredan el permiso.
        let grant = if dir { format!("{who}:(OI)(CI)F") } else { format!("{who}:F") };
        let mut c = std::process::Command::new("icacls");
        c.arg(path).args(["/inheritance:r", "/grant:r"]).arg(grant);
        let _ = crate::hide_console(&mut c).output();
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, dir);
    }
}
