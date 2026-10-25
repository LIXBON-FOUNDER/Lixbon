// orchStore.js — el «Core» de mentira del Orquestador. Estado en memoria + setTimeout; nada toca Git, PTY ni red.
// Las reglas de Integrar y de Attention copian las del modo real (src/orch/canIntegrate.js y attention.js).
import { create } from 'zustand';
import { TASKS, MESSAGES, PENDING, ROLES, PROVIDERS, RUN, policyFor } from './orchData';

const clone = (v) => JSON.parse(JSON.stringify(v));
const initial = () => ({
  tasks: clone(TASKS),
  messages: clone(MESSAGES),
  pending: clone(PENDING),
  roles: clone(ROLES),
  lastReview: {}, // taskId -> { decision, head, at }
  integrated: {}, // taskId -> { commit, target }
  sel: 'c1',
  view: 'runs',
  inspector: false,
  inspectorTab: 'encargo',
  dialog: null, // { kind: 'integrate' | 'newrun' | 'stop' | 'review', taskId? }
  toasts: [],
  livePtr: {},
});

export const isFinal = (t) => ['done', 'failed', 'exited', 'stopped'].includes(t.status);
export const isAwaiting = (t) => t.status === 'awaiting_terminal_approval';

export const STATUS_LABEL = {
  starting: 'Arrancando', running: 'En marcha', awaiting_terminal_approval: 'Espera tu aprobación', blocked: 'Bloqueada',
  done: 'Terminada', failed: 'Falló', exited: 'Cerrada sin entregar', stopped: 'Detenida',
};

/** La tarea terminó con éxito si entregó informe (t7 se cerró sin entregar: `exited`). */
export const isMerged = (s, t) => Boolean(s.integrated[t.id]);
export function reviewStatus(s, t) {
  const lr = s.lastReview[t.id];
  if (!lr) return 'none';
  if (lr.head !== t.head) return 'stale';
  return lr.decision === 'accepted' ? 'accepted' : 'rejected';
}
export const canIntegrate = (s, t) => Boolean(t.parent && t.status === 'done' && t.branch && !isMerged(s, t) && reviewStatus(s, t) === 'accepted');
export const canReview = (s, t) => Boolean(t.parent && t.status === 'done' && t.branch && !isMerged(s, t));

/** Marca de estado: la FORMA distingue, el color refuerza (misma taxonomía que el resto de la maqueta). */
export function markOf(s, t) {
  if (isAwaiting(t)) return { kind: 'waiting', tone: 'warn' };
  if (t.status === 'blocked') return { kind: 'queued', tone: 'muted' };
  if (t.status === 'starting') return { kind: 'queued', tone: 'info' };
  if (t.status === 'running') return { kind: 'working', tone: 'info' };
  if (t.status === 'failed' || t.status === 'exited') return { kind: 'failed', tone: 'danger' };
  if (t.status === 'stopped') return { kind: 'paused', tone: 'muted' };
  if (t.status === 'done') {
    if (isMerged(s, t)) return { kind: 'done', tone: 'good' };
    if (canReview(s, t)) return { kind: 'review', tone: 'merged' };
    return { kind: 'done', tone: 'good' };
  }
  return { kind: 'queued', tone: 'muted' };
}

export const unansweredQuestions = (s) => {
  const answered = new Set(s.messages.filter((m) => m.kind === 'reply').map((m) => m.replyTo));
  return s.messages.filter((m) => m.kind === 'question' && !answered.has(m.id));
};

