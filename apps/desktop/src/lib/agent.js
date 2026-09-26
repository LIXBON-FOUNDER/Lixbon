// agent.js — modo agente del chat del IDE: el modelo pide herramientas con
// JSON embebido ({"tool":...,"args":{...}}) y aquí se parsean y ejecutan sobre
// la carpeta de trabajo usando los comandos Rust existentes (sandbox incluido).
// Mismo protocolo que el CLI (apps/cli/lixbon_cli/agent.py); sin run_command:
// el IDE no tiene un primitivo de ejecución con captura de salida.

import {
  listFiles, readDir, readFileContent, writeFileContent, createNewEntry,
  renameEntry, deleteEntry, searchInFiles, runCommand,
} from './tauri';
import { diffCounts, normalizeRel } from './agentProtocol';
import { searchIndex } from './codebaseIndex';
import { api } from './api';

// La parte pura del protocolo (parseo de tool calls, diff, límites) vive en
// agentProtocol.js para poder testearse sin Tauri; se re-exporta desde aquí.
export {
  MAX_AGENT_STEPS,
  MAX_REPEATED_CALLS,
  READ_ONLY_TOOLS,
  DEFAULT_CMD_ALLOWLIST,
  isAllowedCommand,
  isNeverAutoCommand,
  buildModelHistory,
  cleanProse,
  displayableText,
  extractToolCalls,
  hasInvalidCall,
  hasUnclosedCall,
  splitThinking,
  stripToolCalls,
  truncateFabricated,
} from './agentProtocol';

const MAX_TREE_ENTRIES = 150;
const MAX_LIST_LINES = 300;
const MAX_READ_CHARS = 120000;

// ── Rutas (relativas al workspace, como en el CLI) ────────────────────

function sepOf(root) {
  return root.includes('\\') ? '\\' : '/';
}

function joinPath(root, rel) {
  const norm = normalizeRel(rel);
  const sep = sepOf(root);
  return norm ? root + sep + norm.split('/').join(sep) : root;
}

function toRel(root, absPath) {
  const p = String(absPath);
  if (p.startsWith(root)) {
    return p.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
  }
  return p.replace(/\\/g, '/');
}

/** Crea (si faltan) las carpetas de `relDir` y devuelve la ruta absoluta final. */
async function ensureDirs(root, relDir) {
  const sep = sepOf(root);
  let parent = root;
  const segments = relDir ? relDir.split('/') : [];
  for (const seg of segments) {
    try {
      await createNewEntry(parent, seg, true);
    } catch (e) {
      if (!String(e).includes('Ya existe')) throw e;
    }
    parent = parent + sep + seg;
  }
  return parent;
}

function notifyFsChanged() {
  window.dispatchEvent(new CustomEvent('lixbon:fs-changed'));
}

// ── Herramientas ───────────────────────────────────────────────────────

async function toolListFiles(root, relPath) {
  const prefix = normalizeRel(relPath ?? '.');
  const files = await listFiles();
  const rels = files
    .map((f) => f.rel.replace(/\\/g, '/'))
    .filter((r) => !prefix || r === prefix || r.startsWith(prefix + '/'))
    .sort();
  if (!rels.length) return '(sin archivos)';
  const shown = rels.slice(0, MAX_LIST_LINES);
  const extra = rels.length - shown.length;
  return shown.join('\n') + (extra > 0 ? `\n… (${extra} más)` : '');
}

async function toolReadFile(root, relPath, startLine, endLine) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('Falta la ruta del archivo');
  const content = await readFileContent(joinPath(root, rel));
  if (startLine || endLine) {
    const lines = content.split('\n');
    const s = Math.max(1, parseInt(startLine, 10) || 1);
    const e = Math.min(lines.length, parseInt(endLine, 10) || lines.length);
    return `(líneas ${s}-${e} de ${lines.length})\n` + lines.slice(s - 1, e).join('\n');
  }
  if (content.length > MAX_READ_CHARS) {
    const total = content.split('\n').length;
    return `(archivo grande: ${total} líneas; pide rangos con start_line/end_line)\n`
      + content.slice(0, MAX_READ_CHARS);
  }
  return content;
}

