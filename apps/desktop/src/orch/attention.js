import { isAwaitingTerminalApproval, failureReasonText } from './terminalApprovalContract';
import { isMerged, isReviewAccepted } from './canIntegrate';

export const ATTENTION = Object.freeze({
  approveInTerminal: 'approve_in_terminal',
  integrate: 'integrate',
  review: 'review',
  failed: 'failed',
});

const ORDER = [ATTENTION.approveInTerminal, ATTENTION.integrate, ATTENTION.review, ATTENTION.failed];

/** none: sin revisión; stale: la rama recibió otro commit; accepted y rejected sobre el commit actual. */
export function reviewStatus(task) {
  const lr = task?.last_review;
  if (lr === undefined) return 'accepted';
  if (!lr) return 'none';
  if (!task.head_commit || lr.head_commit !== task.head_commit) return 'stale';
  return lr.decision === 'accepted' ? 'accepted' : 'rejected';
}

const REVIEW_HINT = {
  none: 'Revisa su diff antes de integrar.',
  stale: 'La rama cambió después de tu revisión: revísala de nuevo.',
  rejected: 'Rechazaste este diff. El coordinador debe corregirlo.',
};

function itemFor(task) {
  if (isAwaitingTerminalApproval(task)) {
    return { kind: ATTENTION.approveInTerminal, hint: 'Espera tu aprobación en su terminal.' };
  }
  if (task.status === 'failed') {
    return { kind: ATTENTION.failed, hint: failureReasonText(task) || 'Terminó con error.' };
  }
  if (!task.parent || task.status !== 'done' || !task.branch || isMerged(task)) return null;
  if (isReviewAccepted(task)) return { kind: ATTENTION.integrate, hint: 'Revisada y lista para integrar.' };
  const status = reviewStatus(task);
  if (status === 'rejected') return null;
  return { kind: ATTENTION.review, hint: REVIEW_HINT[status] };
}

/** Tareas que esperan una acción de la persona, de la más urgente a la menos. */
export function attentionItems(tasks) {
  return tasks
    .map((task) => {
      const item = itemFor(task);
      return item && { ...item, task };
    })
    .filter(Boolean)
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.task.created - b.task.created);
}

export function unansweredQuestions(messages = []) {
  const answered = new Set(messages.filter((m) => m.kind === 'reply').map((m) => m.reply_to));
  return messages.filter((m) => m.kind === 'question' && !answered.has(m.id));
}
