// vocabulario.js — espejo del vocabulario canónico (contracts/status-vocabulary.json, slice H).
//
// El ADE CONSUME estos ids; no los define. El contrato JSON vive fuera de la raíz de Vite, así que no se
// importa en ejecución (el servidor de desarrollo no serviría un archivo de fuera). En su lugar,
// vocabulario.test.js compara este espejo con el contrato y falla si se desvían.
//
// Lo que aquí es PRESENTACIÓN (etiquetas en español, orden de los kinds) está marcado; los ids son de dominio.
import { FAILURE_REASON_TEXT } from '../../orch/terminalApprovalContract';

const congelar = (o) => Object.freeze(o);

/** Grupos visuales comunes a todos los clientes (presentation.visual_group.groups). */
export const VISUAL_GROUPS = congelar(['active', 'waiting', 'needs_person', 'ok', 'error', 'halted']);

/** Estados de Task vigentes (domain.task_status). `group` sale de presentation.visual_group.of_task_status. */
export const TASK_STATUSES = congelar([
  { id: 'starting', final: false, group: 'active' },
  { id: 'running', final: false, group: 'active' },
  { id: 'waiting', final: false, group: 'waiting' },
  { id: 'awaiting_terminal_approval', final: false, group: 'needs_person' },
  { id: 'done', final: true, group: 'ok' },
  { id: 'failed', final: true, group: 'error' },
  { id: 'stopped', final: true, group: 'halted' },
  { id: 'exited', final: true, group: 'error' },
]);

/**
 * Estados de Attempt (domain.attempt_state, RESERVADO): los ocho de la Task más `pending_approval`.
 * `pending_approval` no tiene aún grupo visual canónico: `needs_person` es una PROPUESTA de presentación
 * (la persona debe decidir), pendiente de H/G.
 */
export const ATTEMPT_STATES = congelar([
  { id: 'pending_approval', final: false, group: 'needs_person', propuesta: true },
  ...TASK_STATUSES,
]);

/** Etiquetas del Desktop (presentation.desktop.task_status_label) + propuesta para `pending_approval`. */
export const ATTEMPT_STATE_LABELS = congelar({
  pending_approval: 'Pendiente de aprobación',
  starting: 'Arrancando',
  running: 'Trabajando',
  waiting: 'Esperando respuesta',
  awaiting_terminal_approval: 'Esperando aprobación en la terminal',
  done: 'Terminada',
  failed: 'Fallida',
  stopped: 'Detenida',
  exited: 'Cerrada',
});

/** Estado derivado de la Task (domain.task_derived_state, RESERVADO). Las etiquetas salen del modelo de runtime. */
export const TASK_DERIVED_STATES = congelar(['open', 'in_progress', 'in_review', 'integrated', 'discarded']);
export const TASK_DERIVED_LABELS = congelar({
  open: 'Abierta',
  in_progress: 'En curso',
  in_review: 'En revisión',
  integrated: 'Integrada',
  discarded: 'Descartada',
});

/**
 * Kinds de Attention. El ORDEN es la prioridad (más a menos urgente). Los vigentes vienen de
 * domain.attention_kind.ids; los reservados, de `reservados` y siguen a los vigentes hasta que G decida.
 * No hay severidad definida: no se inventa.
 */
export const ATTENTION_KINDS = congelar([
  { id: 'approve_in_terminal', estado: 'vigente' },
  { id: 'integrate', estado: 'vigente' },
  { id: 'review', estado: 'vigente' },
  { id: 'failed', estado: 'vigente' },
  { id: 'pending_spawn', estado: 'reservado' },
  { id: 'unanswered_question', estado: 'reservado' },
]);

/** Títulos de interfaz. Los cuatro vigentes son los de orch/AttentionList.jsx; los reservados, propuesta. */
export const ATTENTION_TITLES = congelar({
  approve_in_terminal: 'Aprobar en la terminal',
  integrate: 'Lista para integrar',
  review: 'Revisar diff',
  failed: 'Falló',
  pending_spawn: 'Lanzamiento pendiente',
  unanswered_question: 'Pregunta sin responder',
});

