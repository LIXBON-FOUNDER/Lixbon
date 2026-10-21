import { useCallback, useId, useRef, useState } from 'react';
import { Collapse } from '../layout/Collapse';
import { Gutter } from '../layout/Gutter';
import { Panel } from '../layout/Panel';
import { RightDock } from '../layout/RightDock';
import { useWorkbenchStore } from '../store/workbenchStore';
import { AttentionInbox } from './AttentionInbox';
import { JumpPaletteHost } from './JumpPaletteHost';
import { ProjectsSidebar } from './ProjectsSidebar';
import { ProjectView } from './ProjectView';
import { TaskWorkspace } from './TaskWorkspace';
import { useCoreQuery } from './useCoreQuery';
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
      error: 'Core con error',
    }[query.reason];
    return `Datos desactualizados${cause ? ` (${cause})` : ''}; se conserva la última respuesta. ${query.error || ''}`.trim();
  }
  if (query.status === 'refreshing') return 'Actualizando desde Core.';
  const sourceLabel = {
    disconnected: 'Core desconectado',
    degraded: 'Core degradado',
    error: 'Core con error',
  }[query.status];
  if (sourceLabel) return `${sourceLabel}. ${query.error || ''}`.trim();
  return query.error || null;
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
];

/** Switch Workspace/Attention con semántica de tabs (flechas, Inicio/Fin); solo cambia la subvista del ADE. */
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

// `onOpenTaskActivity` recibe `{ projectId, taskId }` de la Task seleccionada y verificada; mientras no esté
// conectado, el workspace declara Activity como no disponible. Attention la sirve este shell (AttentionInbox).
// `onOpenRun(runId)` / `onOpenSpawnRequest(pendingId)` son los callbacks existentes de Operación: reciben el
// ID durable exacto y devuelven `true` si lo abrieron (o `false` si ya no existe en esa superficie).
export function AdeShell({ active, leftOpen, rightOpen, drawerOpen, onCloseDrawer, onActivate, operationNavigation, operationWorkspace, onOpenTaskActivity, onOpenRun, onOpenSpawnRequest }) {
  const viewIds = useId();
  const [workspaceView, setWorkspaceView] = useState('workspace');
  const [attentionTarget, setAttentionTarget] = useState(null);
  const [attentionNotice, setAttentionNotice] = useState(null);
  const [projectSnapshot, setProjectSnapshot] = useState(null);
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
  const projectViewActive = Boolean(active && workspaceView === 'workspace' && selectedProjectId && !selectedTaskId);
  const onProjectSnapshot = useCallback((snapshot) => setProjectSnapshot(snapshot), []);
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
  const projectAttention = useCoreQuery('attention_list', {
    project_id: selectedProjectId,
  }, { enabled: projectViewActive });
  const detail = useCoreQuery('task_detail', {
    project_id: selectedProjectId,
    task_id: selectedTaskId,
  }, { enabled: Boolean(selectedProjectId) && Boolean(selectedTaskId) });
  const selectedProject = currentProjectSnapshot?.projectId === selectedProjectId
    ? currentProjectSnapshot.project
    : null;

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
      ? { state: overviewState === 'ready' ? 'unknown' : overviewState, items: [], message: 'Core no incluyó ubicaciones en el overview de este Project.' }
      : overviewUnavailableSlice(projectOverview, 'ubicaciones');
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
      ? { message: ['unknown', 'unavailable'].includes(projectOverview.status)
        ? 'Core no confirmó metadata autoritativa para este Project.'
        : ['ready', 'empty', 'missing'].includes(projectOverview.status)
          ? 'El Project seleccionado no aparece en el overview activo de Core.'
          : projectQueryMessage(projectOverview) || 'No hay metadata autoritativa para este Project.' }
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

  const selectProject = (project) => {
    const projectId = typeof project === 'string' ? project : project?.projectId;
    if (typeof projectId !== 'string' || !projectId.trim()) return;
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
    setAdeSelection({ projectId, taskId: typeof taskId === 'string' && taskId.trim() ? taskId : null });
    setWorkspaceView('workspace');
    onActivate?.();
  };
  const changeWorkspaceView = (view) => { setWorkspaceView(view); if (view !== 'attention') setAttentionNotice(null); };

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
    onOpenActivity: onOpenTaskActivity,
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
              <ProjectsSidebar
                selection={{ projectId: selectedProjectId, taskId: selectedTaskId }}
                onSelectProject={selectProject}
                onSelectTask={selectTask}
                onProjectSnapshot={onProjectSnapshot}
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
