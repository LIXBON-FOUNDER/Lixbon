// store.js — estado SIMULADO compartido por ADE, IDE, Mobile y CLI.
// Es el equivalente visual de "Lixbon Core owns state; clients own presentation": las cuatro superficies leen y
// escriben aquí, así que aprobar en el móvil se ve en el ADE y un `lxo send` aparece en la cola del Composer.
// NADA de esto toca el Core real: son objetos en memoria y setTimeout.
import { create } from 'zustand';
import { useDesk } from './desk/deskStore';
import { ATTEMPTS, TASKS, PROJECTS, ATTENTION, TIMELINES, HOSTS, REVIEW_FILES, CURRENT_HOST, PROVIDERS, FLEET_SIM } from './data';
import { isBusy, agentShort } from './vocab';

let seq = 100;
const uid = (p) => `${p}${++seq}`;
const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const clone = (o) => JSON.parse(JSON.stringify(o));

const ACTIVITY0 = [
  { id: 'a1', time: '14:31', text: 'Codex finished OAuth Refresh · Attempt B', attemptId: 'att_oa_b', tone: 'review' },
  { id: 'a2', time: '14:29', text: 'Claude: 141/141 unit tests passed · Agent Runtime', attemptId: 'att_rt_a', tone: 'good' },
  { id: 'a3', time: '14:21', text: 'GPT asked a question · Linux Packaging', attemptId: 'att_pk_a', tone: 'warn' },
  { id: 'a4', time: '14:20', text: 'Claude failed 4 tests · Migration Script', attemptId: 'att_mig_a', tone: 'danger' },
  { id: 'a5', time: '14:05', text: 'Codex completed CLI Integration (merge blocked)', attemptId: 'att_cli_a', tone: 'good' },
];

function initial() {
  return {
    attempts: clone(ATTEMPTS),
    tasks: clone(TASKS),
    attention: clone(ATTENTION),
    timelines: clone(TIMELINES),
    hosts: clone(HOSTS),
    activity: clone(ACTIVITY0),
    pending: { att_rt_a: [
      { id: 'p1', mode: 'queue', text: 'When tests pass, add edge-case tests for cancelled Attempts.', from: 'ADE' },
      { id: 'p2', mode: 'queue', text: 'Update docs/runtime.md with the new lifecycle diagram.', from: 'CLI' },
    ] },
    mockUi: { inspectorOpen: false, contextOpen: false, resourcesOpen: false, ideReviewOpen: false, explorerOpen: true, terminalOpen: true, sidecarOpen: true },
    reviews: {},
    choice: {},
    composerMode: {},
    clock: FLEET_SIM.start,
    toasts: [],
    push: null,
    scenarioStep: 0,
  };
}

