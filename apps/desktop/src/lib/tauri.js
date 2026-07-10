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

// ── Extensiones (temas de VSCode vía Open VSX) ────────────────────────

/** Busca en el registro Open VSX. Devuelve el JSON crudo de la API. */
export function extSearch(query) {
  return invoke('ext_search', { query });
}

/** Descarga el .vsix e instala sus temas. Devuelve {id, display_name, themes}. */
export function extInstall(url, id) {
  return invoke('ext_install', { url, id });
}

/** Contenido JSON de un tema instalado. */
export function extReadTheme(id, file) {
  return invoke('ext_read_theme', { id, file });
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

// ── Plugins ───────────────────────────────────────────────────────────

/** Abre el selector nativo de carpetas. Devuelve la ruta o null si se cancela. */
export function pickDirectory(options = {}) {
  return openDialog({ directory: true, multiple: false, ...options });
}

/** Abre una URL en el navegador del sistema. */
export function openExternal(url) {
  return openUrl(url);
}
