// activity.js — presentación de eventos de dominio durables (`entidad.verbo`).
// El texto es presentación; el tipo y la entidad vienen del cliente (slice E en producción).
import { DURABLE_EVENT_TYPES, EPHEMERAL_EVENT_TYPES, FAILURE_REASON_LABELS } from '../vocab/vocabulario';

const VERBOS = {
  'project.registered': 'registró el proyecto',
  'project.archived': 'archivó el proyecto',
  'project.relocated': 'reubicó el proyecto',
  'task.created': 'creó la tarea',
  'task.updated': 'actualizó la tarea',
  'task.closed': 'cerró la tarea',
  'attempt.requested': 'pidió lanzar un intento',
  'attempt.approved': 'aprobó el lanzamiento',
  'attempt.rejected': 'rechazó el lanzamiento',
  'attempt.started': 'empezó a trabajar',
  'attempt.waiting': 'quedó esperando',
  'attempt.completed': 'terminó su intento',
  'attempt.failed': 'falló',
  'attempt.stopped': 'detuvo el intento',
  'thread.created': 'abrió un hilo',
  'worktree.created': 'creó el worktree',
  'worktree.removed': 'eliminó el worktree',
  'artifact.created': 'produjo un artefacto',
  'review.requested': 'pidió una revisión',
  'review.completed': 'completó la revisión',
  'integration.requested': 'pidió integrar',
  'integration.completed': 'integró el resultado',
  'integration.conflict': 'encontró un conflicto al integrar',
  'agent.question': 'hizo una pregunta',
  'agent.answered': 'respondió la pregunta',
  'decision.created': 'registró una decisión',
  'policy.warning': 'emitió un aviso de política',
  'attention.created': 'abrió una atención',
  'attention.resolved': 'resolvió una atención',
};

const DECISION = { accepted: 'aceptó', rejected: 'rechazó' };

/** Frase corta del evento, sin el sujeto: «terminó su intento», «rechazó la revisión»… */
export function describeEvent(entry) {
  const base = VERBOS[entry.type] || entry.type;
  const d = entry.data || {};
  if (entry.type === 'review.completed' && DECISION[d.decision]) return `${DECISION[d.decision]} la revisión`;
  if (entry.type === 'attempt.failed' && FAILURE_REASON_LABELS[d.failure_reason]) return `falló: ${FAILURE_REASON_LABELS[d.failure_reason].toLowerCase()}`;
  if (entry.type === 'attempt.waiting' && d.motivo === 'terminal') return 'espera tu aprobación en la terminal';
  return base;
}

/** Los eventos efímeros no se muestran en la Actividad: se descartan aquí por si el cliente los enviara. */
export const isDurableEvent = (entry) => DURABLE_EVENT_TYPES.includes(entry.type) && !EPHEMERAL_EVENT_TYPES.includes(entry.type);

export function actorLabel(actor) {
  if (!actor) return 'Alguien';
  const via = actor.client && actor.kind === 'human' ? ` (${{ desktop: 'Desktop', cli: 'CLI', mobile: 'móvil' }[actor.client] || actor.client})` : '';
  return `${actor.label}${via}`;
}
