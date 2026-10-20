import { useId } from 'react';
import { Collapse } from '../layout/Collapse';
import { Gutter } from '../layout/Gutter';
import { Panel } from '../layout/Panel';
import { RightDock } from '../layout/RightDock';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useCoreQuery } from './useCoreQuery';

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

export function AdeShell({ active, leftOpen, rightOpen, drawerOpen, onCloseDrawer, onActivate, operationNavigation, operationWorkspace }) {
  const sizes = useWorkbenchStore((s) => s.sizes);
  const adeSelection = useWorkbenchStore((s) => s.adeSelection);
  const setAdeSelection = useWorkbenchStore((s) => s.setAdeSelection);
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
  const detail = useCoreQuery('task_detail', {
    project_id: selectedProjectId,
    task_id: selectedTaskId,
  }, { enabled: Boolean(selectedProjectId) && Boolean(selectedTaskId) });
  const task = detail.data?.task;
  const selectedProjectInOverview = projects.data?.projects.some((project) => project.id === selectedProjectId);
  const selectedProjectMissing = selectedProjectId && ['ready', 'empty'].includes(projects.status) && !selectedProjectInOverview;
  const selectedTaskMissingFromCompletePage = selectedTaskId && tasks.data && !tasks.data.has_more
    && !tasks.data.tasks.some((item) => item.id === selectedTaskId);

  const selectProject = (projectId) => {
    if (projectId !== selectedProjectId) {
      setAdeSelection({ projectId, taskId: null });
    }
    onActivate?.();
  };
  const selectTask = (taskId) => { setAdeSelection({ projectId: selectedProjectId, taskId }); onActivate?.(); };

  return (
    <div
      className="wb wb--orch ade__layout"
      data-testid="ade-composition"
    >
      <Collapse open={leftOpen} size={Math.max(sizes.side, 280) + 8}>
        <Panel id="ade-nav" className="sidepanel ade__nav">
          <div className="panelhead"><span className="panelhead__title">Orquestador</span><span className="ade__source">Navegador</span></div>
          <div className="ade__nav-content scroll">
            <section className="ade__nav-section" aria-label="Projects y Tasks">
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
            {operationNavigation}
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
              <div className="panelhead__title">Workspace</div>
              {selectedTaskId && <span className="ade__durable-id mono">Task · {selectedTaskId}</span>}
            </div>
            {!selectedProjectId && <div className="ade__workspace-empty changes__empty">Selecciona un Project del Core.</div>}
            {selectedProjectId && !selectedTaskId && <div className="ade__workspace-empty changes__empty">Selecciona una Task de este Project.</div>}
            {selectedTaskId && (
              <div className="ade__task-overview scroll">
                <QueryFeedback state={detail} subject="el detalle de Task" />
                {selectedTaskMissingFromCompletePage && <div className="ade__notice" role="status">Esta Task ya no aparece en la lista de Tasks activas. La selección se conserva y el detalle refleja el estado actual del Core.</div>}
                {task && (
                  <>
                    <h1>{task.title || task.id}</h1>
                    <div className="ade__status-row"><span className={`orch__state orch__state--${task.status}`}>{STATUS_LABELS[task.status] || task.status}</span><span className="ade__durable-id mono">{task.id}</span></div>
                    <p className="orch__hint">Resumen mínimo de la Task. El detalle ampliado se presentará en este workspace.</p>
                  </>
                )}
              </div>
            )}
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
            </div>
          </RightDock>
        </div>
      </div>
    </div>
  );
}
