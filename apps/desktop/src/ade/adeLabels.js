/**
 * Módulo ÚNICO de textos del ADE para el modelo Task/Attempt (F3): etiquetas de estado, tonos y
 * copia de errores. El estado siempre se muestra como texto; el color (tono) solo lo acompaña.
 * Un valor que el cliente no reconoce se presenta como «Estado no reconocido» en tono neutro: el
 * valor crudo va solo al detalle técnico, nunca al texto principal ni a un estilo de error.
 */

/** Estados de ejecución de una Task F2 (LXO-91). */
export const TASK_STATUS_LABELS = Object.freeze({
  starting: 'Iniciando',
  running: 'En ejecución',
  waiting: 'Esperando',
  awaiting_terminal_approval: 'Esperando aprobación de terminal',
  done: 'Terminada',
  failed: 'Fallida',
  stopped: 'Detenida',
  exited: 'Cerrada',
});

/** Estados del Attempt (migración 008 / LXO-119). */
export const ATTEMPT_STATUS_LABELS = Object.freeze({
  pending_approval: 'Pendiente de aprobación',
  starting: 'Iniciando',
  running: 'En ejecución',
  waiting: 'Esperando',
  awaiting_terminal_approval: 'Esperando aprobación de terminal',
  done: 'Terminado',
  failed: 'Falló',
  stopped: 'Cancelado',
  exited: 'Cerrado',
});

const ATTEMPT_STATUS_TONES = Object.freeze({
  pending_approval: 'waiting',
  starting: 'active',
  running: 'active',
  waiting: 'waiting',
  awaiting_terminal_approval: 'waiting',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  exited: 'exited',
});

/** Estado derivado de la Task en vNext (ADR D17, `task_derived_state`). */
export const TASK_STATE_LABELS = Object.freeze({
  open: 'Abierta',
  in_progress: 'En curso',
  in_review: 'En revisión',
  integrated: 'Integrada',
  discarded: 'Descartada',
});

const TASK_STATE_TONES = Object.freeze({
  open: 'neutral', in_progress: 'active', in_review: 'waiting', integrated: 'done', discarded: 'stopped',
});

export const UNKNOWN_STATUS_LABEL = 'Estado no reconocido';

/** `{label, tone, known, raw}`. Nunca lanza: un valor raro (o ausente) es «no reconocido», neutro. */
function info(labels, tones, raw) {
  const known = typeof raw === 'string' && Object.hasOwn(labels, raw);
  return known
    ? { label: labels[raw], tone: tones[raw], known: true, raw }
    : { label: UNKNOWN_STATUS_LABEL, tone: 'neutral', known: false, raw: raw === undefined ? null : raw };
}
export const attemptStatusInfo = (raw) => info(ATTEMPT_STATUS_LABELS, ATTEMPT_STATUS_TONES, raw);
export const taskStateInfo = (raw) => info(TASK_STATE_LABELS, TASK_STATE_TONES, raw);

export const COPY = Object.freeze({
  noAttempts: 'Sin intentos todavía',
  lastFailed: 'Falló',
  modelInactive: 'El modelo de Attempts aún no está activo en este Core',
  notFound: 'Esta tarea ya no existe o no es de este proyecto',
  backToProject: 'Volver al proyecto',
  unavailable: 'El Core no responde',
  retry: 'Reintentar',
  genericError: 'No se pudo leer este dato del Core',
  technicalDetail: 'Detalle técnico',
  notAvailable: 'no disponible',
  unknown: 'desconocido',
  copyPath: 'Copiar ruta',
  pathCopied: 'Ruta copiada',
  pathCopyFailed: 'No se pudo copiar la ruta',
  attemptOtherTask: 'Este intento no pertenece a esta tarea',
  openAttemptTask: 'Ir a su tarea',
  attemptHistory: 'Historial de intentos',
  attemptDetail: 'Detalle del intento',
  durationUnavailable: 'duración no disponible',
  hostUnavailable: 'Host: no disponible (el Core no lo informa)',
  noArtifacts: 'Sin artefactos',
  noReview: 'Sin revisión registrada',
  noWorktree: 'Sin worktree registrado',
  attemptActivity: 'Actividad del intento',
  activityPerAttemptPartial: 'Actividad parcial: no incluye eventos de sesión ni worktree',
  noAttemptActivity: 'Sin eventos del intento todavía',
  loadingAttemptActivity: 'Cargando actividad del intento.',
  attemptActivityTruncated: (limit) => `Mostrando los ${limit} eventos más recientes`,
  unknownEvent: 'Evento desconocido',
  // LXO-123 · Corte Task/Attempt al arrancar.
  cutApplied: 'El almacén del Core se actualizó al modelo de tareas e intentos. Se guardó una copia de seguridad previa:',
  cutDismiss: 'Entendido',
  cutLegacyNumbering: 'El almacén del Core se actualizó con una numeración anterior y no se puede abrir. Restaura la copia de seguridad «pre-f3-cut» para continuar.',
  cutFailed: 'No se pudo actualizar el almacén al modelo de tareas e intentos. El cambio se deshizo por completo: tus datos quedaron sin cambios.',
  navLegacyMigrated: 'Tu selección guardada del Orquestador era de la versión anterior y se abrió en el modelo de tareas e intentos.',
  navLegacyExpired: 'Tu selección guardada del Orquestador era de la versión anterior y ya no es compatible: se descartó. Elige de nuevo un proyecto o una tarea.',
  navLegacyInvalid: 'La selección guardada del Orquestador no era válida y se descartó.',
  navAttemptNeedsModel: 'Este intento no se puede abrir: el modelo de Attempts aún no está activo en este Core.',
  navAttemptInvalid: 'Este destino no identifica un intento válido.',
  navAttemptNoProject: 'Este intento no trae su proyecto: no se puede abrir.',
  showDiscarded: (n) => `Mostrar descartadas (${n})`,
  hideDiscarded: 'Ocultar descartadas',
  cutModelUnavailable: 'El almacén del Core no está abierto: no se pudo comprobar la actualización al modelo de tareas e intentos.',
});

