use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;

use portable_pty::{
    native_pty_system, Child, CommandBuilder, MasterPty, PtySize, PtySystem, SlavePty,
};
use tauri::{AppHandle, Emitter, State};

/// Carpeta de trabajo elegida por el usuario. Todos los comandos de
/// archivos están confinados a ella: sin raíz no hay acceso al disco.
struct WorkspaceRoot(Mutex<Option<PathBuf>>);

/// Sesión de terminal viva: el master (para redimensionar), su writer (stdin del
/// shell) y el proceso hijo (para matarlo al cerrar). El hilo lector emite la
/// salida por eventos `term:out:{id}` y no toca este estado.
struct TermHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

struct Terminals(Mutex<HashMap<String, TermHandle>>);

static TERM_SEQ: AtomicU64 = AtomicU64::new(1);

const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024; // 5 MB

#[derive(serde::Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

/// Ruta legible para el frontend (sin el prefijo `\\?\` de canonicalize en Windows).
fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

/// Canonicaliza `path` y comprueba que quede dentro de la raíz del workspace.
/// Resuelve symlinks, así que un enlace que escape de la raíz se rechaza.
fn ensure_inside_root(root: &State<WorkspaceRoot>, path: &str) -> Result<PathBuf, String> {
    let guard = root.0.lock().map_err(|_| "Estado interno corrupto".to_string())?;
    let root_path = guard
        .as_ref()
        .ok_or_else(|| "No hay carpeta de trabajo abierta".to_string())?;

    let canonical = fs::canonicalize(path).map_err(|_| "Ruta no encontrada".to_string())?;
    if !canonical.starts_with(root_path) {
        return Err("Ruta fuera de la carpeta de trabajo".to_string());
    }
    Ok(canonical)
}

#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn set_workspace_root(path: String, root: State<WorkspaceRoot>) -> Result<String, String> {
    let canonical = fs::canonicalize(&path).map_err(|_| "La carpeta no existe".to_string())?;
    if !canonical.is_dir() {
        return Err("La ruta no es una carpeta".to_string());
    }
    let resolved = display_path(&canonical);
    *root.0.lock().map_err(|_| "Estado interno corrupto".to_string())? = Some(canonical);
    Ok(resolved)
}

#[tauri::command]
fn get_workspace_root(root: State<WorkspaceRoot>) -> Option<String> {
    root.0
        .lock()
        .ok()?
        .as_ref()
        .map(|p| display_path(p))
}

