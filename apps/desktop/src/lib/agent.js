// agent.js — modo agente del chat del IDE: el modelo pide herramientas con
// JSON embebido ({"tool":...,"args":{...}}) y aquí se parsean y ejecutan sobre
// la carpeta de trabajo usando los comandos Rust existentes (sandbox incluido).
// Mismo protocolo que el CLI (apps/cli/lixbon_cli/agent.py); sin run_command:
// el IDE no tiene un primitivo de ejecución con captura de salida.

import {
  listFiles, readDir, readFileContent, writeFileContent, createNewEntry,
  renameEntry, deleteEntry, searchInFiles,
} from './tauri';
import { useEditorStore } from '../store/editorStore';
import { diffCounts, normalizeRel } from './agentProtocol';

// La parte pura del protocolo (parseo de tool calls, diff, límites) vive en
// agentProtocol.js para poder testearse sin Tauri; se re-exporta desde aquí.
export {
  MAX_AGENT_STEPS,
  READ_ONLY_TOOLS,
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

async function toolReadFile(root, relPath) {
  const rel = normalizeRel(relPath);
  if (!rel) throw new Error('Falta la ruta del archivo');
  const content = await readFileContent(joinPath(root, rel));
  return content.slice(0, MAX_READ_CHARS);
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
    case 'read_file': return toolReadFile(root, args.path);
    case 'write_file': return toolWriteFile(root, args.path, String(args.content ?? ''));
    case 'append_file': return toolAppendFile(root, args.path, String(args.content ?? ''));
    case 'mkdir': return toolMkdir(root, args.path);
    case 'search': return toolSearch(root, args.pattern);
    case 'delete_file': return toolDeleteFile(root, args.path);
    case 'rename_file': return toolRenameFile(root, args.src, args.dst);
    default: throw new Error(`Herramienta no soportada en el IDE: ${tool}`);
  }
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
    'Eres un agente de código experto que trabaja DIRECTAMENTE sobre los archivos del usuario dentro del IDE Lixbon.\n' +
    `Workspace: ${root}\n` +
    'Rutas siempre RELATIVAS al workspace.\n\n' +
    '=== HERRAMIENTAS DISPONIBLES ===\n' +
    'Para usar una herramienta escribe una línea que contenga SOLO su JSON:\n' +
    '{"tool":"list_files","args":{"path":"."}}\n' +
    '{"tool":"read_file","args":{"path":"archivo.txt"}}\n' +
    '{"tool":"write_file","args":{"path":"archivo.txt","content":"contenido completo"}}\n' +
    '{"tool":"append_file","args":{"path":"archivo.txt","content":"texto nuevo al final"}}\n' +
    '{"tool":"mkdir","args":{"path":"carpeta/subcarpeta"}}\n' +
    '{"tool":"search","args":{"pattern":"texto a buscar"}}\n' +
    '{"tool":"delete_file","args":{"path":"archivo.txt"}}\n' +
    '{"tool":"rename_file","args":{"src":"viejo.txt","dst":"nuevo.txt"}}\n\n' +
    '=== REGLAS OBLIGATORIAS ===\n' +
    '1. Si el usuario pide crear, modificar o eliminar algo, DEBES usar herramientas. ' +
    'No describas el cambio ni muestres el código en un bloque: APLÍCALO con la herramienta.\n' +
    '2. Responde con el JSON puro de la herramienta. NUNCA lo envuelvas en markdown (```).\n' +
    '3. Para EDITAR un archivo existente: primero read_file, luego write_file con el contenido COMPLETO ya modificado.\n' +
    '4. Puedes encadenar varias herramientas en una misma respuesta.\n' +
    '5. Los resultados te llegan como TOOL_RESULT. Úsalos para continuar.\n' +
    '6. Cuando termines todas las acciones, responde SOLO con texto normal (sin JSON) resumiendo lo que hiciste.\n\n' +
    '=== EJEMPLO ===\n' +
    'Usuario: crea un script que imprima hola\n' +
    'Asistente: {"tool":"write_file","args":{"path":"hola.py","content":"print(\'hola\')\\n"}}\n' +
    'Usuario: TOOL_RESULT write_file: Archivo creado: hola.py (14 chars)\n' +
    'Asistente: Listo: creé hola.py, que imprime «hola» al ejecutarlo.\n\n' +
    '=== ARCHIVOS DEL WORKSPACE ===\n' +
    tree
  );
}
