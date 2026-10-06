// gitStore.js — estado del control de código. Las operaciones locales/lectura
// (status, branch, add, commit) usan gitRun y capturan salida; las de red
// (pull/push/fetch/clone) se lanzan en el terminal integrado para ver los prompts.

import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { gitRun, gitClone } from '../lib/tauri';
import { streamChatCompletion } from '../lib/stream';
import { splitThinking } from '../lib/agentProtocol';
import { useAppStore } from './appStore';
import { useOutputStore } from './outputStore';

// Cada cuánto se consulta al remoto si hay commits nuevos.
const AUTO_FETCH_MS = 3 * 60 * 1000;
let autoFetchTimer = null;

/** Des-entrecomilla una ruta de porcelain: git envuelve en "…" las rutas con
    espacios/caracteres especiales y escapa en estilo C, con los bytes UTF-8
    no-ASCII como octales (\303\251 = é). Sin esto, stage/unstage/diff sobre
    esas rutas fallaban (git recibía la ruta con comillas y escapes literales). */
function unquoteGitPath(p) {
  if (!p.startsWith('"') || !p.endsWith('"') || p.length < 2) return p;
  const inner = p.slice(1, -1);
  const enc = new TextEncoder();
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') { bytes.push(...enc.encode(c)); continue; }
    const n = inner[i + 1];
    if (n >= '0' && n <= '7') {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8) || 0);
      i += 3;
    } else {
      bytes.push(...enc.encode(n === 't' ? '\t' : n === 'n' ? '\n' : (n ?? '')));
      i += 1;
    }
  }
  try { return new TextDecoder().decode(new Uint8Array(bytes)); } catch { return inner; }
}

/** `git diff --numstat` → { ruta: { added, removed } } (binarios: sin cifras). */
function parseNumstat(stdout) {
  const map = {};
  for (const line of (stdout || '').split('\n')) {
    const [a, r, ...rest] = line.split('\t');
    if (!rest.length) continue;
    let path = rest.join('\t');
    if (path.includes(' => ')) path = path.replace(/\{[^}]* => ([^}]*)\}/, '$1').split(' => ').pop();
    map[unquoteGitPath(path)] = { added: parseInt(a, 10) || 0, removed: parseInt(r, 10) || 0 };
  }
  return map;
}

const COMMIT_SYSTEM = 'Escribes mensajes de commit. Responde SOLO con el mensaje: una primera línea de máximo 72 caracteres '
  + 'y, si hace falta, una línea en blanco y 1-4 viñetas breves. Sigue el estilo de los commits recientes del repositorio '
  + '(idioma, prefijos tipo feat/fix, ámbito entre paréntesis). Sin comillas ni bloques de código.';

const cleanMessage = (raw) => splitThinking(raw).visible.replace(/^```\w*\n?|```\s*$/g, '');

/** Parsea `git status --porcelain=v1` a una lista de cambios. */
function parseStatus(stdout) {
  const changes = [];
  for (const raw of stdout.split('\n')) {
    if (!raw.trim()) continue;
    const index = raw[0];
    const wt = raw[1];
    let path = raw.slice(3);
    if (path.includes(' -> ')) path = path.split(' -> ')[1]; // renombrado
    path = unquoteGitPath(path.trim());
    const untracked = index === '?' && wt === '?';
    // Preparado y además modificado después: sale en los dos grupos.
    if (!untracked && index !== ' ') changes.push({ path, index, wt, staged: true, untracked });
    if (untracked || wt !== ' ') changes.push({ path, index, wt, staged: false, untracked });
  }
  return changes;
}

