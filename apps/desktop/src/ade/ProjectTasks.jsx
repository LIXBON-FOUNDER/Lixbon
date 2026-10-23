import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TASK_PAGE_LIMIT, listAdeTasks } from './coreQueries';
import { useCoreQuery } from './useCoreQuery';
import {
  TASK_STATUS_LABELS,
  FINAL_TASK_STATUSES,
  TASK_STATUS_TONES,
  asText,
  metaValue,
  projectKey,
  taskKey,
  byCoreTaskOrder,
  EMPTY_PAGE,
  emptyPageState,
  uniqueTasksById,
  describeCoreError,
  failureStatuses,
  Feedback,
} from './projectsSidebarModel';

// Tasks de un Project expandido del sidebar (LXO-97), extraídas de `ProjectsSidebar.jsx` sin cambiar
// su comportamiento: lectura paginada por cursor opaco, filas de Task y su teclado.

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


/**
 * Página de Tasks de un Project expandido. Monta su propia query `tasks_by_project` (lazy: solo
 * existe mientras el Project está expandido) y acumula páginas por `next_cursor` opaco.
 */
export function ProjectTasks({
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
  // Oculto, `useCoreQuery` devuelve `data: null`. La última cabecera leída se conserva aquí para que las
  // filas, el cursor y el scroll sigan en su sitio sin consultar Core; al volver, `head.data` la reemplaza.
  const preservedHeadRef = useRef(null);
  if (head.data) preservedHeadRef.current = { key: pageKey, data: head.data };
  const preservedHead = preservedHeadRef.current?.key === pageKey ? preservedHeadRef.current.data : null;
  const headData = head.data ?? preservedHead;
  const [pages, setPages] = useState(() => emptyPageState(pageKey));
  const pageRequestRef = useRef(null);
  const pageRequestSequence = useRef(0);
  const inFlightPageReadsRef = useRef(new Map());
  const pageKeyRef = useRef(pageKey);
  const activeRef = useRef(active);
  pageKeyRef.current = pageKey;
  activeRef.current = active;
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
  const [headResumePending, setHeadResumePending] = useState(false);
  const headDataStale = Boolean(headData)
    && active
    && (headResumePending || headFailed);
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
  const headTasks = headData?.tasks ?? [];
  const headTaskIds = useMemo(() => new Set(headTasks.map((task) => task.id)), [headTasks]);
  const tasks = useMemo(() => {
    return uniqueTasksById([...headTasks, ...currentPages.items]).sort(byCoreTaskOrder);
  }, [headTasks, currentPages.items]);
  const staleTaskIds = useMemo(() => {
    const ids = (currentPages.stale || headFailed)
      ? currentPages.items.filter((task) => !headTaskIds.has(task.id)).map((task) => task.id)
      : [];
    if (headDataStale) ids.push(...headTasks.map((task) => task.id));
    return new Set(ids);
  }, [currentPages.items, currentPages.stale, headDataStale, headFailed, headTaskIds, headTasks]);

  const taskIdSignature = tasks.map((task) => task.id).join('\u0000');
  // Una lectura fallida sin datos no demuestra la ausencia de la Task: no cuenta como asentada.
  const tasksSettled = Boolean(headData) && active && !headDataStale;
  useEffect(() => {
    onVisibleTasks(projectId, taskIdSignature ? taskIdSignature.split('\u0000') : [], tasksSettled, statusView.code);
    return () => onVisibleTasks(projectId, [], false, statusView.code);
  }, [projectId, taskIdSignature, tasksSettled, onVisibleTasks, statusView.code]);

  const headCursor = headData?.has_more ? headData.next_cursor : null;
  const moreCursor = currentPages.pageCount > 0 ? currentPages.nextCursor : headCursor;
  // Una lectura invalidada por ocultar/cambiar identidad sigue viva en Core. Si la misma página
  // se solicita de nuevo al reanudar, se comparte la promesa en vez de duplicarla.
  const readTaskPage = useCallback(async (request, cursor, isCurrentRequest) => {
    if (!isCurrentRequest()) return null;
    const flightKey = JSON.stringify([request.key, cursor]);
    const flights = inFlightPageReadsRef.current.get(flightKey) ?? [];
    const reusableFlight = flights.find((flight) => (
      request.headUpdatedAt != null
      && flight.reusable
      && flight.headUpdatedAt === request.headUpdatedAt
    ));
    if (reusableFlight) return reusableFlight.promise;

    if (!isCurrentRequest()) return null;
    const flight = { headUpdatedAt: request.headUpdatedAt, promise: null, reusable: false, request };
    const promise = listAdeTasks(projectId, { status: statusView.code, cursor });
    flight.promise = Promise.resolve(promise);
    const currentFlights = inFlightPageReadsRef.current.get(flightKey) ?? [];
    currentFlights.push(flight);
    inFlightPageReadsRef.current.set(flightKey, currentFlights);
    request.inFlightPageReads ??= new Set();
    request.inFlightPageReads.add(flight);
    try {
      return await flight.promise;
    } finally {
      const remainingFlights = (inFlightPageReadsRef.current.get(flightKey) ?? []).filter((entry) => entry !== flight);
      if (remainingFlights.length > 0) {
        inFlightPageReadsRef.current.set(flightKey, remainingFlights);
      } else {
        inFlightPageReadsRef.current.delete(flightKey);
      }
      request.inFlightPageReads.delete(flight);
    }
  }, [projectId, statusView.code]);
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
      && activeRef.current
      && pageKeyRef.current === request.key
      && !headFailedRef.current
      && latestHeadUpdatedAtRef.current === request.headUpdatedAt;

    try {
      while (cursor && pagesLoaded < loadedPageCount) {
        const page = await readTaskPage(request, cursor, isCurrentRequest);
        if (!page || !isCurrentRequest()) return;
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
        preserved: false,
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
  }, [head.data, head.retry, head.updatedAt, pageKey, projectId, readTaskPage, statusView.code]);

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

  // Al ocultarse el modo, las páginas ya cargadas (y su cursor) se conservan pero dejan de ser vigentes:
  // se marcan como previas. Al reactivarse, la primera lectura autoritativa de la cabecera (`readEpoch`
  // mayor que el visto al volver) las vuelve a leer aunque la cabecera no haya cambiado.
  const wasActiveRef = useRef(active);
  const resumeEpochRef = useRef(null);
  const previousPageKeyRef = useRef(pageKey);
  const headReadEpochRef = useRef(head.readEpoch);
  headReadEpochRef.current = head.readEpoch;
  useLayoutEffect(() => {
    const wasActive = wasActiveRef.current;
    const pageChanged = previousPageKeyRef.current !== pageKey;
    wasActiveRef.current = active;
    previousPageKeyRef.current = pageKey;
    if (active === wasActive) {
      if (active && pageChanged && resumeEpochRef.current != null) {
        resumeEpochRef.current = headReadEpochRef.current ?? 0;
      }
      return;
    }
    if (!active) {
      resumeEpochRef.current = null;
      setHeadResumePending(false);
      // Una lectura en vuelo al ocultarse se descarta: no debe sellar como vigentes páginas que Core no confirmó.
      for (const flights of inFlightPageReadsRef.current.values()) {
        for (const flight of flights) {
          if (flight.request?.key === pageKey) flight.reusable = true;
        }
      }
      pageRequestRef.current = null;
      pagingRequestActiveRef.current = false;
      pagingFocusRef.current = false;
      pageRetryFocusRef.current = false;
      setPages((current) => (current.key !== pageKey
        ? current
        : {
          ...current,
          loading: false,
          ...(current.pageCount > 0 ? { stale: true, preserved: true } : {}),
          ...(current.loading ? { error: null } : {}),
        }));
      return;
    }
    resumeEpochRef.current = headReadEpochRef.current ?? 0;
    setHeadResumePending(true);
  }, [active, pageKey]);

  useEffect(() => {
    const resumeEpoch = resumeEpochRef.current;
    if (!active || resumeEpoch == null || headFailed || !head.data || head.readEpoch <= resumeEpoch) return;
    resumeEpochRef.current = null;
    setHeadResumePending(false);
    // Si la cabecera cambió, el efecto de versión ya está reconciliando.
    if (pageRequestRef.current || pages.key !== pageKey || pages.pageCount === 0) return;
    void reconcileLoadedPages(pages.pageCount, head.updatedAt);
  }, [active, head.data, head.readEpoch, head.updatedAt, headFailed, pageKey, pages.key, pages.pageCount, reconcileLoadedPages]);

  // Con una cabecera stale/desconectada no se encadenan cursores de otra versión del Core.
  const canLoadMore = !headFailed
    && !headDataStale
    && !currentPages.stale
    && (currentPages.pageCount > 0 ? currentPages.hasMore : Boolean(headCursor));

  const hasData = Boolean(headData);
  const hasMoreTasks = currentPages.pageCount > 0
    ? currentPages.hasMore
    : Boolean(headData?.has_more);
  const taskSetSize = (headFailed || headDataStale || currentPages.stale || hasMoreTasks) ? -1 : tasks.length;
  const allStatusReadComplete = statusView.code === 'all'
    && active
    && hasData
    && !headDataStale
    && !headFailed
    && head.status !== 'refreshing'
    && !currentPages.stale
    && !currentPages.loading
    && !currentPages.error
    && !hasMoreTasks;

  const loadMore = useCallback(async ({ automatic = false, retry = false } = {}) => {
    if (pageRequestRef.current || !moreCursor || currentPages.stale || headDataStale
      || (activeRef.current && resumeEpochRef.current != null)) return;
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
      && activeRef.current
      && pageKeyRef.current === request.key
      && !headFailedRef.current
      && latestHeadUpdatedAtRef.current === request.headUpdatedAt
      && (!automatic || pendingTaskIdRef.current === request.pendingTaskId);
    try {
      const page = await readTaskPage(request, moreCursor, isCurrentRequest);
      if (!isCurrentRequest()) return;
      setPages((current) => (current.key !== requestedKey ? current : {
        ...current,
        items: uniqueTasksById([...current.items, ...page.tasks]),
        pageCount: current.pageCount + 1,
        nextCursor: page.next_cursor,
        hasMore: page.has_more,
        loading: false,
        stale: false,
        preserved: false,
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
  }, [currentPages.stale, head.retry, head.updatedAt, headDataStale, moreCursor, pageKey, pendingTaskId, projectId, readTaskPage, statusView.code]);

  useEffect(() => {
    if (
      !active
      || resumeEpochRef.current != null
      || !pendingTaskId
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
    active,
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

      {headDataStale && (
        <div className="ps__state ps__state--stale" role="status" data-testid={`stale-task-head-${projectId}`}>
          {headFailed
            ? `Core no pudo confirmar la cabecera de Tasks de ${projectName}. Se conserva la última lectura correcta y puede estar desactualizada.`
            : `Se conserva la cabecera anterior de Tasks de ${projectName} mientras Core confirma la lectura actual.`}
        </div>
      )}

      {currentPages.stale && (
        <div className="ps__state ps__state--stale" role="status" data-testid={`stale-task-pages-${projectId}`}>
          <span>
            {currentPages.preserved
              ? `Se conservan las Tasks cargadas de ${projectName} de la última lectura de Core; se vuelven a leer al confirmar los datos y pueden estar desactualizadas.`
              : headFailed
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
          aria-busy={currentPages.loading || head.inFlight}
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
          disabled={currentPages.loading || headDataStale}
          aria-busy={currentPages.loading}
          aria-label={currentPages.stale
            ? (currentPages.loading || headDataStale
              ? `Actualizando páginas de Tasks de ${projectName}`
              : `Reintentar actualización de páginas de Tasks de ${projectName}`)
            : (currentPages.loading
              ? `Cargando Tasks de ${projectName}`
              : `Cargar más Tasks de ${projectName}`)}
        >
          {currentPages.stale
            ? (currentPages.loading || headDataStale ? 'Actualizando páginas…' : 'Reintentar actualización')
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
