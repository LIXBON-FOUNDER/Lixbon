import { ATTENTION_CATEGORIES } from './coreQueries';
import { TASK_STATUS_LABELS } from './adeLabels';

// Modelo compartido del sidebar Projects → Tasks (LXO-97): etiquetas, claves de fila, orden del
// Core y piezas de presentación comunes a `ProjectsSidebar.jsx` y `ProjectTasks.jsx`.
/**
 * Etiquetas de los ocho estados reales de Task (LXO-91). El Core no devuelve textos ni tiene un
 * estado `review`: la revisión se representa aparte como Attention `review_ready`, nunca como status.
 */
export { TASK_STATUS_LABELS };

/** Estados finales del contrato (LXO-91): nunca se presentan como activos. */
export const FINAL_TASK_STATUSES = new Set(['done', 'failed', 'stopped', 'exited']);

/**
 * Tono visual de cada estado real. No agrupa estados ni sustituye la etiqueta: solo elige el color
 * del badge para que `active`, `waiting`, `failed` y `final` se distingan de un vistazo.
 */
export const TASK_STATUS_TONES = Object.freeze({
  starting: 'active',
  running: 'active',
  waiting: 'waiting',
  awaiting_terminal_approval: 'waiting',
  done: 'done',
  failed: 'failed',
  stopped: 'stopped',
  exited: 'exited',
});

/** `status` agregado de un Project en `projects_overview` (LXO-90), distinto de la Attention. */
export const PROJECT_STATUS_LABELS = Object.freeze({
  failed: 'Con fallos',
  attention: 'Con Attention',
  active: 'Activo',
  idle: 'Inactivo',
});

/** Vistas explícitas del filtro de estado de Tasks: ningún «solo activas» fijo. */
export const TASK_STATUS_VIEWS = Object.freeze([
  { code: 'active', label: 'Activas', empty: 'Este Project no tiene Tasks activas.' },
  { code: 'final', label: 'Finalizadas', empty: 'Este Project no tiene Tasks finalizadas.' },
  { code: 'all', label: 'Todas', empty: 'Este Project no tiene Tasks registradas.' },
]);
export const ALL_TASKS_VIEW = TASK_STATUS_VIEWS.find((view) => view.code === 'all');

/** Etiquetas de las siete categorías de Attention del contrato (LXO-87/89). */
export const ATTENTION_CATEGORY_LABELS = Object.freeze({
  question: 'Pregunta',
  approval: 'Aprobación',
  review_ready: 'Revisión lista',
  conflict: 'Conflicto',
  failed: 'Fallida',
  environment_blocked: 'Entorno bloqueado',
  risk: 'Riesgo',
});

export const NOT_REPORTED = 'No informado';

export const asText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
export const metaValue = (value) => asText(value) ?? NOT_REPORTED;
export const countValue = (value) => (Number.isFinite(value) ? String(value) : NOT_REPORTED);

export const projectKey = (projectId) => `p:${projectId}`;
export const taskKey = (projectId, taskId) => `t:${projectId}\u0000${taskId}`;
export const projectIdOfTaskKey = (key) => key.slice(2).split('\u0000')[0];

/**
 * Orden del Core para `tasks_by_project` (docs/core/QUERIES.md): `created_at` descendente y, a
 * igualdad, `id` ascendente. Es el mismo orden del cursor por clave, así que las páginas acumuladas
 * quedan en el orden en que el Core las entrega.
 */
export const byCoreTaskOrder = (a, b) => (b.created_at - a.created_at)
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export const EMPTY_PAGE = Object.freeze({
  items: [], nextCursor: null, hasMore: false, pageCount: 0, loading: false, stale: false, preserved: false, error: null, notice: null,
});
export const EMPTY_PROJECT_IDS = Object.freeze([]);
export const emptyPageState = (key) => ({ ...EMPTY_PAGE, key });
export const uniqueTasksById = (tasks) => {
  const seen = new Map();
  for (const task of tasks) {
    if (!seen.has(task.id)) seen.set(task.id, task);
  }
  return [...seen.values()];
};

