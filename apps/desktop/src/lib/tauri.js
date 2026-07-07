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

// ── Plugins ───────────────────────────────────────────────────────────

/** Abre el selector nativo de carpetas. Devuelve la ruta o null si se cancela. */
export function pickDirectory(options = {}) {
  return openDialog({ directory: true, multiple: false, ...options });
}

/** Abre una URL en el navegador del sistema. */
export function openExternal(url) {
  return openUrl(url);
}
