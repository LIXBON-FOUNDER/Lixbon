use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Evita que los procesos de consola (git, explorer) abran una ventana propia.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

use portable_pty::{
    native_pty_system, Child, CommandBuilder, MasterPty, PtySize, PtySystem, SlavePty,
};
use tauri::{AppHandle, Emitter, Manager, State};

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

/// Vigilancia del sistema de archivos. `watcher` mantiene vivo el observador de
/// la carpeta actual (al reemplazarlo se deja de vigilar la anterior); `pending`
/// acumula las rutas cambiadas que un hilo emite en lotes al frontend.
struct FsWatchState {
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
    pending: Arc<Mutex<HashSet<String>>>,
}

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

/// Milisegundos desde el epoch de la última modificación (0 si no disponible).
/// Sirve de "versión" del archivo para detectar cambios externos antes de pisarlo.
fn mtime_ms(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Escritura atómica: vuelca a un temporal en la MISMA carpeta y luego renombra.
/// `fs::rename` es atómico dentro de la misma unidad (y sobrescribe en Windows),
/// así que si el proceso muere a mitad, el archivo original queda intacto en vez
/// de quedar truncado/corrupto.
fn write_atomic(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = dest.parent().ok_or_else(|| "Ruta inválida".to_string())?;
    let base = dest
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "f".into());
    let tmp = dir.join(format!(".{base}.lixbon-tmp-{}", std::process::id()));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        let _ = f.sync_all();
    }
    // Conserva permisos del original (best-effort; en Windows se heredan del dir).
    if let Ok(meta) = fs::metadata(dest) {
        let _ = fs::set_permissions(&tmp, meta.permissions());
    }
    match fs::rename(&tmp, dest) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
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
fn set_workspace_root(
    path: String,
    root: State<WorkspaceRoot>,
    fs_watch: State<FsWatchState>,
) -> Result<String, String> {
    let canonical = fs::canonicalize(&path).map_err(|_| "La carpeta no existe".to_string())?;
    if !canonical.is_dir() {
        return Err("La ruta no es una carpeta".to_string());
    }
    let resolved = display_path(&canonical);
    start_fs_watch(&fs_watch, &canonical);
    *root.0.lock().map_err(|_| "Estado interno corrupto".to_string())? = Some(canonical);
    Ok(resolved)
}

/// ¿Algún componente de la ruta es una carpeta ignorada (node_modules, .git…)?
/// Filtra el ruido de instalaciones/builds para no inundar de eventos al frontend.
fn path_has_skip_component(p: &Path) -> bool {
    p.components().any(|c| {
        matches!(c, std::path::Component::Normal(os) if skip_dir(&os.to_string_lossy()))
    })
}

/// (Re)inicia la vigilancia recursiva de `root`. El watcher previo se descarta
/// aquí (deja de vigilar la carpeta anterior). Si falla, la app sigue: solo no
/// habrá auto-refresco.
fn start_fs_watch(state: &State<FsWatchState>, root: &Path) {
    use notify::Watcher;
    let pending = state.pending.clone();
    let mut watcher = match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let event = match res {
            Ok(e) => e,
            Err(_) => return,
        };
        if let Ok(mut set) = pending.lock() {
            for path in event.paths {
                if !path_has_skip_component(&path) {
                    set.insert(display_path(&path));
                }
            }
        }
    }) {
        Ok(w) => w,
        Err(_) => return,
    };
    if watcher.watch(root, notify::RecursiveMode::Recursive).is_err() {
        return;
    }
    if let Ok(mut guard) = state.watcher.lock() {
        *guard = Some(watcher); // el anterior se dropea aquí
    }
}

/// Hilo perpetuo: cada 300 ms vacía el acumulador y emite `fs:changed` con el
/// lote de rutas cambiadas (coalescer: evita una avalancha de eventos IPC).
fn spawn_fs_emitter(app: AppHandle, pending: Arc<Mutex<HashSet<String>>>) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(300));
        let batch: Vec<String> = match pending.lock() {
            Ok(mut set) if !set.is_empty() => set.drain().collect(),
            _ => continue,
        };
        let _ = app.emit("fs:changed", batch);
    });
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
fn write_file_content(
    path: String,
    content: String,
    expected_mtime: Option<f64>,
    root: State<WorkspaceRoot>,
) -> Result<f64, String> {
    let file = ensure_inside_root(&root, &path)?;

    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("El contenido supera los 5 MB permitidos".to_string());
    }

    // Guardia anti-clobber: si el archivo cambió en disco desde que el editor lo
    // cargó (mtime distinto), no lo pisamos a ciegas — el frontend decide.
    if let Some(expected) = expected_mtime {
        if let Ok(meta) = fs::metadata(&file) {
            let current = mtime_ms(&meta);
            if (current - expected).abs() > 1.0 {
                return Err(format!("CONFLICT:{current}"));
            }
        }
    }

    write_atomic(&file, content.as_bytes())?;
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    Ok(mtime_ms(&meta))
}

/// mtime del archivo en ms (la "versión" que el editor guarda al abrirlo).
#[tauri::command]
fn stat_file(path: String, root: State<WorkspaceRoot>) -> Result<f64, String> {
    let file = ensure_inside_root(&root, &path)?;
    let meta = fs::metadata(&file).map_err(|e| e.to_string())?;
    Ok(mtime_ms(&meta))
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

/// ¿Es `p` exactamente la raíz del workspace? (la raíz no se renombra/borra)
fn is_workspace_root(root: &State<WorkspaceRoot>, p: &Path) -> bool {
    root.0
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|r| r.as_path() == p))
        .unwrap_or(false)
}

#[tauri::command]
fn rename_entry(path: String, new_name: String, root: State<WorkspaceRoot>) -> Result<String, String> {
    if !is_simple_name(&new_name) {
        return Err("Nombre inválido".to_string());
    }
    let target = ensure_inside_root(&root, &path)?;
    if is_workspace_root(&root, &target) {
        return Err("No se puede renombrar la carpeta de trabajo".to_string());
    }
    let parent = target.parent().ok_or_else(|| "Sin carpeta padre".to_string())?;
    let dest = parent.join(&new_name);
    if dest.exists() {
        return Err("Ya existe una entrada con ese nombre".to_string());
    }
    fs::rename(&target, &dest).map_err(|e| e.to_string())?;
    Ok(display_path(&dest))
}

#[tauri::command]
fn delete_entry(path: String, root: State<WorkspaceRoot>) -> Result<(), String> {
    let target = ensure_inside_root(&root, &path)?;
    if is_workspace_root(&root, &target) {
        return Err("No se puede eliminar la carpeta de trabajo".to_string());
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| e.to_string())
    } else {
        fs::remove_file(&target).map_err(|e| e.to_string())
    }
}

