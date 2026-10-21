import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Collapse } from '../layout/Collapse';
import { Gutter } from '../layout/Gutter';
import { Panel } from '../layout/Panel';
import { RightDock } from '../layout/RightDock';
import { useWorkbenchStore } from '../store/workbenchStore';
import { ActivityPanel } from './ActivityPanel';
import { AttentionInbox } from './AttentionInbox';
import { JumpPaletteHost } from './JumpPaletteHost';
import { ProjectView } from './ProjectView';
import { TaskWorkspace } from './TaskWorkspace';
import { useCoreQuery } from './useCoreQuery';
import './AdeShell.css';
import './TaskWorkspace.css';

const STATUS_LABELS = {
  starting: 'Iniciando',
  running: 'En ejecución',
  waiting: 'Esperando',
  awaiting_terminal_approval: 'Esperando aprobación de terminal',
  done: 'Terminada',
  failed: 'Fallida',
  stopped: 'Detenida',
  exited: 'Cerrada',
};

function describeCoreError(error) {
  if (/(_unavailable|degraded|almac[eé]n.*no disponible)/i.test(error)) return 'Core no tiene un almacén autoritativo disponible.';
  if (/(_auth_required|authentication|unauthorized)/i.test(error)) return 'Core no pudo autenticar esta lectura.';
  if (/(_not_found)/i.test(error)) return 'El Project o la Task ya no está disponible con ese ID.';
  if (/(_read_failed|_internal)/i.test(error)) return 'Core no pudo leer este dato.';
  if (/(disconnected|connection|transport|timeout|ipc.*closed)/i.test(error)) return 'No se pudo completar la conexión con Core.';
  return 'Core devolvió un error al leer este dato.';
}

function projectViewQueryState(query) {
  if (query.status === 'ready' || query.status === 'empty') return 'ready';
  if (query.status === 'loading' || query.status === 'refreshing') return 'loading';
  if (query.status === 'stale' || query.status === 'degraded') return 'degraded';
  if (query.status === 'error' || query.status === 'disconnected') return 'error';
  return 'unavailable';
}

function projectViewSlice(query, items, { hasMore = false } = {}) {
  const queryState = projectViewQueryState(query);
  const state = queryState === 'ready' && hasMore ? 'partial' : queryState;
  const canShowItems = ['ready', 'partial', 'loading', 'degraded'].includes(state);
  const messages = [];
  if (query.status === 'stale') {
    messages.push(`Datos desactualizados; se conserva la última respuesta. ${query.error || ''}`.trim());
  } else if (query.status === 'refreshing') {
    messages.push('Actualizando desde Core.');
  } else if (query.error) {
    messages.push(query.error);
  }
  if (hasMore) messages.push('Core indica que hay más elementos después de esta página.');
  return {
    state,
    items: canShowItems && Array.isArray(items) ? items : [],
    ...(messages.length ? { message: messages.join(' ') } : {}),
  };
}

function overviewUnavailableSlice(projects, subject) {
  if (['ready', 'empty'].includes(projects.status)) {
    return { state: 'unavailable', items: [], message: `El Project seleccionado no aparece en el overview activo de Core; no hay ${subject} autoritativos para mostrar.` };
  }
  return projectViewSlice(projects, []);
}

