// gitStore.js — estado del control de código. Las operaciones locales/lectura
// (status, branch, add, commit) usan gitRun y capturan salida; las de red
// (pull/push/fetch/clone) se lanzan en el terminal integrado para ver los prompts.

import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { gitRun, gitClone } from '../lib/tauri';
import { useTerminalStore } from './terminalStore';

/** Parsea `git status --porcelain=v1` a una lista de cambios. */
function parseStatus(stdout) {
  const changes = [];
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue;
    const index = raw[0];
    const wt = raw[1];
    let path = raw.slice(3);
    if (path.includes(' -> ')) path = path.split(' -> ')[1]; // renombrado
    const untracked = index === '?' && wt === '?';
    const staged = !untracked && index !== ' ';
    changes.push({ path, index, wt, staged, untracked });
  }
  return changes;
}

export const useGitStore = create((set, get) => ({
  isRepo: null, // null = sin comprobar
  branch: '',
  changes: [],
  loading: false,
  error: '',
  message: '',

  setMessage: (message) => set({ message }),

  refresh: async () => {
    set({ loading: true, error: '' });
    try {
      const status = await gitRun(['status', '--porcelain=v1']);
      if (status.code !== 0) {
        const notRepo = /not a git repository/i.test(status.stderr);
        set({ isRepo: !notRepo, changes: [], branch: '', loading: false,
              error: notRepo ? '' : status.stderr.trim() });
        return;
      }
      const branch = await gitRun(['rev-parse', '--abbrev-ref', 'HEAD']);
      set({
        isRepo: true,
        branch: branch.code === 0 ? branch.stdout.trim() : '(sin commits)',
        changes: parseStatus(status.stdout),
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: String(e), isRepo: false });
    }
  },

  stage: async (path) => { await gitRun(['add', '--', path]); await get().refresh(); },
  unstage: async (path) => { await gitRun(['reset', '-q', 'HEAD', '--', path]); await get().refresh(); },
  stageAll: async () => { await gitRun(['add', '-A']); await get().refresh(); },
  unstageAll: async () => { await gitRun(['reset', '-q']); await get().refresh(); },

  commit: async () => {
    const msg = get().message.trim();
    if (!msg) return { ok: false, error: 'Escribe un mensaje de commit.' };
    const res = await gitRun(['commit', '-m', msg]);
    if (res.code === 0) {
      set({ message: '' });
      await get().refresh();
      return { ok: true };
    }
    return { ok: false, error: (res.stderr || res.stdout).trim() };
  },

  init: async () => { await gitRun(['init']); await get().refresh(); },

  // ── Diff / historial / ramas (C1–C3), todo vía gitRun ──────────────
  /** Diff unified de un archivo (staged o del árbol de trabajo). */
  fileDiff: async (path, staged) => {
    const args = ['diff', ...(staged ? ['--cached'] : []), '--', path];
    const res = await gitRun(args);
    return res.stdout || (res.code !== 0 ? `# ${res.stderr.trim()}` : '');
  },

  /** Últimos `limit` commits: [{hash, short, author, date, subject}]. */
  log: async (limit = 100) => {
    const US = '\x1f';
    const res = await gitRun(['log', `--pretty=format:%H${US}%an${US}%ad${US}%s`, '--date=short', '-n', String(limit)]);
    if (res.code !== 0) return [];
    return res.stdout.split('\n').filter(Boolean).map((l) => {
      const [hash, author, date, subject] = l.split(US);
      return { hash, short: hash.slice(0, 7), author, date, subject };
    });
  },

  /** Diff completo de un commit (git show). */
  commitDiff: async (hash) => {
    const res = await gitRun(['show', hash]);
    return res.stdout || (res.code !== 0 ? `# ${res.stderr.trim()}` : '');
  },

  /** Ramas locales: [{name, current}]. */
  branches: async () => {
    const res = await gitRun(['branch', '--format=%(refname:short)%09%(HEAD)']);
    if (res.code !== 0) return [];
    return res.stdout.split('\n').filter(Boolean).map((l) => {
      const [name, head] = l.split('\t');
      return { name: name.trim(), current: head.trim() === '*' };
    });
  },

  /** Cambia (o crea) de rama y refresca. Devuelve { ok, error }. */
  checkout: async (name, create = false) => {
    const args = create ? ['checkout', '-b', name] : ['checkout', name];
    const res = await gitRun(args);
    await get().refresh();
    return res.code === 0 ? { ok: true } : { ok: false, error: (res.stderr || res.stdout).trim() };
  },

  /** Stash. op: 'push' | 'pop' | 'list'. */
  stash: async (op = 'push') => {
    const res = await gitRun(op === 'push' ? ['stash', 'push', '-u'] : ['stash', op]);
    if (op !== 'list') await get().refresh();
    return res.code === 0 ? { ok: true, out: res.stdout.trim() } : { ok: false, error: (res.stderr || res.stdout).trim() };
  },

  // ── Operaciones de red: van al terminal integrado ──────────────────
  pull: () => useTerminalStore.getState().runCommand('git pull'),
  push: () => useTerminalStore.getState().runCommand('git push'),
  fetch: () => useTerminalStore.getState().runCommand('git fetch --all --prune'),

  // ── Clonación: comando Rust dedicado con progreso en vivo ──────────
  cloning: false,
  cloneProgress: '',

  /** Clona `url` dentro de destParent. Devuelve { ok, target | error }. */
  cloneRepo: async (url, destParent) => {
    if (get().cloning) return { ok: false, error: 'Ya hay una clonación en curso.' };
    set({ cloning: true, cloneProgress: 'Iniciando clonación…' });

    const unlisten = await listen('git:clone:out', (e) => {
      // git separa el progreso con \r; nos quedamos con la última línea útil
      const line = String(e.payload)
        .split(/[\r\n]/)
        .reverse()
        .find((l) => l.trim());
      if (line) set({ cloneProgress: line.trim() });
    });

    try {
      const target = await gitClone(url, destParent);
      return { ok: true, target };
    } catch (e) {
      return { ok: false, error: String(e) };
    } finally {
      unlisten();
      set({ cloning: false, cloneProgress: '' });
    }
  },
}));
