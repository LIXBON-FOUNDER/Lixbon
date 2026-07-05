use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::State;

/// Carpeta de trabajo elegida por el usuario. Todos los comandos de
/// archivos están confinados a ella: sin raíz no hay acceso al disco.
struct WorkspaceRoot(Mutex<Option<PathBuf>>);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WorkspaceRoot(Mutex::new(None)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            set_workspace_root,
            get_workspace_root,
            read_dir,
            read_file_content,
            write_file_content,
            create_new_entry
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