export const useGitStore = create((set, get) => ({
  isRepo: null, // null = sin comprobar
  branch: '',
  changes: [],
  stats: { wt: {}, idx: {} },
  hasUpstream: false,
  generating: false,
  hasRemote: false, // sin remoto no hay nada que sincronizar: hay que publicar
  remoteUrl: '',    // URL de origin (para casar el repo con un proyecto de Lixbon Team)
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
        set({ isRepo: !notRepo, changes: [], branch: '', hasRemote: false, remoteUrl: '',
              ahead: 0, behind: 0, loading: false,
              error: notRepo ? '' : status.stderr.trim() });
        return;
      }
      // Las cuatro consultas son independientes: en paralelo el refresh tarda
      // lo que la más lenta, no la suma (se nota en repos grandes).
      // `branch --show-current` da el nombre incluso sin commits (HEAD naciente),
      // donde `rev-parse --abbrev-ref HEAD` falla y dejaba un "(sin commits)".
      const [branch, remotes, counts, originUrl, numWt, numIdx] = await Promise.all([
        gitRun(['branch', '--show-current']),
        gitRun(['remote']),
        // Cuánto nos separa del upstream. Falla (y da 0/0) si la rama no tiene
        // upstream todavía: es justo el caso de un repo recién publicado.
        gitRun(['rev-list', '--left-right', '--count', 'HEAD...@{u}']),
        gitRun(['remote', 'get-url', 'origin']),
        gitRun(['diff', '--numstat']),
        gitRun(['diff', '--cached', '--numstat']),
      ]);
      const name = branch.code === 0 ? branch.stdout.trim() : '';
      const hasRemote = remotes.code === 0 && !!remotes.stdout.trim();

      let ahead = 0;
      let behind = 0;
      if (counts.code === 0) {
        const [a, b] = counts.stdout.trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
        ahead = a || 0;
        behind = b || 0;
      }

      set({
        isRepo: true,
        branch: name || '(HEAD suelto)',
        changes: parseStatus(status.stdout),
        stats: { wt: parseNumstat(numWt.stdout), idx: parseNumstat(numIdx.stdout) },
        hasRemote,
        hasUpstream: counts.code === 0,
        remoteUrl: originUrl.code === 0 ? originUrl.stdout.trim() : '',
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

  /** Deshace los cambios del árbol de trabajo de `path` (o lo borra si es nuevo). */
  discard: async (path, untracked) => {
    const res = await gitRun(untracked ? ['clean', '-f', '--', path] : ['checkout', '--', path]);
    await get().refresh();
    return res.code === 0 ? { ok: true } : { ok: false, error: (res.stderr || res.stdout).trim() };
  },

  commitAndPush: async () => {
    const res = await get().commit();
    if (!res.ok) return res;
    if (!get().hasRemote) return { ok: false, error: 'Commit hecho. Publica la rama en GitHub para poder subirla.' };
    return get().push();
  },

  /** Propone un mensaje de commit a partir del diff preparado (o del árbol
      de trabajo si no hay nada preparado) y del estilo de los últimos commits. */
  generateMessage: async () => {
    if (get().generating) return { ok: false };
    const { serverUrl, apiKey, currentModel } = useAppStore.getState();
    if (!currentModel) return { ok: false, error: 'Elige un modelo en el chat primero.' };
    set({ generating: true });
    try {
      const staged = get().changes.some((c) => c.staged);
      const [diff, recent] = await Promise.all([
        gitRun(['diff', ...(staged ? ['--cached'] : []), '--stat', '--patch', '--no-color']),
        gitRun(['log', '--pretty=format:%s', '-n', '12']),
      ]);
      const patch = (diff.stdout || '').slice(0, 14000);
      if (!patch.trim()) return { ok: false, error: 'No hay cambios que describir.' };
      let raw = '';
      await streamChatCompletion({
        serverUrl, apiKey, model: currentModel, noPersist: true,
        messages: [
          { role: 'system', content: COMMIT_SYSTEM },
          { role: 'user', content: `Commits recientes:\n${recent.stdout || '(ninguno)'}\n\nDiff:\n${patch}` },
        ],
        onDelta: (d) => {
          raw += d;
          set({ message: cleanMessage(raw).trimStart() });
        },
      });
      set({ message: cleanMessage(raw).trim() });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    } finally {
      set({ generating: false });
    }
  },

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
      useOutputStore.getState().append('Git', [`$ git ${args.join(' ')}`, res.stdout, res.stderr].filter((x) => x && x.trim()).join('\n'));
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
  push: () => (get().hasUpstream
    ? get()._net('push', ['push'])
    : get()._net('push', ['push', '-u', 'origin', get().branch])),

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
