import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ATTENTION_CATEGORIES, TASK_PAGE_LIMIT, listAdeTasks } from './coreQueries';
import { useCoreQuery } from './useCoreQuery';
import './ProjectsSidebar.css';

/**
 * Sidebar F2 de Projects → Tasks (LXO-97), solo lectura y aislada del shell: consulta únicamente
 * `projects_overview` (LXO-90) y `tasks_by_project` (LXO-91) por el límite autenticado de Desktop.
 *
 * Invariantes del contrato:
 * - Identidad durable: cada fila se identifica y se selecciona por `id`, nunca por ruta ni etiqueta.
 * - Estado ≠ Attention ≠ unread: el estado sale de `Task.status` / `Project.status`, la Attention del
 *   badge sale **solo** de `counts.attention` de `projects_overview`, y no hay unread porque no existe
 *   una fuente autoritativa separada (LXO-87/89: unread vive en la vista Activity, que aún no existe).
 * - Host/origin/branch/worktree son metadato de provenance: informan, no agrupan ni identifican;
 *   rama y worktree ausentes en la lista se indican como «Solo en detalle».
 * - Las Tasks finalizadas son descubribles con el filtro explícito `active`/`final`/`all`; la vista
 *   «Activas» lo indica en pantalla en vez de ocultarlas en silencio.
 * - Las actualizaciones en segundo plano no roban el foco ni cambian la selección ni la expansión.
 * - Solo lee: no crea, no reintenta Tasks, no muta, no pagina por offset y no marca nada como leído.
 */

/**
 * Etiquetas de los ocho estados reales de Task (LXO-91). El Core no devuelve textos ni tiene un
 * estado `review`: la revisión se representa aparte como Attention `review_ready`, nunca como status.
 */
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

/** Estados finales del contrato (LXO-91): nunca se presentan como activos. */
const FINAL_TASK_STATUSES = new Set(['done', 'failed', 'stopped', 'exited']);

/**
 * Tono visual de cada estado real. No agrupa estados ni sustituye la etiqueta: solo elige el color
 * del badge para que `active`, `waiting`, `failed` y `final` se distingan de un vistazo.
 */
const TASK_STATUS_TONES = Object.freeze({
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
const ALL_TASKS_VIEW = TASK_STATUS_VIEWS.find((view) => view.code === 'all');

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

const asText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);
const metaValue = (value) => asText(value) ?? NOT_REPORTED;
const countValue = (value) => (Number.isFinite(value) ? String(value) : NOT_REPORTED);

const projectKey = (projectId) => `p:${projectId}`;
const taskKey = (projectId, taskId) => `t:${projectId}\u0000${taskId}`;
const projectIdOfTaskKey = (key) => key.slice(2).split('\u0000')[0];

/** Orden del contrato LXO-91: `created_at` descendente y, a igualdad, `id` descendente. */
const byCoreTaskOrder = (a, b) => (b.created_at - a.created_at)
  || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

const EMPTY_PAGE = Object.freeze({
  items: [], nextCursor: null, hasMore: false, pageCount: 0, loading: false, stale: false, error: null, notice: null,
});
const EMPTY_PROJECT_IDS = Object.freeze([]);
const emptyPageState = (key) => ({ ...EMPTY_PAGE, key });
const uniqueTasksById = (tasks) => {
  const seen = new Map();
  for (const task of tasks) {
    if (!seen.has(task.id)) seen.set(task.id, task);
  }
  return [...seen.values()];
};

function describeCoreError(error) {
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

const errorTitle = (status) => (status === 'disconnected' ? 'Core desconectado' : status === 'degraded' ? 'Core degradado' : 'Error de Core');

const failureStatuses = new Set(['stale', 'disconnected', 'degraded', 'error']);

/** Resumen de la Attention que publica el Core para un Project; `total` es el dato autoritativo. */
function attentionSummary(attention) {
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
function primaryLocation(project) {
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

function toProjectViewSummary(project) {
  if (!project) return null;
  const summary = { id: project.id, projectId: project.id };
  for (const field of ['name', 'state', 'status', 'counts', 'locations']) {
    if (Object.hasOwn(project, field)) summary[field] = project[field];
  }
  return summary;
}

function selectedProjectQueryState(overview, project, projectId) {
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

function Feedback({ state, subject, onRetry }) {
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

function TaskRow({ project, task, selected, stale, position, setSize, isActiveKey, registerRef, onKeyDown, onFocus, onActivate }) {
  const metaId = useId();
  const key = taskKey(project.id, task.id);
  const statusLabel = TASK_STATUS_LABELS[task.status] || task.status;
  const isFinal = FINAL_TASK_STATUSES.has(task.status);
  const tone = TASK_STATUS_TONES[task.status] || 'unknown';
  return (
    <li
      role="treeitem"
      aria-level={2}
      aria-posinset={position}
      aria-setsize={setSize}
      aria-selected={selected}
      aria-label={`${stale ? 'Datos desactualizados. ' : ''}${task.title || task.id}. ${statusLabel}`}
      aria-describedby={metaId}
      data-task-id={task.id}
      data-project-id={project.id}
      data-status={task.status}
      data-final={isFinal ? 'true' : 'false'}
      tabIndex={isActiveKey ? 0 : -1}
      ref={registerRef(key)}
      className={`ps__item ps__item--task${selected ? ' is-selected' : ''}${isFinal ? ' is-final' : ''}${stale ? ' is-stale' : ''}`}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocus();
      }}
      onKeyDown={(event) => {
        // El teclado de un control anidado es suyo; solo la fila enfocada navega el árbol.
        if (event.target !== event.currentTarget) return;
        event.stopPropagation();
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate(project, task);
          return;
        }
        onKeyDown(event, key);
      }}
      onClick={(event) => {
        event.stopPropagation();
        onActivate(project, task);
      }}
    >
      <span className="ps__line">
        <span
          className={`ps__badge ps__badge--task ps__badge--${tone}${isFinal ? ' ps__badge--final' : ''}`}
          data-status={task.status}
        >
          {statusLabel}
        </span>
        {stale && <span className="ps__badge ps__badge--stale">Datos previos</span>}
        <span className="ps__name">{task.title || task.id}</span>
        <span className="ps__id mono">{task.id}</span>
      </span>
      <span className="ps__meta" id={metaId}>
        <span>Proveedor {metaValue(task.provider)}</span>
        <span>Modelo {metaValue(task.model)}</span>
        <span>Rama {asText(task.branch) ?? 'Solo en detalle'}</span>
        <span>Worktree {asText(task.worktree) ?? 'Solo en detalle'}</span>
      </span>
    </li>
  );
}

function ProjectRow({ project, expanded, selected, context, position, setSize, isActiveKey, registerRef, onKeyDown, onFocus, onActivate, children }) {
  const metaId = useId();
  const key = projectKey(project.id);
  const statusLabel = PROJECT_STATUS_LABELS[project.status] || project.status || 'Sin estado agregado';
  const location = primaryLocation(project);
  const counts = project.counts ?? {};
  const attention = attentionSummary(counts.attention);
  const accessibleName = [
    project.name || project.id,
    `Project ${project.id}`,
    `Estado ${statusLabel}`,
    attention.total !== null ? `Attention ${attention.total}` : null,
  ].filter(Boolean).join('. ');
  return (
    <li
      role="treeitem"
      aria-level={1}
      aria-posinset={position}
      aria-setsize={setSize}
      aria-expanded={expanded}
      aria-selected={selected}
      aria-label={accessibleName}
      aria-describedby={metaId}
      data-project-id={project.id}
      data-status={project.status ?? ''}
      tabIndex={isActiveKey ? 0 : -1}
      ref={registerRef(key)}
      className={`ps__item ps__item--project${selected ? ' is-selected' : ''}${context ? ' is-context' : ''}${expanded ? ' is-expanded' : ''}`}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onFocus();
      }}
      onKeyDown={(event) => {
        // Enter/Espacio en «Cargar más» o «Reintentar lectura» pertenecen al botón, no a la fila.
        if (event.target !== event.currentTarget) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onActivate(project);
          return;
        }
        onKeyDown(event, key);
      }}
      onClick={(event) => {
        // Los controles anidados (Cargar más, Reintentar lectura) no activan la fila del Project.
        if (event.target.closest?.('button, input, select, textarea, a')) return;
        // La tarjeta del Project (nombre, metadatos y su espacio libre) es un único target.
        // El contenido de Tasks, estados y avisos anidados conserva su propia interacción.
        if (event.target.closest?.('.ps__tasks, .ps__state, .ps__empty, .ps__item--task')) return;
        onActivate(project);
      }}
    >
      <span className="ps__line">
        <span className="ps__chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        <span className="ps__name">{project.name || project.id}</span>
        <span className="ps__id mono">{project.id}</span>
      </span>
      <span className="ps__meta" id={metaId}>
        <span
          className={`ps__badge ps__badge--status${project.status ? ` ps__badge--status-${project.status}` : ''}`}
          data-testid={`project-status-${project.id}`}
          data-status={project.status ?? ''}
          title="Estado agregado del Project según projects_overview"
        >
          {statusLabel}
        </span>
        {attention.total !== null && attention.total > 0 && (
          <span
            className="ps__badge ps__badge--attention"
            data-testid={`project-attention-${project.id}`}
            data-attention-total={attention.total}
            title={attention.detail ? `Attention activa del Core: ${attention.detail}` : 'Attention activa del Core'}
          >
            Attention {attention.total}
          </span>
        )}
        <span>Tasks {countValue(counts.tasks)}</span>
        <span title="Tasks no finales según counts.active">Tasks activas {countValue(counts.active)}</span>
        <span title="Tasks en estado failed según counts.failed; no es la Attention">Tasks fallidas {countValue(counts.failed)}</span>
        <span>Host {metaValue(location?.machine)}</span>
        <span>Origen {metaValue(location?.path)}</span>
      </span>
      {children}
    </li>
  );
}