#[tauri::command]
fn read_dir(path: String, root: State<WorkspaceRoot>) -> Result<Vec<FileEntry>, String> {
    let dir = ensure_inside_root(&root, &path)?;

    let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    for entry in entries.flatten() {
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue, // sin permisos: se omite en vez de romper el árbol
        };
        let name = entry.file_name().to_string_lossy().into_owned();

        // Carpetas pesadas que no aportan en el explorador
        if name == ".git" || name == "node_modules" || name == ".venv" || name == "__pycache__" || name == "target" {
            continue;
        }

        result.push(FileEntry {
            name,
            path: display_path(&entry.path()),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
        });
    }

    // Carpetas primero, luego archivos, alfabético
    result.sort_by(|a, b| {
        if a.is_dir != b.is_dir {
            b.is_dir.cmp(&a.is_dir)
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    Ok(result)
}

#[tauri::command]
fn read_file_content(path: String, root: State<WorkspaceRoot>) -> Result<String, String> {
    let file = ensure_inside_root(&root, &path)?;

    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    if meta.len() > MAX_FILE_BYTES {
        return Err("El archivo supera los 5 MB; ábrelo con otra herramienta".to_string());
    }

    fs::read_to_string(&file)
        .map_err(|_| "El archivo no es texto (¿binario?) o no se pudo leer".to_string())
}

#[tauri::command]
fn write_file_content(path: String, content: String, root: State<WorkspaceRoot>) -> Result<(), String> {
    let file = ensure_inside_root(&root, &path)?;
    fs::write(&file, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_new_entry(
    parent_path: String,
    name: String,
    is_dir: bool,
    root: State<WorkspaceRoot>,
) -> Result<(), String> {
    // El nombre debe ser un componente simple: sin separadores ni ".."
    if !is_simple_name(&name) {
        return Err("Nombre de archivo inválido".to_string());
    }

    let parent = ensure_inside_root(&root, &parent_path)?;
    let full_path = parent.join(&name);

    if full_path.exists() {
        return Err("Ya existe una entrada con ese nombre".to_string());
    }

    if is_dir {
        fs::create_dir(&full_path).map_err(|e| e.to_string())
    } else {
        fs::write(&full_path, "").map_err(|e| e.to_string())
    }
}

fn is_simple_name(name: &str) -> bool {
    !(name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\'))
}

// ── Terminales PTY (bash / PowerShell / cmd) ─────────────────────────────

/// Traduce el shell pedido por el frontend a (programa, argumentos) según el SO.
fn resolve_shell(shell: &str) -> (String, Vec<String>) {
    #[cfg(windows)]
    {
        match shell {
            "cmd" => ("cmd.exe".into(), vec![]),
            "bash" => ("bash.exe".into(), vec!["-l".into()]),
            "" | "powershell" => ("powershell.exe".into(), vec!["-NoLogo".into()]),
            other => (other.into(), vec![]),
        }
    }
    #[cfg(not(windows))]
    {
        match shell {
            "" | "bash" => ("bash".into(), vec!["-l".into()]),
            "zsh" => ("zsh".into(), vec!["-l".into()]),
            other => {
                let sh = std::env::var("SHELL").unwrap_or_else(|_| "bash".into());
                if other.is_empty() { (sh, vec![]) } else { (other.into(), vec![]) }
            }
        }
    }
}

/// Abre una sesión de terminal. `cwd` por defecto = carpeta de trabajo.
/// Devuelve el id de la sesión; la salida llega por eventos `term:out:{id}`.
#[tauri::command]
fn term_open(
    app: AppHandle,
    shell: String,
    cwd: Option<String>,
    root: State<WorkspaceRoot>,
    terms: State<Terminals>,
) -> Result<String, String> {
    let workdir = cwd.or_else(|| {
        root.0
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|p| display_path(p)))
    });

    let pair = native_pty_system()
        .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let (program, args) = resolve_shell(&shell);
    let mut cmd = CommandBuilder::new(program);
    for a in args {
        cmd.arg(a);
    }
    if let Some(dir) = workdir {
        cmd.cwd(dir);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // El slave ya no hace falta en el padre: soltarlo evita colgar el cierre.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = format!("t{}", TERM_SEQ.fetch_add(1, Ordering::Relaxed));

    // Hilo lector: bombea la salida del PTY hacia el frontend.
    let out_event = format!("term:out:{id}");
    let exit_event = format!("term:exit:{id}");
    let app_reader = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    if app_reader.emit(&out_event, chunk).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = app_reader.emit(&exit_event, ());
    });

    terms.0.lock().map_err(|_| "Estado interno corrupto".to_string())?.insert(
        id.clone(),
        TermHandle { master: pair.master, writer, child },
    );

    Ok(id)
}

#[tauri::command]
fn term_write(id: String, data: String, terms: State<Terminals>) -> Result<(), String> {
    let mut map = terms.0.lock().map_err(|_| "Estado interno corrupto".to_string())?;
    let handle = map.get_mut(&id).ok_or_else(|| "Terminal no encontrado".to_string())?;
    handle.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    handle.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn term_resize(id: String, cols: u16, rows: u16, terms: State<Terminals>) -> Result<(), String> {
    let map = terms.0.lock().map_err(|_| "Estado interno corrupto".to_string())?;
    let handle = map.get(&id).ok_or_else(|| "Terminal no encontrado".to_string())?;
    handle
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn term_close(id: String, terms: State<Terminals>) -> Result<(), String> {
    let mut map = terms.0.lock().map_err(|_| "Estado interno corrupto".to_string())?;
    if let Some(mut handle) = map.remove(&id) {
        let _ = handle.child.kill();
    }
    Ok(())
}

// ── Git (CLI del sistema) ────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct GitOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

/// Ejecuta `git` con los argumentos dados y captura la salida. Solo para
/// operaciones de lectura/local (status, branch, log, add, commit); las de red
/// (clone/push/pull/fetch) se lanzan desde el terminal integrado para que los
/// prompts de credenciales sean visibles. cwd por defecto = carpeta de trabajo.
#[tauri::command]
fn git_run(
    args: Vec<String>,
    cwd: Option<String>,
    root: State<WorkspaceRoot>,
) -> Result<GitOutput, String> {
    let dir = match cwd {
        Some(c) => ensure_inside_root(&root, &c)?,
        None => root
            .0
            .lock()
            .map_err(|_| "Estado interno corrupto".to_string())?
            .as_ref()
            .cloned()
            .ok_or_else(|| "No hay carpeta de trabajo abierta".to_string())?,
    };

    let output = Command::new("git")
        .args(&args)
        .current_dir(&dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("No se pudo ejecutar git: {e}"))?;

    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WorkspaceRoot(Mutex::new(None)))
        .manage(Terminals(Mutex::new(HashMap::new())))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            set_workspace_root,
            get_workspace_root,
            read_dir,
            read_file_content,
            write_file_content,
            create_new_entry,
            term_open,
            term_write,
            term_resize,
            term_close,
            git_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::is_simple_name;

    #[test]
    fn rechaza_nombres_con_traversal() {
        assert!(!is_simple_name(".."));
        assert!(!is_simple_name("../x"));
        assert!(!is_simple_name("a/b"));
        assert!(!is_simple_name("a\\b"));
        assert!(!is_simple_name(""));
        assert!(is_simple_name("archivo.rs"));
    }
}
