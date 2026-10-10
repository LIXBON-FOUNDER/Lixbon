// reviewContract.js - contrato con el host para la revisión de diff por tarea del orquestador.
// Vista propia, aparte del chat: no usa reviewStore ni la revisión del chat.
// Los comandos son Tauri propios (no pasan por orch_call ni por HTTP), así que un agente no
// puede aceptar su propio diff. Todos los nombres viven aquí: si el host los cambia, se renombran aquí.

export const REVIEW_COMMANDS = Object.freeze({
  diff: 'orch_task_diff',     // { task_id } -> TaskDiff
  review: 'orch_review_task', // { task_id, decision, head_commit, comment? } -> ReviewResult | ReviewError
});

/** Decisiones posibles de la persona. */
export const REVIEW_DECISIONS = Object.freeze({ accepted: 'accepted', rejected: 'rejected' });

/** Errores estructurados de orch_review_task. head_moved: el head_commit enviado no coincide con la rama. */
export const REVIEW_ERRORS = Object.freeze({ headMoved: 'head_moved', notFound: 'not_found' });

/** Origen de base_commit: registrado al lanzar, o aproximado con git merge-base (tareas viejas). */
export const BASE_SOURCES = Object.freeze({ recorded: 'recorded', mergeBase: 'merge_base' });

export const FILE_STATUSES = Object.freeze(['added', 'modified', 'deleted', 'renamed']);

/** Nombres de campos (argumentos en snake_case, respuesta y snapshot). */
export const REVIEW_FIELDS = Object.freeze({
  taskId: 'task_id',
  decision: 'decision',
  headCommit: 'head_commit',
  baseCommit: 'base_commit',
  baseSource: 'base_source',
  comment: 'comment',
  files: 'files',
  truncated: 'truncated',
  path: 'path',
  status: 'status',
  additions: 'additions',
  deletions: 'deletions',
  patch: 'patch',
  ok: 'ok',
  at: 'at',
  error: 'error',
  foundCommit: 'found_commit',
  lastReview: 'last_review', // por tarea en orch_snapshot: { decision, head_commit, at } | null
});

const F = REVIEW_FIELDS;
export const reviewField = (obj, key) => (obj ? obj[F[key]] : undefined);

export function shortSha(sha) {
  return String(sha ?? '').slice(0, 7);
}

/** Argumentos de orch_task_diff. */
export function diffArgs(taskId) {
  return { [F.taskId]: taskId };
}

/** Argumentos de orch_review_task; el comentario vacío no se envía. */
export function reviewArgs({ task_id, decision, head_commit, comment }) {
  const a = { [F.taskId]: task_id, [F.decision]: decision, [F.headCommit]: head_commit };
  if (typeof comment === 'string' && comment.trim() !== '') a[F.comment] = comment.trim();
  return a;
}

/** Devuelve el error estructurado si el resultado (o el rechazo) lo es; si no, null. */
export function structuredError(x) {
  return x && typeof x === 'object' && typeof x[F.error] === 'string' ? x : null;
}

export function errorText(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  if (structuredError(err)) return err[F.error];
  return String(err);
}