/**
 * Página de Tasks de un Project expandido. Monta su propia query `tasks_by_project` (lazy: solo
 * existe mientras el Project está expandido) y acumula páginas por `next_cursor` opaco.
 */
function ProjectTasks({
  project,
  statusView,
  active,
  pollMs,
  onVisibleTasks,
  registerRef,
  effectiveActiveKey,
  selectedTaskId,
  selectedTaskProjectId,
  pendingTaskId,
  confirmedMissingTaskId,
  onTaskLookupComplete,
  onKeyDown,
  onFocusKey,
  focusItem,
  onActivateTask,
}) {
  const projectId = project.id;
  const projectName = project.name || projectId;
  const pageKey = `${projectId}\u0000${statusView.code}`;
  const head = useCoreQuery('tasks_by_project', {
    project_id: projectId,
    status: statusView.code,
    limit: TASK_PAGE_LIMIT,
  }, { enabled: active, pollMs });
  const [pages, setPages] = useState(() => emptyPageState(pageKey));
  const pageRequestRef = useRef(null);
  const pageRequestSequence = useRef(0);
  const pagingFocusRef = useRef(false);
  const pageRetryFocusRef = useRef(false);
  const pagingRequestActiveRef = useRef(false);
  const loadMoreButtonRef = useRef(null);
  const pageRetryButtonRef = useRef(null);
  const pendingTaskIdRef = useRef(pendingTaskId);
  const previousPendingTaskIdRef = useRef(pendingTaskId);
  pendingTaskIdRef.current = pendingTaskId;
  const headFailed = failureStatuses.has(head.status);
  const headFailedRef = useRef(headFailed);
  headFailedRef.current = headFailed;
  const latestHeadUpdatedAtRef = useRef(head.updatedAt);
  latestHeadUpdatedAtRef.current = head.updatedAt;

  useEffect(() => {
    const clearPagingFocusOnOtherTarget = (event) => {
      if (
        event.target !== loadMoreButtonRef.current
        && event.target !== pageRetryButtonRef.current
        && event.target !== document.body
      ) {
        pagingFocusRef.current = false;
        pageRetryFocusRef.current = false;
      }
    };
    document.addEventListener('focusin', clearPagingFocusOnOtherTarget);
    return () => document.removeEventListener('focusin', clearPagingFocusOnOtherTarget);
  }, []);

  // Un filtro de estado nuevo empieza en la primera página: los cursores son de una sola consulta.
  useEffect(() => {
    pageRequestRef.current = null;
    setPages(emptyPageState(pageKey));
    return () => {
      if (pageRequestRef.current?.key === pageKey) pageRequestRef.current = null;
    };
  }, [pageKey]);

  // Selection-driven paging belongs to the selected durable ID. A new target or a manual filter
  // change must stop the old lookup even if its Core read is already in flight.
  useEffect(() => {
    if (previousPendingTaskIdRef.current === pendingTaskId) return;
    previousPendingTaskIdRef.current = pendingTaskId;
    const request = pageRequestRef.current;
    if (request?.kind !== 'auto') return;
    pageRequestRef.current = null;
    setPages((current) => (current.key !== request.key || !current.loading
      ? current
      : { ...current, loading: false }));
  }, [pendingTaskId]);

  // Si la cabecera falla, no se encadenan sus cursores; conserva las páginas ya cargadas como stale.
  useEffect(() => {
    if (!headFailed) return;
    pageRequestRef.current = null;
    setPages((current) => {
      if (current.key !== pageKey) return current;
      if (current.items.length === 0 && current.pageCount === 0) {
        return current.loading ? { ...current, loading: false } : current;
      }
      return { ...current, loading: false, stale: true };
    });
  }, [headFailed, pageKey]);

  // Nunca se leen páginas de otro filtro; las de la última cabecera siguen visibles como stale.
  const currentPages = pages.key === pageKey ? pages : EMPTY_PAGE;
  const headTasks = head.data?.tasks ?? [];
  const headTaskIds = useMemo(() => new Set(headTasks.map((task) => task.id)), [headTasks]);
  const tasks = useMemo(() => {
    return uniqueTasksById([...headTasks, ...currentPages.items]).sort(byCoreTaskOrder);
  }, [headTasks, currentPages.items]);
  const staleTaskIds = useMemo(() => new Set(
    (currentPages.stale || headFailed)
      ? currentPages.items.filter((task) => !headTaskIds.has(task.id)).map((task) => task.id)
      : [],
  ), [currentPages.items, currentPages.stale, headFailed, headTaskIds]);

  const taskIdSignature = tasks.map((task) => task.id).join('\u0000');
  // Una lectura fallida sin datos no demuestra la ausencia de la Task: no cuenta como asentada.
  const tasksSettled = Boolean(head.data);
  useEffect(() => {
    onVisibleTasks(projectId, taskIdSignature ? taskIdSignature.split('\u0000') : [], tasksSettled, statusView.code);
    return () => onVisibleTasks(projectId, [], false, statusView.code);
  }, [projectId, taskIdSignature, tasksSettled, onVisibleTasks, statusView.code]);

  const headCursor = head.data?.has_more ? head.data.next_cursor : null;
  const moreCursor = currentPages.pageCount > 0 ? currentPages.nextCursor : headCursor;
  // Una página extra se leyó por separado; tras refrescar la cabecera, se vuelve a leer cada cursor
  // ya cargado desde el cursor nuevo. Core no publica una instantánea común para ambas consultas.
  const reconcileLoadedPages = useCallback(async (loadedPageCount, expectedHeadUpdatedAt = head.updatedAt) => {
    if (loadedPageCount <= 0 || headFailedRef.current || !head.data || expectedHeadUpdatedAt == null) return;
    const requestedKey = pageKey;
    const request = {
      id: ++pageRequestSequence.current,
      key: requestedKey,
      headUpdatedAt: expectedHeadUpdatedAt,
      kind: 'reconcile',
    };
    pageRequestRef.current = request;
    pagingRequestActiveRef.current = true;
    setPages((current) => (current.key !== requestedKey ? current : {
      ...current,
      loading: true,
      stale: true,
      error: null,
      notice: null,
    }));

    let cursor = head.data.has_more ? head.data.next_cursor : null;
    let items = [];
    let pagesLoaded = 0;
    let nextCursor = null;
    let hasMore = false;
    const isCurrentRequest = () => pageRequestRef.current === request
      && !headFailedRef.current
      && latestHeadUpdatedAtRef.current === request.headUpdatedAt;

    try {
      while (cursor && pagesLoaded < loadedPageCount) {
        const page = await listAdeTasks(projectId, { status: statusView.code, cursor });
        if (!isCurrentRequest()) return;
        items = uniqueTasksById([...items, ...page.tasks]);
        pagesLoaded += 1;
        nextCursor = page.next_cursor;
        hasMore = page.has_more;
        cursor = page.has_more ? page.next_cursor : null;
      }
      if (!isCurrentRequest()) return;
      setPages((current) => (current.key !== requestedKey ? current : {
        ...current,
        items,
        pageCount: pagesLoaded,
        nextCursor,
        hasMore,
        loading: false,
        stale: false,
        error: null,
        notice: null,
      }));
    } catch (error) {
      if (!isCurrentRequest()) return;
      const message = error instanceof Error ? error.message : String(error ?? 'Error desconocido del Core');
      if (/tasks_invalid_cursor/.test(message)) head.retry();
      setPages((current) => (current.key !== requestedKey ? current : {
        ...current,
        loading: false,
        stale: true,
        error: message,
      }));
    } finally {
      if (pageRequestRef.current === request) {
        pageRequestRef.current = null;
        setPages((current) => (current.key !== requestedKey || !current.loading
          ? current
          : { ...current, loading: false }));
      }
    }
  }, [head.data, head.retry, head.updatedAt, pageKey, projectId, statusView.code]);

  // Si la cabecera cambia, las páginas ya cargadas se marcan desactualizadas de inmediato y se
  // reconcilian recorriendo de nuevo el mismo número de páginas desde el cursor recién publicado.
  const headVersionObservedRef = useRef({ key: pageKey, updatedAt: head.updatedAt ?? null });
  useLayoutEffect(() => {
    if (headFailed || head.updatedAt == null) return;
    const previous = headVersionObservedRef.current;
    headVersionObservedRef.current = { key: pageKey, updatedAt: head.updatedAt };
    if (previous.key !== pageKey || previous.updatedAt == null || previous.updatedAt === head.updatedAt) return;

    if (pageRequestRef.current?.key === pageKey) pageRequestRef.current = null;
    const loadedPageCount = pages.key === pageKey ? pages.pageCount : 0;
    if (loadedPageCount > 0) {
      void reconcileLoadedPages(loadedPageCount, head.updatedAt);
      return;
    }
    setPages((current) => (current.key !== pageKey || !current.loading
      ? current
      : { ...current, loading: false, error: null }));
  }, [head.updatedAt, headFailed, pageKey, pages.key, pages.pageCount, reconcileLoadedPages]);

  // Con una cabecera stale/desconectada no se encadenan cursores de otra versión del Core.
  const canLoadMore = !headFailed
    && !currentPages.stale
    && (currentPages.pageCount > 0 ? currentPages.hasMore : Boolean(headCursor));

  const hasData = Boolean(head.data);
  const hasMoreTasks = currentPages.pageCount > 0
    ? currentPages.hasMore
    : Boolean(head.data?.has_more);
  const taskSetSize = (headFailed || currentPages.stale || hasMoreTasks) ? -1 : tasks.length;
  const allStatusReadComplete = statusView.code === 'all'
    && hasData
    && !headFailed
    && head.status !== 'refreshing'
    && !currentPages.stale
    && !currentPages.loading
    && !currentPages.error
    && !hasMoreTasks;

  const loadMore = useCallback(async ({ automatic = false, retry = false } = {}) => {
    if (pageRequestRef.current || !moreCursor || currentPages.stale) return;
    if (automatic && !pendingTaskId) return;
    if (retry && document.activeElement === pageRetryButtonRef.current) {
      pageRetryFocusRef.current = true;
      pagingFocusRef.current = true;
    } else if (!automatic && (document.activeElement === loadMoreButtonRef.current || document.activeElement === pageRetryButtonRef.current)) {
      pagingFocusRef.current = true;
    }
    const requestedKey = pageKey;
    const request = {
      id: ++pageRequestSequence.current,
      key: requestedKey,
      headUpdatedAt: head.updatedAt,
      kind: automatic ? 'auto' : retry ? 'retry' : 'more',
      pendingTaskId: automatic ? pendingTaskId : null,
    };
    pageRequestRef.current = request;
    pagingRequestActiveRef.current = true;
    setPages((current) => ({ ...current, loading: true, error: null, notice: null }));
    const isCurrentRequest = () => pageRequestRef.current === request
      && !headFailedRef.current
      && latestHeadUpdatedAtRef.current === request.headUpdatedAt
      && (!automatic || pendingTaskIdRef.current === request.pendingTaskId);
    try {
      const page = await listAdeTasks(projectId, { status: statusView.code, cursor: moreCursor });
      if (!isCurrentRequest()) return;
      setPages((current) => (current.key !== requestedKey ? current : {
        ...current,
        items: uniqueTasksById([...current.items, ...page.tasks]),
        pageCount: current.pageCount + 1,
        nextCursor: page.next_cursor,
        hasMore: page.has_more,
        loading: false,
        stale: false,
        error: null,
      }));
    } catch (error) {
      if (!isCurrentRequest()) return;
      const message = error instanceof Error ? error.message : String(error ?? 'Error desconocido del Core');
      if (/tasks_invalid_cursor/.test(message)) {
        // El Core rotó su clave (reinicio): se vuelve a la primera página, sin duplicar.
        setPages((current) => (current.key !== requestedKey ? current : {
          ...emptyPageState(requestedKey),
          notice: 'El Core se reinició y el cursor caducó: se volvió a la primera página.',
        }));
        head.retry();
      } else {
        setPages((current) => (current.key !== requestedKey ? current : { ...current, loading: false, error: message }));
      }
    } finally {
      if (pageRequestRef.current === request) {
        pageRequestRef.current = null;
        setPages((current) => (current.key !== requestedKey || !current.loading
          ? current
          : { ...current, loading: false }));
      }
    }
  }, [currentPages.stale, head.retry, head.updatedAt, moreCursor, pageKey, pendingTaskId, projectId, statusView.code]);

  useEffect(() => {
    if (
      !pendingTaskId
      || statusView.code !== 'all'
      || tasks.some((task) => task.id === pendingTaskId)
      || !canLoadMore
      || currentPages.loading
      || currentPages.stale
      || currentPages.error
      || head.status === 'refreshing'
    ) return;
    void loadMore({ automatic: true });
  }, [
    canLoadMore,
    currentPages.error,
    currentPages.loading,
    currentPages.stale,
    head.status,
    loadMore,
    pendingTaskId,
    statusView.code,
    tasks,
  ]);

  useEffect(() => {
    if (!pendingTaskId || tasks.some((task) => task.id === pendingTaskId) || !allStatusReadComplete) return;
    onTaskLookupComplete(projectId, pendingTaskId);
  }, [allStatusReadComplete, onTaskLookupComplete, pendingTaskId, projectId, tasks]);

  useLayoutEffect(() => {
    if (currentPages.loading) return;
    if (!pagingFocusRef.current) {
      pagingRequestActiveRef.current = false;
      return;
    }

    if (pageRetryFocusRef.current) {
      pageRetryFocusRef.current = false;
      pagingRequestActiveRef.current = false;
      if (currentPages.error && pageRetryButtonRef.current?.isConnected) {
        pageRetryButtonRef.current.focus();
        return;
      }
      pagingFocusRef.current = false;
      const lastTask = tasks.at(-1);
      const fallbackKey = lastTask ? taskKey(projectId, lastTask.id) : projectKey(projectId);
      onFocusKey(fallbackKey);
      focusItem(fallbackKey);
      return;
    }

    const button = loadMoreButtonRef.current;
    const activeElement = document.activeElement;
    const focusIsVacant = activeElement === document.body || !activeElement?.isConnected;
    if (button?.isConnected && !button.disabled) {
      if (focusIsVacant) button.focus();
      else if (activeElement !== button) pagingFocusRef.current = false;
      pagingRequestActiveRef.current = false;
      return;
    }
    if (!focusIsVacant) {
      pagingFocusRef.current = false;
      pagingRequestActiveRef.current = false;
      return;
    }

    pagingFocusRef.current = false;
    pagingRequestActiveRef.current = false;
    const lastTask = tasks.at(-1);
    const fallbackKey = lastTask ? taskKey(projectId, lastTask.id) : projectKey(projectId);
    onFocusKey(fallbackKey);
    focusItem(fallbackKey);
  }, [canLoadMore, currentPages.loading, focusItem, onFocusKey, projectId, taskIdSignature]);

  const isActiveKey = (key) => key === effectiveActiveKey;

  return (
    <>
      <Feedback
        state={head}
        subject={`las Tasks de ${projectName}`}
        onRetry={(event) => {
          if (event.currentTarget === document.activeElement) focusItem(projectKey(projectId));
        }}
      />

      {currentPages.stale && (
        <div className="ps__state ps__state--stale" role="status" data-testid={`stale-task-pages-${projectId}`}>
          <span>
            {headFailed
              ? `Core no confirmó la cabecera de Tasks de ${projectName}. Se conservan las páginas adicionales de la última lectura correcta y pueden estar desactualizadas.`
              : `La primera página de ${projectName} se actualizó. Las páginas adicionales provienen de lecturas independientes anteriores y pueden tener estados o títulos desactualizados.`}
          </span>
          {currentPages.loading && <span>Actualizando las páginas cargadas de {projectName}…</span>}
          {currentPages.error && (
            <>
              <span>No se pudieron actualizar las páginas adicionales. {describeCoreError(currentPages.error)}</span>
              <code>{currentPages.error}</code>
            </>
          )}
        </div>
      )}

      {tasks.length > 0 && (
        <ul
          className="ps__tasks"
          role="group"
          aria-label={`Tasks de ${project.name || projectId} · ${statusView.label}`}
          aria-busy={currentPages.loading || head.status === 'refreshing'}
        >
          {tasks.map((task, index) => {
            const key = taskKey(projectId, task.id);
            return (
              <TaskRow
                key={task.id}
                project={project}
                task={task}
                selected={task.id === selectedTaskId && selectedTaskProjectId === projectId}
                stale={staleTaskIds.has(task.id)}
                position={index + 1}
                setSize={taskSetSize}
                isActiveKey={isActiveKey(key)}
                registerRef={registerRef}
                onKeyDown={onKeyDown}
                onFocus={() => onFocusKey(key)}
                onActivate={onActivateTask}
              />
            );
          })}
        </ul>
      )}

      {hasData && tasks.length === 0 && (
        <div className="ps__empty" role="status">
          {statusView.empty}
          {statusView.code !== 'all' && ' Cambia el filtro para descubrir otras Tasks de este Project.'}
        </div>
      )}

      {confirmedMissingTaskId && (
        <div className="ps__state ps__state--muted" role="status" data-testid="selected-task-missing">
          La Task seleccionada ({confirmedMissingTaskId}) no aparece en ninguna página de este Project según la lectura completa de Tasks del Core.
        </div>
      )}

      {(canLoadMore || (currentPages.stale && !headFailed)) && (
        <button
          ref={loadMoreButtonRef}
          type="button"
          className="lk ps__more"
          onFocus={() => { pagingFocusRef.current = true; }}
          onBlur={(event) => {
            const nextTarget = event.relatedTarget;
            if (
              nextTarget
              && nextTarget !== document.body
              && nextTarget !== loadMoreButtonRef.current
              && nextTarget !== pageRetryButtonRef.current
            ) {
              pagingFocusRef.current = false;
            } else if (!pagingRequestActiveRef.current) {
              pagingFocusRef.current = false;
            }
          }}
          onClick={currentPages.stale
            ? () => reconcileLoadedPages(currentPages.pageCount, head.updatedAt)
            : () => loadMore()}
          disabled={currentPages.loading}
          aria-busy={currentPages.loading}
          aria-label={currentPages.stale
            ? (currentPages.loading
              ? `Actualizando páginas de Tasks de ${projectName}`
              : `Reintentar actualización de páginas de Tasks de ${projectName}`)
            : (currentPages.loading
              ? `Cargando Tasks de ${projectName}`
              : `Cargar más Tasks de ${projectName}`)}
        >
          {currentPages.stale
            ? (currentPages.loading ? 'Actualizando páginas…' : 'Reintentar actualización')
            : (currentPages.loading ? 'Cargando…' : `Cargar más Tasks de ${projectName}`)}
        </button>
      )}

      {currentPages.notice && <div className="ps__state ps__state--muted" role="status">{currentPages.notice}</div>}

      {currentPages.error && !currentPages.stale && (
        <div className="ps__state ps__state--error" role="alert">
          <span>No se pudo cargar la siguiente página de Tasks. {describeCoreError(currentPages.error)}</span>
          <code>{currentPages.error}</code>
          <button
            ref={pageRetryButtonRef}
            type="button"
            className="lk"
            onFocus={() => { pagingFocusRef.current = true; }}
            onBlur={(event) => {
              const nextTarget = event.relatedTarget;
              if (
                nextTarget
                && nextTarget !== document.body
                && nextTarget !== loadMoreButtonRef.current
                && nextTarget !== pageRetryButtonRef.current
              ) {
                pagingFocusRef.current = false;
              } else if (!pagingRequestActiveRef.current) {
                pagingFocusRef.current = false;
              }
            }}
            onClick={() => loadMore({ retry: true })}
            aria-label={`Reintentar carga de Tasks de ${projectName}`}
          >Reintentar lectura</button>
        </div>
      )}
    </>
  );
}