/// Mueve una entrada a otra carpeta (drag & drop del explorador). Devuelve la
/// nueva ruta. Guarda contra: mover la raíz, destino que no es carpeta, mover
/// una carpeta dentro de sí misma o de un descendiente, y pisar algo existente.
#[tauri::command]
fn move_entry(path: String, dest_dir: String, root: State<WorkspaceRoot>) -> Result<String, String> {
    let src = ensure_inside_root(&root, &path)?;
    let dst_dir = ensure_inside_root(&root, &dest_dir)?;
    if is_workspace_root(&root, &src) {
        return Err("No se puede mover la carpeta de trabajo".to_string());
    }
    if !dst_dir.is_dir() {
        return Err("El destino no es una carpeta".to_string());
    }
    let name = src.file_name().ok_or_else(|| "Ruta inválida".to_string())?;
    let dest = dst_dir.join(name);
    if dest == src {
        return Ok(display_path(&src)); // ya está en esa carpeta
    }
    // starts_with(src) cubre tanto el propio origen como cualquier descendiente.
    if dst_dir.starts_with(&src) {
        return Err("No se puede mover una carpeta dentro de sí misma".to_string());
    }
    if dest.exists() {
        return Err("Ya existe una entrada con ese nombre en el destino".to_string());
    }
    fs::rename(&src, &dest).map_err(|e| e.to_string())?;
    Ok(display_path(&dest))
}

fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dst).map(|_| ())
    }
}

/// Crea "nombre copia.ext" (o "nombre copia 2.ext", …) junto al original.
#[tauri::command]
fn duplicate_entry(path: String, root: State<WorkspaceRoot>) -> Result<String, String> {
    let target = ensure_inside_root(&root, &path)?;
    if is_workspace_root(&root, &target) {
        return Err("No se puede duplicar la carpeta de trabajo".to_string());
    }
    let parent = target.parent().ok_or_else(|| "Sin carpeta padre".to_string())?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "Nombre inválido".to_string())?
        .to_string_lossy()
        .into_owned();

    // Extensión solo para archivos y sin contar los que empiezan por punto (.env)
    let (stem, ext) = match file_name.rsplit_once('.') {
        Some((s, e)) if target.is_file() && !s.is_empty() => (s.to_string(), format!(".{e}")),
        _ => (file_name.clone(), String::new()),
    };

    let mut dest = parent.join(format!("{stem} copia{ext}"));
    let mut n = 2u32;
    while dest.exists() {
        dest = parent.join(format!("{stem} copia {n}{ext}"));
        n += 1;
        if n > 500 {
            return Err("Demasiadas copias".to_string());
        }
    }

    copy_recursive(&target, &dest).map_err(|e| e.to_string())?;
    Ok(display_path(&dest))
}

/// Abre el explorador del SO con la entrada seleccionada.
#[tauri::command]
fn reveal_in_os(path: String, root: State<WorkspaceRoot>) -> Result<(), String> {
    let target = ensure_inside_root(&root, &path)?;
    let shown = display_path(&target);

    #[cfg(target_os = "windows")]
    {
        hide_console(Command::new("explorer").arg(format!("/select,{shown}")))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg("-R").arg(&shown).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = target.parent().map(display_path).unwrap_or(shown);
        Command::new("xdg-open").arg(dir).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Búsqueda en el workspace ─────────────────────────────────────────────

/// Carpetas que no aportan al buscar/listar (dependencias, builds, VCS).
const SKIP_DIRS: [&str; 9] = [
    ".git", "node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build", ".next",
];

fn skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

fn workspace_path(root: &State<WorkspaceRoot>) -> Result<PathBuf, String> {
    root.0
        .lock()
        .map_err(|_| "Estado interno corrupto".to_string())?
        .as_ref()
        .cloned()
        .ok_or_else(|| "No hay carpeta de trabajo abierta".to_string())
}

#[derive(serde::Serialize)]
struct SearchHit {
    path: String,
    name: String,
    line: u32,
    text: String,
}

const SEARCH_MAX_HITS: usize = 500;
const SEARCH_MAX_FILE_BYTES: u64 = 1024 * 1024; // 1 MB por archivo

/// Compila la consulta con las opciones de la UI. En modo literal se escapa la
/// consulta; `whole_word` la envuelve en límites de palabra; `case_sensitive`
/// falso añade insensibilidad a mayúsculas. Unifica búsqueda y reemplazo.
fn build_query_regex(
    query: &str,
    case_sensitive: bool,
    is_regex: bool,
    whole_word: bool,
) -> Result<regex::Regex, String> {
    let mut pat = if is_regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    if whole_word {
        pat = format!(r"\b(?:{pat})\b");
    }
    regex::RegexBuilder::new(&pat)
        .case_insensitive(!case_sensitive)
        .size_limit(10 * (1 << 20)) // 10 MB de programa: frena regex patológicas
        .build()
        .map_err(|e| format!("Expresión de búsqueda inválida: {e}"))
}

fn search_walk(dir: &Path, re: &regex::Regex, hits: &mut Vec<SearchHit>) {
    if hits.len() >= SEARCH_MAX_HITS {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        if hits.len() >= SEARCH_MAX_HITS {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if path.is_dir() {
            if !skip_dir(&name) {
                subdirs.push(path);
            }
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > SEARCH_MAX_FILE_BYTES {
            continue;
        }
        // read_to_string falla en binarios no-UTF8; el NUL cubre el resto
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if content.contains('\0') {
            continue;
        }
        for (i, line) in content.lines().enumerate() {
            if re.is_match(line) {
                hits.push(SearchHit {
                    path: display_path(&path),
                    name: name.clone(),
                    line: (i + 1) as u32,
                    text: line.trim().chars().take(240).collect(),
                });
                if hits.len() >= SEARCH_MAX_HITS {
                    return;
                }
            }
        }
    }
    for d in subdirs {
        search_walk(&d, re, hits);
        if hits.len() >= SEARCH_MAX_HITS {
            return;
        }
    }
}

/// Busca en todos los archivos del workspace. `is_regex` interpreta la consulta
/// como expresión regular; `case_sensitive`/`whole_word` afinan la coincidencia.
#[tauri::command]
async fn search_in_files(
    query: String,
    case_sensitive: bool,
    is_regex: bool,
    whole_word: bool,
    root: State<'_, WorkspaceRoot>,
) -> Result<Vec<SearchHit>, String> {
    let base = workspace_path(&root)?;
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let re = build_query_regex(&query, case_sensitive, is_regex, whole_word)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut hits = Vec::new();
        search_walk(&base, &re, &mut hits);
        hits
    })
    .await
    .map_err(|e| e.to_string())
}

// ── Reemplazo global (buscar y reemplazar en todo el workspace) ──────────

#[derive(serde::Serialize)]
struct ReplaceResult {
    files: usize,
    replacements: usize,
}

fn replace_walk(
    dir: &Path,
    re: &regex::Regex,
    replacement: &str,
    is_regex: bool,
    res: &mut ReplaceResult,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if path.is_dir() {
            if !skip_dir(&name) {
                subdirs.push(path);
            }
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.len() > SEARCH_MAX_FILE_BYTES {
            continue;
        }
        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue, // binario/no-UTF8: se omite
        };
        if content.contains('\0') {
            continue;
        }
        let count = re.find_iter(&content).count();
        if count == 0 {
            continue;
        }
        // En modo regex el reemplazo expande $1, ${name}…; en modo literal se
        // trata tal cual (NoExpand) para que un "$" del usuario no se interprete.
        let new_content = if is_regex {
            re.replace_all(&content, replacement).into_owned()
        } else {
            re.replace_all(&content, regex::NoExpand(replacement)).into_owned()
        };
        if write_atomic(&path, new_content.as_bytes()).is_ok() {
            res.files += 1;
            res.replacements += count;
        }
    }
    for d in subdirs {
        replace_walk(&d, re, replacement, is_regex, res);
    }
}

/// Reemplaza `query` por `replacement` en todos los archivos de texto del
/// workspace (mismos filtros/opciones que la búsqueda). Escritura atómica por
/// archivo.
#[tauri::command]
async fn replace_in_files(
    query: String,
    replacement: String,
    case_sensitive: bool,
    is_regex: bool,
    whole_word: bool,
    root: State<'_, WorkspaceRoot>,
) -> Result<ReplaceResult, String> {
    let base = workspace_path(&root)?;
    if query.trim().len() < 2 {
        return Err("El término de búsqueda es demasiado corto".to_string());
    }
    let re = build_query_regex(&query, case_sensitive, is_regex, whole_word)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut res = ReplaceResult { files: 0, replacements: 0 };
        replace_walk(&base, &re, &replacement, is_regex, &mut res);
        res
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct QuickFile {
    name: String,
    path: String,
    rel: String,
}

const LIST_MAX_FILES: usize = 5000;

fn files_walk(base: &Path, dir: &Path, out: &mut Vec<QuickFile>) {
    if out.len() >= LIST_MAX_FILES {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        if out.len() >= LIST_MAX_FILES {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        if path.is_dir() {
            if !skip_dir(&name) {
                subdirs.push(path);
            }
            continue;
        }
        let rel = path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| name.clone());
        out.push(QuickFile { name, path: display_path(&path), rel });
    }
    for d in subdirs {
        files_walk(base, &d, out);
        if out.len() >= LIST_MAX_FILES {
            return;
        }
    }
}

/// Lista (plana) de archivos del workspace para el buscador rápido Ctrl+P.
#[tauri::command]
async fn list_files(root: State<'_, WorkspaceRoot>) -> Result<Vec<QuickFile>, String> {
    let base = workspace_path(&root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        files_walk(&base, &base, &mut out);
        out
    })
    .await
    .map_err(|e| e.to_string())
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

// ── LSP (servidores de lenguaje) ─────────────────────────────────────────
//
// Rust solo hace de transporte: lanza el servidor, desenmarca el framing de
// LSP (`Content-Length: N\r\n\r\n{json}`) y emite cada mensaje entero al
// frontend, que es quien habla JSON-RPC. Un servidor por `id` (= lenguaje).

/// Servidor de lenguaje vivo. El hilo lector no toca este estado: aquí solo
/// queda stdin (para escribir) y el hijo (para matarlo al parar).
struct LspHandle {
    stdin: std::process::ChildStdin,
    child: std::process::Child,
}

struct LspServers(Mutex<HashMap<String, LspHandle>>);

/// Tope de un mensaje LSP. rust-analyzer manda respuestas enormes en repos
/// grandes, pero un `Content-Length` absurdo solo puede ser un marco corrupto.
const MAX_LSP_MESSAGE: usize = 64 * 1024 * 1024;

/// Lee un mensaje del framing de LSP: cabeceras `Clave: valor` hasta una línea
/// vacía, y después `Content-Length` bytes de cuerpo JSON.
/// `Ok(None)` = EOF o marco irrecuperable → el hilo lector termina.
fn read_lsp_message<R: std::io::BufRead>(reader: &mut R) -> std::io::Result<Option<String>> {
    let mut len: Option<usize> = None;
    let mut line = String::new();

    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(None); // el servidor cerró stdout
        }
        let header = line.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break; // línea en blanco: acaban las cabeceras
        }
        if let Some(value) = header.strip_prefix("Content-Length:") {
            len = value.trim().parse().ok();
        }
    }

    let Some(len) = len else {
        return Ok(None); // sin Content-Length no hay forma de desenmarcar
    };
    if len > MAX_LSP_MESSAGE {
        return Ok(None);
    }

    let mut body = vec![0u8; len];
    reader.read_exact(&mut body)?;
    Ok(Some(String::from_utf8_lossy(&body).into_owned()))
}