/** Edición parcial estilo Cursor/Claude Code: reemplazo EXACTO de un
    fragmento. Evita reescribir archivos enteros (donde los modelos truncan). */
async function toolEditFile(root, relPath, oldText, newText, all = false) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('Falta la ruta del archivo');
  if (!oldText) throw new Error('Falta old_text (el fragmento exacto a reemplazar)');
  const abs = joinPath(root, rel);
  const content = await readFileContent(abs);
  const count = content.split(oldText).length - 1;
  if (count === 0) {
    throw new Error(`No se encontró old_text en ${rel}. Debe coincidir EXACTO `
      + '(espacios e indentación incluidos); usa read_file y copia el fragmento tal cual');
  }
  if (count > 1 && !all) {
    throw new Error(`old_text aparece ${count} veces en ${rel}; añade más líneas de `
      + 'contexto para que sea único, o pasa "all":true para reemplazar todas');
  }
  const updated = all
    ? content.split(oldText).join(newText ?? '')
    : content.replace(oldText, newText ?? '');
  await writeFileContent(abs, updated);
  notifyFsChanged();
  return `Archivo editado: ${rel} (${count > 1 ? `${count} reemplazos` : '1 reemplazo'})`;
}

async function toolRunCommand(root, command, timeoutSecs) {
  if (!String(command ?? '').trim()) throw new Error('Falta el comando');
  const timeoutMs = Math.min(Math.max((parseInt(timeoutSecs, 10) || 30) * 1000, 1000), 300000);
  const res = await runCommand(command, timeoutMs);
  const output = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
  const prefix = res.timed_out ? '[TIMEOUT] ' : `[EXIT ${res.code}] `;
  return prefix + (output.slice(0, 8000) || '(sin salida)');
}

async function fileExists(root, rel) {
  const segments = rel.split('/');
  const name = segments.pop();
  const parentAbs = joinPath(root, segments.join('/'));
  try {
    const entries = await readDir(parentAbs);
    return entries.some((e) => e.name === name);
  } catch {
    return false; // la carpeta padre no existe todavía
  }
}

async function toolWriteFile(root, relPath, content) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('Falta la ruta del archivo');
  const segments = rel.split('/');
  const name = segments.pop();
  const parentAbs = await ensureDirs(root, segments.join('/'));
  const abs = joinPath(root, rel);
  const isNew = !(await fileExists(root, rel));
  if (isNew) await createNewEntry(parentAbs, name, false);
  await writeFileContent(abs, content);
  notifyFsChanged();
  return `Archivo ${isNew ? 'creado' : 'actualizado'}: ${rel} (${content.length} chars)`;
}

async function toolAppendFile(root, relPath, content) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('Falta la ruta del archivo');
  let old = '';
  try {
    old = await readFileContent(joinPath(root, rel));
  } catch { /* no existe: se crea */ }
  return toolWriteFile(root, rel, old + content);
}

async function toolMkdir(root, relPath) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('Falta la ruta de la carpeta');
  await ensureDirs(root, rel);
  notifyFsChanged();
  return `Directorio creado/listo: ${rel}`;
}

async function toolSearch(root, pattern) {
  if (!String(pattern ?? '').trim()) throw new Error('Falta el patrón de búsqueda');
  const hits = await searchInFiles(pattern);
  if (!hits.length) return '(sin resultados)';
  return hits
    .slice(0, 200)
    .map((h) => `${toRel(root, h.path)}:${h.line}:${h.text.trim().slice(0, 200)}`)
    .join('\n');
}

