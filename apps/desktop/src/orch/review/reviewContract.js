// reviewContract.js - contrato con el host para la revisión de diff por tarea del orquestador.
// Vista propia, aparte del chat: no usa reviewStore ni la revisión del chat.
// Comandos Tauri propios con rename_all = "snake_case" (src-tauri/src/orch/mod.rs y review.rs).
// orch_call y el servidor de lxo los rechazan, así que un agente no puede revisar ni leer este diff.
// Todos los nombres viven aquí: si el host los cambia, se renombran aquí.

/** Evento del host tras registrar una decisión. payload: { task_id, decision, head_commit, at } */
export const REVIEW_EVENTS = Object.freeze({ reviewed: 'orch-task-reviewed' });

export const REVIEW_COMMANDS = Object.freeze({
  // { task_id } -> { task_id, branch, base_commit, base_source, head_commit, files, truncated, limit_bytes }
  diff: 'orch_task_diff',
  // { task_id, decision, head_commit, comment?, confirm: true } -> outcome 'recorded' | 'head_moved'
  review: 'orch_review_task',
});

/** Decisiones posibles de la persona. */
export const REVIEW_DECISIONS = Object.freeze({ accepted: 'accepted', rejected: 'rejected' });

/** `outcome` de orch_review_task.
    - recorded: { task_id, decision, decision_id, head_commit, base_commit, base_source, comment, at }
    - head_moved: { task_id, expected_commit, found_commit } (found_commit null si la rama ya no existe).
      No registra nada. */
export const REVIEW_OUTCOMES = Object.freeze({ recorded: 'recorded', headMoved: 'head_moved' });

/** Prefijos de los rechazos de texto del host. Otros rechazos (sin base, rama borrada, git) van tal cual. */
export const REVIEW_ERROR_PREFIXES = Object.freeze({ notFound: 'not_found', noBranch: 'no_branch' });

/** Origen de base_commit: registrado al lanzar, o aproximado con git merge-base (tareas viejas). */
export const BASE_SOURCES = Object.freeze({ recorded: 'recorded', mergeBase: 'merge_base' });

/** El host manda la letra de `git diff --name-status --no-renames` (A, M, D, T...).
    Con --no-renames no llegan R ni C ni old_path: un renombre se ve como D + A. */
export const FILE_STATUS_CODES = Object.freeze({
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'unmerged',
});
export const FILE_STATUSES = Object.freeze(['added', 'modified', 'deleted', 'renamed', 'copied', 'typechange', 'unmerged']);

/** Letra del host (o palabra) a palabra; R100/C75 también. Desconocido: se devuelve tal cual. */
export function fileStatus(s) {
  const v = String(s ?? '');
  if (FILE_STATUSES.includes(v)) return v;
  return FILE_STATUS_CODES[v.charAt(0)] || v;
}

/** Nombres de campos (argumentos en snake_case, respuesta y snapshot). */
export const REVIEW_FIELDS = Object.freeze({
  taskId: 'task_id',
  branch: 'branch',
  decision: 'decision',
  decisionId: 'decision_id',
  headCommit: 'head_commit',
  baseCommit: 'base_commit',
  baseSource: 'base_source',
  comment: 'comment',
  confirm: 'confirm',
  files: 'files',
  truncated: 'truncated',
  limitBytes: 'limit_bytes',
  path: 'path',
  status: 'status',
  additions: 'additions', // null en binarios
  deletions: 'deletions', // null en binarios
  patch: 'patch',         // null si se cortó por el límite
  outcome: 'outcome',
  at: 'at',               // número (decisions.at del host)
  expectedCommit: 'expected_commit',
  foundCommit: 'found_commit',
  lastReview: 'last_review', // en cada tarea de orch_snapshot: { decision, head_commit, at } | null
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

/** Argumentos de orch_review_task: confirm siempre true (lo exige el host); comentario vacío no se envía. */
export function reviewArgs({ task_id, decision, head_commit, comment }) {
  const a = { [F.taskId]: task_id, [F.decision]: decision, [F.headCommit]: head_commit, [F.confirm]: true };
  if (typeof comment === 'string' && comment.trim() !== '') a[F.comment] = comment.trim();
  return a;
}

export const isRecorded = (r) => r?.[F.outcome] === REVIEW_OUTCOMES.recorded;
export const isHeadMoved = (r) => r?.[F.outcome] === REVIEW_OUTCOMES.headMoved;

export function errorText(err) {
  if (typeof err === 'string') return err;
  if (err && typeof err.message === 'string') return err.message;
  return String(err);
}

/** ¿El rechazo es not_found? (texto que empieza por 'not_found'). */
export const isNotFound = (err) => errorText(err).startsWith(REVIEW_ERROR_PREFIXES.notFound);
/** ¿El rechazo es no_branch? (tarea sin rama propia). */
export const isNoBranch = (err) => errorText(err).startsWith(REVIEW_ERROR_PREFIXES.noBranch);

/** Texto para la persona según el rechazo. */
export function reviewErrorMessage(err) {
  if (isNotFound(err)) return 'El host no encuentra esta tarea.';
  if (isNoBranch(err)) return 'Esta tarea no tiene rama propia (se lanzó sin worktree): no hay diff que revisar.';
  return errorText(err);
}

/** Límite en texto legible (512 KB). */
export function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1024 * 1024) return `${Math.round(n / 104857.6) / 10} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}