/// Busca el ejecutable en el PATH. En Windows hay que probar las extensiones de
/// PATHEXT a mano: CreateProcess solo añade `.exe`, y casi todos los servidores
/// que se instalan con npm (pyright, typescript-language-server…) quedan como
/// `.cmd`, así que sin esto «no se encuentra» aunque estén instalados.
fn resolve_program(program: &str) -> Option<PathBuf> {
    let direct = Path::new(program);
    if direct.is_absolute() {
        return direct.is_file().then(|| direct.to_path_buf());
    }

    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string());
            for ext in exts.split(';').filter(|e| !e.is_empty()) {
                let candidate = dir.join(format!("{program}{ext}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

/// Prepara el proceso del servidor. Los `.cmd`/`.bat` son scripts: CreateProcess
/// no los ejecuta, hay que pasarlos por `cmd /C`.
fn build_lsp_command(program: &str, args: &[String]) -> Result<Command, String> {
    let resolved = resolve_program(program).ok_or_else(|| {
        format!("No se encontró «{program}» en el PATH. Instálalo y reinicia lixbon.")
    })?;

    #[cfg(windows)]
    {
        let is_script = resolved
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
            .unwrap_or(false);
        if is_script {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(&resolved).args(args);
            return Ok(cmd);
        }
    }

    let mut cmd = Command::new(&resolved);
    cmd.args(args);
    Ok(cmd)
}

// ── Instalación de servidores ────────────────────────────────────────────
//
// Los servidores se instalan en el app-data de lixbon (NO globales: no hacen
// falta permisos de administrador ni tocan el PATH del usuario). Si el usuario
// ya tiene uno instalado por su cuenta, ese gana.

fn servers_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("servers");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Nombres de archivo válidos para un ejecutable. En Windows se EXCLUYE el
/// nombre pelado a propósito: npm deja junto al `.cmd` un script de shell sin
/// extensión que CreateProcess no sabe ejecutar.
fn binary_names(bin: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![format!("{bin}.exe"), format!("{bin}.cmd"), format!("{bin}.bat")]
    }
    #[cfg(not(windows))]
    {
        vec![bin.to_string()]
    }
}

fn find_file(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let mut subdirs = Vec::new();
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            subdirs.push(path);
        } else if path.file_name().and_then(|n| n.to_str()) == Some(name) {
            return Some(path);
        }
    }
    for sub in subdirs {
        if let Some(found) = find_file(&sub, name, depth - 1) {
            return Some(found);
        }
    }
    None
}

