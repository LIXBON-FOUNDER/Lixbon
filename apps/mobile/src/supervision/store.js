// supervision/store.js — estado del prototipo y sus acciones (reducer puro).
// Las decisiones pasan por decide(): lo que no se puede mandar no cambia la
// tarea; lo que queda en cola se ve como pendiente hasta reconectar.
import { buildFixtures } from './fixtures.js';
import { connectionState, decide } from './model.js';

export function initialState(now) {
  // autoSync simula la sincronización continua del modo «en línea».
  return { ...buildFixtures(now), deviceOnline: true, autoSync: true, syncedAt: now, outbox: [], hostFilter: 'all' };
}

const mapTask = (state, taskId, fn) => ({ ...state, tasks: state.tasks.map((t) => (t.id === taskId ? fn(t) : t)) });
const withEvent = (task, now, text) => ({ ...task, events: [...task.events, { at: now, text }] });

function resolve(task, now, text, status = 'running') {
  return withEvent({ ...task, pending: null, status }, now, text);
}

function nextAttempt(task, now, summary) {
  const n = task.attempts.length + 1;
  const attempts = task.attempts.map((a) => (a.status === 'running' ? { ...a, status: 'done', endedAt: now } : a));
  return { ...task, attempts: [...attempts, { n, status: 'running', startedAt: now, endedAt: null, summary }] };
}

/// Aplica una decisión ya permitida a la tarea.
function applyDecision(task, action, now) {
  switch (action.type) {
    case 'answer':
      return resolve(task, now, `Respondiste: ${action.label}`);
    case 'approve':
      return resolve(task, now, 'Aprobaste la acción');
    case 'reject':
      return resolve(task, now, 'Rechazaste la acción');
    case 'accept':
      return resolve(task, now, 'Aceptaste la revisión', 'done');
    case 'changes':
      return nextAttempt(resolve(task, now, `Pediste cambios: ${action.label}`), now, 'Aplicando los cambios pedidos.');
    case 'retry':
      return withEvent(nextAttempt({ ...task, status: 'running' }, now, 'Reintentando.'), now, `Empezó el intento ${task.attempts.length + 1}`);
    default:
      return task;
  }
}

const DECISION_KIND = { answer: 'question', approve: 'approval', reject: 'approval', accept: 'review', changes: 'review', retry: 'retry' };

/// Resultado de intentar una decisión: el estado nuevo y el modo (send,
/// queue, refresh, desktop, blocked) para que la pantalla lo cuente tal cual.
export function act(state, action, now) {
  const task = state.tasks.find((t) => t.id === action.taskId);
  const host = task && state.hosts.find((h) => h.id === task.hostId);
  const kind = DECISION_KIND[action.type];
  // Rechazar o pedir cambios no necesita que la revisión quepa en el teléfono.
  let verdict = decide(kind, { task, host, connection: connectionState(state, now), now });
  if ((action.type === 'reject' || action.type === 'changes') && verdict.mode === 'desktop') {
    verdict = decide('question', { task, host, connection: connectionState(state, now), now });
    if (verdict.mode === 'queue') verdict = { mode: 'blocked', reason: verdict.reason };
  }
  if (verdict.mode === 'send') return { state: mapTask(state, task.id, (t) => applyDecision(t, action, now)), verdict };
  if (verdict.mode === 'queue') {
    const entry = { id: `${task.id}:${now}`, taskId: task.id, action, at: now };
    const next = mapTask({ ...state, outbox: [...state.outbox, entry] }, task.id, (t) => ({ ...t, pending: { ...t.pending, queuedAt: now, queuedLabel: action.label } }));
    return { state: next, verdict };
  }
  return { state, verdict };
}

/// Al reconectar se mandan las respuestas en cola, en orden.
function flush(state, now) {
  let tasks = state.tasks;
  for (const entry of state.outbox) {
    tasks = tasks.map((t) => (t.id === entry.taskId ? applyDecision(t, entry.action, now) : t));
  }
  return { ...state, tasks, outbox: [] };
}

export function reducer(state, { type, now, ...p }) {
  switch (type) {
    case 'reset':
      return initialState(now);
    case 'connection': {
      if (p.value === 'offline') return { ...state, deviceOnline: false, autoSync: false };
      if (p.value === 'stale') return { ...state, deviceOnline: true, autoSync: false, syncedAt: now - 3 * 60 * 1000 };
      return reducer({ ...state, deviceOnline: true, autoSync: true }, { type: 'refresh', now });
    }
    case 'tick':
      if (!state.autoSync || !state.deviceOnline) return state;
      return { ...state, syncedAt: now, hosts: state.hosts.map((h) => (h.connected && h.live ? { ...h, lastSeenAt: now } : h)) };
    case 'refresh': {
      // Actualizar pide datos al gateway y un latido a los hosts conectados;
      // sin red no hay nada que actualizar.
      if (!state.deviceOnline) return state;
      const hosts = state.hosts.map((h) => (h.connected ? { ...h, live: true, lastSeenAt: now } : h));
      const hostIds = new Set(hosts.filter((h) => h.connected).map((h) => h.id));
      return flushReachable({ ...state, hosts, syncedAt: now }, hostIds, now);
    }
    case 'refreshReview':
      if (connectionState(state, now) !== 'online') return state;
      return mapTask(state, p.taskId, (t) =>
        withEvent({ ...t, pending: { ...t.pending, at: now, review: { ...t.pending.review, baseSha: t.headSha } } }, now, 'Revisión regenerada sobre la punta de la rama'),
      );
    case 'pause':
    case 'resume':
      if (connectionState(state, now) !== 'online') return state;
      return mapTask(state, p.taskId, (t) => withEvent({ ...t, status: type === 'pause' ? 'paused' : 'running' }, now, type === 'pause' ? 'Pausaste al agente' : 'Reanudaste al agente'));
    case 'read':
      return { ...state, notifications: state.notifications.map((n) => (n.id === p.id ? { ...n, read: true } : n)) };
    case 'readAll':
      return { ...state, notifications: state.notifications.map((n) => ({ ...n, read: true })) };
    case 'hostFilter':
      return { ...state, hostFilter: p.value };
    default:
      return state;
  }
}

// Solo se mandan las respuestas cuyo host está conectado; el resto sigue en cola.
function flushReachable(state, hostIds, now) {
  const reachable = state.outbox.filter((e) => hostIds.has(state.tasks.find((t) => t.id === e.taskId)?.hostId));
  const waiting = state.outbox.filter((e) => !reachable.includes(e));
  return { ...flush({ ...state, outbox: reachable }, now), outbox: waiting };
}
