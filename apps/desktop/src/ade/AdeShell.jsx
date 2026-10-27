import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Collapse } from '../layout/Collapse';
import { Gutter } from '../layout/Gutter';
import { Panel } from '../layout/Panel';
import { RightDock } from '../layout/RightDock';
import { useWorkbenchStore } from '../store/workbenchStore';
import { ActivityPanel } from './ActivityPanel';
import { AttentionInbox } from './AttentionInbox';
import { translateActivityMessage } from './activityMessages';
import { queryAdeCore, readAdeTask } from './coreQueries';
import { JumpPaletteHost } from './JumpPaletteHost';
import { ProjectsSidebar } from './ProjectsSidebar';
import { ProjectView } from './ProjectView';
import { TaskWorkspace } from './TaskWorkspace';
import { AttemptHistory } from './AttemptHistory';
import { AttemptDetail } from './AttemptDetail';
import { ContextPreview } from './ContextPreview';
import { ProviderInspector } from './ProviderInspector';
import { UsageView } from './UsageView';
import { useCoreModel } from './useCoreModel';
import { StartupCutNotice } from './StartupCutNotice';
import { migratePersistedSelection, resolveNavTarget } from './cutoverNavigation';
import { COPY, navNoticeCopy, navRejectText } from './adeLabels';
import { readLegacyAdeSelection } from '../store/workbenchStore';
import { useCoreQuery } from './useCoreQuery';
import { AdeSourceSwitch } from './preview/AdeSourceSwitch';
import './AdeShell.css';
import './TaskWorkspace.css';

function projectViewQueryState(query) {
  if (query.status === 'ready' || query.status === 'empty') return 'ready';
  if (query.status === 'idle' || query.status === 'loading' || query.status === 'refreshing') return 'loading';
  if (query.status === 'stale' || query.status === 'degraded') return 'degraded';
  if (query.status === 'error' || query.status === 'disconnected') return 'error';
  if (query.status === 'missing') return 'unavailable';
  return 'unavailable';
}

function projectQueryMessage(query) {
  if (query.status === 'stale') {
    const cause = {
      disconnected: 'Core desconectado',
      degraded: 'Core degradado',
      // Un plazo agotado no es una desconexión: el Core puede estar escaneando (LXO-101).
      timeout: 'Core no respondió a tiempo',
      error: 'Core con error',
    }[query.reason];
    return `Datos desactualizados${cause ? ` (${cause})` : ''}; se conserva la última respuesta. ${query.error || ''}`.trim();
  }
  // `refreshing` no lleva mensaje: ProjectView lo pinta como «Actualizando desde Core.» mediante el flag.
  if (query.status === 'refreshing') return null;
  const sourceLabel = {
    disconnected: 'Core desconectado',
    degraded: 'Core degradado',
    timeout: 'Core no respondió a tiempo',
    error: 'Core con error',
  }[query.status];
  if (sourceLabel) return `${sourceLabel}. ${query.error || ''}`.trim();
  return query.error || null;
}

/** Eventos recientes que Project View resume; la línea de tiempo completa vive en la pestaña Activity. */
export const PROJECT_ACTIVITY_LIMIT = 20;

/**
 * Proyecta un item de `activity_list` (LXO-92) a la fila de Project View. Solo se usan campos del
 * contrato: el único fallback permitido (`activity.unknown`) se traduce con los argumentos seguros
 * de Core; fallbacks ajenos o claves inválidas dejan un mensaje genérico en ProjectView.
 */
export function projectActivityItem(item) {
  const target = item?.target && typeof item.target === 'object' ? item.target : null;
  const translated = translateActivityMessage(item?.message_key, item?.args);
  const text = item?.fallback === true
    ? item?.message_key === 'activity.unknown' ? translated : null
    : translated;
  return {
    activity_id: typeof item?.event_id === 'string' ? item.event_id : undefined,
    kind: typeof item?.kind === 'string' ? item.kind : undefined,
    ...(typeof text === 'string' && text ? { text } : {}),
    ...(Number.isSafeInteger(item?.ts) && item.ts >= 0 ? { occurred_at: new Date(item.ts).toISOString() } : {}),
    ...(target?.kind === 'task' && typeof target.id === 'string' ? { task_id: target.id } : {}),
    ...(target?.kind === 'attempt' && typeof target.id === 'string' ? { attempt_id: target.id } : {}),
    ...(typeof item?.project_id === 'string' && item.project_id ? { project_id: item.project_id } : {}),
  };
}

/** Estado del inventario de recursos tal como lo da `useCoreQuery`: stale/loading/error/degraded se conservan. */
export function resourceInventoryStatus(query) {
  return {
    state: query.status,
    message: typeof query.error === 'string' && query.error ? query.error : null,
    reason: query.reason ?? null,
    inFlight: query.inFlight === true,
  };
}

function projectViewSlice(query, items, { hasMore = false } = {}) {
  const queryState = projectViewQueryState(query);
  const state = queryState === 'ready' && hasMore ? 'partial' : queryState;
  const canShowItems = ['ready', 'partial', 'loading', 'degraded'].includes(state);
  const messages = [];
  const queryMessage = projectQueryMessage(query);
  if (queryMessage) messages.push(queryMessage);
  if (hasMore) messages.push('Core indica que hay más elementos después de esta página.');
  return {
    state,
    ...(query.status === 'refreshing' ? { refreshing: true } : {}),
    items: canShowItems && Array.isArray(items) ? items : [],
    ...(messages.length ? { message: messages.join(' ') } : {}),
  };
}

function overviewUnavailableSlice(projects, subject) {
  if (['ready', 'empty', 'missing'].includes(projects.status)) {
    return { state: 'unavailable', items: [], message: `El Project seleccionado no aparece en el overview activo de Core; no hay ${subject} autoritativos para mostrar.` };
  }
  if (projects.status === 'unknown' || projects.status === 'unavailable') {
    return { state: 'unavailable', items: [], message: `Core no confirmó metadata autoritativa para este Project; no hay ${subject} autoritativos para mostrar.` };
  }
  return projectViewSlice(projects, []);
}

function locationLastSeen(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

const WORKSPACE_VIEWS = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'attention', label: 'Attention' },
  { key: 'activity', label: 'Activity' },
];

