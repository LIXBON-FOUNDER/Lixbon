// linters.js — ejecuta linters y parsea su salida JSON a diagnósticos (A2).
//
// ESLint se resuelve como en VSCode: primero el del propio proyecto
// (node_modules/.bin), y si no lo hay, uno que lixbon auto-instala en su
// app-data la primera vez (sin tocar el PATH global). Si el proyecto no trae
// config, se usa el config por defecto de lixbon, así funciona «de fábrica».
import {
  runCommand, resolveProjectBin, lspResolve, lspInstallNpm, eslintDefaultConfig,
} from './tauri';

function extOf(name) {
  const base = (name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** Carpeta que contiene el archivo (para ejecutar el linter ahí). */
function dirOf(path) {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i > 0 ? path.slice(0, i) : path;
}

function parseRuff(stdout) {
  const arr = JSON.parse(stdout || '[]');
  return arr.map((it) => ({
    line: it.location?.row,
    col: it.location?.column,
    endLine: it.end_location?.row,
    endCol: it.end_location?.column,
    severity: 'warning',
    message: `${it.code ? it.code + ': ' : ''}${it.message || ''}`,
    source: 'ruff',
  }));
}

function parseEslint(stdout) {
  const files = JSON.parse(stdout || '[]');
  const out = [];
  for (const f of files) {
    for (const m of f.messages || []) {
      out.push({
        line: m.line,
        col: m.column,
        endLine: m.endLine,
        endCol: m.endColumn,
        severity: m.severity === 2 ? 'error' : 'warning',
        message: `${m.message}${m.ruleId ? ` (${m.ruleId})` : ''}`,
        source: 'eslint',
      });
    }
  }
  return out;
}

const ESLINT_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']);

const LINTERS = {
  py: { tool: 'ruff', cmd: (p) => `ruff check --output-format json "${p}"`, parse: parseRuff },
};
for (const ext of ESLINT_EXTS) LINTERS[ext] = { tool: 'eslint', parse: parseEslint };

export function hasLinter(name) {
  return !!LINTERS[extOf(name)];
}

/** Localiza el ESLint a usar: el del proyecto si existe, si no el de lixbon
    (auto-instalado en app-data la primera vez). Devuelve { bin, local }. */
async function resolveEslint(fileDir) {
  const local = await resolveProjectBin(fileDir, 'eslint').catch(() => null);
  if (local) return { bin: local, local: true };
  let bin = await lspResolve('tool-eslint', 'eslint').catch(() => null);
  if (!bin) bin = await lspInstallNpm('tool-eslint', 'eslint', 'eslint'); // instala una vez
  return { bin, local: false };
}

/** Construye el comando de ESLint. Con el ESLint de lixbon (no el del proyecto)
    y sin config propio del proyecto, se fuerza el config por defecto. */
async function eslintCommand(bin, path, local) {
  const base = `"${bin}" -f json`;
  if (local) return `${base} "${path}"`; // el proyecto manda: usa su config
  const cfg = await eslintDefaultConfig();
  return `${base} --no-config-lookup --config "${cfg}" "${path}"`;
}

/** Ejecuta el linter del archivo. { ok, diagnostics, error? }. */
export async function runLinter(path, name) {
  const ext = extOf(name);
  const l = LINTERS[ext];
  if (!l) return { ok: false, error: `No hay linter para .${ext}`, diagnostics: [] };

  const dir = dirOf(path);
  let cmd;
  if (l.tool === 'eslint') {
    let bin, local;
    try {
      ({ bin, local } = await resolveEslint(dir));
    } catch (e) {
      return { ok: false, error: 'No se pudo preparar ESLint: ' + (e?.message || e), diagnostics: [] };
    }
    if (!bin) return { ok: false, error: 'ESLint no está disponible (¿Node.js instalado?).', diagnostics: [] };
    cmd = await eslintCommand(bin, path, local);
  } else {
    cmd = l.cmd(path);
  }

  let res;
  try {
    res = await runCommand(cmd, 30000, dir); // en la carpeta del archivo
  } catch (e) {
    return { ok: false, error: String(e?.message || e), diagnostics: [] };
  }
  // ruff/eslint salen con código ≠0 cuando HAY problemas: eso es normal.
  const raw = (res.stdout || '').trim();
  if (!raw) {
    if (res.code !== 0 && res.stderr?.trim()) {
      const err = res.stderr.trim();
      if (/config/i.test(err) && /couldn'?t find|no configuration|not found/i.test(err)) {
        return { ok: false, error: 'ESLint no encontró configuración. Crea un eslint.config.js en el proyecto.', diagnostics: [] };
      }
      return { ok: false, error: err.slice(0, 200), diagnostics: [] };
    }
    return { ok: true, diagnostics: [] }; // sin problemas
  }
  try {
    return { ok: true, diagnostics: l.parse(raw) };
  } catch {
    return { ok: false, error: 'No se pudo interpretar la salida del linter.', diagnostics: [] };
  }
}
