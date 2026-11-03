import { useState } from 'react';
import { TaskDiffView } from '../orch/review/TaskDiffView';

/**
 * Cambios del Attempt: lo que su rama tiene respecto a la base y la decisión de la persona sobre un commit concreto.
 * Reutiliza la vista de revisión del orquestador (`orch_task_diff` / `orch_review_task`, solo de la interfaz): el diff es
 * de la rama de la Task, la revisión se registra sobre el `head_commit` que se vio y, si la rama se movió, el Core no la
 * registra y la vista lo dice. Solo se ofrece con una rama que revisar y una vez aprobado el lanzamiento.
 */
export function AttemptChanges({ taskId, status, worktree, onReviewed }) {
  const [open, setOpen] = useState(false);
  // El diff se lee de la rama, no del directorio: con el worktree retirado solo sigue habiendo qué revisar si la rama se conservó.
  const hasBranch = Boolean(worktree?.branch) && (worktree.state !== 'removed' || worktree.branch_kept === true);
  if (!taskId || !hasBranch || status === 'pending_approval') return null;

  return (
    <div className="ade-attempt__changes" data-testid="attempt-changes">
      <button type="button" className="btn btn--ghost btn--sm" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="attempt-changes-toggle">
        {open ? 'Ocultar cambios' : 'Ver cambios'}
      </button>
      {open && <TaskDiffView key={taskId} taskId={taskId} onDecided={onReviewed} onReviewed={onReviewed} />}
    </div>
  );
}