/** Lo que espera a una persona, de lo más urgente a lo menos (ORDER de attention.js + lanzamientos y preguntas). */
export function attentionItems(s) {
  const out = [];
  s.tasks.forEach((t) => { if (isAwaiting(t)) out.push({ key: `ap-${t.id}`, kind: 'approve', taskId: t.id, title: t.title, hint: `vence en ${t.approval.deadlineMin} min` }); });
  s.pending.forEach((p) => out.push({ key: `sp-${p.id}`, kind: 'spawn', pendingId: p.id, title: p.name, hint: `${p.role} · vence en ${Math.max(1, Math.round(p.expiresIn))} min` }));
  unansweredQuestions(s).forEach((q) => out.push({ key: `q-${q.id}`, kind: 'question', taskId: q.from, msgId: q.id, title: s.tasks.find((t) => t.id === q.from)?.title, hint: 'sin responder' }));
  s.tasks.forEach((t) => {
    if (canIntegrate(s, t)) out.push({ key: `in-${t.id}`, kind: 'integrate', taskId: t.id, title: t.title, hint: 'revisada y lista' });
    else if (canReview(s, t)) out.push({ key: `rv-${t.id}`, kind: 'review', taskId: t.id, title: t.title, hint: reviewStatus(s, t) === 'stale' ? 'la rama cambió' : 'diff sin revisar' });
    else if (t.status === 'failed' || (t.status === 'exited' && !t.report)) out.push({ key: `fl-${t.id}`, kind: 'failed', taskId: t.id, title: t.title, hint: 'cerrada sin entregar' });
  });
  return out.filter((i) => i.kind !== 'review' || reviewStatus(s, s.tasks.find((t) => t.id === i.taskId)) !== 'rejected');
}

export function fleetCounts(s) {
  const kids = s.tasks.filter((t) => t.parent);
  const live = s.tasks.filter((t) => t.status === 'running' || t.status === 'starting' || isAwaiting(t));
  return {
    working: s.tasks.filter((t) => t.status === 'running' || t.status === 'starting').length,
    live: live.length,
    attention: attentionItems(s).length,
    done: kids.filter((t) => t.status === 'done').length,
    total: kids.length,
    cost: s.tasks.reduce((n, t) => n + t.cost, 0),
    tokens: s.tasks.reduce((n, t) => n + t.tokens, 0),
  };
}

/** `lxo roles` + validación al guardar: un rol de solo lectura nunca se asigna a un agente sin modo verificado (falla cerrado). */
export function validateRole(role, cfg, roles = ROLES) {
  const p = PROVIDERS[cfg.agent];
  if (!p) return 'Agente desconocido.';
  if (p.state !== 'ready') return `${p.label} no está listo: ${p.state === 'paused' ? 'pausado' : 'no instalado'}.`;
  if (roles[role]?.readOnly && p.readOnly !== 'verificado') return `${p.label} no tiene un modo de solo lectura verificado: el rol «${role}» no se puede lanzar con él.`;
  return null;
}

