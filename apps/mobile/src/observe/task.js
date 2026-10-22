// observe/task.js — Task Detail de Supervisar (LXO-110). Sin dependencias de React Native.
//
// Junta lo que dice el Core de una Task legacy: el detalle (`task_detail` por el relé, `core_task`), su
// Activity (`activity_list`, `core_activity`) y la fila de la snapshot. Lo que el modelo legacy no registra
// (host, a veces el modelo) queda como desconocido; nunca se inventa. La ruta es ubicación secundaria.
import { translateActivityMessage } from './activityMessages.js';

export const STATUS = Object.freeze({
  starting: { label: 'Arrancando', tone: 'ok' },
  running: { label: 'Trabajando', tone: 'ok' },
  waiting: { label: 'Esperando', tone: 'warn' },
  awaiting_terminal_approval: { label: 'Espera aprobación en el escritorio', tone: 'warn' },
  done: { label: 'Terminada', tone: 'ok' },
  failed: { label: 'Falló', tone: 'error' },
  stopped: { label: 'Detenida', tone: 'muted' },
  exited: { label: 'Cerrada', tone: 'muted' },
});
const FINAL = new Set(['done', 'failed', 'stopped', 'exited']);
export const statusOf = (code) => STATUS[code] || { label: String(code || 'desconocido'), tone: 'muted' };
export const isFinal = (code) => FINAL.has(code);

const PROVIDER = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', gemini: 'Gemini', lixbon: 'Lixbon', coordinador: 'Coordinador' };
const REVIEW = { accepted: 'Revisión aceptada', rejected: 'Revisión rechazada' };
const INTEGRATION = { merged: 'Integrada', conflict: 'Integración con conflictos', error: 'La integración falló', target_moved: 'El destino se movió' };

/** La fila de la snapshot de esta Task, si está entre las activas. */
export function snapshotTask(snapshot, taskId) {
  return (snapshot?.active_tasks?.items || []).find((t) => t?.id === taskId) || null;
}

/**
 * Modelo de la pantalla. `source`: 'detail' (task_detail), 'snapshot' (solo la fila de la snapshot) o 'none'.
 * `missing`: el Core respondió que la Task no existe (o ya no es de ese Project).
 */
export function taskModel({ taskId, detail, snapItem, snapshot, missing = false }) {
  const d = detail || null;
  const s = snapItem || null;
  const base = d || s;
  if (!base) return { id: taskId, source: 'none', missing };
  const projectId = d?.project_id ?? s?.project_id ?? null;
  const project = (snapshot?.projects?.items || []).find((p) => p.id === projectId);
  const status = d?.status ?? s?.status ?? null;
  const flags = [];
  if (d?.pending_questions > 0) flags.push({ tone: 'warn', text: d.pending_questions === 1 ? 'Tiene una pregunta sin responder' : `Tiene ${d.pending_questions} preguntas sin responder` });
  if (d?.review?.decision) flags.push({ tone: d.review.decision === 'accepted' ? 'ok' : 'warn', text: REVIEW[d.review.decision] || `Revisión: ${d.review.decision}` });
  if (d?.integration?.outcome) flags.push({ tone: d.integration.outcome === 'merged' ? 'ok' : 'warn', text: INTEGRATION[d.integration.outcome] || `Integración: ${d.integration.outcome}` });
  else if (d?.merged) flags.push({ tone: 'ok', text: 'Integrada' });
  const providerCode = d?.provider ?? s?.provider ?? null;
  return {
    id: base.id || taskId,
    source: d ? 'detail' : 'snapshot',
    missing,
    title: (d?.title ?? s?.title) || '(sin título)',
    status,
    statusMeta: statusOf(status),
    final: isFinal(status),
    projectId,
    projectName: projectId ? project?.name || null : null,
    runId: d?.run_id ?? s?.run_id ?? null,
    rootId: d?.root_id ?? s?.root_id ?? null,
    parentId: d?.parent_id ?? s?.parent_id ?? null,
    isRoot: (d?.parent_id ?? s?.parent_id ?? null) === null,
    children: d ? d.child_ids.length : null,
    provider: providerCode ? PROVIDER[providerCode] || providerCode : null,
    model: d ? d.model : null,
    branch: d ? d.branch : null,
    location: d ? d.location : null,
    sharedCheckout: d ? !d.worktree : null,
    // El modelo legacy no guarda el host; el origen solo lo da la snapshot.
    host: null,
    origin: s?.origin ?? null,
    phase: d?.phase ? (d.phase.done ? 'Última fase terminada' : 'Fase en curso') : null,
    phaseAt: d?.phase?.at ?? null,
    createdAt: d?.created_at ?? null,
    updatedAt: d?.updated_at ?? s?.updated_at ?? null,
    flags,
  };
}

// ── Activity ─────────────────────────────────────────────────────────────────

/** Una línea de Activity traducida; si la clave o sus argumentos no son conocidos, un texto genérico seguro. */
export function activityLine(item) {
  const text = translateActivityMessage(item?.message_key, item?.args || {});
  return {
    seq: item?.seq,
    ts: item?.ts,
    visual: ['info', 'success', 'warning', 'error'].includes(item?.visual) ? item.visual : 'info',
    text: text || 'Algo cambió en esta tarea (este Lixbon no sabe describirlo todavía).',
    known: !!text,
  };
}

export const initialActivity = { items: [], cursor: 0, hasMore: false, loading: false, error: null, loaded: false };

/** Activity en orden descendente (lo último primero), sin repetir `seq`; `cursor` es el `seq` más bajo visto. */
export function activityReducer(state, action) {
  switch (action.type) {
    case 'reset':
      return initialActivity;
    case 'request':
      return { ...state, loading: true, error: null };
    case 'page': {
      const base = action.append ? state.items : [];
      const seen = new Set(base.map((i) => i.seq));
      const fresh = (action.items || []).filter((i) => Number.isSafeInteger(i?.seq) && !seen.has(i.seq));
      const items = [...base, ...fresh].sort((a, b) => b.seq - a.seq);
      return { ...state, items, cursor: Number.isSafeInteger(action.cursor) ? action.cursor : state.cursor, hasMore: !!action.hasMore, loading: false, error: null, loaded: true };
    }
    case 'fail':
      return { ...state, loading: false, error: action.code || 'offline' };
    default:
      return state;
  }
}

/** Qué decir arriba del detalle. */
export function taskNotice(model, { online, error }) {
  if (model.missing) return { tone: 'muted', text: 'Esta tarea ya no está en el Core: se cerró, se quitó o ya no es de este proyecto.' };
  if (model.source === 'none') return { tone: 'muted', text: online ? 'Cargando la tarea…' : 'Sin datos de esta tarea hasta que vuelva la conexión.' };
  if (model.source === 'snapshot' && !model.projectId) return { tone: 'muted', text: 'Esta tarea no tiene proyecto: solo se ve su resumen.' };
  if (model.source === 'snapshot') return { tone: 'warn', text: online ? 'Resumen de la tarea; cargando el detalle…' : 'Sin conexión: ves el resumen guardado de la tarea.' };
  if (error || !online) return { tone: 'warn', text: 'No se pudo actualizar: ves el último detalle que llegó.' };
  return null;
}
