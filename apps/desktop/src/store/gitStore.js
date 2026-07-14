// gitStore.js — estado del control de código. Las operaciones locales/lectura
// (status, branch, add, commit) usan gitRun y capturan salida; las de red
// (pull/push/fetch/clone) se lanzan en el terminal integrado para ver los prompts.

import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { gitRun, gitClone } from '../lib/tauri';

// Cada cuánto se consulta al remoto si hay commits nuevos.
const AUTO_FETCH_MS = 3 * 60 * 1000;
let autoFetchTimer = null;

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
  hasRemote: false, // sin remoto no hay nada que sincronizar: hay que publicar
  ahead: 0,         // commits locales sin subir (se acumulan: Push (2), (3)…)
  behind: 0,        // commits del remoto sin traer
  netBusy: '',      // '' | 'fetch' | 'pull' | 'push' | 'sync'
  netError: '',
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
        set({ isRepo: !notRepo, changes: [], branch: '', hasRemote: false,
              ahead: 0, behind: 0, loading: false,
              error: notRepo ? '' : status.stderr.trim() });
        return;
      }
      // `branch --show-current` da el nombre incluso sin commits (HEAD naciente),
      // donde `rev-parse --abbrev-ref HEAD` falla y dejaba un "(sin commits)".
      const branch = await gitRun(['branch', '--show-current']);
      const name = branch.code === 0 ? branch.stdout.trim() : '';

      const remotes = await gitRun(['remote']);
      const hasRemote = remotes.code === 0 && !!remotes.stdout.trim();

      // Cuánto nos separa del upstream. Falla (y da 0/0) si la rama no tiene
      // upstream todavía: es justo el caso de un repo recién publicado.
      let ahead = 0;
      let behind = 0;
      const counts = await gitRun(['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
      if (counts.code === 0) {
        const [a, b] = counts.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
        ahead = a || 0;
        behind = b || 0;
      }

      set({
        isRepo: true,
        branch: name || '(HEAD suelto)',
        changes: parseStatus(status.stdout),
        hasRemote,
        ahead,
        behind,
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

  // ── Operaciones de red: en SEGUNDO PLANO ───────────────────────────
  // Antes se escupían en el terminal integrado. Además de ensuciar la consola,
  // dependían de su cwd. Ahora las corre Rust (`git_run`), que ya lanza git sin
  // ventana y con GIT_TERMINAL_PROMPT=0: si hicieran falta credenciales, git no
  // se queda colgado esperando, falla y el error se muestra en el panel.
  // (El gestor de credenciales de Windows sigue abriendo su ventana si toca.)

  /** Corre una operación de red y refresca. `kind` marca qué botón está ocupado. */
  _net: async (kind, args) => {
    if (get().netBusy) return { ok: false, error: 'Ya hay una operación en curso.' };
    set({ netBusy: kind, netError: '' });
    try {
      const res = await gitRun(args);
      if (res.code !== 0) {
        const error = (res.stderr || res.stdout).trim() || `git ${args[0]} falló.`;
        set({ netError: error });
        return { ok: false, error };
      }
      return { ok: true };
    } catch (e) {
      const error = String(e);
      set({ netError: error });
      return { ok: false, error };
    } finally {
      set({ netBusy: '' });
      await get().refresh();
    }
  },

  fetch: () => get()._net('fetch', ['fetch', '--all', '--prune']),
  pull: () => get()._net('pull', ['pull']),
  push: () => get()._net('push', ['push']),

  /** Sincronizar (como en VSCode): traer y luego subir. Si el pull falla no se
      sube nada: subir encima de un rechazo solo encadena otro error. */
  sync: async () => {
    const pulled = await get()._net('sync', ['pull']);
    if (!pulled.ok) return pulled;
    return get()._net('sync', ['push']);
  },

  /** Añade el remoto `origin` y sube la rama actual estableciendo upstream.
      Es lo que falta tras un `git init` para que el repo aparezca en GitHub. */
  publish: async (url) => {
    const remote = url.trim();
    if (!remote) return { ok: false, error: 'Pega la URL del repositorio.' };

    if (!get().hasRemote) {
      const res = await gitRun(['remote', 'add', 'origin', remote]);
      if (res.code !== 0) {
        return { ok: false, error: (res.stderr || res.stdout).trim() };
      }
    }
    const branch = get().branch || 'master';
    return get()._net('push', ['push', '-u', 'origin', branch]);
  },

  /** Auto-fetch: sin traer del remoto no hay forma de saber que hay commits
      nuevos, así que el botón nunca podría ofrecer "Pull". Silencioso: no toca
      netBusy ni netError para no parpadear la UI. */
  startAutoFetch: () => {
    if (autoFetchTimer) return;
    const tick = async () => {
      const { isRepo, hasRemote, netBusy } = get();
      if (!isRepo || !hasRemote || netBusy) return;
      try {
        await gitRun(['fetch', '--quiet']);
        await get().refresh();
      } catch { /* sin red: se reintenta al siguiente tick */ }
    };
    autoFetchTimer = setInterval(tick, AUTO_FETCH_MS);
    tick();
  },

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
