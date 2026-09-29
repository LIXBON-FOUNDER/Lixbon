// problemsStore.js — "Problemas": errores y avisos del comprobador del propio
// proyecto (tsc, cargo check, ruff), no de un servidor de lenguaje. Se lanza a
// mano, al guardar (con espera) y cuando el agente termina un turno.
import { create } from 'zustand';
import { readDir, runCommand } from '../lib/tauri';
import { useAppStore } from './appStore';
import { useOutputStore } from './outputStore';

// Cada comprobador: archivo que lo delata, comando y cómo leer su salida.
const CHECKERS = [
  {
    id: 'tsc', marker: 'tsconfig.json', label: 'TypeScript',
    command: 'npx --no-install tsc --noEmit --pretty false',
    // src/a.ts(12,5): error TS2322: Type 'x' is not assignable…
    re: /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/,
    map: (m) => ({ file: m[1], line: +m[2], col: +m[3], severity: m[4], code: m[5], message: m[6] }),
  },
  {
    id: 'cargo', marker: 'Cargo.toml', label: 'Rust',
    command: 'cargo check --message-format short',
    // src/main.rs:12:5: error[E0308]: mismatched types
    re: /^(.+?):(\d+):(\d+):\s+(error|warning)(?:\[(\w+)\])?:\s+(.*)$/,
    map: (m) => ({ file: m[1], line: +m[2], col: +m[3], severity: m[4], code: m[5] || '', message: m[6] }),
  },
  {
    id: 'ruff', marker: 'pyproject.toml', label: 'Python',
    command: 'ruff check --output-format concise',
    // app/main.py:12:5: F401 [*] `os` imported but unused
    re: /^(.+?):(\d+):(\d+):\s+(\w+\d+)\s+(?:\[\*\]\s+)?(.*)$/,
    map: (m) => ({ file: m[1], line: +m[2], col: +m[3], severity: /^E9|^F8/.test(m[4]) ? 'error' : 'warning', code: m[4], message: m[5] }),
  },
];

const SAVE_DELAY = 1500;
let saveTimer = null;

const readAuto = () => { try { return localStorage.getItem('lixbon_problems_auto') !== 'false'; } catch { return true; } };

export const useProblemsStore = create((set, get) => ({
  checker: null,     // CHECKERS[i] detectado para la carpeta
  problems: [],
  running: false,
  lastRun: 0,
  error: '',
  auto: readAuto(),

  setAuto: (auto) => {
    try { localStorage.setItem('lixbon_problems_auto', auto ? 'true' : 'false'); } catch { /* sin almacenamiento */ }
    set({ auto });
  },

  detect: async () => {
    const root = useAppStore.getState().workspaceRoot;
    if (!root) { set({ checker: null, problems: [] }); return null; }
    const entries = await readDir(root).catch(() => []);
    const names = new Set(entries.map((e) => e.name));
    const checker = CHECKERS.find((c) => names.has(c.marker)) || null;
    set({ checker, problems: [], error: '' });
    return checker;
  },

  run: async () => {
    const { running } = get();
    if (running) return;
    const checker = get().checker || await get().detect();
    if (!checker) return;
    set({ running: true, error: '' });
    const out = useOutputStore.getState();
    out.append('Diagnóstico', `$ ${checker.command}`);
    try {
      const res = await runCommand(checker.command, 180000);
      const text = `${res.stdout || ''}\n${res.stderr || ''}`;
      const sep = useAppStore.getState().workspaceRoot.includes('\\') ? '\\' : '/';
      const root = useAppStore.getState().workspaceRoot;
      const problems = [];
      for (const line of text.split(/\r?\n/)) {
        const m = line.trim().match(checker.re);
        if (!m) continue;
        const p = checker.map(m);
        const rel = p.file.replace(/\\/g, '/').replace(/^\.\//, '');
        problems.push({ ...p, rel, path: /^([a-zA-Z]:|\/)/.test(p.file) ? p.file : root + sep + rel.replace(/\//g, sep) });
      }
      out.append('Diagnóstico', res.timed_out ? 'Tiempo agotado.' : `${problems.length} problemas (código ${res.code}).`);
      // Salida sin problemas reconocibles y código de error: el comprobador no
      // está instalado o falló antes de analizar; eso no son 0 problemas.
      const broken = res.code !== 0 && problems.length === 0;
      set({ problems, lastRun: Date.now(), error: broken ? (res.stderr || res.stdout || 'El comprobador falló.').trim().split('\n').slice(-3).join('\n') : '' });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ running: false });
    }
  },

  scheduleAfterSave: () => {
    if (!get().auto) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => get().run(), SAVE_DELAY);
  },
}));

export const problemCounts = (problems) => ({
  errors: problems.filter((p) => p.severity === 'error').length,
  warnings: problems.filter((p) => p.severity !== 'error').length,
});