/// Busca el ejecutable dentro de la carpeta gestionada. Primero los sitios
/// donde debería estar (npm lo deja en `node_modules/.bin`), y si no, se
/// rastrea el árbol: los zips de rust-analyzer/clangd lo anidan.
fn find_managed_binary(dir: &Path, bin: &str) -> Option<PathBuf> {
    let names = binary_names(bin);
    for name in &names {
        for candidate in [dir.join("node_modules").join(".bin").join(name), dir.join(name)] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for name in &names {
        if let Some(found) = find_file(dir, name, 4) {
            return Some(found);
        }
    }
    None
}

/// Ruta del servidor `bin`: primero el instalado por lixbon, luego el PATH del
/// sistema. `None` = no está.
#[tauri::command]
fn lsp_resolve(app: AppHandle, id: String, bin: String) -> Result<Option<String>, String> {
    let dir = servers_dir(&app)?.join(sanitize_component(&id));
    if dir.is_dir() {
        if let Some(path) = find_managed_binary(&dir, &bin) {
            return Ok(Some(display_path(&path)));
        }
    }
    Ok(resolve_program(&bin).map(|p| display_path(&p)))
}

/// Busca un binario instalado por el propio proyecto (`node_modules/.bin/<bin>`),
/// subiendo desde la carpeta del archivo hasta la raíz del workspace — igual que
/// hace VSCode con eslint/prettier. `None` si el proyecto no lo trae.
#[tauri::command]
fn resolve_project_bin(
    start_dir: String,
    bin: String,
    root: State<WorkspaceRoot>,
) -> Result<Option<String>, String> {
    let start = ensure_inside_root(&root, &start_dir)?;
    let root_dir = workspace_path(&root)?;
    let names = binary_names(&bin);
    let mut dir: PathBuf = if start.is_dir() {
        start
    } else {
        start.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| root_dir.clone())
    };
    loop {
        for name in &names {
            let cand = dir.join("node_modules").join(".bin").join(name);
            if cand.is_file() {
                return Ok(Some(display_path(&cand)));
            }
        }
        if dir == root_dir {
            break;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    Ok(None)
}

/// Config plano por defecto de ESLint que usa lixbon cuando el proyecto no trae
/// el suyo: reglas de núcleo (sin plugins) para que el análisis funcione «de
/// fábrica». `.mjs` para forzar ESM sin depender del package.json del proyecto.
const ESLINT_DEFAULT_CONFIG: &str = r#"// Config por defecto de lixbon (solo reglas de núcleo, sin plugins).
export default [
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly', window: 'readonly', document: 'readonly',
        process: 'readonly', module: 'readonly', require: 'readonly',
        __dirname: 'readonly', setTimeout: 'readonly', setInterval: 'readonly',
        fetch: 'readonly', globalThis: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-undef': 'error',
      'no-unreachable': 'warn',
      'no-constant-condition': 'warn',
    },
  },
];
"#;

/// Asegura el config por defecto de ESLint en la app-data de lixbon y devuelve
/// su ruta. Se pasa con `--config` cuando el proyecto no tiene uno propio.
#[tauri::command]
fn eslint_default_config(app: AppHandle) -> Result<String, String> {
    let dir = servers_dir(&app)?.join("tool-eslint");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cfg = dir.join("eslint.config.mjs");
    if !cfg.is_file() {
        fs::write(&cfg, ESLINT_DEFAULT_CONFIG).map_err(|e| e.to_string())?;
    }
    Ok(display_path(&cfg))
}

/// Instala un servidor publicado en npm, local a lixbon (`npm install --prefix`).
/// Devuelve la ruta del ejecutable. Requiere Node.js en el sistema.
#[tauri::command]
async fn lsp_install_npm(
    app: AppHandle,
    id: String,
    package: String,
    bin: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = servers_dir(&app)?.join(sanitize_component(&id));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        let args: Vec<String> = vec![
            "install".into(),
            "--prefix".into(),
            display_path(&dir),
            "--no-audit".into(),
            "--no-fund".into(),
            "--loglevel".into(),
            "error".into(),
            package.clone(),
        ];
        let mut cmd = build_lsp_command("npm", &args)
            .map_err(|_| "Necesitas Node.js instalado (no se encontró npm).".to_string())?;
        cmd.current_dir(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console(&mut cmd);

        let out = cmd.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("npm falló instalando {package}: {}", err.trim()));
        }

        find_managed_binary(&dir, &bin)
            .map(|p| display_path(&p))
            .ok_or_else(|| format!("Se instaló {package}, pero no apareció «{bin}»."))
    })
    .await
    .map_err(|e| e.to_string())?
}

const SERVER_MAX_BYTES: usize = 200 * 1024 * 1024;

/// Descarga un servidor distribuido como .zip (releases de GitHub) y lo extrae
/// en el app-data. Devuelve la ruta del ejecutable.
#[tauri::command]
async fn lsp_install_archive(
    app: AppHandle,
    id: String,
    url: String,
    bin: String,
) -> Result<String, String> {
    if !url.starts_with("https://github.com/") {
        return Err("Solo se descargan servidores desde github.com".to_string());
    }

    let resp = tauri_plugin_http::reqwest::get(&url)
        .await
        .map_err(|e| format!("Descarga fallida: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Descarga fallida ({})", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > SERVER_MAX_BYTES {
        return Err("El servidor supera los 200 MB".to_string());
    }
    let data = bytes.to_vec();

    tauri::async_runtime::spawn_blocking(move || {
        let dir = servers_dir(&app)?.join(sanitize_component(&id));
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())?; // reinstalar limpio
        }
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        unzip_into(data, &dir)?;
        find_managed_binary(&dir, &bin)
            .map(|p| display_path(&p))
            .ok_or_else(|| format!("El archivo no contenía «{bin}»."))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn unzip_into(data: Vec<u8>, dir: &Path) -> Result<(), String> {
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(data)).map_err(|e| format!("Zip inválido: {e}"))?;
    if zip.len() > VSIX_MAX_ENTRIES {
        return Err("El archivo tiene demasiadas entradas".to_string());
    }

    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name() ya descarta rutas absolutas y `..` (zip slip).
        let Some(rel) = entry.enclosed_name() else { continue };
        let out = dir.join(rel);

        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        total += entry.size();
        if total > VSIX_MAX_UNCOMPRESSED {
            return Err("El archivo es demasiado grande al descomprimir".to_string());
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut file = fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut file).map_err(|e| e.to_string())?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Some(mode) = entry.unix_mode() {
                let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode));
            }
        }
    }
    Ok(())
}

/// Borra un servidor instalado por lixbon (para reinstalarlo limpio).
#[tauri::command]
fn lsp_uninstall_server(app: AppHandle, id: String) -> Result<(), String> {
    let dir = servers_dir(&app)?.join(sanitize_component(&id));
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn lsp_kill(id: &str, servers: &State<LspServers>) -> Result<(), String> {
    let mut map = servers.0.lock().map_err(|_| "Estado interno corrupto".to_string())?;
    if let Some(mut handle) = map.remove(id) {
        let _ = handle.child.kill();
        let _ = handle.child.wait();
    }
    Ok(())
}

/// Lanza un servidor de lenguaje en la carpeta de trabajo. Los mensajes que
/// emita llegan por el evento `lsp:msg:{id}` (JSON ya desenmarcado), sus logs
/// por `lsp:err:{id}` y su muerte por `lsp:exit:{id}`.
#[tauri::command]
fn lsp_start(
    app: AppHandle,
    id: String,
    command: String,
    args: Vec<String>,
    root: State<WorkspaceRoot>,
    servers: State<LspServers>,
) -> Result<(), String> {
    let dir = workspace_path(&root)?;
    lsp_kill(&id, &servers)?; // reiniciar = matar el anterior

    let mut cmd = build_lsp_command(&command, &args)?;
    cmd.current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("No se pudo iniciar «{command}»: {e}"))?;

    let stdin = child.stdin.take().ok_or("El servidor no expuso stdin")?;
    let stdout = child.stdout.take().ok_or("El servidor no expuso stdout")?;
    let stderr = child.stderr.take().ok_or("El servidor no expuso stderr")?;

    let msg_event = format!("lsp:msg:{id}");
    let exit_event = format!("lsp:exit:{id}");
    let app_out = app.clone();
    thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stdout);
        while let Ok(Some(msg)) = read_lsp_message(&mut reader) {
            if app_out.emit(&msg_event, msg).is_err() {
                break; // la ventana se fue
            }
        }
        let _ = app_out.emit(&exit_event, ());
    });

    // Los servidores usan stderr para logs; se reenvía para poder depurarlos.
    let err_event = format!("lsp:err:{id}");
    let app_err = app.clone();
    thread::spawn(move || {
        let mut reader = std::io::BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let _ = app_err.emit(&err_event, line.trim_end().to_string());
                }
            }
        }
    });

    servers
        .0
        .lock()
        .map_err(|_| "Estado interno corrupto".to_string())?
        .insert(id, LspHandle { stdin, child });

    Ok(())
}

