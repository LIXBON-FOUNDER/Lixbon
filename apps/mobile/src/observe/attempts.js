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

// ── Ficha de un intento (LXO-127) ───────────────────────────────────────────

const SESSION_STATUS = { open: 'Abierta', idle: 'En espera', closed: 'Cerrada' };
const BINDING = { stream_json: 'por stream-json', session_id: 'por su id de sesión' };
const PROVENANCE = { created: 'Creado por Lixbon', adopted: 'Adoptado por Lixbon', external: 'Externo: Lixbon no lo limpia' };
const WORKTREE_STATE = { active: { label: 'En disco', tone: 'ok' }, missing: { label: 'No está en disco', tone: 'warn' }, removed: { label: 'Retirado', tone: 'muted' } };
const ARTIFACT = { report: 'Informe', pull_request: 'Pull request', last_message: 'Último mensaje', commit: 'Commit', file: 'Archivo' };
const VERDICT = { accepted: 'Aceptada', rejected: 'Rechazada' };
const LIFECYCLE = {
  pending_approval: 'Espera a que una persona apruebe su lanzamiento.',
  starting: 'Arrancando el agente.',
  running: 'El agente está trabajando.',
  waiting: 'El agente espera una respuesta.',
  awaiting_terminal_approval: 'Espera que alguien apruebe en la terminal del escritorio.',
  done: 'Terminó.',
  failed: 'Falló.',
  stopped: 'Se detuvo (cancelado).',
  exited: 'Se cerró la terminal del agente.',
};

/** Un Artifact en una línea: la PR por su número, el commit corto y un archivo por su nombre (la ruta, aparte). */
export function artifactLine(x) {
  const uri = typeof x?.uri === 'string' ? x.uri : '';
  let short = uri || 'sin ubicación';
  const pr = x?.kind === 'pull_request' ? uri.match(/\/pull\/(\d+)/) : null;
  if (x?.kind === 'pull_request') short = pr ? `#${pr[1]}` : uri;
  else if (x?.kind === 'commit') short = uri.slice(0, 10);
  else if (uri) short = uri.split(/[\\/]/).filter(Boolean).pop() || uri;
  return { kind: x?.kind || null, label: ARTIFACT[x?.kind] || 'Artefacto', short, uri: uri || null };
}

/** La revisión, sin ambigüedad: vigente (sobre el HEAD revisado), obsoleta o sustituida. */
export function reviewLine(r) {
  if (!r) return { present: false, tone: 'muted', title: 'Sin revisión', text: 'Nadie ha revisado este intento todavía.', current: null };
  const verdict = VERDICT[r.verdict] || 'Sin veredicto';
  const head = r.head_commit ? r.head_commit.slice(0, 10) : 'un commit desconocido';
  const base = r.base_commit ? ` sobre ${r.base_commit.slice(0, 10)}` : '';
  switch (r.status) {
    case 'active':
      return { present: true, tone: r.verdict === 'accepted' ? 'ok' : 'warn', title: `${verdict} · vigente`, text: `Revisó ${head}${base}, que sigue siendo el código del intento.`, current: true };
    case 'stale':
      return { present: true, tone: 'warn', title: `${verdict} · obsoleta`, text: `Revisó ${head}${base}, pero el código cambió después: hay que revisarlo otra vez.`, current: false };
    case 'superseded':
      return { present: true, tone: 'muted', title: `${verdict} · sustituida`, text: `Revisó ${head}${base}; hubo una revisión posterior de este intento.`, current: false };
    default:
      return { present: true, tone: 'muted', title: verdict, text: `Revisó ${head}${base}; no se sabe si sigue vigente.`, current: null };
  }
}

/**
 * Modelo de la ficha. Todo es de este intento (invariante 1): su sesión, su Worktree, sus Artifacts y su revisión.
 * El id de la sesión del proveedor no llega (invariante 2) y la ruta del Worktree es ubicación, no identidad (3).
 */
export function attemptDetailModel(a, task = null) {
  if (!a) return null;
  const ps = a.provider_session;
  const wt = a.worktree;
  const wtState = wt ? WORKTREE_STATE[wt.state] || { label: wt.state ? String(wt.state) : 'estado desconocido', tone: 'muted' } : null;
  return {
    id: a.id,
    n: a.n,
    taskId: a.task_id || task?.id || null,
    taskTitle: task?.title || null,
    taskState: task?.state ? TASK_STATE[task.state] || null : null,
    current: task?.current_attempt_id ? task.current_attempt_id === a.id : null,
    status: attemptStatusOf(a.status),
    final: FINAL.has(a.status),
    lifecycle: LIFECYCLE[a.status] || 'Estado desconocido.',
    result: attemptResult(a),
    provider: providerName(a.provider) || 'agente desconocido',
    model: a.model || null,
    effort: a.effort || null,
    profile: a.profile || null,
    role: a.role || null,
    origin: originText(a.origin),
    host: a.host || wt?.machine || null,
    summary: a.summary || null,
    session: ps
      ? {
          present: true,
          status: SESSION_STATUS[ps.status] || (ps.status ? String(ps.status) : 'estado desconocido'),
          resumable: ps.resumable === true ? 'Se puede reanudar' : ps.resumable === false ? 'No se puede reanudar' : null,
          bound: ps.bound ? `Vinculada al proveedor ${BINDING[ps.binding] || ''}`.trim() : 'Sin vincular al proveedor',
          opened: ps.opened_here ? 'La abrió este intento' : 'Viene de un intento anterior de la tarea',
        }
      : { present: false },
    worktree: wt
      ? {
          present: true,
          branch: wt.branch || null,
          base: wt.base_branch || null,
          provenance: PROVENANCE[wt.provenance] || 'procedencia desconocida',
          state: wtState,
          host: wt.machine || null,
          path: wt.path || null,
          branchKept: wt.branch_kept === true,
        }
      : { present: false },
    artifacts: (Array.isArray(a.artifacts) ? a.artifacts : []).map(artifactLine),
    review: reviewLine(a.review),
  };
}