/** Búsqueda semántica (RAG): fragmentos relevantes del índice del codebase. */
async function toolSearchCodebase(root, query) {
  if (!String(query ?? '').trim()) throw new Error('Falta la consulta');
  let hits;
  try {
    hits = await searchIndex(query, 6);
  } catch (e) {
    return `(el índice del codebase no está disponible: ${e.message || e}. `
      + 'Pídele al usuario que lo construya en Ajustes → Agente, o usa search/grep.)';
  }
  if (!hits.length) {
    return '(sin índice o sin resultados; usa la herramienta search para buscar por texto)';
  }
  return hits
    .map((h) => `# ${h.rel}:${h.start}-${h.end} (relevancia ${h.score.toFixed(2)})\n${h.text}`)
    .join('\n\n---\n\n');
}

// Carpetas que find_files/outline nunca deben ofrecer: espejo de
// IGNORED_TREE_DIRS en apps/cli/lixbon_cli/agent.py.
const IGNORED_TREE_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build',
  'target', '.next', '.idea', '.vscode', '.mypy_cache', '.pytest_cache',
]);

/** Glob simple (`*`, `**`, `?`) a RegExp. Sin librería: alcanza con lo que
    escribe un modelo ('*.py', 'src/**\/*.jsx', 'test_*'). */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

async function toolFindFiles(root, pattern) {
  let pat = String(pattern ?? '').trim().replace(/\\/g, '/');
  if (!pat) throw new Error('Falta pattern');
  if (!pat.includes('/')) pat = `**/${pat}`;
  const re = globToRegExp(pat);
  const files = await listFiles();
  const hits = files
    .map((f) => f.rel.replace(/\\/g, '/'))
    .filter((r) => !r.split('/').some((seg) => IGNORED_TREE_DIRS.has(seg)))
    .filter((r) => re.test(r))
    .sort();
  if (!hits.length) return '(sin resultados)';
  const shown = hits.slice(0, MAX_LIST_LINES);
  const extra = hits.length - shown.length;
  return shown.join('\n') + (extra > 0 ? `\n… (${extra} más)` : '');
}

// Esqueleto reconocible por extensión: espejo de _OUTLINE_PATTERNS en
// apps/cli/lixbon_cli/agent.py (misma intención, un lenguaje por bloque).
const OUTLINE_PATTERNS = {
  '.py': [/^(?:\s*)(?:async\s+)?(?:def|class)\s+\w+.*?(?::|$)/],
  '.js': [
    /^(?:\s*)(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+\w+|class\s+\w+).*/,
    /^(?:\s*)(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>.*/,
    /^(?:\s{2,})(?:static\s+|async\s+)*\w+\s*\([^)]*\)\s*\{\s*$/,
  ],
  '.go': [/^(?:\s*)(?:func|type)\s+.*/],
  '.rs': [/^(?:\s*)(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl|mod)\s+.*/],
  '.java': [
    /^(?:\s*)(?:public|private|protected|static|final|abstract|\s)*\s*(?:class|interface|enum|record)\s+\w+.*/,
    /^(?:\s{2,})(?:public|private|protected|static|final|synchronized|\s)+[\w<>[\],\s]+\s+\w+\s*\([^)]*\)\s*(?:throws[^{]*)?\{?\s*$/,
  ],
  '.md': [/^#{1,6}\s+.*/],
  '.css': [/^(?:\s*)[^\s{}/][^{}]*\{\s*$/],
};
for (const ext of ['.jsx', '.ts', '.tsx', '.mjs', '.cjs']) OUTLINE_PATTERNS[ext] = OUTLINE_PATTERNS['.js'];
for (const ext of ['.kt', '.cs', '.scala']) OUTLINE_PATTERNS[ext] = OUTLINE_PATTERNS['.java'];

async function toolOutline(root, relPath) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('Falta la ruta del archivo');
  const dot = rel.lastIndexOf('.');
  const ext = dot === -1 ? '' : rel.slice(dot).toLowerCase();
  const patterns = OUTLINE_PATTERNS[ext];
  if (!patterns) return `(sin esqueleto para ${ext || 'este tipo'}; usa read_file)`;
  const content = await readFileContent(joinPath(root, rel));
  const lines = content.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (patterns.some((p) => p.test(line))) {
      hits.push(`${String(i + 1).padStart(5)}  ${line.trimEnd().slice(0, 140)}`);
    }
  });
  if (!hits.length) return `(sin funciones ni clases reconocibles en ${lines.length} líneas)`;
  const shown = hits.slice(0, MAX_LIST_LINES);
  const extra = hits.length - shown.length;
  return `${rel}: ${lines.length} líneas\n` + shown.join('\n') + (extra > 0 ? `\n… (${extra} más)` : '');
}

async function toolMultiEdit(root, relPath, edits) {
  if (!Array.isArray(edits) || !edits.length) {
    throw new Error('edits debe ser una lista de {old_text, new_text}');
  }
  const done = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i] || {};
    try {
      const out = await toolEditFile(root, relPath, e.old_text, e.new_text, !!e.all);
      done.push(out.slice(out.indexOf('(') + 1, out.lastIndexOf(')')));
    } catch (err) {
      const aplicadas = i > 0 ? ` Ya se aplicaron las ${i} anteriores.` : '';
      throw new Error(`Edición ${i + 1} de ${edits.length}: ${err.message}.${aplicadas}`);
    }
  }
  return `Archivo editado: ${normalizeRel(relPath)} (${edits.length} ediciones: ${done.join('; ')})`;
}