// Misma política que useCoreQuery: ninguna lectura de Core queda abierta indefinidamente.
const ACTIVITY_VERIFY_TIMEOUT_MS = 10_000;
const PROJECT_TASK_PAGE_TIMEOUT_MS = 10_000;
const PROJECT_TASK_PAGE_TIMEOUT_MESSAGE = 'El Core tarda en responder; se conservan las Tasks ya cargadas.';

/** Espera la lectura con el límite de 10 s; vencer el plazo solo rechaza al llamante, no libera la lectura en vuelo. */
function withinVerifyPolicy(read) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error('ade_query_timeout: Core no respondió a tiempo')), ACTIVITY_VERIFY_TIMEOUT_MS);
  });
  return Promise.race([read, timeout]).finally(() => window.clearTimeout(timeoutId));
}

function uniqueProjectTasks(...groups) {
  const seen = new Set();
  return groups.flat().filter((task) => {
    const id = task?.id;
    if (typeof id !== 'string' || !id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function nextTaskCursor(page, cursor, visited) {
  if (page?.has_more !== true) return null;
  if (typeof page.next_cursor !== 'string' || !page.next_cursor || visited.has(page.next_cursor)) {
    throw new Error('tasks_by_project_cursor_did_not_advance');
  }
  return page.next_cursor;
}

/** Sigue `tasks_by_project(all)` y solo publica una generación cuando su conjunto de páginas queda listo. */
function useProjectTaskContinuation(projectId, firstPage, enabled) {
  const epoch = Number.isSafeInteger(firstPage.readEpoch) ? firstPage.readEpoch : 0;
  const headVersion = JSON.stringify(firstPage.data ?? null);
  const context = JSON.stringify([projectId ?? null, headVersion, enabled === true]);
  const contextRef = useRef(context);
  contextRef.current = context;
  const [continuation, setContinuation] = useState(null);
  const continuationRef = useRef(null);
  const requestRef = useRef({ id: 0, inFlight: false, timeout: null, context: null, epoch: 0, reconcile: false });

  const publish = useCallback((next) => {
    continuationRef.current = next;
    setContinuation(next);
  }, []);

  const runPageSet = useCallback(({ base, reconcile }) => {
    if (!enabled || !projectId || requestRef.current.inFlight) return;
    const request = requestRef.current;
    const requestId = request.id + 1;
    request.id = requestId;
    request.inFlight = true;
    request.context = context;
    request.epoch = epoch;
    request.reconcile = reconcile;
    const requestContext = context;
    const firstData = firstPage.data;
    const isCurrentRequest = () => requestRef.current.id === requestId && contextRef.current === requestContext;
    const initialItems = Array.isArray(firstData?.tasks) ? uniqueProjectTasks(firstData.tasks) : [];

    publish({
      ...base,
      targetEpoch: epoch,
      loading: true,
      pending: false,
      error: null,
      announcement: reconcile ? null : base.announcement ?? null,
      started: true,
    });

    const readPage = async (cursor) => {
      const timeoutId = window.setTimeout(() => {
        if (!isCurrentRequest()) return;
        request.timeout = null;
        const visible = continuationRef.current?.projectId === projectId ? continuationRef.current : base;
        publish({
          ...visible,
          ...(reconcile ? {} : { epoch: request.epoch }),
          targetEpoch: request.epoch,
          loading: false,
          pending: true,
          error: PROJECT_TASK_PAGE_TIMEOUT_MESSAGE,
          started: true,
        });
      }, PROJECT_TASK_PAGE_TIMEOUT_MS);
      request.timeout = timeoutId;
      try {
        return await queryAdeCore('tasks_by_project', { projectId, status: 'all', cursor });
      } finally {
        window.clearTimeout(timeoutId);
        if (requestRef.current.id === requestId && request.timeout === timeoutId) request.timeout = null;
      }
    };

    const read = async () => {
      let items = reconcile ? initialItems : base.items;
      let pageCount = reconcile ? 0 : base.pageCount;
      let cursor = reconcile ? firstData?.next_cursor : base.cursor;
      let hasMore = reconcile ? firstData?.has_more === true : base.hasMore === true;
      let cursorHistory = reconcile ? [] : [...(base.cursorHistory ?? [])];
      const pageLimit = reconcile ? base.pageCount : 1;
      let addedCount = 0;

      try {
        for (let index = 0; index < pageLimit && hasMore; index += 1) {
          if (typeof cursor !== 'string' || !cursor) {
            throw new Error('tasks_by_project_cursor_did_not_advance');
          }
          const visited = new Set(cursorHistory);
          if (visited.has(cursor)) throw new Error('tasks_by_project_cursor_did_not_advance');
          visited.add(cursor);

          const page = await readPage(cursor);
          if (!isCurrentRequest()) return;
          const pageTasks = Array.isArray(page?.tasks) ? page.tasks : [];
          const knownIds = new Set(uniqueProjectTasks(items).map((task) => task.id));
          addedCount += uniqueProjectTasks(pageTasks).filter((task) => !knownIds.has(task.id)).length;
          items = uniqueProjectTasks(items, pageTasks);
          pageCount += 1;
          hasMore = page?.has_more === true;
          cursor = nextTaskCursor(page, cursor, visited);
          cursorHistory = [...visited];
        }

        if (!isCurrentRequest()) return;
        const loaded = addedCount === 1 ? 'Se cargó 1 Task.' : `Se cargaron ${addedCount} Tasks.`;
        publish({
          projectId,
          epoch: request.epoch,
          items,
          pageCount,
          cursor,
          cursorHistory,
          hasMore,
          started: pageCount > 0,
          loading: false,
          pending: false,
          error: null,
          announcement: reconcile
            ? 'Se actualizó la lista de Tasks desde Core.'
            : `${loaded} ${hasMore ? 'Hay más Tasks disponibles.' : 'No hay más Tasks.'}`,
        });
      } catch (error) {
        if (!isCurrentRequest()) return;
        const message = error instanceof Error ? error.message : String(error ?? 'Error desconocido del Core');
        publish({
          ...base,
          ...(reconcile ? { targetEpoch: request.epoch } : { epoch: request.epoch }),
          loading: false,
          pending: false,
          error: message,
          started: true,
        });
      } finally {
        if (requestRef.current.id === requestId) {
          if (request.timeout !== null) window.clearTimeout(request.timeout);
          request.timeout = null;
          request.inFlight = false;
          request.context = null;
        }
      }
    };

    void read();
  }, [context, enabled, epoch, firstPage.data, projectId, publish]);

  // Same head content is still a new Core read epoch, but it does not invalidate a cursor walk.
  // A changed Project, head DTO, or active state does invalidate it, including on unmount.
  useEffect(() => {
    return () => {
      const request = requestRef.current;
      request.id += 1;
      request.inFlight = false;
      if (request.timeout !== null) window.clearTimeout(request.timeout);
      request.timeout = null;
      request.context = null;
    };
  }, [context]);

  useEffect(() => {
    const request = requestRef.current;
    if (request.inFlight && request.context === context) {
      request.epoch = epoch;
      const active = continuationRef.current;
      if (active?.projectId === projectId && active.epoch !== epoch) {
        publish(request.reconcile
          ? { ...active, targetEpoch: epoch }
          : { ...active, epoch });
      }
      return;
    }

    request.id += 1;
    request.inFlight = false;
    if (request.timeout !== null) window.clearTimeout(request.timeout);
    request.timeout = null;
    request.context = null;

    if (enabled && projectId && firstPage.data) {
      const previous = continuationRef.current;
      if (previous?.projectId === projectId && previous.epoch !== epoch && previous.pageCount > 0) {
        runPageSet({ base: previous, reconcile: true });
      }
    }
  }, [context, enabled, epoch, firstPage.data, projectId, publish, runPageSet]);

  const sameProject = continuation?.projectId === projectId ? continuation : null;
  const current = sameProject?.epoch === epoch ? sameProject : null;
  const stalePages = sameProject?.pageCount > 0 && sameProject.epoch !== epoch;
  const reconciling = stalePages && firstPage.data?.has_more === true;
  const refreshState = reconciling && sameProject.targetEpoch === epoch ? sameProject : null;
  const hasMore = reconciling
    ? refreshState?.error ? true : firstPage.data?.has_more === true
    : current?.hasMore ?? firstPage.data?.has_more === true;

  const loadMore = useCallback(() => {
    if (!enabled || !projectId || !hasMore) return;
    const previous = continuationRef.current;
    if (previous?.projectId === projectId && previous.epoch !== epoch && previous.pageCount > 0 && firstPage.data?.has_more === true) {
      runPageSet({ base: previous, reconcile: true });
      return;
    }
    const base = previous?.projectId === projectId && previous.epoch === epoch
      ? previous
      : {
        projectId,
        epoch,
        items: Array.isArray(firstPage.data?.tasks) ? uniqueProjectTasks(firstPage.data.tasks) : [],
        pageCount: 0,
        cursor: firstPage.data?.next_cursor,
        cursorHistory: [],
        hasMore: firstPage.data?.has_more === true,
        started: false,
        loading: false,
        pending: false,
        error: null,
        announcement: null,
      };
    if (base.hasMore !== true) return;
    runPageSet({ base, reconcile: false });
  }, [enabled, epoch, firstPage.data, hasMore, projectId, runPageSet]);

  const items = current?.items ?? (reconciling ? sameProject.items : null);
  return {
    items,
    hasMore,
    started: reconciling ? true : current?.started === true,
    loading: reconciling ? refreshState ? refreshState.loading === true : true : current?.loading === true,
    pending: reconciling ? refreshState?.pending === true : current?.pending === true,
    error: reconciling ? refreshState?.targetEpoch === epoch ? refreshState.error ?? null : null : current?.error ?? null,
    announcement: current?.announcement ?? null,
    loadMore,
  };
}

const ACTIVITY_SCOPES = [
  { kind: 'global', label: 'Global' },
  { kind: 'project', label: 'Project' },
  { kind: 'task', label: 'Task' },
];

/** Alcance de Activity: preferencia explícita si sigue disponible; si no, el más específico que haya seleccionado. */
function resolveActivityScope(preferred, projectId, taskId) {
  const available = { global: true, project: Boolean(projectId), task: Boolean(projectId && taskId) };
  if (preferred && available[preferred]) return preferred;
  return available.task ? 'task' : available.project ? 'project' : 'global';
}

/** Switch Workspace/Attention/Activity con semántica de tabs (flechas, Inicio/Fin); solo cambia la subvista del ADE. */
function WorkspaceViewSwitch({ view, onChange, idPrefix }) {
  const tabRefs = useRef({});
  const onKeyDown = (event) => {
    const index = WORKSPACE_VIEWS.findIndex((item) => item.key === view);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % WORKSPACE_VIEWS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + WORKSPACE_VIEWS.length) % WORKSPACE_VIEWS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = WORKSPACE_VIEWS.length - 1;
    else return;
    event.preventDefault();
    const key = WORKSPACE_VIEWS[next].key;
    onChange(key);
    tabRefs.current[key]?.focus();
  };
  return (
    <div className="ade-view-switch" role="tablist" aria-label="Vista del ADE" onKeyDown={onKeyDown}>
      {WORKSPACE_VIEWS.map((item) => {
        const selected = item.key === view;
        return (
          <button
            key={item.key}
            ref={(node) => { tabRefs.current[item.key] = node; }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.key}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.key}`}
            tabIndex={selected ? 0 : -1}
            className={`ade-view-switch__tab${selected ? ' is-active' : ''}`}
            onClick={() => onChange(item.key)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

// Activity y Attention las sirve este shell (ActivityPanel / AttentionInbox). El enlace Activity de la Task abre la
// subvista con alcance Task; `onOpenTaskActivity` (opcional) además recibe `{ projectId, taskId }`.
// `onOpenRun(runId)` / `onOpenSpawnRequest(pendingId)` son los callbacks existentes de Operación: reciben el
// ID durable exacto y devuelven `true` si lo abrieron (o `false` si ya no existe en esa superficie).
export function AdeShell({ active, modeActive = true, leftOpen, rightOpen, drawerOpen, onCloseDrawer, onActivate, operationNavigation, operationWorkspace, onOpenTaskActivity, onOpenRun, onOpenSpawnRequest }) {
  const viewIds = useId();
  const [workspaceView, setWorkspaceView] = useState('workspace');
  const [attentionTarget, setAttentionTarget] = useState(null);
  const [attentionNotice, setAttentionNotice] = useState(null);
  const [activityScopePref, setActivityScopePref] = useState(null);
  const [activityNotice, setActivityNotice] = useState(null);
  const [activityFocusSeq, setActivityFocusSeq] = useState(0);
  const [workspaceFocusSeq, setWorkspaceFocusSeq] = useState(0);
  const [projectSnapshot, setProjectSnapshot] = useState(null);
  const [projectsSnapshot, setProjectsSnapshot] = useState(null);
  const targetSeq = useRef(0);
  const activityTargetRequest = useRef(0);
  const taskVerifications = useRef(new Map());
  const sizes = useWorkbenchStore((s) => s.sizes);
  const adeSelection = useWorkbenchStore((s) => s.adeSelection);
  const setAdeSelection = useWorkbenchStore((s) => s.setAdeSelection);
  const jumpPaletteOpen = useWorkbenchStore((s) => s.jumpPaletteOpen);
  const setJumpPaletteOpen = useWorkbenchStore((s) => s.setJumpPaletteOpen);
  // `active` dice qué canvas se ve (Workspace ADE o Ejecuciones); `modeActive`, si el modo Orquestador
  // es el visible. Oculto, nada consulta ni sondea: el estado local y la selección se conservan.
  const workspaceActive = active && modeActive;
  const selectedProjectId = adeSelection.projectId;
  const selectedTaskId = adeSelection.taskId;
  const selectedAttemptId = adeSelection.attemptId ?? null;
  // ÚNICA decisión legacy / task_attempt_v1 del ADE (LXO-120); los hijos la reciben por props.
  const coreModel = useCoreModel({ active: modeActive });
  // LXO-123: lo guardado con forma F2 se migra (o se invalida con aviso) en cuanto se sabe el modelo; una sola vez.
  const legacySelectionRef = useRef(readLegacyAdeSelection());
  const [navNotice, setNavNotice] = useState(null);
  useEffect(() => {
    const result = migratePersistedSelection(legacySelectionRef.current, coreModel);
    if (!result) return;
    legacySelectionRef.current = null;
    setAdeSelection(result.selection);
    if (result.notice) setNavNotice(result.notice);
  }, [coreModel, setAdeSelection]);
  // Projects/Tasks viven en la navegación unificada, también mientras el canvas
  // contextual muestra un Run. Las selecciones Core no se derivan de Runs.
  const projectViewActive = Boolean(workspaceActive && workspaceView === 'workspace' && selectedProjectId && !selectedTaskId);
  const onProjectSnapshot = useCallback((snapshot) => setProjectSnapshot(snapshot), []);
  const onProjectsSnapshot = useCallback((snapshot) => setProjectsSnapshot(snapshot), []);
  const currentProjectSnapshot = projectSnapshot?.projectId === selectedProjectId ? projectSnapshot : null;
  const projectOverview = {
    status: currentProjectSnapshot?.queryState ?? (selectedProjectId ? 'loading' : 'unknown'),
    data: currentProjectSnapshot?.project ? { projects: [currentProjectSnapshot.project] } : null,
    error: currentProjectSnapshot?.error ?? null,
    reason: currentProjectSnapshot?.reason ?? null,
  };
  const projectTasks = useCoreQuery('tasks_by_project', {
    project_id: selectedProjectId,
    status: 'all',
    limit: 50,
  }, { enabled: projectViewActive });
  const projectTaskContinuation = useProjectTaskContinuation(selectedProjectId, projectTasks, projectViewActive);
  const projectAttention = useCoreQuery('attention_list', {
    project_id: selectedProjectId,
  }, { enabled: projectViewActive });
  // Inventario de recursos de SOLO LECTURA (LXO-101): la foto que da el Core para el Project
  // durable seleccionado. `project_id` acota el alcance y `probe` viaja explícito para poder
  // comprobar el eco del Core. No escribe nada: ni git, ni disco, ni Tasks. El escaneo del Core
  // puede tardar más que el umbral del cliente; mientras tanto se conserva la última foto.
  const projectInventory = useCoreQuery('resource_inventory', {
    project_id: selectedProjectId,
    probe: true,
  }, { enabled: projectViewActive });
  // Activity del Project (LXO-204): la misma proyección de Events que la pestaña Activity, acotada
  // al Project durable y en orden descendente. Solo lectura.
  const projectActivity = useCoreQuery('activity_list', {
    cursor: '0',
    limit: PROJECT_ACTIVITY_LIMIT,
    order: 'desc',
    project_id: selectedProjectId,
    run_id: null,
    target_kind: null,
    target_id: null,
  }, { enabled: projectViewActive });
  const detail = useCoreQuery('task_detail', {
    project_id: selectedProjectId,
    task_id: selectedTaskId,
  }, { enabled: modeActive && Boolean(selectedProjectId) && Boolean(selectedTaskId) });
  const selectedProject = currentProjectSnapshot?.projectId === selectedProjectId
    ? currentProjectSnapshot.project
    : null;

  // Activity toma su alcance solo de IDs durables. Título y nombre son rótulos y se aceptan únicamente
  // cuando la respuesta corresponde a la selección actual.
  const activityScopeKind = resolveActivityScope(activityScopePref, selectedProjectId, selectedTaskId);
  const detailTask = detail.data?.task;
  const selectedTaskTitle = detailTask?.id === selectedTaskId && detailTask?.project_id === selectedProjectId
    ? detailTask.title
    : null;
  const selectedProjectName = selectedProject?.name ?? null;
  const activityScope = useMemo(() => {
    if (activityScopeKind === 'task') {
      return { kind: 'task', id: selectedTaskId, ...(selectedTaskTitle ? { title: selectedTaskTitle } : {}) };
    }
    if (activityScopeKind === 'project') {
      return { kind: 'project', id: selectedProjectId, ...(selectedProjectName ? { name: selectedProjectName } : {}) };
    }
    return { kind: 'global' };
  }, [activityScopeKind, selectedProjectId, selectedTaskId, selectedProjectName, selectedTaskTitle]);

  const overviewState = projectViewQueryState(projectOverview);
  const projectLocations = Array.isArray(selectedProject?.locations)
    ? selectedProject.locations.map((location) => ({
      machine: location.machine,
      path: location.path,
      primary: location.primary,
      state: location.state,
      last_seen: locationLastSeen(location.last_seen),
    }))
    : null;
  const projectLocationSlice = projectLocations
    ? projectViewSlice(projectOverview, projectLocations)
    : selectedProject
      ? { state: overviewState === 'ready' ? 'unknown' : overviewState, ...(projectOverview.status === 'refreshing' ? { refreshing: true } : {}), items: [], message: 'Core no incluyó ubicaciones en el overview de este Project.' }
      : overviewUnavailableSlice(projectOverview, 'ubicaciones');
  const projectCounts = selectedProject?.counts && typeof selectedProject.counts === 'object'
    ? selectedProject.counts
    : null;
  const projectSummary = {
    state: selectedProject
      ? projectCounts ? overviewState : overviewState === 'ready' ? 'unknown' : overviewState
      : overviewState === 'ready' ? 'unavailable' : overviewState,
    ...(projectOverview.status === 'refreshing' ? { refreshing: true } : {}),
    counts: {
      tasks: projectCounts?.tasks ?? null,
      active: projectCounts?.active ?? null,
      failed: projectCounts?.failed ?? null,
      review_ready: projectCounts?.attention?.by_category?.review_ready ?? null,
      attempts: null,
      attention: projectCounts?.attention?.total ?? null,
      resources: null,
    },
    ...(!selectedProject
      ? { message: ['unknown', 'unavailable'].includes(projectOverview.status)
        ? 'Core no confirmó metadata autoritativa para este Project.'
        : ['ready', 'empty', 'missing'].includes(projectOverview.status)
          ? 'El Project seleccionado no aparece en el overview activo de Core.'
          : projectQueryMessage(projectOverview) || 'No hay metadata autoritativa para este Project.' }
      : !projectCounts ? { message: 'Core no incluyó contadores para este Project.' } : {}),
  };
  const projectTaskDtos = projectTaskContinuation.items
    ?? uniqueProjectTasks(Array.isArray(projectTasks.data?.tasks) ? projectTasks.data.tasks : []);
  const projectTaskItems = projectTaskDtos.map((task) => ({ task_id: task.id, title: task.title, status: task.status }));
  const projectTaskSlice = {
    ...projectViewSlice(projectTasks, projectTaskItems, { hasMore: projectTaskContinuation.hasMore }),
    hasMore: projectTaskContinuation.hasMore,
    paginationStarted: projectTaskContinuation.started,
    loadingMore: projectTaskContinuation.loading,
    pendingMore: projectTaskContinuation.pending,
    loadMoreError: projectTaskContinuation.error,
    pageAnnouncement: projectTaskContinuation.announcement,
  };
  const projectAttentionItems = Array.isArray(projectAttention.data?.items)
    ? projectAttention.data.items.map((item) => ({
      attention_id: item.id,
      kind: item.category,
      ...(item.target_kind === 'task' ? { task_id: item.target_id } : {}),
      ...(item.target_kind === 'attempt' ? { attempt_id: item.target_id } : {}),
      project_id: item.project_id,
    }))
    : [];
  const projectAttentionSlice = projectViewSlice(projectAttention, projectAttentionItems, { hasMore: projectAttention.data?.has_more === true });
  const projectActivityItems = Array.isArray(projectActivity.data?.items)
    ? projectActivity.data.items.map(projectActivityItem)
    : [];
  const projectActivitySlice = projectViewSlice(projectActivity, projectActivityItems, { hasMore: projectActivity.data?.has_more === true });

  // Invalida la verificación de Activity en curso y retira solo su aviso «Verificando…»; otros avisos no son suyos.
  const invalidateActivityRequest = () => {
    const invalidated = activityTargetRequest.current;
    activityTargetRequest.current += 1;
    setActivityNotice((notice) => (notice?.pendingFor === invalidated ? null : notice));
  };

  const selectProject = (project) => {
    const projectId = typeof project === 'string' ? project : project?.projectId;
    if (typeof projectId !== 'string' || !projectId.trim()) return;
    invalidateActivityRequest();
    if (projectId !== selectedProjectId || selectedTaskId !== null) {
      setAdeSelection({ projectId, taskId: null });
    }
    setWorkspaceView('workspace');
    onActivate?.();
  };
  const selectTask = (task, context) => {
    const projectId = typeof task === 'string'
      ? selectedProjectId
      : task?.projectId ?? context?.projectId ?? selectedProjectId;
    const taskId = typeof task === 'string' ? task : task?.taskId ?? context?.taskId ?? null;
    if (typeof projectId !== 'string' || !projectId.trim()) return;
    invalidateActivityRequest();
    setAdeSelection({ projectId, taskId: typeof taskId === 'string' && taskId.trim() ? taskId : null });
    setWorkspaceView('workspace');
    onActivate?.();
  };
  // LXO-120: un Attempt se selecciona por su trío durable; la Task sigue siendo la del Attempt.
  const selectAttempt = ({ projectId, taskId, attemptId } = {}) => {
    if (![projectId, taskId, attemptId].every((value) => typeof value === 'string' && value.trim())) return;
    invalidateActivityRequest();
    setAdeSelection({ projectId, taskId, attemptId });
    setWorkspaceView('workspace');
    onActivate?.();
  };
  const changeWorkspaceView = (view) => {
    if (view !== 'activity') {
      invalidateActivityRequest();
      setActivityNotice(null);
    }
    setWorkspaceView(view);
    if (view !== 'attention') setAttentionNotice(null);
  };

  const openTaskActivity = (target) => {
    if (target?.projectId === selectedProjectId && target?.taskId === selectedTaskId) {
      setActivityScopePref('task');
      changeWorkspaceView('activity');
      setActivityFocusSeq((seq) => seq + 1);
      onActivate?.();
    }
    onOpenTaskActivity?.(target);
  };

  // Foco solo tras la acción explícita de la Task: el TaskWorkspace queda oculto y el foco pasa a la pestaña Activity.
  useEffect(() => {
    if (activityFocusSeq > 0) document.getElementById(`${viewIds}-tab-activity`)?.focus();
  }, [activityFocusSeq, viewIds]);

  // La navegación desde Activity oculta su panel: si el foco estaba dentro (o ya se perdió), pasa a la pestaña Workspace.
  useEffect(() => {
    if (workspaceFocusSeq > 0) document.getElementById(`${viewIds}-tab-workspace`)?.focus();
  }, [workspaceFocusSeq, viewIds]);
  const activityFocusNeedsRestore = () => {
    const current = document.activeElement;
    return !current || current === document.body
      || Boolean(document.getElementById(`${viewIds}-panel-activity`)?.contains(current));
  };

  // Una sola lectura `task_detail` por par durable en vuelo (A/B/A y reintentos tras timeout la reutilizan).
  // La ranura se libera cuando la consulta subyacente se asienta, nunca por el timeout de la UI.
  const verifyTask = (projectId, taskId) => {
    const key = JSON.stringify([projectId, taskId]);
    const inFlight = taskVerifications.current;
    let read = inFlight.get(key);
    if (!read) {
      read = new Promise((resolve) => resolve(readAdeTask(projectId, taskId)));
      inFlight.set(key, read);
      const release = () => {
        if (inFlight.get(key) === read) inFlight.delete(key);
      };
      read.then(release, release);
    }
    return withinVerifyPolicy(read);
  };

  // Activity entrega IDs durables. Se confirma el Project en la lista actual y la Task por su par exacto
  // antes de cambiar la selección, incluso cuando la página de Tasks no está activa.
  const openActivityTarget = async ({ kind, id, projectId } = {}) => {
    const requestId = ++activityTargetRequest.current;
    const notify = (text, { pending = false } = {}) => setActivityNotice({ text, pendingFor: pending ? requestId : null });
    setActivityNotice(null);
    if (typeof id !== 'string' || !id.trim()) return;
    // `refreshing` conserva la última lectura sana del overview (no es stale/error), así que sigue validando.
    const projectSnapshotReady = ['ready', 'empty', 'refreshing'].includes(projectsSnapshot?.queryState);
    const projectExists = (candidate) => projectSnapshotReady
      && Array.isArray(projectsSnapshot.projectIds)
      && projectsSnapshot.projectIds.includes(candidate);
    if (kind === 'project') {
      if (!projectSnapshotReady) {
        notify(`No se pudo verificar el Project ${id} en el overview de Core; no se cambió la selección.`);
        return;
      }
      if (!projectExists(id)) {
        notify(`El Project ${id} no aparece en el overview activo de Core.`);
        return;
      }
      const restoreFocus = activityFocusNeedsRestore();
      selectProject(id);
      if (restoreFocus) setWorkspaceFocusSeq((seq) => seq + 1);
    } else if (kind === 'task') {
      if (typeof projectId !== 'string' || !projectId.trim()) {
        notify(`La Task ${id} no se puede abrir desde Activity: el evento no identifica su Project.`);
        return;
      }
      if (!projectSnapshotReady) {
        notify(`No se pudo verificar el Project ${projectId} en el overview de Core; no se cambió la selección.`);
        return;
      }
      if (!projectExists(projectId)) {
        notify(`El Project ${projectId} no aparece en el overview activo de Core.`);
        return;
      }

      const openVerifiedTask = () => {
        const restoreFocus = activityFocusNeedsRestore();
        selectTask({ projectId, taskId: id });
        if (restoreFocus) setWorkspaceFocusSeq((seq) => seq + 1);
      };
      // La Task ya seleccionada tiene su `task_detail` sano en el shell: se reutiliza sin repetir la lectura.
      const loaded = detail.data?.task;
      if (projectId === selectedProjectId && id === selectedTaskId
        && ['ready', 'refreshing'].includes(detail.status)
        && loaded?.id === id && loaded.project_id === projectId) {
        openVerifiedTask();
        return;
      }

      notify(`Verificando la Task ${id} en el Project ${projectId}…`, { pending: true });
      try {
        const response = await verifyTask(projectId, id);
        if (requestId !== activityTargetRequest.current) return;
        if (response?.task?.id !== id || response.task.project_id !== projectId) {
          notify(`Core no confirmó la Task ${id} del Project ${projectId}; no se cambió la selección.`);
          return;
        }
        setActivityNotice(null);
        openVerifiedTask();
      } catch (error) {
        if (requestId !== activityTargetRequest.current) return;
        const message = error instanceof Error ? error.message : String(error ?? '');
        if (/project_not_found/i.test(message)) {
          notify(`El Project ${projectId} ya no está disponible en Core.`);
        } else if (/task_not_found|_not_found/i.test(message)) {
          notify(`La Task ${id} ya no está disponible en el Project ${projectId}.`);
        } else if (/ade_query_timeout/i.test(message)) {
          notify(`Core no respondió a tiempo al verificar la Task ${id} del Project ${projectId}; no se cambió la selección.`);
        } else {
          notify(`Core no pudo verificar la Task ${id} del Project ${projectId}; no se cambió la selección.`);
        }
      }
    } else if (kind === 'attempt') {
      // LXO-123: el Attempt se abre con su Task (`<task>-a<n>`) tras confirmar el Project; un destino stale lo explica.
      const resolved = resolveNavTarget({ kind, id, projectId }, coreModel);
      if (resolved.action !== 'select') {
        notify(navRejectText(resolved.reason));
        return;
      }
      if (!projectSnapshotReady) {
        notify(`No se pudo verificar el Project ${projectId} en el overview de Core; no se cambió la selección.`);
        return;
      }
      if (!projectExists(projectId)) {
        notify(`El Project ${projectId} no aparece en el overview activo de Core.`);
        return;
      }
      const restoreFocus = activityFocusNeedsRestore();
      selectAttempt(resolved.selection);
      if (restoreFocus) setWorkspaceFocusSeq((seq) => seq + 1);
    }
  };

  // Attention de un target: filtro por (kind + ID durable) resuelto por el Core, no por la página global.
  const openAttentionFilter = ({ kind, id, projectId }) => {
    targetSeq.current += 1;
    setAttentionTarget({ kind, id, projectId: typeof projectId === 'string' && projectId ? projectId : null, seq: targetSeq.current });
    setAttentionNotice(null);
    invalidateActivityRequest();
    setWorkspaceView('attention');
    onActivate?.();
  };
  const openTaskAttention = ({ projectId, taskId }) => {
    if (typeof taskId !== 'string' || !taskId.trim()) return;
    openAttentionFilter({ kind: 'task', id: taskId, projectId });
  };
  const openProjectAttention = (attentionId) => {
    const item = projectAttention.data?.items.find((candidate) => candidate.id === attentionId);
    if (!item || typeof item.target_kind !== 'string' || typeof item.target_id !== 'string' || !item.target_id.trim()) return;
    openAttentionFilter({ kind: item.target_kind, id: item.target_id, projectId: item.project_id });
  };
  const clearAttentionTarget = useCallback(() => setAttentionTarget(null), []);

  // Cada fila enruta solo por su par (target_kind, target_id) durable; nunca por títulos ni por rutas.
  const openAttentionTarget = ({ kind, id, projectId }) => {
    const unavailable = (what) => setAttentionNotice(`${what} ya no está disponible en esta superficie.`);
    setAttentionNotice(null);
    if (kind === 'project') {
      invalidateActivityRequest();
      setAdeSelection({ projectId: id, taskId: null });
      setWorkspaceView('workspace');
      onActivate?.();
    } else if (kind === 'task') {
      if (!projectId) {
        setAttentionNotice(`La Attention de la Task ${id} no trae Project: no se puede abrir en el Workspace.`);
        return;
      }
      invalidateActivityRequest();
      setAdeSelection({ projectId, taskId: id });
      setWorkspaceView('workspace');
      onActivate?.();
    } else if (kind === 'attempt') {
      // LXO-123: Attention de un Attempt abre ese Attempt (con su Task), en un solo paso.
      const resolved = resolveNavTarget({ kind, id, projectId }, coreModel);
      if (resolved.action !== 'select') {
        setAttentionNotice(navRejectText(resolved.reason));
        return;
      }
      selectAttempt(resolved.selection);
    } else if (kind === 'run') {
      if (typeof onOpenRun !== 'function' || onOpenRun(id) !== true) unavailable(`El Run ${id}`);
    } else if (kind === 'spawn_request') {
      if (typeof onOpenSpawnRequest !== 'function' || onOpenSpawnRequest(id) !== true) unavailable(`La solicitud de lanzamiento ${id}`);
    } else {
      setAttentionNotice(`Esta vista aún no abre destinos de tipo ${kind} (${id}).`);
    }
  };
  // Jump Palette (LXO-102): selecciona IDs exactos o abre el destino exacto de una Attention; sin fallback entre tipos.
  const closeJumpPalette = useCallback(() => setJumpPaletteOpen(false), [setJumpPaletteOpen]);
  const jumpTo = (target) => {
    if (target.kind === 'project') {
      setAdeSelection({ projectId: target.projectId, taskId: null });
      changeWorkspaceView('workspace');
      onActivate?.();
      return { ok: true };
    }
    if (target.kind === 'task') {
      setAdeSelection({ projectId: target.projectId, taskId: target.taskId });
      changeWorkspaceView('workspace');
      onActivate?.();
      return { ok: true };
    }
    const { targetKind, targetId, projectId } = target;
    if (targetKind === 'attempt') {
      const resolved = resolveNavTarget({ kind: 'attempt', id: targetId, projectId }, coreModel);
      if (resolved.action !== 'select') return { ok: false, message: navRejectText(resolved.reason) };
      selectAttempt(resolved.selection);
      return { ok: true };
    }
    if (targetKind === 'project' || targetKind === 'task') {
      openAttentionFilter({ kind: targetKind, id: targetId, projectId });
      return { ok: true };
    }
    if (targetKind === 'run') {
      return typeof onOpenRun === 'function' && onOpenRun(targetId) === true
        ? { ok: true }
        : { ok: false, message: `El Run ${targetId} ya no está disponible en esta superficie.` };
    }
    if (targetKind === 'spawn_request') {
      return typeof onOpenSpawnRequest === 'function' && onOpenSpawnRequest(targetId) === true
        ? { ok: true }
        : { ok: false, message: `La solicitud de lanzamiento ${targetId} ya no está disponible en esta superficie.` };
    }
    return { ok: false, message: `Esta vista aún no abre destinos de tipo ${targetKind} (${targetId}).` };
  };
  // Un solo estado `task_detail` alimenta canvas e Inspector: no hay segunda consulta.
  const workspaceProps = {
    projectId: selectedProjectId,
    taskId: selectedTaskId,
    detail,
    project: selectedProject,
    // Devuelve `true` solo si aceptó el target exacto (mismo Project); el workspace usa esa confirmación para el foco.
    onNavigate: ({ projectId, taskId }) => {
      if (projectId !== selectedProjectId || typeof taskId !== 'string' || !taskId.trim() || taskId === selectedTaskId) return false;
      selectTask(taskId);
      return true;
    },
    onOpenActivity: openTaskActivity,
    onOpenAttention: openTaskAttention,
  };

  return (
    <div
      className="wb wb--orch ade__layout"
      data-testid="ade-composition"
    >
      <JumpPaletteHost open={jumpPaletteOpen && modeActive} onClose={closeJumpPalette} onNavigate={jumpTo} />
      {modeActive && <StartupCutNotice storage={coreModel.storage ?? null} />}
      {modeActive && navNotice && (
        <div className={`ade-notice ade-notice--${navNoticeCopy(navNotice).tone}`} role="status" data-testid="ade-nav-notice" data-notice={navNotice}>
          <span>{navNoticeCopy(navNotice).text}</span>{' '}
          <button type="button" className="lk" onClick={() => setNavNotice(null)}>{COPY.cutDismiss}</button>
        </div>
      )}
      <Collapse open={leftOpen} size={Math.max(sizes.side, 280) + 8}>
        <Panel id="ade-nav" className="sidepanel ade__nav">
          <div className="panelhead"><span className="panelhead__title">Orquestador</span><span className="ade__source">Navegador</span><AdeSourceSwitch /></div>
          <div className="ade__nav-content">
            <section className="ade__nav-section ade__nav-scroll-region ade__nav-projects-scroll" aria-label="Projects y Tasks" tabIndex={0}>
              <ProjectsSidebar
                selection={selectedAttemptId
                  ? { projectId: selectedProjectId, taskId: selectedTaskId, attemptId: selectedAttemptId }
                  : { projectId: selectedProjectId, taskId: selectedTaskId }}
                coreModel={coreModel}
                onSelectProject={selectProject}
                onSelectTask={selectTask}
                onSelectAttempt={selectAttempt}
                onProjectSnapshot={onProjectSnapshot}
                onProjectsSnapshot={onProjectsSnapshot}
                active={modeActive}
              />
            </section>
            {operationNavigation && (
              <div className="ade__nav-scroll-region ade__nav-operation-scroll" role="region" aria-label="Navegación de Operación" tabIndex={0}>
                {operationNavigation}
              </div>
            )}
          </div>
        </Panel>
        <Gutter sizeKey="side" />
      </Collapse>

      <div className="ade__canvas-stack">
        <div className={`ade__context-canvas ade__execution-canvas${active ? ' is-hidden' : ''}`} aria-hidden={active} inert={active} data-testid="execution-composition">
          {operationWorkspace}
        </div>
        <div className={`ade__context-canvas ade__workspace-canvas${active ? '' : ' is-hidden'}`} aria-hidden={!active} inert={!active}>
          <Panel id="ade-workspace" className="wb__grow orch__main ade__workspace">
            <div className="panelhead ade__workspace-head">
              <WorkspaceViewSwitch view={workspaceView} onChange={changeWorkspaceView} idPrefix={viewIds} />
              {selectedTaskId && <span className="ade__durable-id mono">Task · {selectedTaskId}</span>}
            </div>
            <div
              className="ade-view-panel"
              role="tabpanel"
              id={`${viewIds}-panel-workspace`}
              aria-labelledby={`${viewIds}-tab-workspace`}
              hidden={workspaceView !== 'workspace'}
            >
              {!selectedProjectId && <div className="ade__workspace-empty changes__empty">Selecciona un Project del Core.</div>}
              {selectedProjectId && !selectedTaskId && (
                <div className="ade__task-overview scroll">
                  <ProjectView
                    projectId={selectedProjectId}
                    projectName={selectedProject?.name}
                    locations={projectLocationSlice}
                    summary={projectSummary}
                    tasks={projectTaskSlice}
                    onLoadMoreTasks={projectTaskContinuation.loadMore}
                    attention={projectAttentionSlice}
                    activity={projectActivitySlice}
                    // El slice legacy de Resources (resource_id/kind/label/availability) no lo da ninguna
                    // query de Core: se declara no disponible, nunca vacío. La foto real de repos,
                    // worktrees y ramas conservadas es el inventario de solo lectura de abajo.
                    resources={{ state: 'unavailable', items: [], message: 'Core no da un listado de Resources; su foto de solo lectura es el inventario de esta sección.' }}
                    resourceInventory={projectInventory.data ?? null}
                    resourceInventoryStatus={resourceInventoryStatus(projectInventory)}
                    onRetryResourceInventory={projectInventory.retry}
                    onOpenTask={selectTask}
                    onOpenAttention={openProjectAttention}
                  />
                  {/* Qué ofrece cada proveedor (LXO-135): lo que dice el Core, no lo que se supone por su nombre. */}
                  <ProviderInspector active={workspaceActive && workspaceView === 'workspace'} />
                  {/* Cuánta cuota le queda a la cuenta de cada proveedor (LXO-206): el Core consulta en segundo plano. */}
                  <UsageView active={workspaceActive && workspaceView === 'workspace'} />
                  {/* Qué contexto viajaría en un ContextPackage (LXO-136): solo lectura, antes de cualquier transferencia. */}
                  <ContextPreview />
                </div>
              )}
              {selectedTaskId && (
                <div className="ade__task-overview scroll">
                  <TaskWorkspace {...workspaceProps} variant="workspace" />
                  <AttemptHistory
                    taskId={selectedTaskId}
                    coreModel={coreModel}
                    active={workspaceActive && workspaceView === 'workspace'}
                    selectedAttemptId={selectedAttemptId}
                    onSelectAttempt={(attemptId) => selectAttempt({ projectId: selectedProjectId, taskId: selectedTaskId, attemptId })}
                    onBack={() => selectTask({ projectId: selectedProjectId, taskId: null })}
                  />
                  {selectedAttemptId && (
                    <AttemptDetail
                      attemptId={selectedAttemptId}
                      taskId={selectedTaskId}
                      coreModel={coreModel}
                      active={workspaceActive && workspaceView === 'workspace'}
                      onSelectTask={(taskId) => selectTask({ projectId: selectedProjectId, taskId })}
                      onBack={() => selectTask({ projectId: selectedProjectId, taskId: null })}
                    />
                  )}
                </div>
              )}
            </div>
            {/* Siempre montado: conserva filtros y target; sin vista activa no consulta ni sondea. */}
            <div
              className="ade-view-panel"
              role="tabpanel"
              id={`${viewIds}-panel-attention`}
              aria-labelledby={`${viewIds}-tab-attention`}
              hidden={workspaceView !== 'attention'}
            >
              {attentionNotice && <div className="ade__notice" role="status">{attentionNotice}</div>}
              <AttentionInbox
                active={workspaceActive && workspaceView === 'attention'}
                target={attentionTarget}
                onClearTarget={clearAttentionTarget}
                onOpenTarget={openAttentionTarget}
              />
            </div>
            {/* Siempre montado: conserva el historial paginado; sin vista activa no consulta ni sondea. */}
            <div
              className="ade-view-panel"
              role="tabpanel"
              id={`${viewIds}-panel-activity`}
              aria-labelledby={`${viewIds}-tab-activity`}
              hidden={workspaceView !== 'activity'}
            >
              <div className="ade__section-head" role="group" aria-label="Alcance de Activity">
                <div className="ade-view-switch">
                  {ACTIVITY_SCOPES.map(({ kind, label }) => {
                    const enabled = kind === 'global' || (kind === 'project' ? Boolean(selectedProjectId) : Boolean(selectedProjectId && selectedTaskId));
                    return (
                      <button
                        key={kind}
                        type="button"
                        className={`ade-view-switch__tab${kind === activityScopeKind ? ' is-active' : ''}`}
                        aria-pressed={kind === activityScopeKind}
                        disabled={!enabled}
                        onClick={() => { setActivityScopePref(kind); setActivityNotice((notice) => (notice?.pendingFor == null ? null : notice)); }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {activityNotice && <div className="ade__notice" role="status">{activityNotice.text}</div>}
              <ActivityPanel
                scope={activityScope}
                active={workspaceActive && workspaceView === 'activity'}
                onOpenTarget={openActivityTarget}
              />
            </div>
          </Panel>

          <RightDock
            id="ade-inspector"
            sizeKey="inspector"
            className="ade__inspector"
            open={rightOpen}
            visible={workspaceActive}
            keepMountedWhenHidden
            drawerOpen={drawerOpen}
            onCloseDrawer={onCloseDrawer}
          >
            <div className="panelhead"><span className="panelhead__title">Inspector</span></div>
            <div className="ade__inspector-content">
              <section className="ade__inspector-section">
                <div className="ssec__label">Selección ADE</div>
                <div className="ade__selection-row"><span>Project ID</span><span className="mono">{selectedProjectId || 'Ninguno'}</span></div>
                <div className="ade__selection-row"><span>Task ID</span><span className="mono">{selectedTaskId || 'Ninguna'}</span></div>
                {selectedAttemptId && <div className="ade__selection-row"><span>Attempt ID</span><span className="mono">{selectedAttemptId}</span></div>}
              </section>
              {selectedTaskId && <TaskWorkspace {...workspaceProps} variant="inspector" />}
            </div>
          </RightDock>
        </div>
      </div>
    </div>
  );
}
