// tauri.js — punto único de acceso a la API nativa de Tauri.
// Imports estáticos: en el WebView de Tauri siempre están disponibles,
// así que no hay razón para import() dinámico ni estados "aún no cargado".

import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';

// ── Comandos Rust (src-tauri/src/lib.rs) ──────────────────────────────

export function getAppVersion() {
  return invoke('get_app_version');
}

export function getWorkspaceRoot() {
  return invoke('get_workspace_root');
}

/** Fija la carpeta de trabajo (sandbox de los comandos de archivos). Devuelve la ruta canónica. */
export function setWorkspaceRoot(path) {
  return invoke('set_workspace_root', { path });
}

export function readDir(path) {
  return invoke('read_dir', { path });
}

export function readFileContent(path) {
  return invoke('read_file_content', { path });
}

export function writeFileContent(path, content) {
  return invoke('write_file_content', { path, content });
}

export function createNewEntry(parentPath, name, isDir) {
  return invoke('create_new_entry', { parentPath, name, isDir });
}

/** Renombra un archivo/carpeta. Devuelve la ruta nueva. */
export function renameEntry(path, newName) {
  return invoke('rename_entry', { path, newName });
}

export function deleteEntry(path) {
  return invoke('delete_entry', { path });
}

/** Crea "nombre copia.ext" junto al original. Devuelve la ruta de la copia. */
export function duplicateEntry(path) {
  return invoke('duplicate_entry', { path });
}

/** Muestra la entrada en el explorador de archivos del sistema. */
export function revealInOs(path) {
  return invoke('reveal_in_os', { path });
}

/** Busca texto en todos los archivos del workspace. [{path,name,line,text}] */
export function searchInFiles(query) {
  return invoke('search_in_files', { query });
}

/** Lista plana de archivos del workspace (Quick Open). [{name,path,rel}] */
export function listFiles() {
  return invoke('list_files');
}

// ── Extensiones (soporte declarativo de VSCode vía Open VSX) ──────────

/** Busca en el registro Open VSX. Devuelve el JSON crudo de la API. */
export function extSearch(query) {
  return invoke('ext_search', { query });
}

/** Descarga el .vsix y extrae todo lo declarativo. Devuelve el manifest
    {id, display_name, themes, grammars, languages, snippets, icon_themes,
     has_code, warnings}. */
export function extInstall(url, id) {
  return invoke('ext_install', { url, id });
}

/** Contenido JSON de un tema instalado. */
export function extReadTheme(id, file) {
  return invoke('ext_read_theme', { id, file });
}

/** Contenido de cualquier archivo de una extensión (gramáticas, snippets,
    iconos…), confinado a su carpeta. */
export function extReadFile(id, relPath) {
  return invoke('ext_read_file', { id, relPath });
}

export function extUninstall(id) {
  return invoke('ext_uninstall', { id });
}

// ── Terminales PTY ────────────────────────────────────────────────────

/** Abre una sesión de terminal (shell: 'powershell' | 'cmd' | 'bash'). Devuelve el id. */
export function termOpen(shell, cwd) {
  return invoke('term_open', { shell, cwd: cwd ?? null });
}

export function termWrite(id, data) {
  return invoke('term_write', { id, data });
}

export function termResize(id, cols, rows) {
  return invoke('term_resize', { id, cols, rows });
}

export function termClose(id) {
  return invoke('term_close', { id });
}

// ── LSP (servidores de lenguaje) ──────────────────────────────────────
// Rust solo transporta: desenmarca el framing y emite cada mensaje JSON por
// `lsp:msg:{id}` (logs por `lsp:err:{id}`, muerte por `lsp:exit:{id}`).
// Quien habla JSON-RPC es lib/lspClient.js.

/** Lanza el servidor `id` (= lenguaje) en la carpeta de trabajo. */
export function lspStart(id, command, args = []) {
  return invoke('lsp_start', { id, command, args });
}

/** Envía un mensaje JSON-RPC ya serializado. */
export function lspSend(id, message) {
  return invoke('lsp_send', { id, message });
}

export function lspStop(id) {
  return invoke('lsp_stop', { id });
}

/** Ruta del ejecutable del servidor: primero el instalado por lixbon, luego el
    PATH del sistema. null = no está. */
export function lspResolve(id, bin) {
  return invoke('lsp_resolve', { id, bin });
}

/** Instala un servidor de npm dentro del app-data (sin permisos de admin ni
    tocar el PATH). Devuelve la ruta del ejecutable. Requiere Node.js. */
export function lspInstallNpm(id, pkg, bin) {
  return invoke('lsp_install_npm', { id, package: pkg, bin });
}

/** Descarga y extrae un servidor publicado como .zip (releases de GitHub). */
export function lspInstallArchive(id, url, bin) {
  return invoke('lsp_install_archive', { id, url, bin });
}

export function lspUninstallServer(id) {
  return invoke('lsp_uninstall_server', { id });
}

// ── Git (CLI del sistema) ─────────────────────────────────────────────

/** Ejecuta `git args...` en cwd (o la carpeta de trabajo). Devuelve {stdout, stderr, code}. */
export function gitRun(args, cwd) {
  return invoke('git_run', { args, cwd: cwd ?? null });
}

/** Clona `url` dentro de destParent. Progreso por el evento `git:clone:out`.
    Devuelve la ruta del repositorio clonado. */
export function gitClone(url, destParent) {
  return invoke('git_clone', { url, destParent });
}

/** Ejecuta un comando de shell en la carpeta de trabajo (agente del chat).
    Devuelve {stdout, stderr, code, timed_out}. */
export function runCommand(command, timeoutMs) {
  return invoke('run_command', { command, timeoutMs: timeoutMs ?? null });
}

// ── Plugins ───────────────────────────────────────────────────────────

/** Abre el selector nativo de carpetas. Devuelve la ruta o null si se cancela. */
export function pickDirectory(options = {}) {
  return openDialog({ directory: true, multiple: false, ...options });
}

/** Abre una URL en el navegador del sistema. */
export function openExternal(url) {
  return openUrl(url);
}
