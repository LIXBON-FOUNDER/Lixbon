// queries.js — consultas compuestas de las pantallas de detalle (cadena Project → Task → Attempt).
// Cada una es UNA consulta con un solo estado cargando/error; así la pantalla no pinta cadenas a medias.
import { useAdeQuery } from '../../state/useAdeQuery';

/** Intento + su cadena (task, proyecto) + todo lo que cuelga de él. */
export function useAttemptDetail(attemptId) {
  return useAdeQuery(async (c) => {
    const attempt = await c.getAttempt(attemptId);
    const [task, project, worktrees, artifacts, review, integration, attention] = await Promise.all([
      c.getTask(attempt.taskId), c.getProject(attempt.projectId), c.listWorktrees({ attemptId }), c.listArtifacts({ attemptId }),
      c.getReview(attemptId), c.getIntegration(attemptId), c.listAttention({ attemptId }),
    ]);
    const threads = (await c.listThreads({ taskId: task.id })).filter((t) => t.attemptIds.includes(attemptId));
    return { attempt, task, project, worktree: worktrees[0] || null, artifacts, review, integration, attention, threads };
  }, [attemptId]);
}

export function useTaskDetail(taskId) {
  return useAdeQuery(async (c) => {
    const task = await c.getTask(taskId);
    const [project, attempts, threads, attention] = await Promise.all([
      c.getProject(task.projectId), c.listAttempts({ taskId }), c.listThreads({ taskId }), c.listAttention({ projectId: task.projectId }),
    ]);
    return { task, project, attempts, threads, attention: attention.filter((i) => i.taskId === taskId) };
  }, [taskId]);
}

export function useProjectDetail(projectId) {
  return useAdeQuery(async (c) => {
    const project = await c.getProject(projectId);
    const [tasks, attempts, attention, activity] = await Promise.all([
      c.listTasks({ projectId }), c.listAttempts({ projectId }), c.listAttention({ projectId }), c.listActivity({ projectId, limit: 15 }),
    ]);
    return { project, tasks, attempts, attention, activity };
  }, [projectId]);
}

export function useThreadDetail(threadId) {
  return useAdeQuery(async (c) => {
    const thread = await c.getThread(threadId);
    const task = await c.getTask(thread.taskId);
    const [project, attempts] = await Promise.all([c.getProject(task.projectId), c.listAttempts({ taskId: task.id })]);
    return { thread, task, project, attempts };
  }, [threadId]);
}
