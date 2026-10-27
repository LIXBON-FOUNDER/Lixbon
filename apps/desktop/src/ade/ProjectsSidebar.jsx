import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useCoreQuery } from './useCoreQuery';
import { ProjectTasks } from './ProjectTasks';
import { useTreeNavigation } from './useTreeNavigation';
import { UNKNOWN_CORE_MODEL } from './useCoreModel';
import { coreErrorCode, isLegacyModelCode } from './coreModelContract';
import { COPY } from './adeLabels';
import { AttemptTreeContext, attemptKey, taskKeyOfAttemptKey } from './SidebarAttempts';
import {
  ALL_TASKS_VIEW,
  EMPTY_PROJECT_IDS,
  Feedback,
  PROJECT_STATUS_LABELS,
  TASK_STATUS_VIEWS,
  attentionSummary,
  countValue,
  metaValue,
  primaryLocation,
  projectIdOfTaskKey,
  projectKey,
  selectedProjectQueryState,
  taskKey,
  toProjectSummary,
  toProjectViewSummary,
  toTaskSummary,
} from './projectsSidebarModel';
import './ProjectsSidebar.css';

export {
  TASK_STATUS_LABELS,
  PROJECT_STATUS_LABELS,
  TASK_STATUS_VIEWS,
  ATTENTION_CATEGORY_LABELS,
  NOT_REPORTED,
  byCoreTaskOrder,
  toProjectSummary,
  toTaskSummary,
} from './projectsSidebarModel';

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
  onSelectAttempt,
  coreModel: coreModelProp,
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
  // LXO-120 · Task → Attempt. Todo esto es estado de presentación: no lee ni escribe el Core.
  // La decisión legacy / task_attempt_v1 la toma `useCoreModel` en el host (AdeShell) y llega aquí.
  const coreModel = coreModelProp ?? UNKNOWN_CORE_MODEL;
  const [vNextRejected, setVNextRejected] = useState(null);
  const vNext = coreModel.vNext && vNextRejected !== coreModel.modelKey;
  const [taskExpandOverrides, setTaskExpandOverrides] = useState(() => new Map());
  const [expandableTaskKeys, setExpandableTaskKeys] = useState(() => new Set());
  const [attemptIdsByTaskKey, setAttemptIdsByTaskKey] = useState({});
  const selectedAttemptId = selectedTaskId && typeof selection?.attemptId === 'string' ? selection.attemptId : null;
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
  // Oculta la sección, `overview.data` es `null`. El árbol sigue montado con la última lista leída (inerte,
  // sin consultar Core) y durante una reactivación mientras la lectura aún no tiene datos. Los snapshots
  // publicados al host siguen saliendo de `projects`, que sin una respuesta autoritativa queda vacío.
  const preservedOverviewRef = useRef(null);
  if (overview.data) preservedOverviewRef.current = { archived, projects: overview.data.projects };
  const preservedOverview = preservedOverviewRef.current?.archived === archived ? preservedOverviewRef.current : null;
  const treeProjects = overview.data ? projects : preservedOverview?.projects ?? projects;
  const treeProjectsArePreserved = !overview.data && Boolean(preservedOverview);
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

  // Nodos visibles del árbol, en orden, como `{kind, id}` (más su clave de fila). El teclado y el
  // roving tabindex trabajan sobre esta lista (`useTreeNavigation`).
  const treeNodes = useMemo(() => {
    const nodes = [];
    for (const project of treeProjects) {
      const pKey = projectKey(project.id);
      const taskIds = expanded.has(project.id) ? taskIdsByProject[project.id] ?? [] : [];
      nodes.push({
        key: pKey, kind: 'project', id: project.id, parentKey: null, expandable: true,
        expanded: expanded.has(project.id), firstChildKey: taskIds[0] ? taskKey(project.id, taskIds[0]) : null,
      });
      for (const taskId of taskIds) {
        const tKey = taskKey(project.id, taskId);
        const expandable = vNext && expandableTaskKeys.has(tKey);
        const isOpen = expandable && (taskExpandOverrides.get(tKey) ?? true);
        const attemptIds = isOpen ? attemptIdsByTaskKey[tKey] ?? [] : [];
        nodes.push({
          key: tKey, kind: 'task', id: taskId, projectId: project.id, parentKey: pKey, expandable, expanded: isOpen,
          firstChildKey: attemptIds[0] ? attemptKey(project.id, taskId, attemptIds[0]) : null,
        });
        for (const attemptId of attemptIds) {
          nodes.push({ key: attemptKey(project.id, taskId, attemptId), kind: 'attempt', id: attemptId, parentKey: tKey, expandable: false, expanded: false, firstChildKey: null });
        }
      }
    }
    return nodes;
  }, [treeProjects, expanded, taskIdsByProject, vNext, expandableTaskKeys, taskExpandOverrides, attemptIdsByTaskKey]);
  const visibleKeys = useMemo(() => treeNodes.map((node) => node.key), [treeNodes]);

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
    if (activeKey?.startsWith('a:')) {
      const parentTaskKey = taskKeyOfAttemptKey(activeKey);
      if (visibleKeys.includes(parentTaskKey)) return parentTaskKey;
    }
    if (activeKey?.startsWith('t:') || activeKey?.startsWith('a:')) {
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

  const onTreeKeyDown = useTreeNavigation({
    nodes: treeNodes,
    focusKey: (key) => {
      setActiveKey(key);
      focusItem(key);
    },
    setExpanded: (node, next) => {
      if (node.kind === 'project') setExpandedTo(node.id, next);
      if (node.kind === 'task') setTaskExpanded(node.key, next);
    },
  });

  const setTaskExpanded = (key, next) => {
    setTaskExpandOverrides((current) => {
      if (current.get(key) === next) return current;
      const updated = new Map(current);
      updated.set(key, next);
      return updated;
    });
  };
  const onTaskExpandable = useCallback((key, expandable) => {
    setExpandableTaskKeys((current) => {
      if (current.has(key) === expandable) return current;
      const updated = new Set(current);
      if (expandable) updated.add(key); else updated.delete(key);
      return updated;
    });
  }, []);
  const onAttemptIds = useCallback((key, ids) => {
    setAttemptIdsByTaskKey((current) => {
      const previous = current[key];
      if (ids === null) {
        if (!previous) return current;
        const { [key]: _removed, ...rest } = current;
        return rest;
      }
      if (previous && previous.length === ids.length && previous.every((id, index) => id === ids[index])) return current;
      return { ...current, [key]: ids };
    });
  }, []);
  // Si una lectura vNext dice que el modelo no está activo, el sidebar vuelve a F2 para ese modelo.
  const modelKey = coreModel.modelKey;
  const onModelCode = useCallback((error) => {
    if (isLegacyModelCode(coreErrorCode(error))) setVNextRejected(modelKey);
  }, [modelKey]);
  const activateAttempt = ({ projectId, taskId, attemptId }) => {
    setActiveKey(attemptKey(projectId, taskId, attemptId));
    const project = projects.find((candidate) => candidate.id === projectId);
    if (selected.projectId !== projectId && project) onSelectProject?.(toProjectSummary(project));
    if (!selectionControlled) setUncontrolledSelection({ projectId, taskId, taskProjectId: projectId });
    onSelectAttempt?.({ projectId, taskId, attemptId });
  };
  const backToProject = (projectId) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (project) selectProject(project);
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

  const attemptTree = {
    active,
    pollMs,
    vNext,
    modelKey: vNext ? modelKey : 'legacy',
    selection: { projectId: selected.projectId, taskId: selected.taskId, attemptId: selectedAttemptId },
    isTaskExpanded: (key) => taskExpandOverrides.get(key) ?? true,
    setTaskExpanded,
    onTaskExpandable,
    isActiveKey: (key) => key === effectiveActiveKey,
    registerRef: registerItem,
    onFocusKey,
    onKeyDown: onTreeKeyDown,
    onAttemptIds,
    onModelCode,
    onActivateAttempt: activateAttempt,
    onBackToProject: backToProject,
  };

  return (
    <AttemptTreeContext.Provider value={attemptTree}>
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

      {treeProjects.length > 0 && (
        <ul
          className="ps__tree scroll"
          role="tree"
          aria-label="Projects y Tasks del Core"
          aria-busy={overview.status === 'refreshing' || (active && treeProjectsArePreserved)}
        >
          {treeProjects.map((project, index) => {
            const isExpanded = expanded.has(project.id);
            return (
              <ProjectRow
                key={project.id}
                project={project}
                expanded={isExpanded}
                selected={project.id === selected.projectId && !selected.taskId}
                context={project.id === selected.projectId && Boolean(selected.taskId)}
                position={index + 1}
                setSize={treeProjects.length}
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
        Solo lectura: sin crear, reintentar ni lanzar Tasks o intentos, sin arrastrar y sin marcar como leído.
        La identidad de cada fila es su ID durable; host, origen, rama y worktree son metadato.
      </p>
      {coreModel.mode === 'legacy' && (
        <p className="ps__note ps__note--info" role="status" data-testid="core-model-legacy">{COPY.modelInactive}</p>
      )}
    </section>
    </AttemptTreeContext.Provider>
  );
}
