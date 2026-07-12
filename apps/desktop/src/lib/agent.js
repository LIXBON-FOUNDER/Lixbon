// agent.js — modo agente del chat del IDE: el modelo pide herramientas con
// JSON embebido ({"tool":...,"args":{...}}) y aquí se parsean y ejecutan sobre
// la carpeta de trabajo usando los comandos Rust existentes (sandbox incluido).
// Mismo protocolo que el CLI (apps/cli/lixbon_cli/agent.py); sin run_command:
// el IDE no tiene un primitivo de ejecución con captura de salida.

import {
  listFiles, readDir, readFileContent, writeFileContent, createNewEntry,
  renameEntry, deleteEntry, searchInFiles, runCommand,
} from './tauri';
import { useEditorStore } from '../store/editorStore';
import { diffCounts, normalizeRel } from './agentProtocol';

// La parte pura del protocolo (parseo de tool calls, diff, límites) vive en
// agentProtocol.js para poder testearse sin Tauri; se re-exporta desde aquí.
export {
  MAX_AGENT_STEPS,
  READ_ONLY_TOOLS,
  buildModelHistory,
  cleanProse,
  displayableText,
  extractToolCalls,
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
  try {
    await useEditorStore.getState().reloadFromDisk(abs);
  } catch { /* la UI no debe romper la herramienta */ }
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
  const isNew = !(await fileExists(root, rel));
  if (isNew) await createNewEntry(parentAbs, name, false);
  const abs = joinPath(root, rel);
  await writeFileContent(abs, content);
  try {
    await useEditorStore.getState().reloadFromDisk(abs);
  } catch { /* la UI no debe romper la herramienta */ }
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

async function toolDeleteFile(root, relPath) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('Falta la ruta');
  const abs = joinPath(root, rel);
  await deleteEntry(abs);
  try {
    useEditorStore.getState().closeUnder(abs);
  } catch { /* ídem */ }
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
    const newAbs = await renameEntry(absSrc, dstName);
    useEditorStore.getState().remapPaths(absSrc, newAbs);
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
  useEditorStore.getState().remapPaths(absSrc, absDst);
  notifyFsChanged();
  return `Movido: ${src} → ${dst}`;
}

export async function executeToolCall(root, tool, args = {}) {
  switch (tool) {
    case 'list_files': return toolListFiles(root, args.path ?? '.');
    case 'read_file': return toolReadFile(root, args.path, args.start_line, args.end_line);
    case 'write_file': return toolWriteFile(root, args.path, String(args.content ?? ''));
    case 'edit_file': return toolEditFile(root, args.path, args.old_text, args.new_text, !!args.all);
    case 'append_file': return toolAppendFile(root, args.path, String(args.content ?? ''));
    case 'mkdir': return toolMkdir(root, args.path);
    case 'search': return toolSearch(root, args.pattern);
    case 'delete_file': return toolDeleteFile(root, args.path);
    case 'rename_file': return toolRenameFile(root, args.src, args.dst);
    case 'run_command': return toolRunCommand(root, args.command, args.timeout);
    default: throw new Error(`Herramienta no soportada en el IDE: ${tool}`);
  }
}

// ── Checkpoints: revertir un cambio del agente (estilo Cursor) ─────────

const MAX_SNAPSHOT_CHARS = 300000;

/** Captura lo necesario para deshacer una herramienta mutadora ANTES de
    ejecutarla. null = no reversible (mkdir, comandos, archivos enormes). */
export async function captureSnapshot(root, tool, args = {}) {
  try {
    if (tool === 'write_file' || tool === 'append_file' || tool === 'edit_file' || tool === 'delete_file') {
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
  return toolWriteFile(root, snapshot.path, snapshot.oldContent);
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

export async function buildAgentSystemPrompt(root, activeFile = '') {
  let tree = '(no se pudo listar el workspace)';
  try {
    const files = await listFiles();
    const rels = files.map((f) => f.rel.replace(/\\/g, '/')).sort();
    tree = rels.slice(0, MAX_TREE_ENTRIES).join('\n') || '(workspace vacío)';
    if (rels.length > MAX_TREE_ENTRIES) {
      tree += '\n… (hay más archivos; usa list_files para explorar)';
    }
  } catch { /* sin árbol: el agente puede usar list_files */ }

  const activeLine = activeFile
    ? `Archivo abierto en el editor ahora mismo: ${activeFile} (si el usuario dice "este archivo", es este).\n`
    : '';

  return (
    'Eres un agente de código experto que trabaja DIRECTAMENTE sobre los archivos del usuario dentro del IDE Lixbon.\n' +
    `Workspace: ${root}\n` +
    activeLine +
    'Rutas siempre RELATIVAS al workspace.\n\n' +
    '=== HERRAMIENTAS DISPONIBLES ===\n' +
    'Para usar una herramienta escribe una línea que contenga SOLO su JSON:\n' +
    '{"tool":"list_files","args":{"path":"."}}\n' +
    '{"tool":"read_file","args":{"path":"archivo.txt"}}  (opcional: "start_line" y "end_line" para archivos grandes)\n' +
    '{"tool":"edit_file","args":{"path":"archivo.txt","old_text":"fragmento EXACTO actual","new_text":"fragmento nuevo"}}\n' +
    '{"tool":"write_file","args":{"path":"archivo.txt","content":"contenido completo"}}\n' +
    '{"tool":"append_file","args":{"path":"archivo.txt","content":"texto nuevo al final"}}\n' +
    '{"tool":"mkdir","args":{"path":"carpeta/subcarpeta"}}\n' +
    '{"tool":"search","args":{"pattern":"texto a buscar"}}\n' +
    '{"tool":"delete_file","args":{"path":"archivo.txt"}}\n' +
    '{"tool":"rename_file","args":{"src":"viejo.txt","dst":"nuevo.txt"}}\n' +
    '{"tool":"run_command","args":{"command":"npm test","timeout":60}}\n\n' +
    '=== REGLAS OBLIGATORIAS ===\n' +
    '1. Si el usuario pide crear, modificar, arreglar o eliminar algo, DEBES hacerlo con herramientas EN ESTA MISMA RESPUESTA. ' +
    'Tú ejecutas los cambios; el usuario no copia código.\n' +
    '2. PROHIBIDO responder a una petición de cambio mostrando código en bloques ```: ' +
    'el código va DENTRO del JSON de edit_file o write_file.\n' +
    '3. Emite el JSON puro de la herramienta, sin envolverlo en markdown.\n' +
    '4. Para EDITAR un archivo existente: primero read_file, luego **edit_file** con el fragmento exacto ' +
    '(old_text copiado tal cual, con su indentación). Usa write_file solo para archivos nuevos o reescrituras totales.\n' +
    '5. Puedes encadenar varias herramientas en una misma respuesta.\n' +
    '6. Los resultados te llegan como TOOL_RESULT. Úsalos para continuar; nunca los escribas tú.\n' +
    '7. Tras cambiar código, si el proyecto tiene tests o build, verifica con run_command.\n' +
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
