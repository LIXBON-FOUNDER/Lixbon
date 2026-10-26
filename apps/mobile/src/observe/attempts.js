// observe/attempts.js — los intentos (Attempts) de una Task en Supervisar (LXO-126). Sin dependencias de React Native.
//
// La Task es la intención y su estado derivado; cada intento es una ejecución con su estado, su proveedor, su
// resultado y su host. Llegan por el relé (`core_attempts`: `task_detail_v2` + `attempt_detail` de cada uno) solo
// cuando el Core ya está en el modelo Task/Attempt; antes, la pantalla sigue como en LXO-110. Lo que no se sabe
// (el host, si el Core no lo registra) queda como desconocido: nunca se deduce de la ruta ni del orden.
import { ageText } from './attention.js';
import { providerName } from './task.js';

export const ATTEMPTS_CAPABILITY = 'core_attempts';

/** `contracts/status-vocabulary.json` `attempt_state`. Masculino: «el intento». */
export const ATTEMPT_STATUS = Object.freeze({
  pending_approval: { label: 'Pendiente de aprobación', tone: 'warn' },
  starting: { label: 'Arrancando', tone: 'ok' },
  running: { label: 'Trabajando', tone: 'ok' },
  waiting: { label: 'Esperando', tone: 'warn' },
  awaiting_terminal_approval: { label: 'Espera aprobación en el escritorio', tone: 'warn' },
  done: { label: 'Terminado', tone: 'ok' },
  failed: { label: 'Falló', tone: 'error' },
  stopped: { label: 'Detenido', tone: 'muted' },
  exited: { label: 'Cerrado', tone: 'muted' },
});
const FINAL = new Set(['done', 'failed', 'stopped', 'exited']);
export const attemptStatusOf = (code) => ATTEMPT_STATUS[code] || { label: String(code || 'desconocido'), tone: 'muted' };

/** `task_derived_state`: el estado de la Task se deriva de su intento actual (ADR D17). */
export const TASK_STATE = Object.freeze({
  open: 'Abierta',
  in_progress: 'En curso',
  in_review: 'En revisión',
  integrated: 'Integrada',
  discarded: 'Descartada',
});

const FAILURES = {
  launch_failed: 'no llegó a arrancar',
  terminal_approval_timeout: 'nadie aprobó en la terminal a tiempo',
  agent_idle_timeout: 'el agente dejó de dar señales',
  agent_reported: 'el agente informó el fallo',
};
const ORIGIN = { lixbon: 'Lanzado por Lixbon', external: 'Coordinador externo' };
const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 };

export const ATTEMPT_FILTERS = Object.freeze(['all', 'active', 'final']);

/** El resultado de un intento terminado, en una línea; `null` si sigue en marcha. */
export function attemptResult(a) {
  switch (a?.status) {
    case 'done':
      if (a.integrated === true) return { tone: 'ok', text: 'Integrado' };
      if (a.integrated === false) return { tone: 'ok', text: a.has_summary ? 'Terminó con resumen; sin integrar' : 'Terminó; sin integrar' };
      return { tone: 'ok', text: 'Terminó' };
    case 'failed':
      return { tone: 'error', text: a.failure_reason ? `Falló: ${FAILURES[a.failure_reason] || 'motivo desconocido'}` : 'Falló' };
    case 'stopped':
      return { tone: 'muted', text: 'Se detuvo' };
    case 'exited':
      return { tone: 'muted', text: 'Se cerró su terminal' };
    default:
      return null;
  }
}

export const originText = (code) => ORIGIN[code] || 'origen desconocido';

/** La Attention que apunta a intentos de esta lista, por id de intento y de la más grave a la menos. */
export function attentionByAttempt(attention, ids) {
  const out = {};
  for (const a of Array.isArray(attention) ? attention : []) {
    if (a?.target_kind !== 'attempt' || !ids.has(a.target_id)) continue;
    (out[a.target_id] ||= []).push(a);
  }
  for (const list of Object.values(out)) list.sort((x, y) => (SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9));
  return out;
}

/** Un intento listo para pintar. */
function attemptItem(a, task, attention) {
  const final = FINAL.has(a.status);
  return {
    id: a.id,
    n: a.n,
    current: !!a.id && a.id === task.current_attempt_id,
    status: a.status,
    statusMeta: attemptStatusOf(a.status),
    final,
    provider: providerName(a.provider) || 'agente desconocido',
    model: a.model || null,
    role: a.role || null,
    origin: a.origin ?? null,
    host: a.host ?? null,
    // La edad de lo último que hizo: cuándo terminó, cuándo empezó o cuándo se pidió.
    at: a.ended_at ?? a.started_at ?? a.created_at ?? null,
    result: attemptResult(a),
    attention: attention[a.id] || [],
  };
}