/// Envía un mensaje JSON-RPC ya serializado (el framing lo pone Rust).
#[tauri::command]
fn lsp_send(id: String, message: String, servers: State<LspServers>) -> Result<(), String> {
    let mut map = servers.0.lock().map_err(|_| "Estado interno corrupto".to_string())?;
    let handle = map
        .get_mut(&id)
        .ok_or_else(|| "Servidor de lenguaje no encontrado".to_string())?;

    let body = message.as_bytes();
    handle
        .stdin
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .map_err(|e| e.to_string())?;
    handle.stdin.write_all(body).map_err(|e| e.to_string())?;
    handle.stdin.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn lsp_stop(id: String, servers: State<LspServers>) -> Result<(), String> {
    lsp_kill(&id, &servers)
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

    let output = hide_console(
        Command::new("git")
            .args(&args)
            .current_dir(&dir)
            .env("GIT_TERMINAL_PROMPT", "0"),
    )
    .output()
    .map_err(|e| format!("No se pudo ejecutar git: {e}"))?;

    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        code: output.status.code().unwrap_or(-1),
    })
}

#[derive(serde::Serialize)]
struct CmdOutput {
    stdout: String,
    stderr: String,
    code: i32,
    timed_out: bool,
}

/// Ejecuta un comando de shell en la carpeta de trabajo y captura la salida.
/// Para el agente del chat (tests, builds, instalación de dependencias); el
/// frontend pide aprobación antes de llamarlo. Timeout duro con kill.
#[tauri::command]
async fn run_command(
    command: String,
    timeout_ms: Option<u64>,
    cwd: Option<String>,
    root: State<'_, WorkspaceRoot>,
) -> Result<CmdOutput, String> {
    // cwd opcional (p. ej. la carpeta del archivo para que eslint encuentre su
    // config); si no se pasa, la carpeta de trabajo. Siempre dentro de la raíz.
    let dir = match cwd {
        Some(c) => ensure_inside_root(&root, &c)?,
        None => workspace_path(&root)?,
    };
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1_000, 600_000));
    tauri::async_runtime::spawn_blocking(move || run_command_blocking(command, dir, timeout))
        .await
        .map_err(|e| e.to_string())?
}

/// Máximo de bytes de salida (por flujo) que se conservan en memoria. Se guarda
/// la cola; el resto se descarta pero se sigue drenando el pipe.
const CMD_OUTPUT_CAP: usize = 2 * 1024 * 1024; // 2 MB

/// Lee todo el pipe pero mantiene en memoria como mucho ~`cap` bytes finales.
/// El recorte se hace de forma amortizada (solo al duplicar `cap`), así el coste
/// total es lineal aunque el proceso escriba sin parar.
fn read_tail_capped<R: Read>(mut pipe: R, cap: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 16384];
    loop {
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.len() > cap * 2 {
                    let drop = out.len() - cap;
                    out.drain(0..drop);
                }
            }
            Err(_) => break,
        }
    }
    out
}

fn run_command_blocking(command: String, dir: PathBuf, timeout: Duration) -> Result<CmdOutput, String> {
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        // Command escaparía las comillas internas al estilo C (\"), pero cmd.exe
        // las trata literalmente y rompe cualquier ruta entrecomillada (p. ej.
        // "…\.bin\eslint.cmd"). raw_arg pasa la línea verbatim; /S hace que cmd
        // quite solo la primera y última comilla y ejecute el resto tal cual.
        c.raw_arg(format!("/S /C \"{command}\""));
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    cmd.current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("No se pudo ejecutar el comando: {e}"))?;

    // Lectores en hilos: sin drenar los pipes, un proceso verboso se bloquea.
    // read_tail_capped sigue drenando pero conserva en memoria solo la COLA (que
    // es donde viven los errores), así un comando que escupe gigas no agota RAM.
    let out_pipe = child.stdout.take().ok_or_else(|| "Sin stdout".to_string())?;
    let err_pipe = child.stderr.take().ok_or_else(|| "Sin stderr".to_string())?;
    let out_h = thread::spawn(move || read_tail_capped(out_pipe, CMD_OUTPUT_CAP));
    let err_h = thread::spawn(move || read_tail_capped(err_pipe, CMD_OUTPUT_CAP));

    let start = Instant::now();
    let mut timed_out = false;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break -1;
                }
                thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(e.to_string()),
        }
    };

    // Se conserva la COLA de la salida: ahí viven los errores que importan.
    fn tail_utf8(v: Vec<u8>) -> String {
        let s = String::from_utf8_lossy(&v).into_owned();
        if s.len() <= 20_000 {
            return s;
        }
        let mut cut = s.len() - 20_000;
        while !s.is_char_boundary(cut) {
            cut += 1;
        }
        s[cut..].to_string()
    }

    Ok(CmdOutput {
        stdout: tail_utf8(out_h.join().unwrap_or_default()),
        stderr: tail_utf8(err_h.join().unwrap_or_default()),
        code,
        timed_out,
    })
}

/// Extrae "repo" de URLs tipo https://github.com/u/repo.git o git@host:u/repo.git
fn repo_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next()?;
    let name = last.trim_end_matches(".git").trim();
    if name.is_empty() || !is_simple_name(name) {
        None
    } else {
        Some(name.to_string())
    }
}

/// Clona `url` dentro de `dest_parent` (elegido con el diálogo nativo, por eso
/// no pasa por el sandbox del workspace). El progreso de git (stderr) se
/// retransmite por el evento `git:clone:out`. Devuelve la ruta del repo clonado.
/// Async + spawn_blocking: un clon tarda minutos y no debe congelar la UI.
#[tauri::command]
async fn git_clone(app: AppHandle, url: String, dest_parent: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_clone_blocking(app, url, dest_parent))
        .await
        .map_err(|e| e.to_string())?
}

