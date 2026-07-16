// format.js — formatear el documento activo (A4). Ejecuta el formateador del
// lenguaje sobre el archivo (in-place) vía run_command y recarga desde disco.
//
// Prettier se resuelve como ESLint (ver linters.js): primero el del propio
// proyecto (node_modules/.bin), y si no lo hay, uno que lixbon auto-instala en
// su app-data la primera vez. Prettier funciona sin config (usa sus defaults) y,
// si el proyecto trae .prettierrc, lo respeta porque se ejecuta en su carpeta.
// Los demás formateadores (black/rustfmt/gofmt) deben estar en el PATH.

import { runCommand, resolveProjectBin, lspResolve, lspInstallNpm } from './tauri';
import { useEditorStore } from '../store/editorStore';

// Extensiones que formatea Prettier (auto-provisionable).
const PRETTIER_EXTS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'json',
  'css', 'scss', 'less', 'html', 'vue', 'svelte', 'md', 'yaml', 'yml',
]);

// Otros formateadores por extensión (comando que formatea EN SITIO, en PATH).
const OTHER_FORMATTERS = {
  py: 'black -q', rs: 'rustfmt', go: 'gofmt -w',
};

function extOf(name) {
  const base = (name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Carpeta que contiene el archivo (para ejecutar el formateador ahí). */
function dirOf(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : path;
}

export function canFormat(name) {
  const ext = extOf(name);
  return PRETTIER_EXTS.has(ext) || !!OTHER_FORMATTERS[ext];
}

/** Localiza Prettier: el del proyecto si existe, si no el de lixbon
    (auto-instalado en app-data la primera vez). Requiere Node.js. */
async function resolvePrettier(fileDir) {
  const local = await resolveProjectBin(fileDir, 'prettier').catch(() => null);
  if (local) return local;
  let bin = await lspResolve('tool-prettier', 'prettier').catch(() => null);
  if (!bin) bin = await lspInstallNpm('tool-prettier', 'prettier', 'prettier'); // instala una vez
  return bin;
}

/** Formatea `path`. Devuelve { ok, error? }. `silent` para no molestar en autosave. */
export async function formatFile(path, name) {
  const ext = extOf(name);
  const isPrettier = PRETTIER_EXTS.has(ext);
  if (!isPrettier && !OTHER_FORMATTERS[ext]) {
    return { ok: false, error: `No hay formateador configurado para .${ext}` };
  }

  const store = useEditorStore.getState();
  await store.saveTab(path, true); // el formateador lee del disco
  const dir = dirOf(path);

  let cmd;
  if (isPrettier) {
    let bin;
    try {
      bin = await resolvePrettier(dir);
    } catch (e) {
      return { ok: false, error: 'No se pudo preparar Prettier: ' + (e?.message || e) };
    }
    if (!bin) return { ok: false, error: 'Prettier no está disponible (¿Node.js instalado?).' };
    cmd = `"${bin}" --write "${path}"`;
  } else {
    cmd = `${OTHER_FORMATTERS[ext]} "${path}"`;
  }

  try {
    const res = await runCommand(cmd, 30000, dir); // en la carpeta del archivo
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