async function toolInsertAtLine(root, relPath, lineArg, content) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('Falta la ruta del archivo');
  const abs = joinPath(root, rel);
  const original = await readFileContent(abs);
  const nl = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(nl);
  let text = String(content ?? '');
  if (!text.endsWith('\n') && !text.endsWith('\r\n')) text += nl;
  const nuevas = text.replace(/\r\n/g, '\n').split('\n');
  nuevas.pop(); // cola vacía por el \n final
  const line = parseInt(lineArg, 10) || 0;
  let idx = line <= 0 || line > lines.length ? lines.length : line - 1;
  if (idx === lines.length && lines.length && lines[lines.length - 1] === '') idx -= 1;
  lines.splice(idx, 0, ...nuevas);
  await writeFileContent(abs, lines.join(nl));
  notifyFsChanged();
  return `Archivo editado: ${rel} (${nuevas.length} línea(s) insertada(s) en la línea ${idx + 1})`;
}

const MAX_FETCH_CHARS = 12000;

function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript').forEach((el) => el.remove());
  return (doc.body?.textContent || '').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
}

async function toolFetchUrl(url) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) throw new Error('La URL debe empezar por http:// o https://');
  let res;
  try {
    res = await fetch(target, { headers: { Accept: 'text/html,application/json,text/plain,*/*' } });
  } catch (err) {
    throw new Error(`No se pudo descargar ${target}: ${err.message || err}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} al descargar ${target}`);
  const ctype = res.headers.get('content-type') || '';
  const raw = await res.text();
  let text = raw;
  if (ctype.includes('html') || /^\s*<!doctype|^\s*<html/i.test(raw.slice(0, 200))) {
    text = htmlToText(raw);
  } else if (!/text|json|xml|javascript/.test(ctype)) {
    throw new Error(`${target} no es texto (${ctype.split(';')[0] || 'tipo desconocido'})`);
  }
  if (text.length > MAX_FETCH_CHARS) {
    text = `${text.slice(0, MAX_FETCH_CHARS)}\n…[recortado: ${text.length - MAX_FETCH_CHARS} caracteres más]`;
  }
  return text || '(la página no tiene texto)';
}

async function toolWebSearch(query, limit) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('Falta query');
  let data;
  try {
    data = await api.post('/api/websearch', { query: q, limit: Math.max(1, Math.min(parseInt(limit, 10) || 5, 10)) });
  } catch (err) {
    throw new Error(`Búsqueda web fallida: ${err.message || err}`);
  }
  const results = data?.results || [];
  if (!results.length) return '(sin resultados)';
  return results
    .map((r, i) => `${i + 1}. ${r.title || '(sin título)'}\n   ${r.url || ''}\n   `
      + `${String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 1500)}`)
    .join('\n\n');
}

