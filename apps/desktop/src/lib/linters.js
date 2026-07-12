// linters.js — ejecuta linters de línea de comandos y parsea su salida JSON a
// diagnósticos (A2). Best-effort: si el linter no está instalado o el proyecto
// no tiene config, se devuelve un error legible.
import { runCommand } from './tauri';

function extOf(name) {
  const base = (name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
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

const ESLINT = { cmd: (p) => `eslint -f json "${p}"`, parse: parseEslint };

const LINTERS = {
  py: { cmd: (p) => `ruff check --output-format json "${p}"`, parse: parseRuff },
  js: ESLINT, jsx: ESLINT, ts: ESLINT, tsx: ESLINT, mjs: ESLINT, cjs: ESLINT,
};

export function hasLinter(name) {
  return !!LINTERS[extOf(name)];
}

/** Ejecuta el linter del archivo. { ok, diagnostics, error? }. */
export async function runLinter(path, name) {
  const ext = extOf(name);
  const l = LINTERS[ext];
  if (!l) return { ok: false, error: `No hay linter para .${ext}`, diagnostics: [] };
  let res;
  try {
    res = await runCommand(l.cmd(path), 30000);
  } catch (e) {
    return { ok: false, error: String(e?.message || e), diagnostics: [] };
  }
  // ruff/eslint salen con código ≠0 cuando HAY problemas: eso es normal.
  const raw = (res.stdout || '').trim();
  if (!raw) {
    // Sin salida JSON: puede ser que no esté instalado (mensaje en stderr).
    if (res.code !== 0 && res.stderr?.trim()) {
      return { ok: false, error: res.stderr.trim().slice(0, 200), diagnostics: [] };
    }
    return { ok: true, diagnostics: [] }; // sin problemas
  }
  try {
    return { ok: true, diagnostics: l.parse(raw) };
  } catch {
    return { ok: false, error: 'No se pudo interpretar la salida del linter.', diagnostics: [] };
  }
}