export const useStore = create((set, get) => ({
  // ── Cliente (presentación) ──────────────────────────────────────────────
  surface: 'all',
  theme: 'dark',
  sel: { projectId: 'lixbon', taskId: 't_runtime', attemptId: 'att_rt_a' },
  view: 'workspace',
  expanded: { lixbon: true, zajuna: true, sgi: true, tourism: false, t_runtime: true, t_oauth: true },
  filter: { q: '', chips: [], showHostAlways: false },
  prefs: { followUp: 'queue' },
  overlay: null,
  mismatch: false,
  mobile: { tab: 'home', stack: [] },
  cli: { buffer: null },
  ...initial(),

  // ── Navegación ─────────────────────────────────────────────────────────
  setMockUi: (patch) => set(s => ({ mockUi: { ...s.mockUi, ...patch } })),
  openReview: (attemptId) => { get().select(attemptId, 'review'); get().setMockUi({ ideReviewOpen: true }); get().setSurface('ide'); },
  openProof: (attemptId) => { get().select(attemptId, 'proof'); get().setMockUi({ ideReviewOpen: false }); get().setSurface('ade'); },
  setSurface: (surface) => { if (get().surface === 'desk' && (surface === 'ide' || surface === 'ade')) { useDesk.getState().setMode(surface === 'ide' ? 'editor' : 'orch'); return; } set(s => ({ surface, ...(surface === 'mobile' && !s.mobile.stack.length ? { mobile: { tab: s.attention.length ? 'attention' : 'home', stack: [] } } : {}) })); },
  setTheme: (theme) => { document.documentElement.dataset.theme = theme; set({ theme }); },
  setView: (view) => set({ view }),
  setOverlay: (overlay) => set({ overlay }),
  toggleExpanded: (id) => set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),
  setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
  setPref: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
  /** Seleccionar un Attempt NO ocurre solo por eventos de fondo (principio P3: no robar foco). Solo lo llama una persona. */
  select: (attemptId, view = 'workspace') => {
    const a = get().attempts.find((x) => x.id === attemptId);
    if (!a) return;
    const t = get().tasks.find((x) => x.id === a.taskId);
    set((s) => ({
      sel: { projectId: t.projectId, taskId: t.id, attemptId },
      view,
      expanded: { ...s.expanded, [t.projectId]: true, [t.id]: true },
      attempts: s.attempts.map((x) => (x.id === attemptId ? { ...x, unread: false } : x)),
    }));
  },
  previewState: (attemptId) => {
    const baseline = ATTEMPTS.find((a) => a.id === attemptId);
    if (!baseline) return;
    const seeded = initial();
    set((s) => ({
      attempts: s.attempts.map((a) => a.id === attemptId ? clone(baseline) : a),
      attention: [...s.attention.filter((x) => x.attemptId !== attemptId), ...clone(ATTENTION.filter((x) => x.attemptId === attemptId))],
      timelines: { ...s.timelines, [attemptId]: clone(TIMELINES[attemptId] || []) },
      pending: { ...s.pending, [attemptId]: seeded.pending[attemptId] || [] },
    }));
    get().select(attemptId, 'workspace');
  },

  // ── Utilidades internas ────────────────────────────────────────────────
  toast: (text, tone = 'info') => {
    const id = uid('t');
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200);
  },
  /** break-ui: datos del peor caso (nombres larguísimos, sin espacios, emoji, no latino, cifras enormes). Se deshace con resetAll. */
  worstCase: () => set((s) => ({
    tasks: s.tasks.map((t, i) => (i === 0 ? { ...t, title: 'Refactor_ProviderSessionAdapter_BoundaryWithExtremelyLongUnbreakableIdentifier_v2_final', objective: 'Run agents as Attempts behind one Core. '.repeat(14) }
      : i === 1 ? { ...t, title: 'Migración de la capa de autenticación del módulo de facturación para clientes enterprise con SSO y SCIM 日本語のタスク 🚀' }
        : i === 2 ? { ...t, title: 'x' } : t)),
    attempts: s.attempts.map((a, i) => (i === 0 ? { ...a, branch: 'feature/very/long/branch/name/with/many/segments/auth-refresh-token-rotation-compat-layer-2026-10-24', latest: 'A very long latest line that keeps going and going without any natural break. '.repeat(4), files: 12840, add: 482100, del: 99120, minutes: 1440, tokens: 48200000, cost: 1234.56 } : a)),
  })),
  patchAttempt: (id, patch) => set((s) => ({ attempts: s.attempts.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
  addEvent: (attemptId, evt) => set((s) => {
    const a = s.attempts.find((x) => x.id === attemptId);
    const base = s.timelines[attemptId] || [{ id: uid('e'), kind: 'agent', time: fmt(s.clock - 3), text: a?.latest || 'Started.' }];
    return { clock: s.clock + 1, timelines: { ...s.timelines, [attemptId]: [...base, { id: uid('e'), time: fmt(s.clock), ...evt }] } };
  }),
  feed: (text, attemptId, tone = 'info') => set((s) => ({ activity: [{ id: uid('a'), time: fmt(s.clock), text, attemptId, tone }, ...s.activity].slice(0, 30) })),

  // ── Composer: Queue / Steer / Stop & Send / Fork ───────────────────────
  setComposerMode: (attemptId, mode) => set((s) => ({ composerMode: { ...s.composerMode, [attemptId]: mode } })),

  /** Punto único de envío de una instrucción. `from` = ADE | IDE | CLI | Mobile (procedencia, no categoría). */
  send: ({ attemptId, text, mode, from = 'ADE' }) => {
    const { attempts, addEvent, patchAttempt, toast } = get();
    const a = attempts.find((x) => x.id === attemptId);
    const msg = (text || '').trim();
    if (!a || !msg) return { ok: false };
    const m = mode || get().prefs.followUp;

    if (!isBusy(a)) { // ocioso (o sin host): "Send" normal
      if (a.state === 'offline') {
        set((s) => ({ pending: { ...s.pending, [attemptId]: [...(s.pending[attemptId] || []), { id: uid('p'), mode: 'queue', text: msg, from, note: 'Delivered when the host reconnects' }] } }));
        toast(`${a.host} is offline — instruction saved locally and queued.`, 'warn');
        return { ok: true, queued: true };
      }
      addEvent(attemptId, { kind: 'user', from, text: msg, delivered: 'sent' });
      patchAttempt(attemptId, { state: 'working', phase: 'thinking', cause: undefined, latest: 'Reading your instruction', control: 'agent', toolLabel: undefined });
      return { ok: true, mode: 'send' };
    }

    if (m === 'stop') {
      addEvent(attemptId, { kind: 'system', tone: 'warn', text: `Turn stopped by you (${from}). Files already written were not reverted.` });
      patchAttempt(attemptId, { state: 'paused', latest: 'Stopped — sending your instruction' });
      setTimeout(() => {
        get().addEvent(attemptId, { kind: 'user', from, text: msg, delivered: 'stop' });
        get().patchAttempt(attemptId, { state: 'working', phase: 'thinking', latest: 'Reading your instruction' });
      }, 900);
      return { ok: true, mode: 'stop' };
    }

    let eff = m;
    if (m === 'steer' && !PROVIDERS[a.provider].steer) { // nunca fingir una capacidad
      eff = 'queue';
      toast(`${PROVIDERS[a.provider].name} has no native Steer — queued instead.`, 'warn');
    }
    const item = { id: uid('p'), mode: eff, text: msg, from, applying: eff === 'steer' };
    set((s) => ({ pending: { ...s.pending, [attemptId]: [...(s.pending[attemptId] || []), item] } }));
    if (eff === 'steer') setTimeout(() => get().applySteer(attemptId, item.id), 2600);
    else toast(`Queued after the current turn · #${(get().pending[attemptId] || []).length}`);
    return { ok: true, mode: eff, id: item.id };
  },

  applySteer: (attemptId, pid) => {
    const item = (get().pending[attemptId] || []).find((p) => p.id === pid);
    if (!item || item.mode !== 'steer') return;
    set((s) => ({ pending: { ...s.pending, [attemptId]: s.pending[attemptId].filter((p) => p.id !== pid) } }));
    get().addEvent(attemptId, { kind: 'user', from: item.from, text: item.text, delivered: 'steer' });
    get().addEvent(attemptId, { kind: 'system', text: 'Steer applied at the next safe boundary (after the running tool).' });
    get().toast('Steer applied at a safe boundary.');
  },

  editPending: (attemptId, pid, text) => set((s) => ({ pending: { ...s.pending, [attemptId]: s.pending[attemptId].map((p) => (p.id === pid ? { ...p, text } : p)) } })),
  removePending: (attemptId, pid) => set((s) => ({ pending: { ...s.pending, [attemptId]: (s.pending[attemptId] || []).filter((p) => p.id !== pid) } })),
  movePending: (attemptId, pid, dir) => set((s) => {
    const list = [...(s.pending[attemptId] || [])];
    const i = list.findIndex((p) => p.id === pid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return {};
    [list[i], list[j]] = [list[j], list[i]];
    return { pending: { ...s.pending, [attemptId]: list } };
  }),
  convertPending: (attemptId, pid) => {
    const a = get().attempts.find((x) => x.id === attemptId);
    const item = (get().pending[attemptId] || []).find((p) => p.id === pid);
    if (!item) return;
    const to = item.mode === 'queue' ? 'steer' : 'queue';
    if (to === 'steer' && !PROVIDERS[a.provider].steer) { get().toast(`${PROVIDERS[a.provider].name} has no native Steer.`, 'warn'); return; }
    set((s) => ({ pending: { ...s.pending, [attemptId]: s.pending[attemptId].map((p) => (p.id === pid ? { ...p, mode: to, applying: to === 'steer' } : p)) } }));
    if (to === 'steer') setTimeout(() => get().applySteer(attemptId, pid), 2600);
  },
  pendingToAttempt: (attemptId, pid) => {
    const item = (get().pending[attemptId] || []).find((p) => p.id === pid);
    if (!item) return;
    get().removePending(attemptId, pid);
    get().openFork(attemptId, item.text);
  },

  /** Simula que el turno actual termina: entrega el primer pendiente o pasa a Review ready. */
  endTurn: (attemptId) => {
    const list = get().pending[attemptId] || [];
    if (list.length) {
      const [first, ...rest] = list;
      set((s) => ({ pending: { ...s.pending, [attemptId]: rest } }));
      get().addEvent(attemptId, { kind: 'agent', text: 'Turn complete.' });
      get().addEvent(attemptId, { kind: 'user', from: first.from, text: first.text, delivered: 'queue' });
      get().patchAttempt(attemptId, { state: 'working', phase: 'thinking', latest: 'Reading the next queued instruction' });
      get().toast(`Delivered queued instruction. ${rest.length} left.`);
    } else {
      get().addEvent(attemptId, { kind: 'agent', text: 'All done. Evidence attached as a Proof Pack.' });
      get().patchAttempt(attemptId, { state: 'review_ready', phase: undefined, latest: 'Done · Proof Pack ready' });
      get().feed(`${agentShort(get().attempts.find((a) => a.id === attemptId))} finished — Review ready`, attemptId, 'review');
      get().raiseAttention({ kind: 'review', attemptId, risk: 'medium', title: 'Review ready', summary: 'Attempt finished. Open the Proof Pack before reading the diff.' });
    }
  },

  // ── Fork as Attempt ────────────────────────────────────────────────────
  openFork: (attemptId, text = '') => set({ overlay: { type: 'fork', attemptId, text } }),
  fork: ({ attemptId, provider, model, host, policy, text, from = 'ADE', navigate = true }) => {
    const src = get().attempts.find((a) => a.id === attemptId);
    const task = get().tasks.find((t) => t.id === src.taskId);
    const siblings = get().attempts.filter((a) => a.taskId === task.id);
    const label = String.fromCharCode(65 + siblings.length);
    const id = `att_${task.id.slice(2, 6)}_${label.toLowerCase()}${++seq}`;
    let branch = src.readonly ? null : `${task.branchBase}-${provider}`;
    while (branch && get().attempts.some((a) => a.branch === branch)) branch += '-2';
    const proj = task.projectId;
    const next = {
      ...src, id, label, provider, model, host, policy: policy || src.policy, branch,
      worktree: branch ? `%LOCALAPPDATA%\\Lixbon\\worktrees\\${proj}\\${id}` : null,
      state: 'starting', phase: undefined, cause: undefined, minutes: 0, files: 0, add: 0, del: 0, tests: null, cost: 0, tokens: 0,
      latest: 'Creating worktree and loading ContextPackage', origin: from, control: 'agent', unread: false, forkOf: src.id,
    };
    set((s) => ({
      attempts: [...s.attempts, next],
      timelines: { ...s.timelines, [id]: [
        { id: uid('e'), time: fmt(s.clock), kind: 'system', text: `Forked from Attempt ${src.label} (${agentShort(src)}) · same ContextPackage ${src.ctx}` },
        ...(text ? [{ id: uid('e'), time: fmt(s.clock), kind: 'user', from, text, delivered: 'sent' }] : []),
      ], [src.id]: [...(s.timelines[src.id] || []), { id: uid('e'), time: fmt(s.clock), kind: 'system', text: `Forked → Attempt ${label} (${provider === 'local' ? 'Local Model' : PROVIDERS[provider].name}). This Attempt keeps running.` }] },
      overlay: null,
      expanded: { ...s.expanded, [proj]: true, [task.id]: true },
    }));
    if (navigate) get().select(id);
    get().toast(`Forked Attempt ${label} · ${branch || 'no worktree'} · ${src.ctx} shared`, 'good');
    setTimeout(() => get().patchAttempt(id, { state: 'working', phase: 'thinking', latest: 'Reading ContextPackage' }), 1600);
    return id;
  },

  createTask: ({ projectId, title, provider, host, objective }) => {
    const model = PROVIDERS[provider].models[0];
    const tid = `t_new${++seq}`;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const id = `att_${tid.slice(2)}`;
    set((s) => ({
      tasks: [...s.tasks, { id: tid, projectId, title, objective: objective || title, criteria: [], constraints: [], decisions: [], branchBase: `feat/${slug}` }],
      attempts: [...s.attempts, {
        control: 'agent', origin: 'ADE', unread: false, policy: 'Workspace Safe', files: 0, add: 0, del: 0, tests: null, cost: 0, tokens: 0, minutes: 0,
        id, taskId: tid, label: 'A', provider, model, effort: 'medium', branch: `feat/${slug}`, worktree: `%LOCALAPPDATA%\\Lixbon\\worktrees\\${projectId}\\${id}`,
        host, state: 'starting', latest: 'Creating worktree and ContextPackage', ctx: 'v1',
      }],
      timelines: { ...s.timelines, [id]: [{ id: uid('e'), time: fmt(s.clock), kind: 'user', from: 'ADE', text: objective || title, delivered: 'sent' }] },
      expanded: { ...s.expanded, [projectId]: true },
    }));
    get().select(id);
    get().toast(`Task “${title}” created · Attempt A starting on ${host}`, 'good');
    setTimeout(() => get().patchAttempt(id, { state: 'working', phase: 'thinking', latest: 'Reading the repository' }), 1500);
    return id;
  },

  // ── Attention ──────────────────────────────────────────────────────────
  raiseAttention: (item) => set((s) => (s.attention.some((x) => x.attemptId === item.attemptId && x.kind === item.kind && x.title === item.title) ? {} : { attention: [{ id: uid('at'), ago: 'now', ...item }, ...s.attention] })),
  requestPermission: (attemptId, extra = {}) => {
    const a = get().attempts.find((x) => x.id === attemptId);
    get().patchAttempt(attemptId, { state: 'waiting', phase: undefined, cause: 'approval', latest: 'Wants to run npm install better-sqlite3' });
    get().raiseAttention({
      kind: 'permission', attemptId, risk: 'medium', title: 'Permission required',
      command: 'npm install better-sqlite3', riskLabel: 'Dependency modification', reason: 'Needed for the local event store', scope: 'This command once', ...extra,
    });
    get().feed(`${agentShort(a)} needs permission · ${get().tasks.find((t) => t.id === a.taskId).title}`, attemptId, 'warn');
    set({ push: { attemptId, title: 'Permission required', body: `${agentShort(a)} · ${get().tasks.find((t) => t.id === a.taskId).title} · npm install better-sqlite3`, at: 'now' } });
  },
  dismissPush: () => set({ push: null }),
  /** decision: allow_once | allow_attempt | deny | answer | retry | snooze | dismiss */
  resolveAttention: (id, decision, { from = 'ADE', answer } = {}) => {
    const item = get().attention.find((x) => x.id === id);
    if (!item) return;
    const a = get().attempts.find((x) => x.id === item.attemptId);
    set((s) => ({ attention: s.attention.filter((x) => x.id !== id), push: s.push && s.push.attemptId === item.attemptId ? null : s.push }));
    const who = from === 'Mobile' ? 'Mobile' : from;
    if (item.kind === 'permission') {
      if (decision === 'deny') {
        get().addEvent(a.id, { kind: 'system', tone: 'warn', text: `Denied from ${who}. The agent will choose another route.` });
        get().patchAttempt(a.id, { state: 'working', phase: 'thinking', cause: undefined, latest: 'Looking for another route' });
      } else {
        const scope = decision === 'allow_attempt' ? 'for this Attempt' : 'once';
        get().addEvent(a.id, { kind: 'system', tone: 'good', text: `Approved ${scope} from ${who}: ${item.command}` });
        get().patchAttempt(a.id, { state: 'working', phase: 'tool', cause: undefined, latest: 'Approved · running the command', toolLabel: item.command });
      }
      get().feed(`${decision === 'deny' ? 'Denied' : 'Approved'} from ${who}: ${item.command}`, a.id, decision === 'deny' ? 'warn' : 'good');
    } else if (item.kind === 'question') {
      get().addEvent(a.id, { kind: 'user', from: who, text: answer || 'OK', delivered: 'sent' });
      get().patchAttempt(a.id, { state: 'working', phase: 'thinking', cause: undefined, latest: 'Continuing with your answer' });
      get().feed(`Answered from ${who}: “${answer}” · ${a.branch}`, a.id, 'good');
    } else if (item.kind === 'failed' && decision === 'retry') {
      get().addEvent(a.id, { kind: 'system', text: `Retry requested from ${who} from the last checkpoint.` });
      get().patchAttempt(a.id, { state: 'working', phase: 'thinking', latest: 'Retrying from checkpoint' });
    } else if (item.kind === 'review') {
      get().feed(`Review item dismissed (${decision})`, a.id, 'info');
    }
  },

  // ── Take Over / Return to Agent ────────────────────────────────────────
  takeOver: (attemptId) => {
    get().patchAttempt(attemptId, { state: 'paused', control: 'human', latest: 'Paused at a safe boundary — you have the keys' });
    get().addEvent(attemptId, { kind: 'system', text: 'Take Over: the agent paused at a safe boundary. Actor changed → you.' });
    get().toast('You took over. The agent is paused; the worktree is yours.', 'info');
  },
  returnToAgent: (attemptId, note) => {
    get().patchAttempt(attemptId, { state: 'working', phase: 'thinking', control: 'agent', ctx: 'v' + (Number((get().attempts.find((a) => a.id === attemptId).ctx || 'v1').slice(1)) + 1), latest: 'Reading your changes' });
    get().addEvent(attemptId, { kind: 'system', tone: 'good', text: 'Return to Agent: ContextPackage refreshed with your edits (3 files, +42 / −7).' + (note ? ` Note: ${note}` : '') });
    get().toast('Returned to the agent with updated context.', 'good');
  },

  // ── Hosts ──────────────────────────────────────────────────────────────
  toggleHost: (hostId) => {
    const h = get().hosts.find((x) => x.id === hostId);
    const to = h.status === 'online' ? 'offline' : 'online';
    set((s) => ({ hosts: s.hosts.map((x) => (x.id === hostId ? { ...x, status: to, note: to === 'offline' ? 'Disconnected just now' : x.note } : x)) }));
    const affected = get().attempts.filter((a) => a.host === hostId);
    if (to === 'offline') {
      affected.filter((a) => ['working', 'waiting', 'starting'].includes(a.state)).forEach((a) => get().patchAttempt(a.id, { state: 'offline', latest: `${h.name} disconnected` }));
      get().raiseAttention({ kind: 'host', attemptId: affected[0]?.id || null, risk: 'none', title: `${h.name} is offline`, summary: 'Work on this host is paused. It resumes when the host reconnects.' });
    } else {
      affected.filter((a) => a.state === 'offline').forEach((a) => get().patchAttempt(a.id, { state: 'working', phase: 'thinking', latest: 'Reconnected · resuming' }));
      set((s) => ({ attention: s.attention.filter((x) => !(x.kind === 'host' && x.title.startsWith(h.name))) }));
    }
  },

  // ── Review ─────────────────────────────────────────────────────────────
  review: (attemptId) => get().reviews[attemptId] || { reviewed: {}, comments: [], round: 1, since: false, filter: 'all' },
  patchReview: (attemptId, patch) => set((s) => ({ reviews: { ...s.reviews, [attemptId]: { ...(s.reviews[attemptId] || { reviewed: {}, comments: [], round: 1, since: false, filter: 'all' }), ...patch } } })),
  toggleReviewed: (attemptId, path) => { const r = get().review(attemptId); get().patchReview(attemptId, { reviewed: { ...r.reviewed, [path]: !r.reviewed[path] } }); },
  addComment: (attemptId, path, line, text) => { const r = get().review(attemptId); get().patchReview(attemptId, { comments: [...r.comments, { id: uid('c'), path, line, text, sent: false }] }); },
  removeComment: (attemptId, id) => { const r = get().review(attemptId); get().patchReview(attemptId, { comments: r.comments.filter((c) => c.id !== id) }); },
  sendReview: (attemptId) => {
    const r = get().review(attemptId);
    const open = r.comments.filter((c) => !c.sent);
    if (!open.length) return;
    get().addEvent(attemptId, { kind: 'user', from: 'ADE', delivered: 'review', text: `Review feedback · ${open.length} comment${open.length > 1 ? 's' : ''} on ${new Set(open.map((c) => c.path)).size} file(s)`, comments: open });
    get().patchReview(attemptId, { comments: r.comments.map((c) => ({ ...c, sent: true })), round: r.round + 1, since: true, ui: { ...r.ui, filter: 'since', commenting: null, draft: '' } });
    get().patchAttempt(attemptId, { state: 'working', phase: 'thinking', latest: `Addressing review feedback (${open.length})` });
    set((s) => ({ attention: s.attention.filter((x) => !(x.kind === 'review' && x.attemptId === attemptId)) }));
    get().toast(`Sent one feedback package (${open.length} comments). Next review opens “Since last review”.`, 'good');
  },
  decide: (attemptId, verdict, from = 'ADE') => {
    const a = get().attempts.find((x) => x.id === attemptId);
    get().patchAttempt(attemptId, { reviewVerdict: verdict, integrationStatus: verdict === 'accepted' ? 'pending' : null, state: verdict === 'accepted' ? 'completed' : 'working', ...(verdict === 'rejected' ? { phase: 'thinking', latest: 'Review rejected — reworking' } : { latest: 'Accepted — ready to integrate' }) });
    set((s) => ({ attention: s.attention.filter((x) => !(x.kind === 'review' && x.attemptId === attemptId)) }));
    get().addEvent(attemptId, { kind: 'system', tone: verdict === 'accepted' ? 'good' : 'warn', text: `Review ${verdict} from ${from} at ${(get().attempts.find((x) => x.id === attemptId) && 'a91f3c2')}.` });
    get().toast(`Review ${verdict} · ${agentShort(a)}`, verdict === 'accepted' ? 'good' : 'warn');
  },
  choose: (taskId, attemptId) => {
    set((s) => ({ choice: { ...s.choice, [taskId]: attemptId } }));
    get().toast('Winner chosen. Other Attempts can be archived — nothing was deleted.', 'good');
  },

  // ── Simulación genérica ────────────────────────────────────────────────
  simulate: (attemptId, patch) => get().patchAttempt(attemptId, patch),
  setScenarioStep: (n) => set({ scenarioStep: n }),
  setMismatch: (v) => set({ mismatch: v }),

  // ── Mobile ─────────────────────────────────────────────────────────────
  mTab: (tab) => set({ mobile: { tab, stack: [] } }),
  mOpen: (screen, params = {}) => set((s) => ({ mobile: { ...s.mobile, stack: [...s.mobile.stack, { screen, params }] } })),
  mBack: () => set((s) => ({ mobile: { ...s.mobile, stack: s.mobile.stack.slice(0, -1) } })),

  resetAll: () => set({ ...initial(), sel: { projectId: 'lixbon', taskId: 't_runtime', attemptId: 'att_rt_a' }, view: 'workspace', overlay: null, mobile: { tab: 'home', stack: [] }, mismatch: false }),
}));

// ── Selectores (puros) ────────────────────────────────────────────────────
export const attemptsOfTask = (s, taskId) => s.attempts.filter((a) => a.taskId === taskId);
export const taskOf = (s, a) => s.tasks.find((t) => t.id === a.taskId);
export const projectOf = (s, t) => PROJECTS.find((p) => p.id === t.projectId);
export const attemptById = (s, id) => s.attempts.find((a) => a.id === id);
export const attentionFor = (s, attemptId) => s.attention.filter((x) => x.attemptId === attemptId);
export const timelineOf = (s, a) => s.timelines[a.id] || [{ id: 'seed', kind: 'agent', time: '14:00', text: a.latest || 'Started.' }];
export const activeSel = (s) => attemptById(s, s.sel.attemptId);
export const fleetCounts = (s) => ({
  active: s.attempts.filter((a) => a.state === 'working').length,
  attention: s.attention.length,
  review: s.attempts.filter((a) => a.state === 'review_ready').length,
  failed: s.attempts.filter((a) => a.state === 'failed').length,
});
export const hostCount = (s, hostId) => s.attempts.filter((a) => a.host === hostId).length;
export { CURRENT_HOST, REVIEW_FILES };