async function toolDeleteFile(root, relPath) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('Falta la ruta');
  const abs = joinPath(root, rel);
  await deleteEntry(abs);
  notifyFsChanged();
  return `Eliminado: ${rel}`;
}

async function toolRenameFile(root, srcRel, dstRel) {
  const src = normalizeRel(srcRel);
  const dst = normalizeRel(dstRel);
  if (!src || !dst) throw new Error('Faltan las rutas src/dst');
  const absSrc = joinPath(root, src);
  const srcParent = src.split('/').slice(0, -1).join('/');
  const dstParent = dst.split('/').slice(0, -1).join('/');
  const dstName = dst.split('/').pop();

  if (srcParent === dstParent) {
    await renameEntry(absSrc, dstName);
    notifyFsChanged();
    return `Movido: ${src} → ${dst}`;
  }

  // Entre carpetas distintas: solo archivos (leer + escribir + borrar)
  const content = await readFileContent(absSrc);
  const parentAbs = await ensureDirs(root, dstParent);
  if (!(await fileExists(root, dst))) await createNewEntry(parentAbs, dstName, false);
  const absDst = joinPath(root, dst);
  await writeFileContent(absDst, content);
  await deleteEntry(absSrc);
  notifyFsChanged();
  return `Movido: ${src} → ${dst}`;
}

export async function executeToolCall(root, tool, args = {}) {
  switch (tool) {
    case 'list_files': return toolListFiles(root, args.path ?? '.');
    case 'find_files': return toolFindFiles(root, args.pattern);
    case 'outline': return toolOutline(root, args.path);
    case 'read_file': return toolReadFile(root, args.path, args.start_line, args.end_line);
    case 'write_file': return toolWriteFile(root, args.path, String(args.content ?? ''));
    case 'edit_file': return toolEditFile(root, args.path, args.old_text, args.new_text, !!args.all);
    case 'multi_edit': return toolMultiEdit(root, args.path, args.edits);
    case 'insert_at_line': return toolInsertAtLine(root, args.path, args.line, String(args.content ?? ''));
    case 'append_file': return toolAppendFile(root, args.path, String(args.content ?? ''));
    case 'mkdir': return toolMkdir(root, args.path);
    case 'search': return toolSearch(root, args.pattern);
    case 'search_codebase': return toolSearchCodebase(root, args.query ?? args.pattern);
    case 'delete_file': return toolDeleteFile(root, args.path);
    case 'rename_file': return toolRenameFile(root, args.src, args.dst);
    case 'run_command': return toolRunCommand(root, args.command, args.timeout);
    case 'fetch_url': return toolFetchUrl(args.url);
    case 'web_search': return toolWebSearch(args.query, args.limit);
    default: throw new Error(`Herramienta no soportada en el IDE: ${tool}`);
  }
}

// ── Checkpoints: revertir un cambio del agente (estilo Cursor) ─────────

const MAX_SNAPSHOT_CHARS = 300000;

/** Captura lo necesario para deshacer una herramienta mutadora ANTES de
    ejecutarla. null = no reversible (mkdir, comandos, archivos enormes). */
export async function captureSnapshot(root, tool, args = {}) {
  try {
    if (tool === 'write_file' || tool === 'append_file' || tool === 'edit_file' || tool === 'delete_file'
      || tool === 'multi_edit' || tool === 'insert_at_line') {
      const rel = normalizeRel(args.path);
      if (!rel) return null;
      let oldContent = null; // null = el archivo no existía
      try {
        oldContent = await readFileContent(joinPath(root, rel));
      } catch { /* nuevo o binario */ }
      if (oldContent !== null && oldContent.length > MAX_SNAPSHOT_CHARS) return null;
      return { kind: 'file', path: rel, oldContent };
    }
    if (tool === 'rename_file') {
      return { kind: 'rename', src: normalizeRel(args.src), dst: normalizeRel(args.dst) };
    }
  } catch { /* rutas inválidas: sin snapshot */ }
  return null;
}

