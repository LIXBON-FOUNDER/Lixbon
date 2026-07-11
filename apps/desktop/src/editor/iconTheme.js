// iconTheme.js — temas de iconos de VSCode (contributes.iconThemes) para el
// FileTree. Solo iconos SVG (cubre Material Icon Theme y similares); los
// basados en fuente (Seti) no son representables y devuelven null → el árbol
// cae a sus iconos propios.

import { extReadFile } from '../lib/tauri';
import { parseJsonc } from './jsonc';

let loaded = null; // { key, extId, basePath, json } — tema cargado en memoria
const svgCache = new Map(); // `${extId}:${rel}` → dataURL | null

/** Une y normaliza una ruta relativa resolviendo ./ y ../ (Rust rechaza `..`,
    así que hay que resolverlos aquí). Devuelve null si escapa de la raíz. */
function joinRel(base, rel) {
  const parts = [];
  for (const part of `${base}/${rel}`.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

/** Carga (una vez) el JSON del tema de iconos seleccionado. */
export async function loadIconTheme(sel) {
  if (!sel) {
    loaded = null;
    return null;
  }
  const key = `${sel.extId}:${sel.path}`;
  if (loaded && loaded.key === key) return loaded;
  const json = parseJsonc(await extReadFile(sel.extId, sel.path));
  const basePath = sel.path.split('/').slice(0, -1).join('/');
  loaded = { key, extId: sel.extId, basePath, json };
  return loaded;
}

export function unloadIconTheme() {
  loaded = null;
}

/** Id de definición de icono para una entrada del árbol, o null. */
export function iconDefIdFor(name, isDir, expanded = false) {
  if (!loaded) return null;
  const j = loaded.json;
  const lower = String(name || '').toLowerCase();
  if (isDir) {
    const named = expanded
      ? (j.folderNamesExpanded || {})[lower] || (j.folderNames || {})[lower]
      : (j.folderNames || {})[lower];
    if (named) return named;
    return (expanded && j.folderExpanded) || j.folder || null;
  }
  if ((j.fileNames || {})[lower]) return (j.fileNames || {})[lower];
  // extensiones compuestas: "app.spec.ts" prueba "spec.ts" y luego "ts"
  const parts = lower.split('.');
  const fes = j.fileExtensions || {};
  for (let i = 1; i < parts.length; i++) {
    const ext = parts.slice(i).join('.');
    if (fes[ext]) return fes[ext];
  }
  // languageIds: aproximación por extensión simple
  const lids = j.languageIds || {};
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  if (last && lids[last]) return lids[last];
  return j.file || null;
}

/** Data-URL del SVG de una definición, o null si no es SVG/estás sin tema. */
export async function iconDataUrl(defId) {
  if (!loaded || !defId) return null;
  const def = (loaded.json.iconDefinitions || {})[defId];
  const iconPath = def && def.iconPath;
  if (!iconPath || !String(iconPath).toLowerCase().endsWith('.svg')) return null;
  const rel = joinRel(loaded.basePath, String(iconPath));
  if (!rel) return null;
  const key = `${loaded.extId}:${rel}`;
  if (svgCache.has(key)) return svgCache.get(key);
  try {
    const svg = await extReadFile(loaded.extId, rel);
    const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
    svgCache.set(key, url);
    return url;
  } catch {
    svgCache.set(key, null);
    return null;
  }
}
