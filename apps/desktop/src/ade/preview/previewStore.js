// previewStore.js — estado SIMULADO de la vista previa del ADE. Objetos en memoria y setTimeout:
// nada toca el Core, git, worktrees ni proveedores. Los avisos usan el sistema de toasts del producto.
import { create } from 'zustand';
import { toast } from '../../store/toastStore';
import {
  ATTEMPTS, TASKS, PROJECTS, ATTENTION, TIMELINES, HOSTS, PROVIDERS, ACTIVITY, PENDING, CLOCK_START,
} from './previewData';
import { isBusy, agentName, canSteer, hostOf } from './previewVocab';

let seq = 100;
const uid = (p) => `${p}${++seq}`;
const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const clone = (o) => JSON.parse(JSON.stringify(o));
// El producto solo distingue avisos normales y de error; la vista previa no inventa tonos.
// eslint-disable-next-line no-unused-vars
const say = (text, _tone) => toast(text);
const EMPTY_REVIEW = { reviewed: {}, comments: [], round: 1 };

function initial() {
  return {
    attempts: clone(ATTEMPTS),
    tasks: clone(TASKS),
    attention: clone(ATTENTION),
    timelines: clone(TIMELINES),
    hosts: clone(HOSTS),
    activity: clone(ACTIVITY),
    pending: clone(PENDING),
    decisions: [],
    reviews: {},
    choice: {},
    composerMode: {},
    clock: CLOCK_START,
  };
}

