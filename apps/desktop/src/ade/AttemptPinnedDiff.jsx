import { useMemo } from 'react';
import { TaskDiffView } from '../orch/review/TaskDiffView';
import { defaultReviewApi } from '../orch/review/taskReview';
import { queryAdeCore } from './coreQueries';

// The legacy diff reader is Task-scoped. Never let it silently substitute a newer Attempt.
export function AttemptPinnedDiff({ attempt, revision, file, line }) {
  const api = useMemo(() => ({
    ...defaultReviewApi,
    fetchDiff: async (taskId) => {
      const history = await queryAdeCore('attempts_by_task', { taskId });
      if (!history.items?.length || history.items.some((a) => a.n > attempt.n)) throw new Error('El diff de este Attempt histórico requiere abrir su revisión en ADE. No se muestra el de otro intento.');
      const diff = await defaultReviewApi.fetchDiff(taskId);
      if (revision && !diff.head_commit?.startsWith(revision)) throw new Error('link_stale: la revisión cambió. Vuelve a revisar el destino.');
      return diff;
    },
  }), [attempt.id, attempt.n, revision]);
  return <TaskDiffView taskId={attempt.task_id} api={api} readOnly focusFile={file} focusLine={line} />;
}
