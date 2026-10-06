// preview.js — qué archivos tienen vista previa y cómo se llega a ellos por
// el servidor local de visuales (visual_server.rs).
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { visualBase, visualSnippet } from './tauri';

const KINDS = { md: 'markdown', markdown: 'markdown', mdx: 'markdown', html: 'html', htm: 'html', svg: 'svg' };

export const VISUALS_DIR = '.lixbon/visuals';

export function previewKind(path) {
  const ext = /\.([a-z0-9]+)$/i.exec(path || '')?.[1]?.toLowerCase();
  return KINDS[ext] || null;
}

/** Markdown se abre para leer; HTML y SVG, para editar. Con cambios del
    agente pendientes de revisar manda el código, que es donde se revisan. */
export function viewOf(tab, views, reviewing) {
  const kind = tab && !tab.virtual ? previewKind(tab.path) : null;
  if (!kind) return 'code';
  if (views[tab.path]) return views[tab.path];
  return kind === 'markdown' && !reviewing ? 'preview' : 'code';
}

const sepOf = (p) => (p.includes('\\') ? '\\' : '/');

export function absFromRoot(root, rel) {
  if (!rel || /^([a-z]:)?[\\/]/i.test(rel)) return rel;
  const sep = sepOf(root);
  return root.replace(/[\\/]+$/, '') + sep + rel.replace(/^\.[\\/]/, '').split(/[\\/]/).join(sep);
}

export function relToRoot(root, abs) {
  if (!root || !abs.startsWith(root)) return null;
  return abs.slice(root.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
}

/** Resuelve `href` (relativo a `fromPath`) a una ruta absoluta normalizada. */
export function resolveFrom(fromPath, href) {
  const sep = sepOf(fromPath);
  const parts = fromPath.split(/[\\/]/).slice(0, -1);
  for (const seg of decodeURI(href.split(/[?#]/)[0]).split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join(sep);
}

export function useVisualBase() {
  const root = useAppStore((s) => s.workspaceRoot);
  const [base, setBase] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!root) { setBase(''); return undefined; }
    visualBase().then((b) => alive && setBase(b)).catch(() => alive && setBase(''));
    return () => { alive = false; };
  }, [root]);
  return base;
}

export function servedUrl(base, root, abs) {
  const rel = relToRoot(root, abs);
  if (!base || rel == null) return '';
  return base + rel.split('/').map(encodeURIComponent).join('/');
}

function showInEditor() {
  const wb = useWorkbenchStore.getState();
  if (wb.mode !== 'editor') wb.setMode('editor');
}

export function openFilePreview(abs) {
  showInEditor();
  return useFileViewStore.getState().openPreview(abs);
}

export async function openSnippet(code, language) {
  const ext = language === 'svg' ? 'svg' : 'html';
  const url = await visualSnippet(code, ext);
  const title = /<title>([^<]{1,60})<\/title>/i.exec(code)?.[1]?.trim();
  showInEditor();
  useFileViewStore.getState().openVirtual(`visual://${url.split('/').pop()}`, title || `Visual.${ext}`, { url });
}
