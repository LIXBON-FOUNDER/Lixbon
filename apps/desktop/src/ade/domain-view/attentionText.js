// attentionText.js — textos de la tarjeta de Attention (PRESENTACIÓN, no dominio).
// Las pistas de los cuatro kinds vigentes son las de src/orch/attention.js; las de los reservados son
// propuesta. El Core entrega kind + reason (ids de máquina); aquí se convierten en español.
import { FAILURE_REASON_LABELS, REVIEW_STATE_LABELS } from '../vocab/vocabulario';

const PISTA_REVISION = {
  none: 'Revisa su diff antes de integrar.',
  stale: 'La rama cambió después de tu revisión: revísala de nuevo.',
};

/** @param {{item: object, attempt: object|null}} view */
export function attentionHint({ item, attempt }) {
  switch (item.kind) {
    case 'approve_in_terminal': return 'Espera tu aprobación en su terminal.';
    case 'integrate': return 'Revisada y lista para integrar.';
    case 'review': return PISTA_REVISION[item.reason] || `Revisión: ${REVIEW_STATE_LABELS[item.reason] || 'pendiente'}.`;
    case 'failed': return FAILURE_REASON_LABELS[item.reason] || 'Terminó con error.';
    case 'pending_spawn': return attempt?.policy?.elevated
      ? 'Pide lanzarse con política elevada: revisa los avisos antes de aprobar.'
      : 'Pide permiso para lanzarse. Revisa la política efectiva.';
    case 'unanswered_question': return attempt?.pendingQuestion?.text || 'El agente espera tu respuesta.';
    default: return '';
  }
}