/**
 * Modelo de la sección «Intentos». `data`: `{task, attempts, truncated}` del relé. `filter`: all · active · final.
 * El intento relevante va primero (el que pide atención, el más grave; si ninguno, el actual) y el resto, del más
 * nuevo al más viejo: la historia queda a la vista.
 */
export function attemptsModel({ data, attention = [], filter = 'all' }) {
  if (!data) return null;
  const task = data.task || {};
  const raw = (Array.isArray(data.attempts) ? data.attempts : []).filter((a) => a?.id);
  const byAttempt = attentionByAttempt(attention, new Set(raw.map((a) => a.id)));
  const all = raw.map((a) => attemptItem(a, task, byAttempt)).sort((x, y) => (y.n ?? 0) - (x.n ?? 0));
  const flagged = all.filter((i) => i.attention.length).sort((x, y) => (SEVERITY_RANK[x.attention[0].severity] ?? 9) - (SEVERITY_RANK[y.attention[0].severity] ?? 9));
  const relevant = flagged[0] || all.find((i) => i.current) || all[0] || null;
  const ordered = relevant ? [relevant, ...all.filter((i) => i !== relevant)] : all;
  // Host y origen solo se enseñan en cada fila si cambian entre intentos (y entonces, también el desconocido).
  const showPlace = new Set(all.map((i) => i.host ?? '?')).size > 1 || new Set(all.map((i) => i.origin ?? '?')).size > 1;
  const visible = ordered.filter((i) => filter === 'all' || (filter === 'active' ? !i.final : i.final));
  const host = all.length && !showPlace ? all[0].host : null;
  return {
    taskId: task.id || null,
    taskState: TASK_STATE[task.state] || null,
    count: Number.isSafeInteger(task.attempt_count) ? task.attempt_count : all.length,
    truncated: !!data.truncated,
    counts: { all: all.length, active: all.filter((i) => !i.final).length, final: all.filter((i) => i.final).length },
    filter,
    items: visible,
    relevantId: relevant?.id || null,
    flaggedCount: flagged.length,
    showPlace,
    // Si no cambian, el host y el origen comunes van una vez en el resumen.
    sharedPlace: all.length && !showPlace ? { host, origin: all[0].origin ?? null } : null,
    empty: all.length === 0,
  };
}

/** Las opciones del filtro, con cuántos hay de cada. */
export function attemptFilterOptions(counts) {
  return [
    { value: 'all', label: `Todos · ${counts.all}`, a11y: `Todos los intentos, ${counts.all}` },
    { value: 'active', label: `En curso · ${counts.active}`, a11y: `Intentos en curso, ${counts.active}` },
    { value: 'final', label: `Terminados · ${counts.final}`, a11y: `Intentos terminados, ${counts.final}` },
  ];
}

/** Lo que lee el lector de pantalla en una fila. */
export function attemptA11y(item, now, showPlace) {
  const parts = [`Intento ${item.n ?? '?'}`, item.current ? 'actual' : null, item.provider, item.statusMeta.label, item.at ? ageText(item.at, now) : null, item.result?.text];
  if (item.attention.length) parts.push(item.attention.length === 1 ? 'pide atención' : `${item.attention.length} avisos de atención`);
  if (showPlace) parts.push(item.host ? `en ${item.host}` : 'host desconocido', originText(item.origin));
  return parts.filter(Boolean).join(', ');
}

/** Qué decir de la sección cuando no llegan datos frescos. */
export function attemptsNotice({ data, stale, at, now, online }) {
  if (!data) return online ? { tone: 'muted', text: 'Cargando los intentos…' } : { tone: 'muted', text: 'Sin datos de los intentos hasta que vuelva la conexión.' };
  if (stale) return { tone: 'warn', text: `Desactualizado: son los intentos de ${at ? ageText(at, now) : 'la última conexión'}.` };
  return null;
}

/**
 * Memoria de los últimos intentos vistos por Task, para volver a una tarea sin conexión: lo que da sale siempre
 * marcado como desactualizado. Solo en memoria (sin rutas ni encargos en disco) y con tope.
 */
export function createAttemptsMemory(max = 30) {
  const map = new Map();
  return {
    remember(key, entry) {
      map.delete(key);
      map.set(key, entry);
      while (map.size > max) map.delete(map.keys().next().value);
    },
    recall(key) {
      return map.get(key) || null;
    },
    clear() {
      map.clear();
    },
  };
}
