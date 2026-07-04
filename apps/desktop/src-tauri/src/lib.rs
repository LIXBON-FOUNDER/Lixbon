use std::fs;
use std::path::{Path, PathBuf};

#[derive(serde::Serialize)]
struct FileEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn get_workspace_root() -> String {
    // Obtenemos la ruta absoluta de trabajo
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "c:\\Users\\Usuario\\Desktop\\LLM-DataCent".to_string())
}

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err("Ruta no encontrada".to_string());
    }

    let entries = fs::read_dir(p).map_err(|e| e.to_string())?;
    let mut result = Vec::new();

    for entry in entries {
        if let Ok(entry) = entry {
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            
            // Ignorar carpetas pesadas para optimizar la interfaz del editor
            if name == ".git" || name == "node_modules" || name == ".venv" || name == "__pycache__" {
                continue;
            }

            result.push(FileEntry {
                name,
                path: entry.path().to_string_lossy().into_owned(),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
            });
        }
    }

    // Ordenar: Carpetas primero, luego archivos
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
fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file_content(path: String, content: String) -> Result<(), String> {
    fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_new_entry(parent_path: String, name: String, is_dir: bool) -> Result<(), String> {
    let mut full_path = PathBuf::from(parent_path);
    full_path.push(name);

    if is_dir {
        fs::create_dir_all(full_path).map_err(|e| e.to_string())
    } else {
        fs::write(full_path, "").map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            get_workspace_root,
            read_dir,
            read_file_content,
            write_file_content,
            create_new_entry
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