export const usePreviewStore = create((set, get) => ({
  // ── Presentación ─────────────────────────────────────────────────────────
  sel: { projectId: 'lixbon', taskId: 't_runtime', attemptId: 'att_rt_a' },
  view: 'workspace',
  expanded: { lixbon: true, zajuna: true, sgi: true, tourism: false, t_runtime: true, t_oauth: true },
  filter: { q: '', chips: [], hostId: null },
  prefs: { followUp: 'queue' },
  overlay: null,
  contextOpen: false,
  ...initial(),

  setView: (view) => set({ view }),
  setOverlay: (overlay) => set({ overlay }),
  toggleContext: () => set((s) => ({ contextOpen: !s.contextOpen })),
  toggleExpanded: (id) => set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),
  setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
  setPref: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
  /** Solo una persona cambia la selección: un evento de fondo nunca roba el foco. */
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

  // ── Utilidades ───────────────────────────────────────────────────────────
  toast: say,
  patchAttempt: (id, patch) => set((s) => ({ attempts: s.attempts.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),
  addEvent: (attemptId, evt) => set((s) => {
    const a = s.attempts.find((x) => x.id === attemptId);
    const base = s.timelines[attemptId] || [{ id: uid('e'), kind: 'agent', time: fmt(s.clock - 3), text: a?.latest || 'Empezó.' }];
    return { clock: s.clock + 1, timelines: { ...s.timelines, [attemptId]: [...base, { id: uid('e'), time: fmt(s.clock), ...evt }] } };
  }),
  feed: (text, attemptId, tone = 'neutral') => set((s) => ({ activity: [{ id: uid('a'), time: fmt(s.clock), text, attemptId, tone }, ...s.activity].slice(0, 30) })),
  /** Datos del peor caso (nombres larguísimos, sin espacios, cifras enormes). Se deshace con resetAll. */
  worstCase: () => set((s) => ({
    tasks: s.tasks.map((t, i) => (i === 0 ? { ...t, title: 'Refactor_ProviderSessionAdapter_FronteraConUnIdentificadorLarguísimoSinEspacios_v2_final', objective: 'Ejecutar agentes como Intentos detrás de un solo Core. '.repeat(10) }
      : i === 1 ? { ...t, title: 'Migración de la capa de autenticación del módulo de facturación para clientes enterprise con SSO y SCIM 日本語のタスク' }
        : i === 2 ? { ...t, title: 'x' } : t)),
    attempts: s.attempts.map((a, i) => (i === 0 ? { ...a, branch: 'feature/rama/muy/larga/con/muchos/segmentos/auth-refresh-token-rotation-compat-layer-2026-10-24', latest: 'Una última línea muy larga que sigue y sigue sin un corte natural. '.repeat(4), files: 12840, add: 482100, del: 99120, minutes: 1440, tokens: 48200000, cost: 1234.56 } : a)),
  })),
  resetAll: () => set({ ...initial(), sel: { projectId: 'lixbon', taskId: 't_runtime', attemptId: 'att_rt_a' }, view: 'workspace', overlay: null }),

  // ── Compositor: Cola / Corregir / Detener y enviar / Nuevo Intento ──────
  setComposerMode: (attemptId, mode) => set((s) => ({ composerMode: { ...s.composerMode, [attemptId]: mode } })),
  /** Punto único de envío. `from` = ADE | IDE | CLI | Móvil: procedencia, no categoría. */
  send: ({ attemptId, text, mode, from = 'ADE' }) => {
    const { attempts, addEvent, patchAttempt } = get();
    const a = attempts.find((x) => x.id === attemptId);
    const msg = (text || '').trim();
    if (!a || !msg) return { ok: false };
    const m = mode || get().prefs.followUp;

    if (!isBusy(a)) {
      if (a.state === 'offline') {
        set((s) => ({ pending: { ...s.pending, [attemptId]: [...(s.pending[attemptId] || []), { id: uid('p'), mode: 'queue', text: msg, from, note: 'Se entrega cuando vuelva el host' }] } }));
        say(`${hostOf(a.host).name} está desconectado: la instrucción queda guardada en la cola.`, 'warn');
        return { ok: true, queued: true };
      }
      addEvent(attemptId, { kind: 'user', from, text: msg, delivered: 'sent' });
      patchAttempt(attemptId, { state: 'working', phase: 'thinking', cause: undefined, latest: 'Leyendo tu instrucción', control: 'agent', toolLabel: undefined });
      return { ok: true, mode: 'send' };
    }

    if (m === 'stop') {
      addEvent(attemptId, { kind: 'system', tone: 'warn', text: `Turno detenido por ti (${from}). Los archivos ya escritos no se deshicieron.` });
      patchAttempt(attemptId, { state: 'paused', latest: 'Detenido · enviando tu instrucción' });
      setTimeout(() => {
        get().addEvent(attemptId, { kind: 'user', from, text: msg, delivered: 'stop' });
        get().patchAttempt(attemptId, { state: 'working', phase: 'thinking', latest: 'Leyendo tu instrucción' });
      }, 900);
      return { ok: true, mode: 'stop' };
    }

    let eff = m;
    if (m === 'steer' && !canSteer(a)) { // nunca fingir una capacidad
      eff = 'queue';
      say(`${agentName(a)} no puede corregir un turno en marcha: va a la cola.`, 'warn');
    }
    const item = { id: uid('p'), mode: eff, text: msg, from, applying: eff === 'steer' };
    set((s) => ({ pending: { ...s.pending, [attemptId]: [...(s.pending[attemptId] || []), item] } }));
    if (eff === 'steer') setTimeout(() => get().applySteer(attemptId, item.id), 2600);
    else say(`En cola tras el turno actual · posición ${(get().pending[attemptId] || []).length}`);
    return { ok: true, mode: eff, id: item.id };
  },
  applySteer: (attemptId, pid) => {
    const item = (get().pending[attemptId] || []).find((p) => p.id === pid);
    if (!item || item.mode !== 'steer') return;
    set((s) => ({ pending: { ...s.pending, [attemptId]: s.pending[attemptId].filter((p) => p.id !== pid) } }));
    get().addEvent(attemptId, { kind: 'user', from: item.from, text: item.text, delivered: 'steer' });
    get().addEvent(attemptId, { kind: 'system', text: 'Corrección aplicada en el siguiente punto seguro (tras la orden en curso).' });
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
    if (to === 'steer' && !canSteer(a)) { say(`${agentName(a)} no puede corregir un turno en marcha.`, 'warn'); return; }
    set((s) => ({ pending: { ...s.pending, [attemptId]: s.pending[attemptId].map((p) => (p.id === pid ? { ...p, mode: to, applying: to === 'steer' } : p)) } }));
    if (to === 'steer') setTimeout(() => get().applySteer(attemptId, pid), 2600);
  },
  pendingToAttempt: (attemptId, pid) => {
    const item = (get().pending[attemptId] || []).find((p) => p.id === pid);
    if (!item) return;
    get().removePending(attemptId, pid);
    get().openFork(attemptId, item.text);
  },
  /** Control de simulación: el turno actual termina; entrega el siguiente pendiente o pasa a revisión. */
  endTurn: (attemptId) => {
    const list = get().pending[attemptId] || [];
    if (list.length) {
      const [first, ...rest] = list;
      set((s) => ({ pending: { ...s.pending, [attemptId]: rest } }));
      get().addEvent(attemptId, { kind: 'agent', text: 'Turno terminado.' });
      get().addEvent(attemptId, { kind: 'user', from: first.from, text: first.text, delivered: 'queue' });
      get().patchAttempt(attemptId, { state: 'working', phase: 'thinking', latest: 'Leyendo la siguiente instrucción de la cola' });
    } else {
      const a = get().attempts.find((x) => x.id === attemptId);
      get().addEvent(attemptId, { kind: 'agent', text: 'Todo hecho. La evidencia va adjunta como Proof Pack.' });
      get().patchAttempt(attemptId, { state: 'review_ready', phase: undefined, latest: 'Terminado · Proof Pack listo' });
      get().feed(`${agentName(a)} terminó · listo para revisar`, attemptId, 'review');
      get().raiseAttention({ kind: 'review', attemptId, risk: 'medium', title: 'Listo para revisar', summary: 'El Intento terminó. Abre el Proof Pack antes de leer el diff.' });
    }
  },

  // ── Nuevo Intento en paralelo y nueva Task ──────────────────────────────
  openFork: (attemptId, text = '') => set({ overlay: { type: 'fork', attemptId, text } }),
  fork: ({ attemptId, provider, model, host, policy, text, from = 'ADE' }) => {
    const src = get().attempts.find((a) => a.id === attemptId);
    const task = get().tasks.find((t) => t.id === src.taskId);
    const siblings = get().attempts.filter((a) => a.taskId === task.id);
    const label = String.fromCharCode(65 + siblings.length);
    const id = `att_${task.id.slice(2, 6)}_${label.toLowerCase()}${++seq}`;
    let branch = src.readonly ? null : `${task.branchBase}-${provider}`;
    while (branch && get().attempts.some((a) => a.branch === branch)) branch += '-2';
    const next = {
      ...src, id, label, provider, model, host, policy: policy || src.policy, branch,
      worktree: branch ? `%LOCALAPPDATA%\\Lixbon\\worktrees\\${task.projectId}\\${id}` : null,
      state: 'starting', phase: undefined, cause: undefined, minutes: 0, files: 0, add: 0, del: 0, tests: null, cost: 0, tokens: 0,
      latest: 'Creando el worktree y cargando el ContextPackage', origin: from, control: 'agent', unread: false, forkOf: src.id,
    };
    set((s) => ({
      attempts: [...s.attempts, next],
      timelines: {
        ...s.timelines,
        [id]: [
          { id: uid('e'), time: fmt(s.clock), kind: 'system', text: `Nace del Intento ${src.label} (${agentName(src)}) · mismo ContextPackage ${src.ctx}` },
          ...(text ? [{ id: uid('e'), time: fmt(s.clock), kind: 'user', from, text, delivered: 'sent' }] : []),
        ],
        [src.id]: [...(s.timelines[src.id] || []), { id: uid('e'), time: fmt(s.clock), kind: 'system', text: `Nuevo Intento ${label} en paralelo (${agentName(next)}). Este Intento sigue.` }],
      },
      overlay: null,
      expanded: { ...s.expanded, [task.projectId]: true, [task.id]: true },
    }));
    get().select(id);
    say(`Intento ${label} arrancando · ${branch || 'sin worktree'} · ContextPackage ${src.ctx} compartido`, 'good');
    setTimeout(() => get().patchAttempt(id, { state: 'working', phase: 'thinking', latest: 'Leyendo el ContextPackage' }), 1600);
    return id;
  },
  createTask: ({ projectId, title, provider, host, objective }) => {
    const model = PROVIDERS[provider].models[0];
    const tid = `t_new${++seq}`;
    const slug = title.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'task';
    const id = `att_${tid.slice(2)}`;
    set((s) => ({
      tasks: [...s.tasks, { id: tid, projectId, title, objective: objective || title, criteria: [], constraints: [], decisions: [], branchBase: `feat/${slug}` }],
      attempts: [...s.attempts, {
        control: 'agent', origin: 'ADE', unread: false, policy: 'delegar_con_revision', files: 0, add: 0, del: 0, tests: null, cost: 0, tokens: 0, minutes: 0,
        id, taskId: tid, label: 'A', provider, model, effort: 'medium', branch: `feat/${slug}`, worktree: `%LOCALAPPDATA%\\Lixbon\\worktrees\\${projectId}\\${id}`,
        host, state: 'starting', latest: 'Creando el worktree y el ContextPackage', ctx: 'v1',
      }],
      timelines: { ...s.timelines, [id]: [{ id: uid('e'), time: fmt(s.clock), kind: 'user', from: 'ADE', text: objective || title, delivered: 'sent' }] },
      expanded: { ...s.expanded, [projectId]: true },
    }));
    get().select(id);
    say(`Task «${title}» creada · el Intento A arranca en ${hostOf(host).name}`, 'good');
    setTimeout(() => get().patchAttempt(id, { state: 'working', phase: 'thinking', latest: 'Leyendo el repositorio' }), 1500);
    return id;
  },

  // ── Attention ────────────────────────────────────────────────────────────
  raiseAttention: (item) => set((s) => (s.attention.some((x) => x.attemptId === item.attemptId && x.kind === item.kind && x.title === item.title)
    ? {} : { attention: [{ id: uid('at'), ago: 'ahora', ...item }, ...s.attention] })),
  /** decision: allow_once | allow_attempt | deny | answer | retry | snooze */
  resolveAttention: (id, decision, { from = 'ADE', answer } = {}) => {
    const item = get().attention.find((x) => x.id === id);
    if (!item) return;
    const a = get().attempts.find((x) => x.id === item.attemptId);
    set((s) => ({
      attention: s.attention.filter((x) => x.id !== id),
      decisions: [{ id: uid('d'), kind: item.kind, command: item.command, decision, time: fmt(s.clock) }, ...s.decisions].slice(0, 50),
    }));
    if (!a) return;
    if (item.kind === 'permission') {
      if (decision === 'deny') {
        get().addEvent(a.id, { kind: 'system', tone: 'warn', text: `Denegado desde ${from}. El agente buscará otro camino.` });
        get().patchAttempt(a.id, { state: 'working', phase: 'thinking', cause: undefined, latest: 'Buscando otro camino' });
      } else {
        const scope = decision === 'allow_attempt' ? 'para este Intento' : 'una vez';
        get().addEvent(a.id, { kind: 'system', tone: 'good', text: `Permitido ${scope} desde ${from}: ${item.command}` });
        get().patchAttempt(a.id, { state: 'working', phase: 'tool', cause: undefined, latest: 'Permitido · ejecutando la orden', toolLabel: item.command });
      }
      get().feed(`${decision === 'deny' ? 'Denegado' : 'Permitido'} desde ${from}: ${item.command}`, a.id, decision === 'deny' ? 'warn' : 'good');
    } else if (item.kind === 'question') {
      get().addEvent(a.id, { kind: 'user', from, text: answer || 'De acuerdo', delivered: 'sent' });
      get().patchAttempt(a.id, { state: 'working', phase: 'thinking', cause: undefined, latest: 'Sigue con tu respuesta' });
      get().feed(`Respondido desde ${from}: «${answer}»`, a.id, 'good');
    } else if (item.kind === 'failed' && decision === 'retry') {
      get().addEvent(a.id, { kind: 'system', text: `Reintento pedido desde ${from} a partir del último checkpoint.` });
      get().patchAttempt(a.id, { state: 'working', phase: 'thinking', latest: 'Reintentando desde el checkpoint' });
    }
  },

  // ── Tomar el control / Devolver al agente ───────────────────────────────
  takeOver: (attemptId) => {
    get().patchAttempt(attemptId, { state: 'paused', control: 'human', latest: 'En pausa en un punto seguro · tienes el control' });
    get().addEvent(attemptId, { kind: 'system', text: 'Tomaste el control: el agente se pausó en un punto seguro.' });
    say('Tienes el control. El agente está en pausa; el worktree es tuyo.');
  },
  returnToAgent: (attemptId, note) => {
    const a = get().attempts.find((x) => x.id === attemptId);
    get().patchAttempt(attemptId, { state: 'working', phase: 'thinking', control: 'agent', ctx: `v${Number((a?.ctx || 'v1').slice(1)) + 1}`, latest: 'Leyendo tus cambios' });
    get().addEvent(attemptId, { kind: 'system', tone: 'good', text: `Devuelto al agente: ContextPackage actualizado con tus cambios (3 archivos, +42 / −7).${note ? ` Nota: ${note}` : ''}` });
    say('Devuelto al agente con el contexto actualizado.', 'good');
  },

  // ── Hosts ────────────────────────────────────────────────────────────────
  toggleHost: (hostId) => {
    const h = get().hosts.find((x) => x.id === hostId);
    const to = h.status === 'online' ? 'offline' : 'online';
    set((s) => ({ hosts: s.hosts.map((x) => (x.id === hostId ? { ...x, status: to, note: to === 'offline' ? 'Desconectado ahora mismo' : x.note } : x)) }));
    const affected = get().attempts.filter((a) => a.host === hostId);
    if (to === 'offline') {
      affected.filter((a) => ['working', 'waiting', 'starting'].includes(a.state)).forEach((a) => get().patchAttempt(a.id, { state: 'offline', latest: `${h.name} se desconectó` }));
      get().raiseAttention({ kind: 'host', attemptId: affected[0]?.id || null, risk: 'none', title: `${h.name} está desconectado`, summary: 'El trabajo de este host está en pausa. Sigue cuando vuelva.' });
    } else {
      affected.filter((a) => a.state === 'offline').forEach((a) => get().patchAttempt(a.id, { state: 'working', phase: 'thinking', latest: 'Reconectado · siguiendo' }));
      set((s) => ({ attention: s.attention.filter((x) => !(x.kind === 'host' && x.title.startsWith(h.name))) }));
    }
  },

  // ── Revisión ─────────────────────────────────────────────────────────────
  review: (attemptId) => get().reviews[attemptId] || EMPTY_REVIEW,
  patchReview: (attemptId, patch) => set((s) => ({ reviews: { ...s.reviews, [attemptId]: { ...(s.reviews[attemptId] || EMPTY_REVIEW), ...patch } } })),
  toggleReviewed: (attemptId, path) => { const r = get().review(attemptId); get().patchReview(attemptId, { reviewed: { ...r.reviewed, [path]: !r.reviewed[path] } }); },
  addComment: (attemptId, path, text) => { const r = get().review(attemptId); get().patchReview(attemptId, { comments: [...r.comments, { id: uid('c'), path, text, sent: false }] }); },
  removeComment: (attemptId, id) => { const r = get().review(attemptId); get().patchReview(attemptId, { comments: r.comments.filter((c) => c.id !== id) }); },
  sendReview: (attemptId) => {
    const r = get().review(attemptId);
    const open = r.comments.filter((c) => !c.sent);
    if (!open.length) return;
    get().addEvent(attemptId, { kind: 'user', from: 'ADE', delivered: 'review', text: `Revisión · ${open.length} comentario${open.length > 1 ? 's' : ''} en ${new Set(open.map((c) => c.path)).size} archivo(s)`, comments: open });
    get().patchReview(attemptId, { comments: r.comments.map((c) => ({ ...c, sent: true })), round: r.round + 1 });
    get().patchAttempt(attemptId, { state: 'working', phase: 'thinking', latest: `Atendiendo la revisión (${open.length})` });
    set((s) => ({ attention: s.attention.filter((x) => !(x.kind === 'review' && x.attemptId === attemptId)) }));
    say(`Revisión enviada como un solo paquete (${open.length} comentarios).`, 'good');
  },
  decide: (attemptId, verdict, revision, from = 'ADE') => {
    get().patchAttempt(attemptId, { reviewVerdict: verdict, integrationStatus: verdict === 'accepted' ? 'pending' : null, state: verdict === 'accepted' ? 'completed' : 'working', ...(verdict === 'rejected' ? { phase: 'thinking', latest: 'Revisión rechazada · rehaciendo' } : { latest: 'Aceptado · listo para integrar' }) });
    set((s) => ({ attention: s.attention.filter((x) => !(x.kind === 'review' && x.attemptId === attemptId)) }));
    get().addEvent(attemptId, { kind: 'system', tone: verdict === 'accepted' ? 'good' : 'warn', text: `Revisión ${verdict === 'accepted' ? 'aceptada' : 'rechazada'} desde ${from} en ${revision}.` });
    say(verdict === 'accepted' ? `Aceptado en ${revision}. La integración sigue pendiente de una persona.` : 'Rechazado: el agente rehace el trabajo.', verdict === 'accepted' ? 'good' : 'warn');
  },
  choose: (taskId, attemptId) => {
    set((s) => ({ choice: { ...s.choice, [taskId]: attemptId } }));
    say('Ganador elegido. Los otros Intentos se pueden archivar: no se borró nada.', 'good');
  },
}));

// ── Selectores puros ───────────────────────────────────────────────────────
export const attemptsOfTask = (s, taskId) => s.attempts.filter((a) => a.taskId === taskId);
export const taskOf = (s, a) => s.tasks.find((t) => t.id === a.taskId);
export const projectOf = (t) => PROJECTS.find((p) => p.id === t.projectId);
export const attemptById = (s, id) => s.attempts.find((a) => a.id === id);
export const attentionFor = (s, attemptId) => s.attention.filter((x) => x.attemptId === attemptId);
export const timelineOf = (s, a) => s.timelines[a.id] || [{ id: 'seed', kind: 'agent', time: '14:00', text: a.latest || 'Empezó.' }];
export const fleetCounts = (s) => ({
  active: s.attempts.filter((a) => a.state === 'working').length,
  attention: s.attention.length,
  review: s.attempts.filter((a) => a.state === 'review_ready').length,
  failed: s.attempts.filter((a) => a.state === 'failed').length,
});
export const hostCount = (s, hostId) => s.attempts.filter((a) => a.host === hostId).length;