export const ENTITY_KINDS = congelar(['project', 'task', 'attempt', 'thread', 'worktree', 'artifact', 'review', 'integration', 'agent', 'decision', 'policy', 'attention']);

export const MESSAGE_KINDS = congelar(['phase', 'done', 'question', 'reply', 'note', 'exited']);
export const MESSAGE_KIND_LABELS = congelar({
  phase: 'Fase', done: 'Entregó su informe', question: 'Preguntó', reply: 'Respuesta', note: 'Nota', exited: 'Se cerró',
});

export const FAILURE_REASONS = congelar(['terminal_approval_timeout', 'agent_idle_timeout']);
/** Textos de los motivos de fallo: son los del Desktop (orch/terminalApprovalContract.js), no se duplican. */
export const FAILURE_REASON_LABELS = FAILURE_REASON_TEXT;

export const POLICY_STATUSES = congelar(['ok', 'blocked', 'unverified']);
export const POLICY_STATUS_LABELS = congelar({ ok: 'Política verificada', blocked: 'Política bloqueada', unverified: 'Política sin verificar' });

export const REVIEW_DECISIONS = congelar(['accepted', 'rejected']);
export const REVIEW_STATES = congelar(['none', 'stale', 'accepted', 'rejected']);
export const REVIEW_STATE_LABELS = congelar({ none: 'Sin revisar', stale: 'Desactualizada', accepted: 'Aceptada', rejected: 'Rechazada' });

export const INTEGRATION_OUTCOMES = congelar(['merged', 'conflict', 'error', 'target_moved']);
export const INTEGRATION_OUTCOME_LABELS = congelar({
  merged: 'Integrada', conflict: 'Conflicto', error: 'Error al integrar', target_moved: 'La rama destino se movió',
});

/** Eventos de dominio durables (domain.event.dominio_durable_reservado.ids), formato `entidad.verbo`. */
export const DURABLE_EVENT_TYPES = congelar([
  'project.registered', 'project.archived', 'project.relocated',
  'task.created', 'task.updated', 'task.closed',
  'attempt.requested', 'attempt.approved', 'attempt.rejected', 'attempt.started', 'attempt.waiting', 'attempt.completed', 'attempt.failed', 'attempt.stopped',
  'thread.created', 'worktree.created', 'worktree.removed', 'artifact.created',
  'review.requested', 'review.completed',
  'integration.requested', 'integration.completed', 'integration.conflict',
  'agent.question', 'agent.answered', 'decision.created', 'policy.warning',
  'attention.created', 'attention.resolved',
]);

/** Efímeros (UI en vivo): el ADE nunca los muestra en la Actividad. */
export const EPHEMERAL_EVENT_TYPES = congelar(['attempt.progress', 'terminal.output', 'agent.typing', 'token.stream', 'tool.progress']);

/** Política de sincronización del Thread (modelo de runtime §4); `metadata-only` es la predeterminada. */
export const THREAD_SYNC_POLICIES = congelar(['local-only', 'metadata-only', 'summary', 'full-transcript']);

const porId = (lista) => Object.fromEntries(lista.map((e) => [e.id, e]));
const ESTADOS = porId(ATTEMPT_STATES);
const KINDS = porId(ATTENTION_KINDS);

/** Información de presentación de un estado de Attempt (o de Task vigente). Un id desconocido no rompe la UI. */
export function attemptStateInfo(id) {
  const e = ESTADOS[id];
  return { id, label: ATTEMPT_STATE_LABELS[id] || String(id), group: e?.group || null, final: e?.final ?? false, known: Boolean(e), propuesta: Boolean(e?.propuesta) };
}

export const isFinalState = (id) => ESTADOS[id]?.final === true;

/** Prioridad de un kind: su posición en el vocabulario (menor = más urgente). Desconocido, al final. */
export function attentionPriority(kind) {
  const i = ATTENTION_KINDS.findIndex((k) => k.id === kind);
  return i === -1 ? ATTENTION_KINDS.length : i;
}

export const attentionKindInfo = (kind) => ({
  id: kind,
  title: ATTENTION_TITLES[kind] || String(kind),
  estado: KINDS[kind]?.estado || 'desconocido',
  known: Boolean(KINDS[kind]),
});