export function describeCoreError(error) {
  if (/(_unavailable|degraded|almac[eé]n.*no disponible)/i.test(error)) return 'Core no tiene un almacén autoritativo disponible.';
  if (/(_auth_required|authentication|unauthorized)/i.test(error)) return 'Core no pudo autenticar esta lectura.';
  if (/(_invalid_cursor)/i.test(error)) return 'El cursor de paginación ya no es válido para este Core.';
  if (/(_invalid_request)/i.test(error)) return 'Core rechazó los parámetros de esta consulta.';
  if (/(_project_not_found)/i.test(error)) return 'El Project ya no existe en el registro del Core.';
  if (/(_not_found)/i.test(error)) return 'El Project o la Task ya no está disponible con ese ID.';
  if (/(_read_failed|_internal)/i.test(error)) return 'Core no pudo leer este dato.';
  if (/(disconnected|connection|transport|timeout|ipc.*closed)/i.test(error)) return 'No se pudo completar la conexión con Core.';
  return 'Core devolvió un error al leer este dato.';
}

export const errorTitle = (status) => (status === 'disconnected' ? 'Core desconectado' : status === 'degraded' ? 'Core degradado' : 'Error de Core');

export const failureStatuses = new Set(['stale', 'disconnected', 'degraded', 'error']);

/** Resumen de la Attention que publica el Core para un Project; `total` es el dato autoritativo. */
export function attentionSummary(attention) {
  if (!attention || !Number.isFinite(attention.total)) return { total: null, detail: null };
  const entries = ATTENTION_CATEGORIES
    .map((category) => [category, attention.by_category?.[category]])
    .filter(([, count]) => Number.isFinite(count) && count > 0);
  return {
    total: attention.total,
    detail: entries.length ? entries.map(([category, count]) => `${ATTENTION_CATEGORY_LABELS[category] || category} ${count}`).join(' · ') : null,
  };
}

/** Ubicación primaria del Project: metadato de provenance, nunca la identidad. */
export function primaryLocation(project) {
  const locations = Array.isArray(project?.locations) ? project.locations : [];
  return locations.find((location) => location?.primary) ?? locations[0] ?? null;
}

/**
 * @typedef {object} ProjectSummary
 * @property {string} projectId ID durable del Project; es la identidad.
 * @property {string} name Nombre visible (o el ID si el Core no lo informa).
 * @property {'active'|'archived'|null} state Estado del registro, no el estado del trabajo.
 * @property {'failed'|'attention'|'active'|'idle'|null} status Estado agregado de `projects_overview`.
 * @property {{tasks: number|null, active: number|null, failed: number|null}} taskCounts Contadores del Core; `null` si faltan.
 * @property {number|null} attentionTotal Solo `counts.attention.total`; `null` si el Core no lo informa.
 * @property {string|null} host `locations[].machine` de la ubicación primaria; metadato.
 * @property {string|null} origin `locations[].path` de la ubicación primaria; metadato.
 */

/** Payload estable de selección de Project que recibe `onSelectProject`. */
export function toProjectSummary(project) {
  const location = primaryLocation(project);
  const counts = project?.counts ?? {};
  const attention = attentionSummary(counts.attention);
  return {
    projectId: project.id,
    name: project.name || project.id,
    state: project.state ?? null,
    status: project.status ?? null,
    taskCounts: {
      tasks: Number.isFinite(counts.tasks) ? counts.tasks : null,
      active: Number.isFinite(counts.active) ? counts.active : null,
      failed: Number.isFinite(counts.failed) ? counts.failed : null,
    },
    attentionTotal: attention.total,
    host: asText(location?.machine),
    origin: asText(location?.path),
  };
}

export function toProjectViewSummary(project) {
  if (!project) return null;
  const summary = { id: project.id, projectId: project.id };
  for (const field of ['name', 'state', 'status', 'counts', 'locations']) {
    if (Object.hasOwn(project, field)) summary[field] = project[field];
  }
  return summary;
}