/**
 * API pública (LXO-97). Componente aislado, solo lectura y sin dependencias del shell; el host lo
 * monta y conecta la selección con estos callbacks. No crea, reintenta ni muta nada.
 *
 * La expansión es estado interno no controlado. `initialExpandedProjectIds` solo se lee al montar;
 * para persistir, el host guarda los IDs que recibe por `onExpandedChange`. La selección también es
 * interna salvo que `selection` suministre los IDs durables actuales.
 *
 * @param {object} [props]
 * @param {boolean} [props.active=true] Si es `false`, la sección queda oculta e `inert` y no consulta el Core.
 * @param {'exclude'|'include'|'only'} [props.archived='exclude'] Filtro de archivo de `projects_overview`.
 * @param {number} [props.pollMs] Intervalo de refresco; por defecto el de `useCoreQuery` (15 s).
 * @param {string[]} [props.initialExpandedProjectIds=[]] Expansión inicial por ID durable; solo al montar.
 * @param {{projectId: string | null, taskId: string | null} | null} [props.selection]
 *   Selección durable controlada; si se omite, la selección es interna.
 * @param {(projectIds: string[]) => void} [props.onExpandedChange] Lista completa de IDs expandidos tras un cambio.
 * @param {(summary: ProjectSummary) => void} [props.onSelectProject] Se invoca al activar una fila de Project.
 * @param {(summary: TaskSummary | null, context?: {projectId: string, taskId: string | null}) => void} [props.onSelectTask]
 *   Se invoca al activar una Task; al cambiar a otro Project sin conservarla, con `null` y el contexto nuevo.
 * @param {(snapshot: {projectId: string|null, queryState: 'idle'|'loading'|'refreshing'|'ready'|'stale'|'error'|'disconnected'|'degraded'|'missing'|'empty'|'unknown', project: ProjectViewSummary|null, error: string|null}) => void} [props.onProjectSnapshot]
 *   Publica la metadata del Project que coincide con la selección controlada y el estado de su overview.
 * @param {(snapshot: {queryState: string, projectIds: string[], error: string|null}) => void} [props.onProjectsSnapshot]
 *   Publica los IDs de la lista de Projects junto con el estado de la lectura autoritativa del overview.
 * @returns {import('react').ReactElement}
 */
