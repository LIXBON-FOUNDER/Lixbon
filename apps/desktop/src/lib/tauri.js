// tauri.js — punto único de acceso a la API nativa de Tauri.
// Imports estáticos: en el WebView de Tauri siempre están disponibles,
// así que no hay razón para import() dinámico ni estados "aún no cargado".

import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';

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

/** Guarda el archivo (escritura atómica). Con `expectedMtime` no vacío, si el
    archivo cambió en disco desde entonces rechaza con "CONFLICT:<mtime>" en vez
    de pisarlo. Devuelve el mtime nuevo (ms). */
export function writeFileContent(path, content, expectedMtime) {
  return invoke('write_file_content', { path, content, expectedMtime: expectedMtime ?? null });
}

/** Diálogo nativo "Guardar como" + escritura. Devuelve la ruta o null si se canceló. */
export function saveTextAs(defaultName, content) {
  return invoke('save_text_as', { defaultName, content });
}

/** mtime del archivo en ms (la "versión" que el editor guarda al abrirlo). */
export function statFile(path) {
  return invoke('stat_file', { path });
}

/** Reemplaza `query` por `replacement` en todo el workspace. `opts` como en
    searchInFiles. Devuelve {files, replacements}. */
export function replaceInFiles(query, replacement, opts = {}) {
  return invoke('replace_in_files', {
    query,
    replacement,
    caseSensitive: !!opts.caseSensitive,
    isRegex: !!opts.isRegex,
    wholeWord: !!opts.wholeWord,
  });
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

/** Mueve una entrada a otra carpeta (drag & drop). Devuelve la nueva ruta. */
export function moveEntry(path, destDir) {
  return invoke('move_entry', { path, destDir });
}

/** Muestra la entrada en el explorador de archivos del sistema. */
export function revealInOs(path) {
  return invoke('reveal_in_os', { path });
}

/** Busca en todos los archivos del workspace. `opts` = {caseSensitive, isRegex,
    wholeWord}. Devuelve [{path,name,line,text}]. Con `streamId`, los lotes
    parciales llegan por el evento `search:hits:{streamId}` mientras se busca. */
export function searchInFiles(query, opts = {}, streamId = null) {
  return invoke('search_in_files', {
    query,
    caseSensitive: !!opts.caseSensitive,
    isRegex: !!opts.isRegex,
    wholeWord: !!opts.wholeWord,
    streamId: streamId || null,
  });
}

/** Lista plana de archivos del workspace (Quick Open). [{name,path,rel}] */
export function listFiles() {
  return invoke('list_files');
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

/** Ejecuta un comando de shell en la carpeta de trabajo (agente del chat).
    Devuelve {stdout, stderr, code, timed_out}. */
export function runCommand(command, timeoutMs, cwd) {
  return invoke('run_command', { command, timeoutMs: timeoutMs ?? null, cwd: cwd ?? null });
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

export function revealInDir(path) {
  return revealItemInDir(path);
}

// ── Servidores MCP (stdio) ─────────────────────────────────────────────

/** Lanza un servidor MCP. Sus líneas de stdout llegan por `mcp:line:{id}`
    y el cierre por `mcp:exit:{id}`. */
export function mcpStart(id, command, args = [], env = {}, cwd = null) {
  return invoke('mcp_start', { id, command, args, env, cwd });
}

export function mcpSend(id, line) {
  return invoke('mcp_send', { id, line });
}

export function mcpStop(id) {
  return invoke('mcp_stop', { id });
}

/** Contenido de ~/.lixbon/mcp.json, o null si no existe. */
export function mcpUserConfig() {
  return invoke('mcp_user_config');
}

/** Guarda ~/.lixbon/mcp.json (valida que sea JSON). Devuelve la ruta. */
export function mcpSaveUserConfig(content) {
  return invoke('mcp_save_user_config', { content });
}

/** Servidor de un solo uso en 127.0.0.1 para la vuelta del navegador en el
    login con lixbon.com. Devuelve el puerto; el resultado llega como evento
    `auth:callback` o `auth:timeout`. */
export function authLoopbackStart() {
  return invoke('auth_loopback_start');
}

/** Proxy de la vista previa (modo Diseño) que inyecta el inspector.
    Devuelve el puerto local; `url` es el servidor de desarrollo. */
export function previewProxyStart(url) {
  return invoke('preview_proxy_start', { url });
}