function locationLastSeen(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function QueryFeedback({ state, subject }) {
  if (state.status === 'idle' || state.status === 'ready' || state.status === 'empty') return null;
  if (state.status === 'loading') return <div className="ade__query-state" role="status">Conectando con Core para cargar {subject}…</div>;
  if (state.status === 'refreshing') return null;
  if (state.status === 'stale') {
    return (
      <div className="ade__query-state ade__query-state--stale" role="status">
        <span>Datos desactualizados · Core {state.reason === 'disconnected' ? 'desconectado' : state.reason === 'degraded' ? 'degradado' : 'con error'}. Se conserva la última respuesta. {describeCoreError(state.error)}</span>
        <code>{state.error}</code>
        <button type="button" className="lk" onClick={state.retry}>Reintentar</button>
      </div>
    );
  }
  const title = state.status === 'disconnected' ? 'Core desconectado' : state.status === 'degraded' ? 'Core degradado' : 'Error de Core';
  return (
    <div className="ade__query-state ade__query-state--error" role="alert">
      <strong>{title}</strong>
      <span>{describeCoreError(state.error)}</span>
      <code>{state.error}</code>
      <button type="button" className="lk" onClick={state.retry}>Reintentar</button>
    </div>
  );
}

function CoreProjectButton({ project, selected, onSelect }) {
  const idDescription = useId();
  return (
    <button
      type="button"
      className={`ade__project${selected ? ' is-active' : ''}`}
      aria-label={project.name}
      aria-describedby={idDescription}
      aria-pressed={selected}
      onClick={() => onSelect(project.id)}
    >
      <span className="ade__project-name">{project.name}</span>
      <span id={idDescription} className="ade__durable-id mono">{project.id}</span>
    </button>
  );
}

function CoreTaskButton({ task, selected, onSelect }) {
  const idDescription = useId();
  return (
    <button
      type="button"
      className={`ade__task${selected ? ' is-active' : ''}`}
      aria-label={task.title}
      aria-describedby={idDescription}
      aria-pressed={selected}
      onClick={() => onSelect(task.id)}
    >
      <span className="ade__task-name">{task.title}</span>
      <span className="ade__task-meta"><span>{STATUS_LABELS[task.status] || task.status}</span><span id={idDescription} className="ade__durable-id mono">{task.id}</span></span>
    </button>
  );
}

const WORKSPACE_VIEWS = [
  { key: 'workspace', label: 'Workspace' },
  { key: 'attention', label: 'Attention' },
  { key: 'activity', label: 'Activity' },
];

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
// subvista Activity con alcance Task; `onOpenTaskActivity` (opcional) además recibe `{ projectId, taskId }`.
// `onOpenRun(runId)` / `onOpenSpawnRequest(pendingId)` son los callbacks existentes de Operación: reciben el
// ID durable exacto y devuelven `true` si lo abrieron (o `false` si ya no existe en esa superficie).
export function AdeShell({ active, leftOpen, rightOpen, drawerOpen, onCloseDrawer, onActivate, operationNavigation, operationWorkspace, onOpenTaskActivity, onOpenRun, onOpenSpawnRequest }) {
  const viewIds = useId();
  const [workspaceView, setWorkspaceView] = useState('workspace');
  const [attentionTarget, setAttentionTarget] = useState(null);
  const [attentionNotice, setAttentionNotice] = useState(null);
  const [activityScopePref, setActivityScopePref] = useState(null);
  const [activityNotice, setActivityNotice] = useState(null);
  const [activityFocusSeq, setActivityFocusSeq] = useState(0);
  const targetSeq = useRef(0);
  const sizes = useWorkbenchStore((s) => s.sizes);
  const adeSelection = useWorkbenchStore((s) => s.adeSelection);
  const setAdeSelection = useWorkbenchStore((s) => s.setAdeSelection);
  const jumpPaletteOpen = useWorkbenchStore((s) => s.jumpPaletteOpen);
  const setJumpPaletteOpen = useWorkbenchStore((s) => s.setJumpPaletteOpen);
  const selectedProjectId = adeSelection.projectId;
  const selectedTaskId = adeSelection.taskId;
  // Projects/Tasks viven en la navegación unificada, también mientras el canvas
  // contextual muestra un Run. Las selecciones Core no se derivan de Runs.
  const projects = useCoreQuery('projects_overview', { archived: 'exclude' });
  const tasks = useCoreQuery('tasks_by_project', {
    project_id: selectedProjectId,
    status: 'active',
    limit: 50,
  }, { enabled: Boolean(selectedProjectId) });
  const projectViewActive = Boolean(active && workspaceView === 'workspace' && selectedProjectId && !selectedTaskId);
  const projectTasks = useCoreQuery('tasks_by_project', {
    project_id: selectedProjectId,
    status: 'all',
    limit: 50,
  }, { enabled: projectViewActive });
  const projectAttention = useCoreQuery('attention_list', {
    project_id: selectedProjectId,
  }, { enabled: projectViewActive });
  const detail = useCoreQuery('task_detail', {
    project_id: selectedProjectId,
    task_id: selectedTaskId,
  }, { enabled: Boolean(selectedProjectId) && Boolean(selectedTaskId) });
  const selectedProject = projects.data?.projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedProjectInOverview = projects.data?.projects.some((project) => project.id === selectedProjectId);
  const selectedProjectMissing = selectedProjectId && ['ready', 'empty'].includes(projects.status) && !selectedProjectInOverview;
  const selectedTaskMissingFromCompletePage = selectedTaskId && tasks.data && !tasks.data.has_more
    && !tasks.data.tasks.some((item) => item.id === selectedTaskId);

  // El alcance de Activity sale solo de los IDs durables seleccionados; nombre/título son rótulo, no identidad.
  const activityScopeKind = resolveActivityScope(activityScopePref, selectedProjectId, selectedTaskId);
  const detailTask = detail.data?.task;
  const selectedTaskTitle = (detailTask?.id === selectedTaskId && detailTask?.project_id === selectedProjectId
    ? detailTask.title
    : tasks.data?.tasks.find((item) => item.id === selectedTaskId)?.title) ?? null;
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

  const overviewState = projectViewQueryState(projects);
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
    ? projectViewSlice(projects, projectLocations)
    : selectedProject
      ? { state: overviewState === 'ready' ? 'unknown' : overviewState, items: [], message: 'Core no incluyó ubicaciones en el overview de este Project.' }
      : overviewUnavailableSlice(projects, 'ubicaciones');
  const projectCounts = selectedProject?.counts && typeof selectedProject.counts === 'object'
    ? selectedProject.counts
    : null;
  const projectSummary = {
    state: selectedProject
      ? projectCounts ? overviewState : overviewState === 'ready' ? 'unknown' : overviewState
      : overviewState === 'ready' ? 'unavailable' : overviewState,
    counts: {
      tasks: projectCounts?.tasks ?? null,
      attempts: null,
      attention: projectCounts?.attention?.total ?? null,
      resources: null,
    },
    ...(!selectedProject
      ? { message: 'El Project seleccionado no aparece en el overview activo de Core.' }
      : !projectCounts ? { message: 'Core no incluyó contadores para este Project.' } : {}),
  };
  const projectTaskItems = Array.isArray(projectTasks.data?.tasks)
    ? projectTasks.data.tasks.map((task) => ({ task_id: task.id, title: task.title, status: task.status }))
    : [];
  const projectTaskSlice = projectViewSlice(projectTasks, projectTaskItems, { hasMore: projectTasks.data?.has_more === true });
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

  const selectProject = (projectId) => {
    if (projectId !== selectedProjectId || selectedTaskId !== null) {
      setAdeSelection({ projectId, taskId: null });
    }
    setWorkspaceView('workspace');
    onActivate?.();
  };
  const selectTask = (taskId) => {
    setAdeSelection({ projectId: selectedProjectId, taskId });
    setWorkspaceView('workspace');
    onActivate?.();
  };
  const changeWorkspaceView = (view) => {
    setWorkspaceView(view);
    if (view !== 'attention') setAttentionNotice(null);
    if (view !== 'activity') setActivityNotice(null);
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
  // Destinos de Activity: solo por (kind, ID durable). Una Task se abre únicamente si está seleccionada o aparece
  // en las Tasks del Project seleccionado, porque el evento no trae el Project y no se infiere ni se adivina.
  const openActivityTarget = ({ kind, id }) => {
    setActivityNotice(null);
    if (kind === 'project') {
      if (!projects.data?.projects.some((project) => project.id === id)) {
        setActivityNotice(`El Project ${id} no aparece en el overview activo de Core.`);
        return;
      }
      selectProject(id);
    } else if (kind === 'task') {
      if (id === selectedTaskId || tasks.data?.tasks.some((item) => item.id === id)) {
        selectTask(id);
      } else {
        setActivityNotice(`La Task ${id} no se puede abrir desde Activity: el evento no identifica su Project.`);
      }
    }
  };

  // Attention de un target: filtro por (kind + ID durable) resuelto por el Core, no por la página global.
  const openAttentionFilter = ({ kind, id, projectId }) => {
    targetSeq.current += 1;
    setAttentionTarget({ kind, id, projectId: typeof projectId === 'string' && projectId ? projectId : null, seq: targetSeq.current });
    setAttentionNotice(null);
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
      setAdeSelection({ projectId: id, taskId: null });
      setWorkspaceView('workspace');
      onActivate?.();
    } else if (kind === 'task') {
      if (!projectId) {
        setAttentionNotice(`La Attention de la Task ${id} no trae Project: no se puede abrir en el Workspace.`);
        return;
      }
      setAdeSelection({ projectId, taskId: id });
      setWorkspaceView('workspace');
      onActivate?.();
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
      <JumpPaletteHost open={jumpPaletteOpen} onClose={closeJumpPalette} onNavigate={jumpTo} />
      <Collapse open={leftOpen} size={Math.max(sizes.side, 280) + 8}>
        <Panel id="ade-nav" className="sidepanel ade__nav">
          <div className="panelhead"><span className="panelhead__title">Orquestador</span><span className="ade__source">Navegador</span></div>
          <div className="ade__nav-content">
            <section className="ade__nav-section ade__nav-scroll-region ade__nav-projects-scroll" aria-label="Projects y Tasks" tabIndex={0}>
              <div className="ade__nav-section-head"><span>Projects</span><span className="ade__source">Core</span></div>
              <QueryFeedback state={projects} subject="Projects" />
              {selectedProjectMissing && <div className="ade__notice" role="status">El Project seleccionado ya no aparece en el overview activo. Se conserva la selección; elige otro Project para cambiar de contexto.</div>}
              {projects.status === 'empty' && <div className="changes__empty">No hay Projects registrados.</div>}
              {projects.data?.projects.map((project) => (
                <CoreProjectButton key={project.id} project={project} selected={active && project.id === selectedProjectId} onSelect={selectProject} />
              ))}

              {selectedProjectId && (
                <section className="ade__task-list" aria-label={`Tasks del Project ${selectedProjectId}`}>
                  <div className="ade__section-head">
                    <span>Tasks activas</span>
                    <span className="ade__durable-id mono" title="Project ID">{selectedProjectId}</span>
                  </div>
                  <QueryFeedback state={tasks} subject="Tasks" />
                  {tasks.status === 'empty' && <div className="changes__empty">Este Project no tiene Tasks activas.</div>}
                  {tasks.data?.tasks.map((item) => (
                    <CoreTaskButton key={item.id} task={item} selected={active && item.id === selectedTaskId} onSelect={selectTask} />
                  ))}
                  {tasks.data?.has_more && <div className="ade__partial" role="status">Vista parcial: hay más Tasks después de esta página.</div>}
                </section>
              )}
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
                    attention={projectAttentionSlice}
                    activity={{ state: 'unavailable', items: [], message: 'Activity permanece en Backlog (LXO-92).' }}
                    resources={{ state: 'unavailable', items: [], message: 'Resources permanece en Backlog (LXO-93).' }}
                    onOpenTask={selectTask}
                    onOpenAttention={openProjectAttention}
                  />
                </div>
              )}
              {selectedTaskId && (
                <div className="ade__task-overview scroll">
                  {selectedTaskMissingFromCompletePage && <div className="ade__notice" role="status">Esta Task ya no aparece en la lista de Tasks activas. La selección se conserva y el detalle refleja el estado actual del Core.</div>}
                  <TaskWorkspace {...workspaceProps} variant="workspace" />
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
                active={active && workspaceView === 'attention'}
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
                        onClick={() => { setActivityScopePref(kind); setActivityNotice(null); }}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {activityNotice && <div className="ade__notice" role="status">{activityNotice}</div>}
              <ActivityPanel
                scope={activityScope}
                active={active && workspaceView === 'activity'}
                onOpenTarget={openActivityTarget}
              />
            </div>
          </Panel>

          <RightDock
            id="ade-inspector"
            sizeKey="inspector"
            className="ade__inspector"
            open={rightOpen}
            visible={active}
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
              </section>
              {selectedTaskId && <TaskWorkspace {...workspaceProps} variant="inspector" />}
            </div>
          </RightDock>
        </div>
      </div>
    </div>
  );
}