fn git_clone_blocking(app: AppHandle, url: String, dest_parent: String) -> Result<String, String> {
    let parent = fs::canonicalize(&dest_parent).map_err(|_| "La carpeta destino no existe".to_string())?;
    if !parent.is_dir() {
        return Err("El destino no es una carpeta".to_string());
    }
    let name = repo_name_from_url(&url).ok_or_else(|| "URL de repositorio no válida".to_string())?;

    // Ruta legible (sin \\?\) para git y para el frontend
    let target = PathBuf::from(display_path(&parent)).join(&name);
    if target.exists() {
        return Err(format!("Ya existe una carpeta \"{name}\" en el destino"));
    }

    let mut cmd = Command::new("git");
    cmd.arg("clone")
        .arg("--progress")
        .arg(url.trim())
        .arg(&target)
        // Sin terminal no hay dónde escribir credenciales: falla rápido en vez de
        // colgarse (el credential manager gráfico de Windows sí puede aparecer).
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    hide_console(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| format!("No se pudo ejecutar git: {e}"))?;
    let mut stderr = child.stderr.take().ok_or_else(|| "Sin salida de git".to_string())?;

    // git escribe el progreso por stderr; se retransmite y se guarda la cola
    // para poder mostrar el motivo real si el clon falla.
    let app_reader = app.clone();
    let reader = thread::spawn(move || {
        let mut buf = [0u8; 2048];
        let mut tail = String::new();
        loop {
            match stderr.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                    tail.push_str(&chunk);
                    if tail.len() > 4000 {
                        let mut cut = tail.len() - 2000;
                        while !tail.is_char_boundary(cut) {
                            cut += 1;
                        }
                        tail.drain(..cut);
                    }
                    let _ = app_reader.emit("git:clone:out", chunk);
                }
            }
        }
        tail
    });

    let status = child.wait().map_err(|e| e.to_string())?;
    let tail = reader.join().unwrap_or_default();

    if status.success() {
        Ok(display_path(&target))
    } else {
        let reason = tail
            .split(['\n', '\r'])
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("git clone falló")
            .to_string();
        Err(reason)
    }
}

// ── Extensiones: soporte declarativo de VSCode vía Open VSX ─────────────
// Un IDE CodeMirror no puede ejecutar el extension host de VSCode, así que
// se extrae TODO lo declarativo del .vsix: temas de color, gramáticas
// TextMate, snippets, temas de iconos y declaraciones de lenguajes. El
// código (main/browser) no se ejecuta y se avisa con `warnings`.

/// Los JSON de temas de VSCode suelen ser JSONC: comentarios y comas finales.
fn clean_jsonc(src: &str) -> String {
    // Algunos archivos vienen con BOM UTF-8, que serde_json rechaza.
    let src = src.trim_start_matches('\u{feff}');
    // 1) quitar comentarios // y /* */ (respetando strings)
    let mut no_comments = String::with_capacity(src.len());
    let mut chars = src.chars().peekable();
    let mut in_str = false;
    let mut esc = false;
    while let Some(c) = chars.next() {
        if in_str {
            no_comments.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_str = true;
                no_comments.push(c);
            }
            '/' => match chars.peek() {
                Some('/') => {
                    while let Some(&n) = chars.peek() {
                        if n == '\n' {
                            break;
                        }
                        chars.next();
                    }
                }
                Some('*') => {
                    chars.next();
                    let mut prev = ' ';
                    for n in chars.by_ref() {
                        if prev == '*' && n == '/' {
                            break;
                        }
                        prev = n;
                    }
                }
                _ => no_comments.push(c),
            },
            _ => no_comments.push(c),
        }
    }

    // 2) quitar comas finales antes de } o ] (respetando strings)
    let bytes: Vec<char> = no_comments.chars().collect();
    let mut out = String::with_capacity(no_comments.len());
    let mut in_str = false;
    let mut esc = false;
    for (i, &c) in bytes.iter().enumerate() {
        if in_str {
            out.push(c);
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        if c == '"' {
            in_str = true;
            out.push(c);
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_whitespace() {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == '}' || bytes[j] == ']') {
                continue; // coma final: fuera
            }
        }
        out.push(c);
    }
    out
}

/// Nombre seguro para carpeta/archivo (id de extensión, label de tema).
fn sanitize_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() { "ext".to_string() } else { trimmed }
}

fn extensions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("extensions");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Ruta relativa segura dentro de un .vsix: sin absolutos, sin `..`, sin unidad.
fn safe_rel_path(rel: &str) -> Option<PathBuf> {
    let rel = rel.replace('\\', "/");
    if rel.is_empty() || rel.starts_with('/') || rel.contains(':') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in rel.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None;
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() { None } else { Some(out) }
}

#[derive(serde::Serialize)]
struct ThemeInfo {
    label: String,
    file: String,
    dark: bool,
}

#[derive(serde::Serialize)]
struct GrammarInfo {
    language: Option<String>,
    scope_name: String,
    path: String,
    embedded: Option<serde_json::Value>,
}

#[derive(serde::Serialize)]
struct LanguageInfo {
    id: String,
    extensions: Vec<String>,
    filenames: Vec<String>,
    aliases: Vec<String>,
}

#[derive(serde::Serialize)]
struct SnippetInfo {
    language: String,
    path: String,
}

#[derive(serde::Serialize)]
struct IconThemeInfo {
    id: String,
    label: String,
    path: String,
}

#[derive(serde::Serialize)]
struct ExtInstalled {
    id: String,
    display_name: String,
    themes: Vec<ThemeInfo>,
    grammars: Vec<GrammarInfo>,
    languages: Vec<LanguageInfo>,
    snippets: Vec<SnippetInfo>,
    icon_themes: Vec<IconThemeInfo>,
    has_code: bool,
    warnings: Vec<String>,
}