let seq = 100;
export const useOrch = create((set, get) => ({
  ...initial(),
  reset: () => set(initial()),

  select: (sel) => set({ sel, view: 'runs' }),
  setView: (view) => set({ view }),
  toggleInspector: () => set((s) => ({ inspector: !s.inspector })),
  setInspectorTab: (inspectorTab) => set({ inspectorTab }),
  openDialog: (dialog) => set({ dialog }),
  closeDialog: () => set({ dialog: null }),

  toast: (text, tone = 'info') => {
    const id = ++seq;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 4200);
  },
  patch: (id, p) => set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...p } : t)) })),
  say: (m) => set((s) => ({ messages: [...s.messages, { id: `m${++seq}`, at: 0, ...m }] })),

  /* Lanzamientos pendientes: aprobar con confirmación explícita, o rechazar con motivo. */
  approveSpawn: (pendingId) => {
    const p = get().pending.find((x) => x.id === pendingId);
    if (!p) return;
    const id = `t${++seq}`;
    const cfg = get().roles[p.role];
    const task = {
      id, parent: 'c1', title: p.name, role: p.role, agent: p.agent, model: p.model, effort: p.effort, status: 'starting', min: 0, deps: [], attempt: 1,
      spec: p.spec, phases: [], files: [], cost: 0, tokens: 0, live: { verdict: 'unverifiable', hb: null }, log: [['out', `$ ${policyFor(p.role, p.agent).argv.join(' ').slice(0, 96)}…`]],
      branch: cfg?.worktree ? `lx/${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}` : undefined,
    };
    set((s) => ({ pending: s.pending.filter((x) => x.id !== pendingId), tasks: [...s.tasks, task], sel: id }));
    get().toast(`Aprobado · ${p.name} arranca (${PROVIDERS[p.agent].label})`, 'good');
    setTimeout(() => get().patch(id, { status: 'running', min: 0, live: { verdict: 'live', hb: 2 }, phases: [{ name: 'Entender', done: false, ago: 0 }] }), 1100);
  },
  rejectSpawn: (pendingId, reason = 'Rechazado por la persona') => {
    set((s) => ({ pending: s.pending.filter((x) => x.id !== pendingId) }));
    get().say({ kind: 'note', from: 'persona', to: 'c1', body: `Lanzamiento rechazado: ${reason}` });
    get().toast('Lanzamiento rechazado · el coordinador recibe el motivo', 'warn');
  },

  approveTerminal: (id, ok = true) => {
    const t = get().tasks.find((x) => x.id === id);
    if (!t) return;
    get().patch(id, {
      status: 'running', approval: undefined,
      phases: t.phases.map((p, i, arr) => (i === arr.length - 1 ? { ...p, done: false, note: ok ? 'Aprobado: ejecutando `cargo test`' : 'Rechazado: replantea sin compilar' } : p)),
      log: [...(t.log || []), ok ? ['ok', 'OK Aprobado por la persona. Ejecutando…'] : ['warn', 'Rechazado por la persona. El agente replantea.']],
    });
    get().toast(ok ? 'Aprobado en su terminal' : 'Rechazado en su terminal', ok ? 'good' : 'warn');
  },

  reply: (msgId, text) => {
    const q = get().messages.find((m) => m.id === msgId);
    if (!q || !text.trim()) return;
    get().say({ kind: 'reply', from: 'c1', to: q.from, replyTo: msgId, body: text.trim() });
    get().toast('Respuesta enviada al agente por el coordinador', 'good');
  },

  stop: (id) => {
    get().patch(id, { status: 'stopped', live: { verdict: 'exited', hb: null } });
    get().say({ kind: 'exited', from: id, to: 'c1', body: 'Detenida por la persona (emergencia). El coordinador recibe el aviso.' });
    set({ dialog: null });
    get().toast('Tarea detenida · el coordinador lo sabe', 'warn');
  },
  relaunch: (id) => {
    const t = get().tasks.find((x) => x.id === id);
    if (!t) return;
    get().patch(id, { status: 'starting', attempt: t.attempt + 1, failure: undefined, live: { verdict: 'unverifiable', hb: null } });
    get().toast(`Intento ${t.attempt + 1} lanzado · el intento anterior ya no puede entregar`, 'info');
    setTimeout(() => get().patch(id, { status: 'running', live: { verdict: 'live', hb: 3 } }), 1100);
  },
  continueTask: (id, text) => {
    const t = get().tasks.find((x) => x.id === id);
    if (!t || !text.trim()) return;
    get().patch(id, { status: 'running', live: { verdict: 'live', hb: 2 }, phases: [...t.phases, { name: 'Corregir', done: false, ago: 0, note: text.trim().slice(0, 80) }] });
    get().say({ kind: 'note', from: 'c1', to: id, body: text.trim() });
    get().toast('Continúa con su contexto (ronda 2 de 2 como máximo)', 'info');
  },

  /* Revisión del diff por la persona: Integrar solo vale sobre el HEAD revisado. */
  review: (id, decision) => {
    const t = get().tasks.find((x) => x.id === id);
    set((s) => ({ lastReview: { ...s.lastReview, [id]: { decision, head: t.head, at: 'ahora' } } }));
    get().toast(decision === 'accepted' ? `Diff aceptado sobre ${t.head}` : 'Diff rechazado · el coordinador debe corregirlo', decision === 'accepted' ? 'good' : 'warn');
  },
  integrate: (id, target) => {
    const t = get().tasks.find((x) => x.id === id);
    const commit = `${t.head.slice(0, 3)}${Math.floor(1000 + Math.random() * 8999).toString(16)}`.slice(0, 7);
    set((s) => ({ integrated: { ...s.integrated, [id]: { commit, target } }, dialog: null }));
    get().say({ kind: 'note', from: 'persona', to: 'c1', body: `Integrada ${t.branch} en ${target} · ${commit}` });
    get().toast(`Integrada en ${target} · ${commit}`, 'good');
  },

  /* Ajustes → Orquestador */
  setRole: (role, patch) => {
    const next = { ...get().roles[role], ...patch };
    const err = validateRole(role, next, get().roles);
    if (err) { get().toast(err, 'warn'); return false; }
    const p = PROVIDERS[next.agent];
    if (patch.agent) { next.model = p.models[0]; next.effort = p.efforts[0] ? p.efforts[Math.min(1, p.efforts.length - 1)] : null; }
    set((s) => ({ roles: { ...s.roles, [role]: next } }));
    return true;
  },

  newRun: ({ objective, mode }) => {
    if (!objective.trim()) return;
    set({ dialog: null });
    if (mode === 'compare') get().toast('Comparar: el mismo encargo irá a 3 agentes; elegirás el diff ganador (Plan · Fase 5)', 'info');
    else if (mode === 'handoff') get().toast('Handoff lanzado en otro worktree, sin run ni espera (Plan · Fase 5)', 'info');
    else {
      set((s) => ({ pending: [...s.pending, { id: `p${++seq}`, role: 'explorador', name: 'Primer reconocimiento del objetivo', agent: s.roles.explorador.agent, model: s.roles.explorador.model, effort: s.roles.explorador.effort, shared: true, spec: objective.trim(), expiresIn: 10 }] }));
      get().toast('Run creado · el coordinador propone su primer lanzamiento y espera tu aprobación', 'good');
    }
  },

  /* Menú «Simular» (control de la maqueta, no del producto) */
  simulate: (what) => {
    const g = get();
    if (what === 't2-done') {
      g.patch('t2', { status: 'done', tests: { pass: 11, total: 11 }, summary: 'Selección migrada a Attempt; 11/11 pruebas de f2Nav.', report: '.lixbon/informes/t2.md', live: { verdict: 'exited', hb: null }, phases: g.tasks.find((t) => t.id === 't2').phases.map((p) => ({ ...p, done: true })) });
      g.say({ kind: 'done', from: 't2', to: 'c1', body: 'Entregado. 11/11 pruebas. Informe en .lixbon/informes/t2.md' });
      g.toast('Navegación F2 por Attempt entregó · lista para revisar', 'good');
    }
    if (what === 't3-done') {
      g.patch('t3', { status: 'done', approval: undefined, summary: 'Aviso de corte en el ADE con prueba de render con y sin corte.', report: '.lixbon/informes/t3.md', live: { verdict: 'exited', hb: null } });
      g.patch('t4', { status: 'starting' });
      setTimeout(() => g.patch('t4', { status: 'running', live: { verdict: 'live', hb: 3 } }), 900);
      g.toast('t3 terminó · el host lanza t4 porque sus dependencias terminaron', 'info');
    }
    if (what === 'expire') {
      const p = g.pending[g.pending.length - 1];
      if (p) { set((s) => ({ pending: s.pending.filter((x) => x.id !== p.id) })); g.toast('El lanzamiento venció a los 10 min sin decisión', 'warn'); }
    }
    if (what === 'reset') { g.reset(); g.toast('Maqueta restablecida'); }
  },

  /* Goteo de terminal para las tareas en marcha: da sensación de vivo sin ser real. */
  tickLive: () => set((s) => {
    const livePtr = { ...s.livePtr };
    const tasks = s.tasks.map((t) => {
      if (t.status !== 'running' || !t.liveFeed) return t;
      const i = livePtr[t.id] || 0;
      if (i >= t.liveFeed.length) return t;
      livePtr[t.id] = i + 1;
      return { ...t, log: [...(t.log || []), t.liveFeed[i]], tests: i === t.liveFeed.length - 1 && t.tests ? { ...t.tests, pass: t.tests.total } : t.tests };
    });
    return { tasks, livePtr };
  }),
}));

export const RUN_INFO = RUN;
