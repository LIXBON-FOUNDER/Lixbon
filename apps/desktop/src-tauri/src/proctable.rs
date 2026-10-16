//! Tabla de procesos del sistema: `(pid, ppid)` de los procesos vivos. La usa `orch::pty` para comprobar que murió TODO
//! el árbol de un agente y no solo su raíz. Vive fuera de `orch/` porque no tiene que ver con la frontera del almacén
//! (la guardia de `mutation_tests` limita Win32 a `fsio.rs` por la publicación durable, no por esto).

use crate::hide_console;

/// Tabla `(pid, ppid)` de los procesos vivos, o `None` si no se pudo leer.
#[cfg(windows)]
pub(crate) fn process_table() -> Option<Vec<(u32, u32)>> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    // SAFETY: llamadas FFI con una estructura inicializada a cero y `dwSize` fijado; el handle se cierra siempre.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut out = Vec::new();
        let mut more = Process32FirstW(snap, &mut entry);
        while more != 0 {
            out.push((entry.th32ProcessID, entry.th32ParentProcessID));
            more = Process32NextW(snap, &mut entry);
        }
        CloseHandle(snap);
        Some(out)
    }
}

#[cfg(not(windows))]
pub(crate) fn process_table() -> Option<Vec<(u32, u32)>> {
    let mut cmd = std::process::Command::new("ps");
    cmd.args(["-e", "-o", "pid=,ppid=,stat="]);
    let o = hide_console(&mut cmd).output().ok().filter(|o| o.status.success())?;
    let text = String::from_utf8_lossy(&o.stdout);
    Some(
        text.lines()
            .filter_map(|l| {
                let mut f = l.split_whitespace();
                let (pid, ppid, stat) = (f.next()?.parse().ok()?, f.next()?.parse().ok()?, f.next().unwrap_or(""));
                // Un zombi pendiente de `wait` cuenta como muerto.
                (!stat.starts_with('Z')).then_some((pid, ppid))
            })
            .collect(),
    )
}