/** Deshace un cambio a partir de su snapshot. */
export async function revertSnapshot(root, snapshot) {
  if (!snapshot) throw new Error('Este cambio no es reversible');
  if (snapshot.kind === 'rename') {
    return toolRenameFile(root, snapshot.dst, snapshot.src);
  }
  if (snapshot.oldContent === null) {
    // El archivo no existía: revertir = eliminarlo
    return toolDeleteFile(root, snapshot.path);
  }
  const rel = normalizeRel(snapshot.path);
  const abs = joinPath(root, rel);
  await writeFileContent(abs, snapshot.oldContent);
  notifyFsChanged();
  return `Revertido: ${rel}`;
}

// ── Vista previa del cambio (para la tarjeta de aprobación) ────────────

export async function computeChangePreview(root, tool, args = {}) {
  if (tool === 'write_file' || tool === 'append_file') {
    const rel = normalizeRel(args.path);
    let oldText = null;
    try {
      oldText = await readFileContent(joinPath(root, rel));
    } catch { /* archivo nuevo (o binario: sin preview) */ }
    const newText = tool === 'append_file'
      ? (oldText ?? '') + String(args.content ?? '')
      : String(args.content ?? '');
    const d = diffCounts(oldText ?? '', newText);
    return { kind: oldText === null ? 'create' : 'update', path: rel, ...d };
  }
  if (tool === 'edit_file') {
    const rel = normalizeRel(args.path);
    const empty = { kind: 'update', path: rel, added: 0, removed: 0, sampleOld: [], sampleNew: [] };
    let oldText = null;
    try {
      oldText = await readFileContent(joinPath(root, rel));
    } catch { /* no existe: el error real saldrá al ejecutar */ }
    if (oldText === null || !args.old_text || !oldText.includes(args.old_text)) return empty;
    const newText = args.all
      ? oldText.split(args.old_text).join(args.new_text ?? '')
      : oldText.replace(args.old_text, args.new_text ?? '');
    const d = diffCounts(oldText, newText);
    return { kind: 'update', path: rel, ...d };
  }
  if (tool === 'multi_edit') {
    const rel = normalizeRel(args.path);
    const empty = { kind: 'update', path: rel, added: 0, removed: 0, sampleOld: [], sampleNew: [] };
    let oldText = null;
    try {
      oldText = await readFileContent(joinPath(root, rel));
    } catch { /* no existe: el error real saldrá al ejecutar */ }
    if (oldText === null) return empty;
    let newText = oldText;
    for (const e of (Array.isArray(args.edits) ? args.edits : [])) {
      if (!e?.old_text || !newText.includes(e.old_text)) continue;
      newText = e.all ? newText.split(e.old_text).join(e.new_text ?? '') : newText.replace(e.old_text, e.new_text ?? '');
    }
    const d = diffCounts(oldText, newText);
    return { kind: 'update', path: rel, ...d };
  }
  if (tool === 'insert_at_line') {
    const rel = normalizeRel(args.path);
    const added = String(args.content ?? '').split('\n').filter((l, i, arr) => i < arr.length - 1 || l !== '').length;
    return { kind: 'update', path: rel, added, removed: 0, sampleOld: [], sampleNew: String(args.content ?? '').split('\n').slice(0, 10) };
  }
  if (tool === 'run_command') {
    return { kind: 'command', path: String(args.command ?? ''), added: 0, removed: 0, sampleOld: [], sampleNew: [] };
  }
  if (tool === 'delete_file') {
    const rel = normalizeRel(args.path);
    let removed = 0;
    try {
      removed = (await readFileContent(joinPath(root, rel))).split('\n').length;
    } catch { /* carpeta o binario: sin conteo */ }
    return { kind: 'delete', path: rel, added: 0, removed, sampleOld: [], sampleNew: [] };
  }
  if (tool === 'rename_file') {
    return {
      kind: 'rename',
      path: `${normalizeRel(args.src)} → ${normalizeRel(args.dst)}`,
      added: 0, removed: 0, sampleOld: [], sampleNew: [],
    };
  }
  if (tool === 'mkdir') {
    return { kind: 'mkdir', path: normalizeRel(args.path), added: 0, removed: 0, sampleOld: [], sampleNew: [] };
  }
  return null;
}

