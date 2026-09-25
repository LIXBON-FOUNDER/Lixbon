use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
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

pub(crate) fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

mod mcp;
mod auth_loopback;
mod preview_proxy;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
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
    // A la papelera del SO: un mal clic en el explorador deja de ser
    // irreversible. Si el SO no puede (unidades de red, papelera llena),
    // se cae al borrado definitivo de siempre.
    if trash::delete(&target).is_ok() {
        return Ok(());
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

#[derive(Clone, serde::Serialize)]
struct SearchHit {
    path: String,
    name: String,
    line: u32,
    text: String,
}

/// Recorre el workspace respetando el `.gitignore` del proyecto (crate `ignore`,
/// el walker de ripgrep), además de las carpetas fijas de SKIP_DIRS. Sustituye
/// a los walkers manuales: sin ruido de builds/artefactos ignorados.
fn workspace_walker(base: &Path) -> ignore::Walk {
    ignore::WalkBuilder::new(base)
        .follow_links(false)
        .hidden(false) // los dotfiles (.env, .github…) sí se listan, como antes
        .git_global(false) // solo el .gitignore del repo: comportamiento predecible
        .filter_entry(|e| {
            e.file_name()
                .to_str()
                .map(|n| !skip_dir(n))
                .unwrap_or(true)
        })
        .build()
}

/// Extrae la ruta si la entrada del walker es un archivo normal (None si es
/// carpeta, error de lectura o tipo raro).
fn entry_file_path(entry: Result<ignore::DirEntry, ignore::Error>) -> Option<PathBuf> {
    let entry = entry.ok()?;
    if entry.file_type()?.is_file() {
        Some(entry.into_path())
    } else {
        None
    }
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

/// Busca en todos los archivos del workspace. `is_regex` interpreta la consulta
/// como expresión regular; `case_sensitive`/`whole_word` afinan la coincidencia.
/// Con `stream_id`, los resultados van llegando en lotes por el evento
/// `search:hits:{stream_id}` mientras se busca; el retorno final es la lista
/// completa (autoritativa: el frontend la usa para el estado definitivo).
#[tauri::command]
async fn search_in_files(
    app: AppHandle,
    query: String,
    case_sensitive: bool,
    is_regex: bool,
    whole_word: bool,
    stream_id: Option<String>,
    root: State<'_, WorkspaceRoot>,
) -> Result<Vec<SearchHit>, String> {
    let base = workspace_path(&root)?;
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let re = build_query_regex(&query, case_sensitive, is_regex, whole_word)?;
    tauri::async_runtime::spawn_blocking(move || {
        let event = stream_id.map(|id| format!("search:hits:{}", sanitize_component(&id)));
        let mut hits: Vec<SearchHit> = Vec::new();
        let mut batch: Vec<SearchHit> = Vec::new();
        for entry in workspace_walker(&base) {
            if hits.len() >= SEARCH_MAX_HITS {
                break;
            }
            let Some(path) = entry_file_path(entry) else { continue };
            let Ok(meta) = fs::metadata(&path) else { continue };
            if meta.len() > SEARCH_MAX_FILE_BYTES {
                continue;
            }
            // read_to_string falla en binarios no-UTF8; el NUL cubre el resto
            let Ok(content) = fs::read_to_string(&path) else { continue };
            if content.contains('\0') {
                continue;
            }
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            for (i, line) in content.lines().enumerate() {
                if re.is_match(line) {
                    let hit = SearchHit {
                        path: display_path(&path),
                        name: name.clone(),
                        line: (i + 1) as u32,
                        text: line.trim().chars().take(240).collect(),
                    };
                    if event.is_some() {
                        batch.push(hit.clone());
                    }
                    hits.push(hit);
                    if hits.len() >= SEARCH_MAX_HITS {
                        break;
                    }
                }
            }
            if let Some(ev) = &event {
                if batch.len() >= 20 {
                    let _ = app.emit(ev, std::mem::take(&mut batch));
                }
            }
        }
        if let Some(ev) = &event {
            if !batch.is_empty() {
                let _ = app.emit(ev, batch);
            }
        }
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

fn replace_walk(base: &Path, re: &regex::Regex, replacement: &str, is_regex: bool) -> ReplaceResult {
    let mut res = ReplaceResult { files: 0, replacements: 0 };
    for entry in workspace_walker(base) {
        let Some(path) = entry_file_path(entry) else { continue };
        let Ok(meta) = fs::metadata(&path) else { continue };
        if meta.len() > SEARCH_MAX_FILE_BYTES {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else { continue }; // binario: se omite
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
    res
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
    tauri::async_runtime::spawn_blocking(move || replace_walk(&base, &re, &replacement, is_regex))
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

fn files_walk(base: &Path, out: &mut Vec<QuickFile>) {
    for entry in workspace_walker(base) {
        if out.len() >= LIST_MAX_FILES {
            return;
        }
        let Some(path) = entry_file_path(entry) else { continue };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let rel = path
            .strip_prefix(base)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| name.clone());
        out.push(QuickFile { name, path: display_path(&path), rel });
    }
}

/// Lista (plana) de archivos del workspace para el buscador rápido Ctrl+P.
#[tauri::command]
async fn list_files(root: State<'_, WorkspaceRoot>) -> Result<Vec<QuickFile>, String> {
    let base = workspace_path(&root)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        files_walk(&base, &mut out);
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


// ── Git (CLI del sistema) ────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct GitOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

/// Subcomandos de git que la UI puede invocar. Todo lo demás (push/pull, y
/// cualquier flag global tipo `-c` o `--exec-path` que permita ejecutar código)
/// se rechaza: el frontend es de confianza, pero validar en Rust es la línea
/// de defensa que no depende del WebView.
const GIT_ALLOWED_SUBCOMMANDS: [&str; 19] = [
    "status", "diff", "log", "show", "branch", "add", "commit", "reset", "restore",
    "checkout", "stash", "rev-parse", "rev-list", "remote", "init", "fetch", "merge",
    "pull", "push",
];

fn validate_git_args(args: &[String]) -> Result<(), String> {
    let sub = args.first().ok_or_else(|| "Falta el subcomando de git".to_string())?;
    if !GIT_ALLOWED_SUBCOMMANDS.contains(&sub.as_str()) {
        return Err(format!("Subcomando git no permitido desde la UI: {sub}"));
    }
    for a in args {
        let l = a.to_lowercase();
        if l == "-c"
            || l == "--config"
            || l.starts_with("--config-env")
            || l.starts_with("--exec-path")
            || l.starts_with("--upload-pack")
            || l.starts_with("--receive-pack")
        {
            return Err(format!("Opción de git no permitida: {a}"));
        }
    }
    Ok(())
}

/// Ejecuta `git` con los argumentos dados y captura la salida. Solo para
/// operaciones de lectura/local (status, branch, log, add, commit); las de red
/// (clone/push/pull) se lanzan desde el terminal integrado para que los
/// prompts de credenciales sean visibles. cwd por defecto = carpeta de trabajo.
#[tauri::command]
fn git_run(
    args: Vec<String>,
    cwd: Option<String>,
    root: State<WorkspaceRoot>,
) -> Result<GitOutput, String> {
    validate_git_args(&args)?;
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

// ── Extensiones (capacidades del agente) ─────────────────────────────────
// Ya no hay marketplace de VSCode/Open VSX: la app dejó de ser un editor de
// código, así que sus extensiones declarativas (temas, gramáticas, snippets)
// no tienen editor al que aplicarse. El panel de Extensiones ahora vive
// enteramente en el store de React (capacidades del agente, sin backend).

/// Nombre seguro para carpeta/archivo.
fn sanitize_component(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() { "ext".to_string() } else { trimmed }
}

// ── Secretos (almacén de credenciales del SO) ────────────────────────────
// La API key del usuario deja de vivir en claro en el JSON de settings: en
// Windows va al Credential Manager (cifrado por DPAPI con la cuenta del
// usuario). En otros SO los comandos devuelven error y el frontend cae al
// JSON de siempre — la app funciona igual, solo que sin cifrado.

#[cfg(windows)]
const SECRET_SERVICE: &str = "com.usuario.app-lixbon";

#[cfg(windows)]
fn secret_entry(name: &str) -> Result<keyring::Entry, String> {
    if !is_simple_name(name) {
        return Err("Nombre de secreto inválido".to_string());
    }
    keyring::Entry::new(SECRET_SERVICE, name).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        secret_entry(&name)?.set_password(&value).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (name, value);
        Err("Almacén de credenciales no soportado en este SO".to_string())
    }
}

#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        match secret_entry(&name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        Err("Almacén de credenciales no soportado en este SO".to_string())
    }
}

#[tauri::command]
fn secret_delete(name: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        match secret_entry(&name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = name;
        Err("Almacén de credenciales no soportado en este SO".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WorkspaceRoot(Mutex::new(None)))
        .manage(Terminals(Mutex::new(HashMap::new())))
        .manage(mcp::McpServers::default())
        .manage(preview_proxy::PreviewProxy::default())
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
        .on_window_event(|window, event| {
            // Los servidores MCP son procesos hijos: sin esto quedaban vivos
            // al cerrar la ventana.
            if let tauri::WindowEvent::Destroyed = event {
                window.state::<mcp::McpServers>().stop_all();
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
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
            reveal_in_os,
            search_in_files,
            list_files,
            term_open,
            term_write,
            term_resize,
            term_close,
            git_run,
            git_clone,
            run_command,
            secret_set,
            secret_get,
            secret_delete,
            auth_loopback::auth_loopback_start,
            preview_proxy::preview_proxy_start,
            mcp::vscode_user_file,
            mcp::mcp_start,
            mcp::mcp_send,
            mcp::mcp_stop,
            mcp::mcp_user_config,
            mcp::mcp_save_user_config
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
    fn sanitiza_componentes() {
        use super::sanitize_component;
        assert_eq!(sanitize_component("pub.ext-name"), "pub.ext-name");
        assert_eq!(sanitize_component("a/b\\c"), "a-b-c");
        assert_eq!(sanitize_component("../.."), "ext");
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