/** LXO-123 · Texto de un destino de navegación rechazado (`resolveNavTarget`). */
export function navRejectText(reason) {
  if (reason === 'model_inactive') return COPY.navAttemptNeedsModel;
  if (reason === 'no_project') return COPY.navAttemptNoProject;
  return COPY.navAttemptInvalid;
}

/** LXO-123 · Aviso de la migración de la selección F2 (`migratePersistedSelection`). */
export function navNoticeCopy(notice) {
  if (notice === 'migrated') return { tone: 'info', text: COPY.navLegacyMigrated };
  if (notice === 'expired') return { tone: 'warn', text: COPY.navLegacyExpired };
  return { tone: 'warn', text: COPY.navLegacyInvalid };
}

/** LXO-123 · Copia del aviso de arranque por código del corte. */
export function startupCutCopy(code) {
  if (code === 'core_cut_legacy_numbering') return { tone: 'error', text: COPY.cutLegacyNumbering };
  if (code === 'model_unavailable') return { tone: 'error', text: COPY.cutModelUnavailable };
  return { tone: 'error', text: COPY.cutFailed };
}

/** Copia por código de error estructurado (`coreErrorCode`). */
export function errorCopy(code) {
  if (code === 'core_model_inactive' || code === 'query_unsupported') return { tone: 'info', text: COPY.modelInactive, retry: false, back: false };
  if (code === 'model_not_found') return { tone: 'error', text: COPY.notFound, retry: false, back: true };
  if (code === 'model_unavailable') return { tone: 'error', text: COPY.unavailable, retry: true, back: false };
  return { tone: 'error', text: COPY.genericError, retry: true, back: false };
}

/** Frescura de la revisión: solo `review.status` del Core; si no se puede decidir, «desconocida». */
export const REVIEW_FRESHNESS_LABELS = Object.freeze({
  active: 'Vigente para este head',
  stale: 'Desactualizada: el head cambió desde la revisión',
  superseded: 'Reemplazada por una revisión posterior',
});
export function reviewFreshnessInfo(review) {
  if (!review || typeof review !== 'object') return { label: COPY.noReview, tone: 'neutral', known: true, raw: null };
  const known = typeof review.status === 'string' && Object.hasOwn(REVIEW_FRESHNESS_LABELS, review.status) && typeof review.head_commit === 'string' && review.head_commit !== '';
  return known
    ? { label: REVIEW_FRESHNESS_LABELS[review.status], tone: review.status === 'active' ? 'ok' : 'warn', known: true, raw: review.status }
    : { label: 'Frescura desconocida', tone: 'neutral', known: false, raw: review.status ?? null };
}

/** LXO-121 · Texto corto de cada evento `activity.attempt.*`; cualquier otra clave, COPY.unknownEvent. */
export const ATTEMPT_ACTIVITY_LABELS = Object.freeze({
  'activity.attempt.requested': 'Solicitado',
  'activity.attempt.approved': 'Aprobado',
  'activity.attempt.rejected': 'Rechazado',
  'activity.attempt.started': 'Iniciado',
  'activity.attempt.completed': 'Completado',
  'activity.attempt.failed': 'Falló',
  'activity.attempt.stopped': 'Detenido',
});

export function attemptActivityLabel(messageKey) {
  return Object.hasOwn(ATTEMPT_ACTIVITY_LABELS, messageKey) ? ATTEMPT_ACTIVITY_LABELS[messageKey] : COPY.unknownEvent;
}

export function isKnownAttemptActivity(messageKey) {
  return Object.hasOwn(ATTEMPT_ACTIVITY_LABELS, messageKey);
}