export function selectedProjectQueryState(overview, project, projectId) {
  // `idle` es una consulta sin habilitar (sección inactiva), no una carga pendiente: no se disfraza de `loading`.
  if (overview.status === 'idle') return 'idle';
  if (overview.status === 'loading') return 'loading';
  if (overview.status === 'refreshing') return 'refreshing';
  if (overview.status === 'stale') return 'stale';
  if (['error', 'disconnected', 'degraded'].includes(overview.status)) return overview.status;
  if (overview.status === 'empty') return projectId ? 'missing' : 'empty';
  if (overview.status === 'ready') {
    return project && project.id === projectId ? 'ready' : projectId ? 'missing' : 'unknown';
  }
  return 'unknown';
}

/** @typedef {{id: string, projectId: string, name?: string, state?: string, status?: string, counts?: object, locations?: object[]}} ProjectViewSummary */

/**
 * @typedef {object} TaskSummary
 * @property {string} taskId ID durable de la Task; es la identidad.
 * @property {string} projectId ID durable del Project al que pertenece.
 * @property {string} status Uno de los ocho estados reales de `Task.status`; nunca se infiere.
 * @property {string} title Título visible (o el ID si el Core no lo informa).
 * @property {string|null} provider `Task.provider`; metadato.
 * @property {string|null} model `Task.model`; metadato.
 * @property {string|null} runId `Task.run_id`; metadato.
 * @property {string|null} parentId `Task.parent_id`; metadato.
 * @property {string|null} rootId `Task.root_id`; metadato.
 * @property {number|null} createdAt `Task.created_at` (ms epoch).
 * @property {number|null} updatedAt `Task.updated_at` (ms epoch).
 * @property {string|null} branch `Task.branch`; metadato, normalmente `null` en la lista.
 * @property {string|null} worktree `Task.worktree`; metadato, normalmente `null` en la lista.
 */

/** Payload estable de selección de Task que recibe `onSelectTask`. */
export function toTaskSummary(task, projectId) {
  return {
    taskId: task.id,
    projectId,
    status: task.status,
    title: task.title || task.id,
    provider: asText(task.provider),
    model: asText(task.model),
    runId: asText(task.run_id),
    parentId: asText(task.parent_id),
    rootId: asText(task.root_id),
    createdAt: Number.isFinite(task.created_at) ? task.created_at : null,
    updatedAt: Number.isFinite(task.updated_at) ? task.updated_at : null,
    branch: asText(task.branch),
    worktree: asText(task.worktree),
  };
}

export function Feedback({ state, subject, onRetry }) {
  const retry = (event) => {
    onRetry?.(event);
    state.retry();
  };
  if (state.status === 'idle' || state.status === 'ready' || state.status === 'refreshing') return null;
  if (state.status === 'loading') return <div className="ps__state" role="status">Conectando con Core para cargar {subject}…</div>;
  if (state.status === 'empty') return null;
  if (state.status === 'stale') {
    return (
      <div className="ps__state ps__state--stale" role="status">
        <span>Datos desactualizados ({state.reason === 'disconnected' ? 'Core desconectado' : state.reason === 'degraded' ? 'Core degradado' : 'Core con error'}). Se conserva la última respuesta. {describeCoreError(state.error)}</span>
        <code>{state.error}</code>
        <button
          type="button"
          className="lk"
          onClick={retry}
          aria-label={`Reintentar lectura de ${subject}`}
        >Reintentar lectura</button>
      </div>
    );
  }
  return (
    <div className="ps__state ps__state--error" role="alert">
      <strong>{errorTitle(state.status)}</strong>
      <span>{describeCoreError(state.error)}</span>
      <code>{state.error}</code>
      <button
        type="button"
        className="lk"
        onClick={retry}
        aria-label={`Reintentar lectura de ${subject}`}
      >Reintentar lectura</button>
    </div>
  );
}