/// Busca extensiones en el registro público Open VSX (se hace desde Rust
/// para evitar CORS). Devuelve el JSON crudo de la API.
#[tauri::command]
async fn ext_search(query: String) -> Result<String, String> {
    let client = tauri_plugin_http::reqwest::Client::new();
    let resp = client
        .get("https://open-vsx.org/api/-/search")
        .query(&[("query", query.as_str()), ("size", "24"), ("sortBy", "relevance")])
        .send()
        .await
        .map_err(|e| format!("No se pudo contactar Open VSX: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Open VSX respondió {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}

/// Descarga un .vsix de Open VSX y extrae sus temas de color al app-data.
#[tauri::command]
async fn ext_install(app: AppHandle, url: String, id: String) -> Result<ExtInstalled, String> {
    if !url.starts_with("https://open-vsx.org/") {
        return Err("Solo se instalan extensiones desde open-vsx.org".to_string());
    }
    let id = sanitize_component(&id);

    let resp = tauri_plugin_http::reqwest::get(&url)
        .await
        .map_err(|e| format!("Descarga fallida: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Descarga fallida ({})", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 60 * 1024 * 1024 {
        return Err("La extensión supera los 60 MB".to_string());
    }

    let dir = extensions_dir(&app)?.join(&id);
    let data = bytes.to_vec();
    tauri::async_runtime::spawn_blocking(move || install_vsix(data, dir, id))
        .await
        .map_err(|e| e.to_string())?
}

const VSIX_MAX_UNCOMPRESSED: u64 = 120 * 1024 * 1024;
const VSIX_MAX_ENTRIES: usize = 20_000;

/// Normaliza el `path` que declara package.json ("./themes/x.json") a la ruta
/// relativa extraída ("extension/themes/x.json"), validada contra traversal.
fn contrib_rel(path: &str) -> Option<String> {
    let rel = format!("extension/{}", path.trim_start_matches("./"));
    safe_rel_path(&rel).map(|p| p.to_string_lossy().replace('\\', "/"))
}

fn install_vsix(data: Vec<u8>, dir: PathBuf, id: String) -> Result<ExtInstalled, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(data))
        .map_err(|_| "El archivo .vsix no es válido".to_string())?;
    if zip.len() > VSIX_MAX_ENTRIES {
        return Err("La extensión contiene demasiados archivos".to_string());
    }

    let mut pkg_raw = String::new();
    zip.by_name("extension/package.json")
        .map_err(|_| "El .vsix no contiene package.json".to_string())?
        .read_to_string(&mut pkg_raw)
        .map_err(|e| e.to_string())?;
    let pkg: serde_json::Value = serde_json::from_str(&clean_jsonc(&pkg_raw))
        .map_err(|_| "package.json inválido".to_string())?;

    // displayName puede ser una clave de localización "%x%": no sirve
    let display_name = pkg
        .get("displayName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.starts_with('%'))
        .unwrap_or(&id)
        .to_string();

    // ── Extraer todo extension/ a disco (con guardas) ──
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut written: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = match zip.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if entry.is_dir() || !entry.name().starts_with("extension/") {
            continue;
        }
        let rel = match safe_rel_path(entry.name()) {
            Some(p) => p,
            None => continue, // entrada maliciosa: se ignora
        };
        written += entry.size();
        if written > VSIX_MAX_UNCOMPRESSED {
            let _ = fs::remove_dir_all(&dir);
            return Err("La extensión supera los 120 MB descomprimida".to_string());
        }
        let target = dir.join(&rel);
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut out = match fs::File::create(&target) {
            Ok(f) => f,
            Err(_) => continue,
        };
        if std::io::copy(&mut entry, &mut out).is_err() {
            continue;
        }
    }

    let contributes = pkg.get("contributes").cloned().unwrap_or(serde_json::Value::Null);
    let arr = |key: &str| -> Vec<serde_json::Value> {
        contributes
            .get(key)
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default()
    };
    let mut warnings: Vec<String> = Vec::new();

    // ── Temas de color: se re-serializan a JSON estricto en la raíz de la
    //    carpeta (compatibilidad con ext_read_theme y los temas ya activos) ──
    let mut themes = Vec::new();
    for def in arr("themes") {
        let label = def
            .get("label")
            .and_then(|v| v.as_str())
            .unwrap_or("tema")
            .to_string();
        let rel = match def.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => continue,
        };
        if !rel.ends_with(".json") {
            warnings.push(format!("Tema '{label}' en formato .tmTheme (XML): no soportado."));
            continue;
        }
        let raw = match contrib_rel(rel).and_then(|r| fs::read_to_string(dir.join(r)).ok()) {
            Some(s) => s,
            None => continue,
        };
        let value: serde_json::Value = match serde_json::from_str(&clean_jsonc(&raw)) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let dark = def
            .get("uiTheme")
            .and_then(|v| v.as_str())
            .map(|u| u != "vs")
            .unwrap_or(true);
        let file_name = format!("{}.json", sanitize_component(&label));
        let serialized = match serde_json::to_string(&value) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if fs::write(dir.join(&file_name), serialized).is_err() {
            continue;
        }
        themes.push(ThemeInfo { label, file: file_name, dark });
    }

    // ── Gramáticas TextMate ──
    let mut grammars = Vec::new();
    for g in arr("grammars") {
        let scope = match g.get("scopeName").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let rel = match g.get("path").and_then(|v| v.as_str()).and_then(contrib_rel) {
            Some(r) if dir.join(&r).exists() => r,
            _ => continue,
        };
        grammars.push(GrammarInfo {
            language: g.get("language").and_then(|v| v.as_str()).map(String::from),
            scope_name: scope,
            path: rel,
            embedded: g.get("embeddedLanguages").cloned(),
        });
    }

    // ── Lenguajes declarados (extensiones de archivo → id de lenguaje) ──
    let str_vec = |v: Option<&serde_json::Value>| -> Vec<String> {
        v.and_then(|x| x.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect())
            .unwrap_or_default()
    };
    let mut languages = Vec::new();
    for l in arr("languages") {
        let lang_id = match l.get("id").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        languages.push(LanguageInfo {
            id: lang_id,
            extensions: str_vec(l.get("extensions")),
            filenames: str_vec(l.get("filenames")),
            aliases: str_vec(l.get("aliases")),
        });
    }

    // ── Snippets ──
    let mut snippets = Vec::new();
    for s in arr("snippets") {
        let language = match s.get("language").and_then(|v| v.as_str()) {
            Some(l) => l.to_string(),
            None => continue,
        };
        let rel = match s.get("path").and_then(|v| v.as_str()).and_then(contrib_rel) {
            Some(r) if dir.join(&r).exists() => r,
            _ => continue,
        };
        snippets.push(SnippetInfo { language, path: rel });
    }

    // ── Temas de iconos (el lado JS decide si son SVG utilizables) ──
    let mut icon_themes = Vec::new();
    for it in arr("iconThemes") {
        let rel = match it.get("path").and_then(|v| v.as_str()).and_then(contrib_rel) {
            Some(r) if dir.join(&r).exists() => r,
            _ => continue,
        };
        icon_themes.push(IconThemeInfo {
            id: it.get("id").and_then(|v| v.as_str()).unwrap_or("icons").to_string(),
            label: it
                .get("label")
                .and_then(|v| v.as_str())
                .filter(|s| !s.starts_with('%'))
                .unwrap_or("Iconos")
                .to_string(),
            path: rel,
        });
    }

    let has_code = pkg.get("main").is_some() || pkg.get("browser").is_some();
    if has_code {
        warnings.push(
            "Incluye código que requiere el extension host de VSCode: esa parte no se ejecuta en lixbon."
                .to_string(),
        );
    }
    if themes.is_empty() && grammars.is_empty() && languages.is_empty()
        && snippets.is_empty() && icon_themes.is_empty()
    {
        warnings.push(
            "No aporta nada declarativo que lixbon pueda usar (temas, gramáticas, snippets o iconos)."
                .to_string(),
        );
    }

    Ok(ExtInstalled {
        id,
        display_name,
        themes,
        grammars,
        languages,
        snippets,
        icon_themes,
        has_code,
        warnings,
    })
}

/// Lee el JSON de un tema ya instalado (confinado a la carpeta de extensiones).
#[tauri::command]
fn ext_read_theme(app: AppHandle, id: String, file: String) -> Result<String, String> {
    if !is_simple_name(&id) || !is_simple_name(&file) {
        return Err("Nombre inválido".to_string());
    }
    let path = extensions_dir(&app)?
        .join(sanitize_component(&id))
        .join(sanitize_component(&file));
    fs::read_to_string(&path).map_err(|_| "Tema no encontrado".to_string())
}

/// Lee cualquier archivo de una extensión instalada (gramáticas, snippets,
/// iconos…), confinado a su carpeta. Generaliza ext_read_theme.
#[tauri::command]
fn ext_read_file(app: AppHandle, id: String, rel_path: String) -> Result<String, String> {
    if !is_simple_name(&id) {
        return Err("Nombre inválido".to_string());
    }
    let rel = safe_rel_path(&rel_path).ok_or("Ruta inválida".to_string())?;
    let path = extensions_dir(&app)?
        .join(sanitize_component(&id))
        .join(rel);
    fs::read_to_string(&path).map_err(|_| "Archivo no encontrado".to_string())
}

#[tauri::command]
fn ext_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    if !is_simple_name(&id) {
        return Err("Nombre inválido".to_string());
    }
    let dir = extensions_dir(&app)?.join(sanitize_component(&id));
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WorkspaceRoot(Mutex::new(None)))
        .manage(Terminals(Mutex::new(HashMap::new())))
        .manage(LspServers(Mutex::new(HashMap::new())))
        .manage(FsWatchState {
            watcher: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashSet::new())),
        })
        .setup(|app| {
            // Hilo que emite los lotes de cambios de disco al frontend.
            let pending = app.state::<FsWatchState>().pending.clone();
            spawn_fs_emitter(app.handle().clone(), pending);
            Ok(())
        })
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
            stat_file,
            replace_in_files,
            create_new_entry,
            rename_entry,
            delete_entry,
            duplicate_entry,
            move_entry,
            resolve_project_bin,
            eslint_default_config,
            reveal_in_os,
            search_in_files,
            list_files,
            term_open,
            term_write,
            term_resize,
            term_close,
            lsp_start,
            lsp_send,
            lsp_stop,
            lsp_resolve,
            lsp_install_npm,
            lsp_install_archive,
            lsp_uninstall_server,
            git_run,
            git_clone,
            run_command,
            ext_search,
            ext_install,
            ext_read_theme,
            ext_read_file,
            ext_uninstall
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{is_simple_name, repo_name_from_url};

    #[test]
    fn rechaza_nombres_con_traversal() {
        assert!(!is_simple_name(".."));
        assert!(!is_simple_name("../x"));
        assert!(!is_simple_name("a/b"));
        assert!(!is_simple_name("a\\b"));
        assert!(!is_simple_name(""));
        assert!(is_simple_name("archivo.rs"));
    }

    #[test]
    fn limpia_jsonc() {
        use super::clean_jsonc;
        let src = r#"{
  // comentario
  "a": 1, /* otro */
  "b": "con // barras y /* no comentario */ dentro",
  "c": [1, 2,],
}"#;
        let cleaned = clean_jsonc(src);
        let v: serde_json::Value = serde_json::from_str(&cleaned).expect("JSON válido");
        assert_eq!(v["a"], 1);
        assert_eq!(v["c"][1], 2);
        assert!(v["b"].as_str().unwrap().contains("no comentario"));
    }

    #[test]
    fn sanitiza_componentes() {
        use super::sanitize_component;
        assert_eq!(sanitize_component("pub.ext-name"), "pub.ext-name");
        assert_eq!(sanitize_component("a/b\\c"), "a-b-c");
        assert_eq!(sanitize_component("../.."), "ext");
    }

    #[test]
    fn safe_rel_path_bloquea_traversal() {
        use super::safe_rel_path;
        assert!(safe_rel_path("../fuera").is_none());
        assert!(safe_rel_path("a/../../b").is_none());
        assert!(safe_rel_path("/absoluta").is_none());
        assert!(safe_rel_path("C:/windows").is_none());
        assert!(safe_rel_path("").is_none());
        assert!(safe_rel_path("./").is_none());
        let ok = safe_rel_path("extension/./themes/one.json").unwrap();
        assert_eq!(ok.to_string_lossy().replace('\\', "/"), "extension/themes/one.json");
        let win = safe_rel_path("extension\\syntaxes\\x.json").unwrap();
        assert_eq!(win.to_string_lossy().replace('\\', "/"), "extension/syntaxes/x.json");
    }

    #[test]
    fn contrib_rel_normaliza() {
        use super::contrib_rel;
        assert_eq!(contrib_rel("./themes/x.json").as_deref(), Some("extension/themes/x.json"));
        assert_eq!(contrib_rel("syntaxes/y.tmLanguage.json").as_deref(), Some("extension/syntaxes/y.tmLanguage.json"));
        assert!(contrib_rel("../fuga.json").is_none());
    }

    #[test]
    fn extrae_nombre_de_repo() {
        assert_eq!(repo_name_from_url("https://github.com/u/repo.git").as_deref(), Some("repo"));
        assert_eq!(repo_name_from_url("https://github.com/u/repo/").as_deref(), Some("repo"));
        assert_eq!(repo_name_from_url("git@github.com:u/otro.git").as_deref(), Some("otro"));
        assert_eq!(repo_name_from_url(""), None);
        assert_eq!(repo_name_from_url("https://"), None);
    }

    #[test]
    fn regex_literal_insensible_y_palabra_completa() {
        use super::build_query_regex;
        // literal, insensible a mayúsculas
        let re = build_query_regex("foo", false, false, false).unwrap();
        assert!(re.is_match("un FOO aquí"));
        assert_eq!(re.find_iter("foo Foo FOO").count(), 3);
        // sensible: solo el exacto
        let re = build_query_regex("Foo", true, false, false).unwrap();
        assert_eq!(re.find_iter("foo Foo FOO").count(), 1);
        // palabra completa: no dentro de otra palabra
        let re = build_query_regex("cat", false, false, true).unwrap();
        assert!(re.is_match("a cat sat"));
        assert!(!re.is_match("category"));
        // en modo literal los metacaracteres se escapan
        let re = build_query_regex("a.b", true, false, false).unwrap();
        assert!(re.is_match("a.b"));
        assert!(!re.is_match("axb"));
    }

    #[test]
    fn regex_modo_expresion() {
        use super::build_query_regex;
        let re = build_query_regex(r"\d+", false, true, false).unwrap();
        assert_eq!(re.find_iter("a12 b3").count(), 2);
        // una regex inválida devuelve error, no panic
        assert!(build_query_regex("(", false, true, false).is_err());
    }

    #[test]
    fn reemplazo_literal_no_expande_dolar() {
        use super::build_query_regex;
        let re = build_query_regex("x", false, false, false).unwrap();
        // literal: "$1" se conserva tal cual, no se interpreta como grupo
        let out = re.replace_all("x y x", regex::NoExpand("$1")).into_owned();
        assert_eq!(out, "$1 y $1");
    }

    #[test]
    fn escritura_atomica_ida_y_vuelta() {
        use super::write_atomic;
        let mut p = std::env::temp_dir();
        p.push(format!("lixbon-test-{}.txt", std::process::id()));
        write_atomic(&p, b"hola").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "hola");
        // sobrescribe un archivo existente
        write_atomic(&p, b"adios mundo").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "adios mundo");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn cola_capada_conserva_el_final() {
        use super::read_tail_capped;
        let data: String = (0..10_000u32).map(|n| format!("{n}\n")).collect();
        let out = read_tail_capped(std::io::Cursor::new(data.clone().into_bytes()), 128);
        // conserva a lo sumo ~2*cap y siempre el final del flujo
        assert!(out.len() <= 256);
        assert!(data.ends_with(&String::from_utf8(out).unwrap()));
    }

    #[test]
    fn salta_carpetas_pesadas() {
        use super::path_has_skip_component;
        use std::path::Path;
        assert!(path_has_skip_component(Path::new("proj/node_modules/x/index.js")));
        assert!(path_has_skip_component(Path::new("proj/.git/HEAD")));
        assert!(!path_has_skip_component(Path::new("proj/src/main.rs")));
    }
}
