// codebaseIndex.js — índice semántico del workspace (RAG local, B3).
// Trocea los archivos de texto, pide embeddings al gateway (/api/embed) y guarda
// {rel,start,end,text,vec} en `.lixbon/index.json` DENTRO del workspace (sandbox
// Rust). La búsqueda es coseno en JS. Sin Rust nuevo: reutiliza los comandos de
// archivo existentes.

import { listFiles, readFileContent, writeFileContent, createNewEntry } from './tauri';
import { useAppStore } from '../store/appStore';
import { roleWarning } from './modelRoles';

const INDEX_DIR = '.lixbon';
const INDEX_FILE = 'index.json';
const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 10;
const MAX_FILE_BYTES = 200_000;
const MAX_CHUNKS = 2500;
const EMBED_BATCH = 24;

const TEXT_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json', 'py', 'rs', 'go', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'rb', 'php', 'swift', 'scala', 'dart', 'lua',
  'sh', 'bash', 'ps1', 'sql', 'html', 'css', 'scss', 'less', 'vue', 'svelte',
  'md', 'txt', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'xml', 'r', 'jl', 'ex', 'exs',
  'clj', 'hs', 'ml', 'proto', 'graphql', 'gradle', 'dockerfile', 'env',
]);

const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.lixbon|dist|build|target|\.venv|venv|__pycache__|\.next|out|coverage)\//;

let cached = null; // índice cargado en memoria

// ── Rutas (sandbox) ─────────────────────────────────────────────────────
function sepOf(root) { return root.includes('\\') ? '\\' : '/'; }

function extOf(rel) {
  const base = rel.split('/').pop() || '';
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

async function ensureIndexPath(root) {
  const s = sepOf(root);
  try { await createNewEntry(root, INDEX_DIR, true); }
  catch (e) { if (!String(e).includes('Ya existe')) throw e; }
  const dirAbs = root + s + INDEX_DIR;
  try { await createNewEntry(dirAbs, INDEX_FILE, false); }
  catch (e) { if (!String(e).includes('Ya existe')) throw e; }
  return dirAbs + s + INDEX_FILE;
}

// ── Embeddings vía gateway ──────────────────────────────────────────────
async function requestEmbeddings(model, texts, signal) {
  const { serverUrl, apiKey } = useAppStore.getState();
  const res = await fetch(`${serverUrl}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts }),
    signal,
  });
  if (!res.ok) {
    let detail = `Error del servidor (${res.status})`;
    try { const b = await res.json(); if (b.detail) detail = b.detail; } catch { /* no-json */ }
    throw new Error(detail);
  }
  const data = await res.json();
  return data.embeddings || [];
}

// ── Troceado ────────────────────────────────────────────────────────────
function chunkFile(rel, content) {
  const lines = content.split('\n');
  const chunks = [];
  const step = CHUNK_LINES - CHUNK_OVERLAP;
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    const text = slice.join('\n').trim();
    if (text) chunks.push({ rel, start: i + 1, end: Math.min(i + CHUNK_LINES, lines.length), text });
    if (i + CHUNK_LINES >= lines.length) break;
  }
  return chunks;
}

// ── Similitud coseno ────────────────────────────────────────────────────
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ── API pública ─────────────────────────────────────────────────────────

/** (Re)construye el índice. onProgress({phase, done, total}). Devuelve el status. */
export async function buildIndex(onProgress = () => {}, signal) {
  const { workspaceRoot } = useAppStore.getState();
  if (!workspaceRoot) throw new Error('No hay carpeta de trabajo abierta.');
  const model = useAppStore.getState().effectiveEmbedModel();
  if (!model) {
    // El gateway ya dice qué instalar cuando el rol `embed` no tiene modelo.
    const aviso = roleWarning(useAppStore.getState().modelRoles, 'embed')
      || 'Instala uno en Ollama (p. ej. `ollama pull nomic-embed-text`).';
    throw new Error(`No hay modelo de embeddings. ${aviso}`);
  }

  onProgress({ phase: 'scan', done: 0, total: 0 });
  const files = (await listFiles())
    .map((f) => ({ ...f, rel: f.rel.replace(/\\/g, '/') }))
    .filter((f) => TEXT_EXT.has(extOf(f.rel)) && !SKIP_DIRS.test('/' + f.rel + '/'));

  // Trocear
  let chunks = [];
  for (const f of files) {
    if (signal?.aborted) throw new Error('Cancelado');
    let content;
    try { content = await readFileContent(f.path); } catch { continue; }
    if (content.length > MAX_FILE_BYTES) content = content.slice(0, MAX_FILE_BYTES);
    chunks.push(...chunkFile(f.rel, content));
    if (chunks.length >= MAX_CHUNKS) { chunks = chunks.slice(0, MAX_CHUNKS); break; }
  }

  // Embeber por lotes
  const total = chunks.length;
  for (let i = 0; i < total; i += EMBED_BATCH) {
    if (signal?.aborted) throw new Error('Cancelado');
    const batch = chunks.slice(i, i + EMBED_BATCH);
    const vecs = await requestEmbeddings(model, batch.map((c) => c.text), signal);
    batch.forEach((c, j) => { c.vec = vecs[j] || []; });
    onProgress({ phase: 'embed', done: Math.min(i + EMBED_BATCH, total), total });
  }
  chunks = chunks.filter((c) => c.vec && c.vec.length);

  const index = {
    version: 1,
    model,
    root: workspaceRoot,
    createdAt: new Date().toISOString(),
    dims: chunks[0]?.vec.length || 0,
    chunks,
  };
  const path = await ensureIndexPath(workspaceRoot);
  await writeFileContent(path, JSON.stringify(index));
  cached = index;
  return indexStatusFrom(index);
}

/** Carga el índice desde disco (cacheado). null si no existe o es de otro root. */
export async function loadIndex() {
  const { workspaceRoot } = useAppStore.getState();
  if (!workspaceRoot) return null;
  if (cached && cached.root === workspaceRoot) return cached;
  const s = sepOf(workspaceRoot);
  const path = workspaceRoot + s + INDEX_DIR + s + INDEX_FILE;
  try {
    const raw = await readFileContent(path);
    const idx = JSON.parse(raw);
    if (idx && Array.isArray(idx.chunks)) { cached = idx; return idx; }
  } catch { /* no existe todavía */ }
  return null;
}

/** Busca los `k` fragmentos más relevantes para `query`. [] si no hay índice. */
export async function searchIndex(query, k = 6, signal) {
  const idx = await loadIndex();
  if (!idx || !idx.chunks.length) return [];
  const [qvec] = await requestEmbeddings(idx.model, [query], signal);
  if (!qvec) return [];
  return idx.chunks
    .map((c) => ({ ...c, score: cosine(qvec, c.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(({ rel, start, end, text, score }) => ({ rel, start, end, text, score }));
}

function indexStatusFrom(idx) {
  return idx
    ? { exists: true, count: idx.chunks.length, model: idx.model, createdAt: idx.createdAt }
    : { exists: false, count: 0, model: '', createdAt: null };
}

/** Estado del índice del workspace actual. */
export async function indexStatus() {
  return indexStatusFrom(await loadIndex());
}

/** Invalida la caché en memoria (al cambiar de workspace). */
export function resetIndexCache() { cached = null; }
