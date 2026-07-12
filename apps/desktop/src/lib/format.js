// format.js — formatear el documento activo (A4). Ejecuta el formateador del
// lenguaje sobre el archivo (in-place) vía run_command y recarga desde disco.
// Best-effort: si el formateador no está instalado, devuelve un error legible.

import { runCommand } from './tauri';
import { useEditorStore } from '../store/editorStore';

// ext → comando que formatea EN SITIO (recibe la ruta del archivo).
const FORMATTERS = {
  js: 'prettier --write', jsx: 'prettier --write', ts: 'prettier --write', tsx: 'prettier --write',
  mjs: 'prettier --write', cjs: 'prettier --write', json: 'prettier --write',
  css: 'prettier --write', scss: 'prettier --write', less: 'prettier --write',
  html: 'prettier --write', vue: 'prettier --write', svelte: 'prettier --write',
  md: 'prettier --write', yaml: 'prettier --write', yml: 'prettier --write',
  py: 'black -q', rs: 'rustfmt', go: 'gofmt -w',
};

function extOf(name) {
  const base = (name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function canFormat(name) {
  return !!FORMATTERS[extOf(name)];
}

/** Formatea `path`. Devuelve { ok, error? }. `silent` para no molestar en autosave. */
export async function formatFile(path, name) {
  const ext = extOf(name);
  const cmd = FORMATTERS[ext];
  if (!cmd) return { ok: false, error: `No hay formateador configurado para .${ext}` };

  const store = useEditorStore.getState();
  await store.saveTab(path, true); // el formateador lee del disco
  try {
    const res = await runCommand(`${cmd} "${path}"`, 30000);
    if (res.timed_out) return { ok: false, error: 'El formateador tardó demasiado.' };
    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout || '').trim().slice(0, 300);
      return { ok: false, error: msg || `El formateador salió con código ${res.code}. ¿Está instalado?` };
    }
    await store.reloadFromDisk(path);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