export function ProjectsSidebar({
  active = true,
  archived = 'exclude',
  pollMs,
  initialExpandedProjectIds,
  selection,
  onExpandedChange,
  onSelectProject,
  onSelectTask,
  onProjectSnapshot,
  onProjectsSnapshot,
}) {
  const headingId = useId();
  const statusFilterName = useId();
  const [statusView, setStatusView] = useState(TASK_STATUS_VIEWS[0]);
  const [expanded, setExpanded] = useState(() => new Set(initialExpandedProjectIds ?? []));
  const selectionControlled = selection !== undefined;
  const [uncontrolledSelection, setUncontrolledSelection] = useState({ projectId: null, taskId: null, taskProjectId: null });
  const selectedProjectId = typeof selection?.projectId === 'string' ? selection.projectId : null;
  const selectedTaskId = selectedProjectId && typeof selection?.taskId === 'string' ? selection.taskId : null;
  const selected = selectionControlled
    ? {
      projectId: selectedProjectId,
      taskId: selectedTaskId,
      taskProjectId: selectedTaskId ? selectedProjectId : null,
    }
    : uncontrolledSelection;
  const [taskIdsByProject, setTaskIdsByProject] = useState({});
  const [settledTaskStatusByProject, setSettledTaskStatusByProject] = useState({});
  const [pendingSelectionScroll, setPendingSelectionScroll] = useState(null);
  const [missingTaskSelection, setMissingTaskSelection] = useState(null);
  const [automaticFilterNotice, setAutomaticFilterNotice] = useState(null);
  const [selectionAnnouncement, setSelectionAnnouncement] = useState('');
  const [activeKey, setActiveKey] = useState(null);
  const itemRefs = useRef(new Map());
  const previousSelectionRef = useRef(null);
  const pendingSelectionAnnouncementRef = useRef(null);
  const pendingSelectionFilterCheckRef = useRef(null);
  const pendingSelectionScrollRef = useRef(null);
  const firstFilterInputRef = useRef(null);

  useEffect(() => {
    if (!selectionControlled || !selected.projectId) return;
    setExpanded((current) => {
      if (current.has(selected.projectId)) return current;
      const next = new Set(current);
      next.add(selected.projectId);
      return next;
    });
  }, [selectionControlled, selected.projectId, selected.taskId]);

  const overview = useCoreQuery('projects_overview', { archived }, { enabled: active, pollMs });
  const projects = overview.data?.projects ?? [];
  const projectIds = useMemo(() => overview.data?.projects.map((project) => project.id) ?? EMPTY_PROJECT_IDS, [overview.data]);

  const registerItem = useCallback((key) => (node) => {
    if (node) itemRefs.current.set(key, node);
    else itemRefs.current.delete(key);
  }, []);

  const onFocusKey = useCallback((key) => setActiveKey(key), []);

  const onVisibleTasks = useCallback((projectId, taskIds, settled, taskStatus) => {
    setTaskIdsByProject((current) => {
      const previous = current[projectId];
      if (previous && previous.length === taskIds.length && previous.every((id, index) => id === taskIds[index])) return current;
      return { ...current, [projectId]: taskIds };
    });
    setSettledTaskStatusByProject((current) => {
      const next = settled ? taskStatus : null;
      if (current[projectId] === next) return current;
      return { ...current, [projectId]: next };
    });
  }, []);

  const onTaskLookupComplete = useCallback((projectId, taskId) => {
    const pending = pendingSelectionScrollRef.current;
    if (pending?.projectId !== projectId || pending.taskId !== taskId) return;
    pendingSelectionScrollRef.current = null;
    setPendingSelectionScroll(null);
    setMissingTaskSelection({ projectId, taskId });
  }, []);

  const visibleKeys = useMemo(() => {
    const keys = [];
    for (const project of projects) {
      keys.push(projectKey(project.id));
      if (expanded.has(project.id)) {
        for (const taskId of taskIdsByProject[project.id] ?? []) keys.push(taskKey(project.id, taskId));
      }
    }
    return keys;
  }, [projects, expanded, taskIdsByProject]);

  // Solo una modificación de IDs controlados inicia scroll. La solicitud de Task sigue pendiente
  // hasta que aparece la fila o una lectura completa de todas las Tasks confirma su ausencia.
  useLayoutEffect(() => {
    const current = {
      controlled: selectionControlled,
      projectId: selected.projectId,
      taskId: selected.taskId,
    };
    const previous = previousSelectionRef.current;
    const changed = !previous
      || previous.controlled !== current.controlled
      || previous.projectId !== current.projectId
      || previous.taskId !== current.taskId;

    if (changed) {
      previousSelectionRef.current = current;
      pendingSelectionAnnouncementRef.current = current.controlled && current.projectId && current.taskId
        ? { projectId: current.projectId, taskId: current.taskId }
        : null;
      pendingSelectionFilterCheckRef.current = current.controlled && current.projectId && current.taskId && statusView.code !== 'all'
        ? { projectId: current.projectId, taskId: current.taskId, status: statusView.code }
        : null;
      setSelectionAnnouncement('');
      const nextPending = current.controlled && current.projectId
        ? {
          key: current.taskId ? taskKey(current.projectId, current.taskId) : projectKey(current.projectId),
          projectId: current.projectId,
          taskId: current.taskId,
        }
        : null;
      pendingSelectionScrollRef.current = nextPending;
      setPendingSelectionScroll(nextPending);
      setMissingTaskSelection(null);
      setAutomaticFilterNotice(null);
    }

    // Controlled selection can arrive before its lazy Task rows mount; wait for the page to settle
    // before deciding whether the current filter needs an automatic transition.
    const pendingFilterCheck = pendingSelectionFilterCheckRef.current;
    if (
      pendingFilterCheck?.projectId === current.projectId
      && pendingFilterCheck.taskId === current.taskId
      && pendingFilterCheck.status === statusView.code
      && current.controlled
      && settledTaskStatusByProject[current.projectId] === statusView.code
    ) {
      pendingSelectionFilterCheckRef.current = null;
      if (!itemRefs.current.has(taskKey(current.projectId, current.taskId))) {
        setStatusView(ALL_TASKS_VIEW);
        setAutomaticFilterNotice({ projectId: current.projectId, taskId: current.taskId });
      }
    }

    // Update the persistent status region only after the selected row exists in the tree.
    const pendingAnnouncement = pendingSelectionAnnouncementRef.current;
    if (
      pendingAnnouncement?.projectId === current.projectId
      && pendingAnnouncement.taskId === current.taskId
      && current.controlled
    ) {
      const taskNode = itemRefs.current.get(taskKey(current.projectId, current.taskId));
      if (taskNode) {
        const taskLabel = taskNode.getAttribute('aria-label') || current.taskId;
        pendingSelectionAnnouncementRef.current = null;
        setSelectionAnnouncement(`Task seleccionada: ${taskLabel}.`);
      }
    }

    let pending = pendingSelectionScrollRef.current;
    if (pending && overview.data && !projects.some((project) => project.id === pending.projectId)) {
      pendingSelectionScrollRef.current = null;
      setPendingSelectionScroll(null);
      pending = null;
    }
    const node = pending && itemRefs.current.get(pending.key);
    if (active && node) {
      node.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      pendingSelectionScrollRef.current = null;
      setPendingSelectionScroll(null);
    }
  }, [active, overview.data, projects, selectionControlled, selected.projectId, selected.taskId, settledTaskStatusByProject, statusView.code, visibleKeys]);

  const confirmedMissingTaskId = missingTaskSelection?.projectId === selected.projectId
    && missingTaskSelection.taskId === selected.taskId
    ? missingTaskSelection.taskId
    : null;

  useEffect(() => {
    if (
      confirmedMissingTaskId
      && (taskIdsByProject[selected.projectId] ?? []).includes(confirmedMissingTaskId)
    ) setMissingTaskSelection(null);
  }, [confirmedMissingTaskId, selected.projectId, taskIdsByProject]);

  // Clave con foco de teclado (roving tabindex). Si su fila desaparece, se degrada a la fila más
  // cercana sin llamar a `focus()`: una actualización en segundo plano nunca mueve el foco.
  const effectiveActiveKey = useMemo(() => {
    if (activeKey && visibleKeys.includes(activeKey)) return activeKey;
    if (activeKey?.startsWith('t:')) {
      const parentKey = projectKey(projectIdOfTaskKey(activeKey));
      if (visibleKeys.includes(parentKey)) return parentKey;
    }
    return visibleKeys[0] ?? null;
  }, [activeKey, visibleKeys]);

  const setExpandedTo = (projectId, next) => {
    const updated = new Set(expanded);
    if (next) updated.add(projectId); else updated.delete(projectId);
    setExpanded(updated);
    onExpandedChange?.([...updated]);
  };

  const selectProject = (project) => {
    const keepsTask = selected.taskProjectId === project.id;
    if (!keepsTask && selected.taskId) onSelectTask?.(null, { projectId: project.id, taskId: null });
    const next = {
      projectId: project.id,
      taskId: keepsTask ? selected.taskId : null,
      taskProjectId: keepsTask ? selected.taskProjectId : null,
    };
    if (!selectionControlled) {
      setUncontrolledSelection((current) => (current.projectId === next.projectId && current.taskId === next.taskId ? current : next));
    }
    onSelectProject?.(toProjectSummary(project));
  };

  const activateProject = (project) => {
    setActiveKey(projectKey(project.id));
    selectProject(project);
    setExpandedTo(project.id, !expanded.has(project.id));
  };

  const activateTask = (project, task) => {
    setActiveKey(taskKey(project.id, task.id));
    if (!selectionControlled) setUncontrolledSelection({ projectId: project.id, taskId: task.id, taskProjectId: project.id });
    if (selected.projectId !== project.id) onSelectProject?.(toProjectSummary(project));
    onSelectTask?.(toTaskSummary(task, project.id));
  };

  const focusItem = useCallback((key) => {
    const node = itemRefs.current.get(key);
    if (node) node.focus();
  }, []);

  const onTreeKeyDown = (event, key) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = visibleKeys.indexOf(key);
    if (index < 0) return;
    const isProjectRow = key.startsWith('p:');
    const projectId = isProjectRow ? key.slice(2) : projectIdOfTaskKey(key);
    let nextKey = null;
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        nextKey = visibleKeys[index + 1] ?? null;
        break;
      case 'ArrowUp':
        nextKey = visibleKeys[index - 1] ?? null;
        break;
      case 'Home':
        nextKey = visibleKeys[0] ?? null;
        break;
      case 'End':
        nextKey = visibleKeys[visibleKeys.length - 1] ?? null;
        break;
      case 'ArrowRight':
        if (isProjectRow) {
          if (!expanded.has(projectId)) setExpandedTo(projectId, true);
          else {
            const firstTaskId = (taskIdsByProject[projectId] ?? [])[0];
            if (firstTaskId) nextKey = taskKey(projectId, firstTaskId);
          }
        }
        break;
      case 'ArrowLeft':
        if (isProjectRow) {
          if (expanded.has(projectId)) setExpandedTo(projectId, false);
        } else {
          nextKey = projectKey(projectId);
        }
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    event.preventDefault();
    if (nextKey) {
      setActiveKey(nextKey);
      focusItem(nextKey);
    }
  };

  const selectedProject = projects.find((project) => project.id === selected.projectId);
  const projectViewSummary = useMemo(() => toProjectViewSummary(selectedProject), [selectedProject]);
  const projectQueryState = selectedProjectQueryState(overview, selectedProject, selected.projectId);
  // Al reactivarse, espera a que `useCoreQuery` inicie una lectura antes de volver a publicar una
  // respuesta cacheada como vigente. Si la pestaña está oculta, el hook omite el refresco y el host
  // conserva la metadata con estado stale hasta que una lectura empiece o termine.
  const [queryResumed, setQueryResumed] = useState(active);
  useEffect(() => {
    if (!active) {
      setQueryResumed(false);
      return;
    }
    if (!['ready', 'empty'].includes(overview.status)) setQueryResumed(true);
  }, [active, overview.status]);
  const waitingForFreshQuery = active && !queryResumed;
  const hiddenCachedResume = waitingForFreshQuery
    && document.visibilityState === 'hidden'
    && overview.data !== null;
  const snapshotCurrent = !active || queryResumed || hiddenCachedResume;
  const snapshotQueryState = hiddenCachedResume ? 'stale' : projectQueryState;
  useEffect(() => {
    if (!snapshotCurrent) return;
    onProjectSnapshot?.({
      projectId: selected.projectId,
      queryState: snapshotQueryState,
      project: projectViewSummary,
      error: overview.error ?? null,
      reason: overview.reason ?? null,
    });
  }, [onProjectSnapshot, overview.error, overview.reason, projectQueryState, projectViewSummary, selected.projectId, snapshotCurrent, snapshotQueryState]);
  const projectsSnapshotQueryState = hiddenCachedResume ? 'stale' : overview.status;
  useEffect(() => {
    if (!snapshotCurrent) return;
    onProjectsSnapshot?.({
      queryState: projectsSnapshotQueryState,
      projectIds,
      error: overview.error ?? null,
    });
  }, [onProjectsSnapshot, overview.error, projectIds, projectsSnapshotQueryState, snapshotCurrent]);

  const selectedProjectMissing = Boolean(selected.projectId) && ['ready', 'empty'].includes(overview.status) && !selectedProject;
  const unassignedTasks = overview.data?.unassigned?.tasks;
  const isEmpty = overview.status === 'empty';
  const automaticFilterAnnouncement = automaticFilterNotice?.projectId === selected.projectId
    && automaticFilterNotice.taskId === selected.taskId
    && overview.data
    && projects.some((project) => project.id === selected.projectId)
    && statusView.code === 'all'
    ? `Filtro cambiado automáticamente a Todas para buscar la Task seleccionada (${automaticFilterNotice.taskId}).`
    : '';

  return (
    <section
      className={`ps${active ? '' : ' is-hidden'}`}
      aria-labelledby={headingId}
      aria-hidden={!active}
      inert={!active}
      data-testid="projects-sidebar"
    >
      <header className="ps__head">
        <h2 id={headingId} className="ps__title">Projects</h2>
        <p className="ps__subtitle">Projects y Tasks del Core, con su estado y su Attention. Solo lectura.</p>
      </header>

      <div className="ps__filters">
        <span className="ps__filter-label" id={`${headingId}-tasks-filter`}>Estado de las Tasks</span>
        <div className="ps__radios" role="radiogroup" aria-labelledby={`${headingId}-tasks-filter`}>
          {TASK_STATUS_VIEWS.map((view) => (
            <label key={view.code} className={`ps__radio${statusView.code === view.code ? ' is-active' : ''}`}>
              <input
                ref={view.code === 'active' ? firstFilterInputRef : undefined}
                type="radio"
                name={statusFilterName}
                value={view.code}
                checked={statusView.code === view.code}
                onChange={() => {
                  pendingSelectionScrollRef.current = null;
                  pendingSelectionFilterCheckRef.current = null;
                  setPendingSelectionScroll(null);
                  setAutomaticFilterNotice(null);
                  setStatusView(view);
                }}
              />
              <span>{view.label}</span>
            </label>
          ))}
        </div>
      </div>

      <div
        className={automaticFilterAnnouncement ? 'ps__state ps__state--muted' : 'ps__live-region--sr-only'}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="selection-filter-notice"
      >
        {automaticFilterAnnouncement}
        {selectionAnnouncement && <span className="ps__sr-only">{selectionAnnouncement}</span>}
      </div>

      {statusView.code === 'active' && (
        <p className="ps__hint" data-testid="active-view-hint">
          Vista «Activas»: las Tasks finalizadas quedan ocultas. Usa «Finalizadas» o «Todas» para descubrirlas.
        </p>
      )}

      <Feedback
        state={overview}
        subject="Projects"
        onRetry={(event) => {
          if (event.currentTarget !== document.activeElement) return;
          if (visibleKeys[0]) focusItem(visibleKeys[0]);
          else firstFilterInputRef.current?.focus();
        }}
      />

      {selectedProjectMissing && (
        <div className="ps__state ps__state--muted" role="status">
          El Project seleccionado ({selected.projectId}) ya no aparece en el overview. Se conserva la selección; elige otro Project para cambiar de contexto.
        </div>
      )}

      {isEmpty && <div className="ps__empty" role="status">No hay Projects registrados con este filtro del Core.</div>}

      {projects.length > 0 && (
        <ul
          className="ps__tree scroll"
          role="tree"
          aria-label="Projects y Tasks del Core"
          aria-busy={overview.status === 'refreshing'}
        >
          {projects.map((project, index) => {
            const isExpanded = expanded.has(project.id);
            return (
              <ProjectRow
                key={project.id}
                project={project}
                expanded={isExpanded}
                selected={project.id === selected.projectId && !selected.taskId}
                context={project.id === selected.projectId && Boolean(selected.taskId)}
                position={index + 1}
                setSize={projects.length}
                isActiveKey={projectKey(project.id) === effectiveActiveKey}
                registerRef={registerItem}
                onKeyDown={onTreeKeyDown}
                onFocus={() => onFocusKey(projectKey(project.id))}
                onActivate={activateProject}
              >
                {isExpanded && (
                  <ProjectTasks
                    project={project}
                    statusView={statusView}
                    active={active}
                    pollMs={pollMs}
                    onVisibleTasks={onVisibleTasks}
                    registerRef={registerItem}
                    effectiveActiveKey={effectiveActiveKey}
                    selectedTaskId={selected.taskId}
                    selectedTaskProjectId={selected.taskProjectId}
                    pendingTaskId={pendingSelectionScroll?.projectId === project.id ? pendingSelectionScroll.taskId : null}
                    confirmedMissingTaskId={confirmedMissingTaskId && missingTaskSelection.projectId === project.id
                      ? confirmedMissingTaskId
                      : null}
                    onTaskLookupComplete={onTaskLookupComplete}
                    onKeyDown={onTreeKeyDown}
                    onFocusKey={onFocusKey}
                    focusItem={focusItem}
                    onActivateTask={activateTask}
                  />
                )}
              </ProjectRow>
            );
          })}
        </ul>
      )}

      {Number.isFinite(unassignedTasks) && unassignedTasks > 0 && (
        <p className="ps__hint" data-testid="unassigned-hint">
          Hay {unassignedTasks} Tasks del Core sin Project (`unassigned`): no se listan aquí porque no tienen Project durable.
        </p>
      )}

      <p className="ps__note">
        Solo lectura: sin Attempts, sin crear ni reintentar Tasks, sin arrastrar y sin marcar como leído.
        La identidad de cada fila es su ID durable; host, origen, rama y worktree son metadato.
      </p>
    </section>
  );
}