// ── System prompt ──────────────────────────────────────────────────────

export async function buildAgentSystemPrompt(root) {
  let tree = '(no se pudo listar el workspace)';
  try {
    const files = await listFiles();
    const rels = files.map((f) => f.rel.replace(/\\/g, '/')).sort();
    tree = rels.slice(0, MAX_TREE_ENTRIES).join('\n') || '(workspace vacío)';
    if (rels.length > MAX_TREE_ENTRIES) {
      tree += '\n… (hay más archivos; usa list_files para explorar)';
    }
  } catch { /* sin árbol: el agente puede usar list_files */ }

  return (
    'Eres un agente de código experto que trabaja DIRECTAMENTE sobre los archivos del usuario dentro de Lixbon, ' +
    'una app centrada en el chat: el usuario no tiene un editor de código abierto, así que tus resúmenes deben ' +
    'ser claros por sí mismos.\n' +
    `Workspace: ${root}\n` +
    'Rutas siempre RELATIVAS al workspace.\n\n' +
    '=== HERRAMIENTAS DISPONIBLES ===\n' +
    'Para usar una herramienta escribe una línea que contenga SOLO su JSON:\n' +
    '{"tool":"list_files","args":{"path":"."}}\n' +
    '{"tool":"find_files","args":{"pattern":"*.py"}}  (glob por nombre o ruta: "src/**/*.jsx", "test_*")\n' +
    '{"tool":"read_file","args":{"path":"archivo.txt"}}  (opcional: "start_line" y "end_line" para archivos grandes)\n' +
    '{"tool":"outline","args":{"path":"archivo.js"}}  (funciones/clases con su línea; úsalo antes de read_file en archivos grandes)\n' +
    '{"tool":"edit_file","args":{"path":"archivo.txt","old_text":"fragmento EXACTO actual","new_text":"fragmento nuevo"}}\n' +
    '{"tool":"multi_edit","args":{"path":"archivo.txt","edits":[{"old_text":"a","new_text":"b"},{"old_text":"c","new_text":"d"}]}}  (varias sustituciones EXACTAS en una llamada)\n' +
    '{"tool":"insert_at_line","args":{"path":"archivo.txt","line":10,"content":"texto a insertar\\n"}}  (line=0 o mayor que el total: al final)\n' +
    '{"tool":"write_file","args":{"path":"archivo.txt","content":"contenido completo"}}\n' +
    '{"tool":"append_file","args":{"path":"archivo.txt","content":"texto nuevo al final"}}\n' +
    '{"tool":"mkdir","args":{"path":"carpeta/subcarpeta"}}\n' +
    '{"tool":"search","args":{"pattern":"texto exacto a buscar (grep)"}}\n' +
    '{"tool":"search_codebase","args":{"query":"qué hace o dónde está X (búsqueda semántica)"}}\n' +
    '{"tool":"delete_file","args":{"path":"archivo.txt"}}\n' +
    '{"tool":"rename_file","args":{"src":"viejo.txt","dst":"nuevo.txt"}}\n' +
    '{"tool":"run_command","args":{"command":"npm test","timeout":60}}\n' +
    '{"tool":"fetch_url","args":{"url":"https://…"}}  (descarga una página web como texto)\n' +
    '{"tool":"web_search","args":{"query":"…","limit":5}}  (busca en internet vía el gateway)\n' +
    '{"tool":"ask_user","args":{"questions":[{"question":"¿Qué base de datos uso?","header":"Base de datos","options":[{"label":"PostgreSQL","description":"Ya está en docker-compose"},{"label":"SQLite"}],"multiSelect":false}]}}  ' +
    '(pregunta al usuario con opciones: hasta 4 preguntas de 2 a 6 opciones; siempre podrá escribir otra respuesta. ' +
    'Úsala solo cuando una decisión dependa del usuario y no puedas deducirla del código)\n\n' +
    '=== VISUALES ===\n' +
    'El IDE muestra archivos .html, .svg y .md en una pestaña de vista previa. Si el usuario pide un diagrama, ' +
    'un dashboard, un mockup, un prototipo o cualquier cosa visual que no sea parte del proyecto, crea UN archivo HTML ' +
    'autónomo (CSS y JS en línea; librerías solo por CDN https) en .lixbon/visuals/<nombre>.html con write_file ' +
    'y dile que puede abrirlo con «Ver visual». Sin carpeta de trabajo o en modo Preguntar/Plan, devuélvelo en un ' +
    'único bloque ```html y el usuario lo abrirá con el botón «Ver» del bloque.\n\n' +
    '=== REGLAS OBLIGATORIAS ===\n' +
    '1. Si el usuario pide crear, modificar, arreglar o eliminar algo, DEBES hacerlo con herramientas EN ESTA MISMA RESPUESTA. ' +
    'Tú ejecutas los cambios; el usuario no copia código.\n' +
    '2. PROHIBIDO responder a una petición de cambio mostrando código en bloques ```: ' +
    'el código va DENTRO del JSON de edit_file o write_file.\n' +
    '3. Emite el JSON puro de la herramienta, sin envolverlo en markdown.\n' +
    '4. Para EDITAR o MEJORAR un archivo existente: primero read_file, luego **edit_file** con el fragmento exacto ' +
    '(old_text copiado tal cual, con su indentación). NUNCA reescribas un archivo grande entero con write_file: ' +
    'la salida se trunca y falla. write_file es SOLO para archivos nuevos. Haz varios edit_file pequeños si el cambio es amplio.\n' +
    '5. Puedes encadenar varias herramientas en una misma respuesta.\n' +
    '6. Los resultados te llegan como TOOL_RESULT. Úsalos para continuar; nunca los escribas tú.\n' +
    '7. Tras cambiar código, si el proyecto tiene tests o build, verifica con run_command; ' +
    'si el resultado trae un error (EXIT distinto de 0), CORRIGE el archivo y vuelve a ejecutar hasta que pase.\n' +
    '8. Cuando termines todas las acciones, responde SOLO con texto normal (sin JSON ni código) resumiendo lo que hiciste.\n\n' +
    '=== EJEMPLO 1 (crear) ===\n' +
    'Usuario: crea un script que imprima hola\n' +
    'Asistente: {"tool":"write_file","args":{"path":"hola.py","content":"print(\'hola\')\\n"}}\n' +
    'Usuario: TOOL_RESULT write_file: Archivo creado: hola.py (14 chars)\n' +
    'Asistente: Listo: creé hola.py, que imprime «hola» al ejecutarlo.\n\n' +
    '=== EJEMPLO 2 (editar) ===\n' +
    'Usuario: renombra la variable x a total en utils.js\n' +
    'Asistente: {"tool":"read_file","args":{"path":"utils.js"}}\n' +
    'Usuario: TOOL_RESULT read_file: export const x = 1;\\nexport const y = x + 2;\n' +
    'Asistente: {"tool":"edit_file","args":{"path":"utils.js","old_text":"export const x = 1;\\nexport const y = x + 2;","new_text":"export const total = 1;\\nexport const y = total + 2;"}}\n' +
    'Usuario: TOOL_RESULT edit_file: Archivo editado: utils.js (1 reemplazo)\n' +
    'Asistente: Hecho: renombré x a total en utils.js.\n\n' +
    '=== ARCHIVOS DEL WORKSPACE ===\n' +
    tree +
    '\n\n=== RECUERDA ===\n' +
    'Las peticiones de cambio se resuelven con herramientas, nunca mostrando código en el chat.'
  );
}
