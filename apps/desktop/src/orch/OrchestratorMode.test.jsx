import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { OrchestratorMode } from './OrchestratorMode';
import { useOrchStore } from '../store/orchStore';
import { useAppStore } from '../store/appStore';
import { useWorkbenchStore } from '../store/workbenchStore';
import { live } from '../ade/testFixtures/providerCapabilitiesFixtures';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('./AgentTerminal', () => ({ AgentTerminal: ({ visible }) => <div data-testid="agent-terminal" data-visible={String(visible)} /> }));
vi.mock('./review/TaskDiffView', () => ({ TaskDiffView: ({ taskId }) => <div data-testid={`review-${taskId}`} /> }));

const task = (id, over = {}) => ({
  id, run: 'r1', parent: 'coord', title: id, agent: 'claude', status: 'done', branch: `lxo/${id}`, head_commit: 'aaa',
  created: 1, updated: 2, depth: 1, repo: 'C:/repo', phases: [], last_review: null, last_integration: null, ...over,
});
const snapshot = (tasks, extra = {}) => ({
  settings: { enabled: true }, lxo_exists: true, live: [], messages: [],
  runs: { r1: { id: 'r1', root: 'coord', objective: 'Objetivo', created: 1, closed: false } },
  tasks: { coord: task('coord', { parent: null, branch: null, status: 'running' }), ...Object.fromEntries(tasks.map((t) => [t.id, t])) },
  ...extra,
});
const pendingSpawn = { pending_id: 'p1', parent_task: 'coord', agent: 'claude', provider: 'claude', profile: 'explorar', role: 'explorador', expires_at: Date.now() + 300000, policy: { argv: ['claude'], status: 'ok', warnings: [] } };
const findTreeitemById = async (region, attribute, id, accessibleName) => {
  const row = await within(region).findByRole('treeitem', { name: accessibleName });
  expect(row.getAttribute(attribute)).toBe(id);
  return row;
};

function mountWith(snap, pending = [], query = async (name) => (name === 'projects_overview'
  ? { v: 1, filters: { archived: 'exclude', machine: null }, total: 0, projects: [], unassigned: {} }
  : { v: 1, tasks: [], has_more: false, next_cursor: null }), selected = null, snapshotReader = async () => snap) {
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'orch_pending_spawns' || cmd === 'orch_list_pending_spawns') return pending;
    if (cmd === 'orch_snapshot') return snapshotReader();
    if (cmd === 'orch_query') return query(args.query, args.args);
    return snap;
  });
  useAppStore.setState({ workspaceRoot: 'C:/repo' });
  useWorkbenchStore.setState((state) => ({
    page: 'editor', settingsSection: null, orchView: 'executions', focus: 'ade-nav', drawer: false, adeDrawer: false,
    adeSelection: { projectId: null, taskId: null },
    modePanels: { ...state.modePanels, orch: { left: true, right: true, adeRight: true } },
  }));
  useOrchStore.setState({ snap, snapshotError: null, snapshotRefreshing: false, selected, init: () => {} });
  return render(<OrchestratorMode />);
}

beforeEach(() => invoke.mockReset());
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.removeItem('lx_orch_view'); });

describe('OrchestratorMode', () => {
  it('muestra desconexión inicial y recupera la vista con un reintento read-only', { timeout: 20_000 }, async () => {
    const recovered = snapshot([]);
    let attempts = 0;
    mountWith(null, [], undefined, null, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Core offline');
      return recovered;
    });

    expect(screen.getByText('Cargando el orquestador…')).toBeTruthy();
    await act(async () => { await useOrchStore.getState().refresh(); });
    expect(screen.getByTestId('orch-snapshot-error').textContent).toContain('Core desconectado');
    expect(screen.getByTestId('orch-snapshot-error').textContent).toContain('Core offline');

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('region', { name: 'Projects y Tasks' })).toBeTruthy();
    expect(useOrchStore.getState().snap).toBe(recovered);
    expect(useOrchStore.getState().snapshotError).toBeNull();
    expect(attempts).toBe(2);
    expect(invoke.mock.calls.filter(([command]) => command === 'orch_snapshot')).toHaveLength(2);
    expect(invoke.mock.calls.filter(([command]) => ['orch_call', 'orch_settings_set'].includes(command))).toEqual([]);
  });

  it('conserva y marca como degradada la última snapshot cuando falla su refresco', async () => {
    const lastSnapshot = snapshot([task('cached-task')]);
    mountWith(lastSnapshot, [], undefined, null, async () => { throw new Error('Core no disponible'); });

    await act(async () => { await useOrchStore.getState().refresh(); });

    expect(useOrchStore.getState().snap).toBe(lastSnapshot);
    expect(screen.getByTestId('orch-snapshot-stale').textContent).toContain('Core degradado');
    expect(screen.getByTestId('orch-snapshot-stale').textContent).toContain('Core no disponible');
    expect(screen.getByText('cached-task', { selector: '.orch__task-title' })).toBeTruthy();
  });

  it('mantiene desactivado el flujo hasta el opt-in experimental en Ajustes', () => {
    mountWith(snapshot([], { settings: { enabled: false } }));

    expect(screen.getByText('Experimental')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Projects y Tasks' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Activar en Ajustes' }));
    expect(useWorkbenchStore.getState().page).toBe('settings');
    expect(useWorkbenchStore.getState().settingsSection).toBe('orch');
  });

  it('presenta Projects y Operación en un navegador y un canvas contextual', async () => {
    mountWith(snapshot([task('t1')]), [], undefined, 'execution-task');

    expect(screen.queryByRole('button', { name: 'Ejecuciones' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ADE' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Projects y Tasks' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Operación' })).toBeTruthy();
    expect(screen.getByTestId('execution-composition').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByTestId('ade-composition')).toBeTruthy();
    expect(invoke.mock.calls.filter(([command]) => command === 'orch_query').map(([, args]) => args.query)).toEqual(['projects_overview', 'core_model']);
    expect(useOrchStore.getState().selected).toBe('execution-task');
    expect(useWorkbenchStore.getState().focus).toBe('ade-nav');
  });

  it('carga Project, Tasks y detalle desde las queries read-only del Core', async () => {
    const project = {
      id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active',
      counts: { tasks: 1, active: 1, failed: 0, attention: { total: 0, by_category: {} } }, locations: [],
    };
    const item = {
      id: 'task-uuid-1', run_id: 'run-1', parent_id: null, root_id: 'task-uuid-1', status: 'running',
      title: 'Task Real', provider: 'claude', model: null, created_at: 1, updated_at: 2,
    };
    const calls = [];
    mountWith(snapshot([task('execution-task')]), [], async (query, args) => {
      calls.push([query, args]);
      if (query === 'projects_overview') return { v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [project], unassigned: {} };
      if (query === 'tasks_by_project') return { v: 1, project_id: project.id, filters: { status: args.status }, limit: 50, tasks: [item], has_more: true, next_cursor: 'next-page' };
      if (query === 'attention_list') return { v: 1, items: [], next_cursor: null, has_more: false, limit: 100 };
      // LXO-135: el inspector de proveedores lee lo que ofrece cada uno; la respuesta es la canónica del Core.
      if (query === 'provider_capabilities') return live();
      if (query === 'task_detail') return { v: 1, task: { ...item, project_id: project.id, child_ids: [], phase: null, messages: [], cwd: '', branch: null, worktree: null, merged: false, review: null, integration: null } };
      throw new Error(`Query no permitida en fixture: ${query}`);
    }, 'execution-task');

    const projectTaskSidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    const projectRow = await findTreeitemById(projectTaskSidebar, 'data-project-id', project.id, new RegExp(`Project ${project.id}`));
    fireEvent.click(projectRow);
    const taskRow = await findTreeitemById(projectTaskSidebar, 'data-task-id', item.id, new RegExp(`^${item.title}\\.`));
    fireEvent.click(taskRow);

    expect((await screen.findAllByText('task-uuid-1')).length).toBeGreaterThan(0);
    expect(taskRow.getAttribute('data-task-id')).toBe(item.id);
    expect(within(projectTaskSidebar).getByRole('button', { name: 'Cargar más Tasks de Repo Real' })).toBeTruthy();
    // LXO-135: el inspector de proveedores añade UNA lectura propia, sin argumentos y de solo lectura; el resto es lo de antes.
    expect(calls.filter(([query]) => query === 'provider_capabilities').every(([, args]) => Object.keys(args).length === 0)).toBe(true);
    expect(calls.some(([query]) => query === 'provider_capabilities')).toBe(true);
    expect(calls.filter(([query]) => query !== 'provider_capabilities')).toEqual([
      // LXO-120: la decisión legacy / task_attempt_v1 (aquí el fixture F2 la rechaza: modo F2).
      ['projects_overview', { archived: 'exclude' }],
      ['core_model', {}],
      ['tasks_by_project', { project_id: 'project-uuid-1', status: 'active', limit: 50 }],
      ['tasks_by_project', { project_id: 'project-uuid-1', status: 'all', limit: 50 }],
      ['attention_list', { limit: 100, project_id: 'project-uuid-1' }],
      ['resource_inventory', { project_id: 'project-uuid-1', probe: true }],
      ['activity_list', { cursor: '0', limit: 20, order: 'desc', project_id: 'project-uuid-1' }],
      ['task_detail', { project_id: 'project-uuid-1', task_id: 'task-uuid-1' }],
    ]);
    expect(invoke.mock.calls.filter(([command]) => command === 'orch_call')).toEqual([]);
    expect(useWorkbenchStore.getState().orchView).toBe('ade');
  });

  it('conserva la selección ADE por ID durable al desmontar y volver a Orquestador', { timeout: 20_000 }, async () => {
    const project = {
      id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active',
      counts: { tasks: 1, active: 1, failed: 0, attention: { total: 0, by_category: {} } }, locations: [],
    };
    const item = {
      id: 'task-uuid-1', run_id: 'run-1', parent_id: null, root_id: 'task-uuid-1', status: 'running',
      title: 'Task Real', provider: 'claude', model: null, created_at: 1, updated_at: 2,
    };
    const view = mountWith(snapshot([task('execution-task')]), [], async (query) => {
      if (query === 'projects_overview') return { v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [project], unassigned: {} };
      if (query === 'tasks_by_project') return { v: 1, project_id: project.id, filters: { status: 'active' }, limit: 50, tasks: [item], has_more: false, next_cursor: null };
      if (query === 'task_detail') return { v: 1, task: { ...item, project_id: project.id, child_ids: [], phase: null, messages: [], cwd: '', branch: null, worktree: null, merged: false, review: null, integration: null } };
      throw new Error(`Query no permitida en fixture: ${query}`);
    });

    const projectTaskSidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    fireEvent.click(await findTreeitemById(projectTaskSidebar, 'data-project-id', project.id, new RegExp(`Project ${project.id}`)));
    fireEvent.click(await findTreeitemById(projectTaskSidebar, 'data-task-id', item.id, new RegExp(`^${item.title}\\.`)));
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: project.id, taskId: item.id });

    view.unmount();
    render(<OrchestratorMode />);

    const remountedSidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    const projectRow = await findTreeitemById(remountedSidebar, 'data-project-id', project.id, new RegExp(`Project ${project.id}`));
    const taskRow = await findTreeitemById(remountedSidebar, 'data-task-id', item.id, new RegExp(`^${item.title}\\.`));
    expect(projectRow.getAttribute('aria-selected')).toBe('false');
    expect(projectRow.classList.contains('is-context')).toBe(true);
    expect(taskRow.getAttribute('aria-selected')).toBe('true');
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: project.id, taskId: item.id });
  });

  it('representa Core degradado y se recupera al reconectar sin cambiar la vista', async () => {
    let attempts = 0;
    vi.useFakeTimers();
    mountWith(snapshot([]), [], async (query) => {
      if (query !== 'projects_overview') throw new Error(`Query inesperada: ${query}`);
      attempts += 1;
      if (attempts === 1) throw new Error('projects_overview_unavailable: almacén Core no disponible');
      return { v: 1, filters: { archived: 'exclude', machine: null }, total: 0, projects: [], unassigned: {} };
    });

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('alert').textContent).toContain('Core degradado');
    expect(screen.getByRole('alert').textContent).toContain('projects_overview_unavailable');

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText('No hay Projects registrados con este filtro del Core.')).toBeTruthy();
    expect(attempts).toBe(2);
    expect(useWorkbenchStore.getState().orchView).toBe('executions');
  });

  it('conserva IDs y foco cuando una actualización de Core deja de listar el Project', async () => {
    const project = { id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active', counts: { tasks: 0, active: 0, failed: 0, attention: { total: 0, by_category: {} } }, locations: [] };
    let overviewCalls = 0;
    mountWith(snapshot([]), [], async (query) => {
      if (query === 'projects_overview') {
        overviewCalls += 1;
        const projects = overviewCalls === 1 ? [project] : [];
        return { v: 1, filters: { archived: 'exclude', machine: null }, total: projects.length, projects, unassigned: {} };
      }
      if (query === 'tasks_by_project') return { v: 1, project_id: project.id, filters: { status: 'active' }, limit: 50, tasks: [], has_more: false, next_cursor: null };
      throw new Error(`Query inesperada: ${query}`);
    });

    const projectTaskSidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    const projectRow = await findTreeitemById(projectTaskSidebar, 'data-project-id', project.id, new RegExp(`Project ${project.id}`));
    fireEvent.pointerDown(projectRow);
    fireEvent.click(projectRow);
    expect(useWorkbenchStore.getState().focus).toBe('ade-nav');

    document.dispatchEvent(new Event('visibilitychange'));
    expect(await within(projectTaskSidebar).findByText(/El Project seleccionado \(project-uuid-1\) ya no aparece/)).toBeTruthy();
    expect((await screen.findAllByText('project-uuid-1')).length).toBeGreaterThan(0);
    expect(useWorkbenchStore.getState().focus).toBe('ade-nav');
    expect(overviewCalls).toBe(2);
  });

  it('mantiene selecciones separadas y conserva AgentPanel, conversación y scroll al cambiar el canvas', async () => {
    const project = {
      id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active',
      counts: { tasks: 1, active: 1, failed: 0, attention: { total: 0, by_category: {} } }, locations: [],
    };
    const item = {
      id: 'task-uuid-1', run_id: 'run-1', parent_id: null, root_id: 'task-uuid-1', status: 'running',
      title: 'Task Real', provider: 'claude', model: null, created_at: 1, updated_at: 2,
    };
    mountWith(snapshot([task('execution-task')]), [], async (query) => {
      if (query === 'projects_overview') return { v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [project], unassigned: {} };
      if (query === 'tasks_by_project') return { v: 1, project_id: project.id, filters: { status: 'active' }, limit: 50, tasks: [item], has_more: false, next_cursor: null };
      if (query === 'task_detail') return { v: 1, task: { ...item, project_id: project.id, child_ids: [], phase: null, messages: [], cwd: '', branch: null, worktree: null, merged: false, review: null, integration: null } };
      throw new Error(`Query no permitida en fixture: ${query}`);
    }, 'execution-task');

    const feed = document.querySelector('.chatpanel__feed');
    feed.scrollTop = 47;
    const projectTaskSidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    const projectRow = await findTreeitemById(projectTaskSidebar, 'data-project-id', project.id, new RegExp(`Project ${project.id}`));
    fireEvent.pointerDown(projectRow);
    fireEvent.click(projectRow);
    const taskRow = await findTreeitemById(projectTaskSidebar, 'data-task-id', item.id, new RegExp(`^${item.title}\\.`));
    fireEvent.pointerDown(taskRow);
    fireEvent.click(taskRow);

    expect(useOrchStore.getState().selected).toBe('execution-task');
    const operationTask = [...document.querySelectorAll('.orch__runs .orch__task')]
      .find((button) => button.querySelector('.orch__task-title')?.textContent === 'execution-task');
    expect(operationTask.classList.contains('is-active')).toBe(false);
    expect(document.querySelector('.chatpanel__feed')).toBe(feed);
    expect(feed.scrollTop).toBe(47);
    expect(useWorkbenchStore.getState().focus).toBe('ade-nav');
    const projectMeta = document.getElementById(projectRow.getAttribute('aria-describedby'));
    const taskMeta = document.getElementById(taskRow.getAttribute('aria-describedby'));
    expect(projectMeta).toBe(projectRow.querySelector('.ps__meta'));
    expect(projectMeta.classList.contains('ps__meta')).toBe(true);
    expect(projectMeta.textContent).toContain('Tasks 1');
    expect(taskMeta).toBe(taskRow.querySelector('.ps__meta'));
    expect(taskMeta.classList.contains('ps__meta')).toBe(true);
    expect(taskMeta.textContent).toContain('Proveedor claude');
    expect(taskMeta.textContent).toContain('Rama Solo en detalle');
    expect(projectRow.getAttribute('data-project-id')).toBe(project.id);
    expect(projectRow.querySelector('.ps__id').textContent).toBe(project.id);
    expect(taskRow.getAttribute('data-task-id')).toBe(item.id);
    expect(taskRow.querySelector('.ps__id').textContent).toBe(item.id);
    expect(projectRow.getAttribute('aria-selected')).toBe('false');
    expect(projectRow.classList.contains('is-context')).toBe(true);

    expect(operationTask).toBeTruthy();
    fireEvent.pointerDown(operationTask);
    fireEvent.click(operationTask);
    expect(useOrchStore.getState().selected).toBe('execution-task');
    expect(useWorkbenchStore.getState().orchView).toBe('executions');
    expect(operationTask.classList.contains('is-active')).toBe(true);
    expect(taskRow.getAttribute('aria-selected')).toBe('true');
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: project.id, taskId: item.id });
    expect(document.querySelector('.chatpanel__feed')).toBe(feed);
    expect(feed.scrollTop).toBe(47);
    fireEvent.click(await findTreeitemById(projectTaskSidebar, 'data-project-id', project.id, new RegExp(`Project ${project.id}`)));
    expect(useWorkbenchStore.getState().orchView).toBe('ade');
    const returnedSidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    const returnedProjectRow = await findTreeitemById(returnedSidebar, 'data-project-id', project.id, new RegExp(`Project ${project.id}`));
    expect(returnedProjectRow.getAttribute('aria-selected')).toBe('true');
    expect(returnedProjectRow.getAttribute('aria-expanded')).toBe('true');
    const returnedTaskRow = await findTreeitemById(returnedSidebar, 'data-task-id', item.id, new RegExp(`^${item.title}\\.`));
    expect(returnedTaskRow.getAttribute('aria-selected')).toBe('false');
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: project.id, taskId: null });
  });

  it('lista lo que espera una decisión y abre la revisión al elegirlo', async () => {
    mountWith(snapshot([task('t1'), task('t2', { last_review: { decision: 'accepted', head_commit: 'aaa' } })]));
    expect(screen.getByLabelText('Requiere tu atención')).toBeTruthy();
    expect(screen.getByTestId('attention-t1').textContent).toContain('Revisar diff');
    expect(screen.getByTestId('attention-t2').textContent).toContain('Lista para integrar');
    fireEvent.click(screen.getByTestId('attention-t1'));
    await waitFor(() => expect(screen.getByTestId('review-t1')).toBeTruthy());
  });

  it('al volver al mismo Run conserva la revisión iniciada desde Attention', async () => {
    const project = { id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active', counts: { tasks: 0, active: 0, failed: 0, attention: { total: 0, by_category: {} } }, locations: [] };
    mountWith(snapshot([task('t1', { branch: 'lxo/t1' })]), [], async (query) => {
      if (query === 'projects_overview') return { v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [project], unassigned: {} };
      if (query === 'tasks_by_project') return { v: 1, project_id: project.id, filters: { status: 'active' }, limit: 50, tasks: [], has_more: false, next_cursor: null };
      throw new Error(`Query inesperada: ${query}`);
    }, 't1');

    fireEvent.click(screen.getByTestId('attention-t1'));
    expect(screen.getByTestId('review-t1')).toBeTruthy();
    const taskPanel = document.querySelector('.orch__head');
    const projectTaskSidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    fireEvent.click(await findTreeitemById(projectTaskSidebar, 'data-project-id', project.id, new RegExp(`Project ${project.id}`)));
    const operationTask = [...document.querySelectorAll('.orch__runs .orch__task')]
      .find((button) => button.querySelector('.orch__task-title')?.textContent === 't1');
    fireEvent.click(operationTask);

    expect(screen.getByTestId('review-t1')).toBeTruthy();
    expect(document.querySelector('.orch__head')).toBe(taskPanel);
  });

  it('abre Run y solicitud pendiente desde Attention solo si el ID durable existe en Operación', async () => {
    const project = { id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active', counts: { tasks: 0, active: 0, failed: 0, attention: { total: 2, by_category: {} } }, locations: [] };
    const row = (id, kind, targetId, createdAt) => ({
      id, category: 'approval', severity: 'medium', status: 'active', target_kind: kind, target_id: targetId,
      project_id: project.id, run_id: null, occurrence: 1, created_at: createdAt, resolved_at: null, resolution: null,
    });
    const rows = [row('att_run', 'run', 'r1', 1), row('att_run_gone', 'run', 'r-gone', 2), row('att_p2', 'spawn_request', 'p2', 3), row('att_p_gone', 'spawn_request', 'p-gone', 4)];
    mountWith(snapshot([task('t1')]), [pendingSpawn, { ...pendingSpawn, pending_id: 'p2' }], async (query) => {
      if (query === 'projects_overview') return { v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [project], unassigned: {} };
      if (query === 'tasks_by_project') return { v: 1, project_id: project.id, filters: { status: 'active' }, limit: 50, tasks: [], has_more: false, next_cursor: null };
      if (query === 'attention_list') return { v: 1, items: rows, next_cursor: null, has_more: false, limit: 100 };
      throw new Error(`Query inesperada: ${query}`);
    });
    const attentionRow = (id) => document.querySelector(`[data-attention-id="${id}"]`);

    const projectTaskSidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    fireEvent.click(await findTreeitemById(projectTaskSidebar, 'data-project-id', project.id, new RegExp(`Project ${project.id}`)));
    fireEvent.click(screen.getByRole('tab', { name: 'Attention' }));
    await screen.findByTestId('attention-total');
    await waitFor(() => expect(attentionRow('att_run')).toBeTruthy());

    // IDs inexistentes: se avisa y la vista no cambia ni cae en otro Run o pendiente.
    fireEvent.click(attentionRow('att_run_gone'));
    fireEvent.click(attentionRow('att_p_gone'));
    expect(useWorkbenchStore.getState().orchView).toBe('ade');
    expect(useOrchStore.getState().selected).toBeNull();
    expect(screen.getByText(/La solicitud de lanzamiento p-gone ya no está disponible/)).toBeTruthy();

    fireEvent.click(attentionRow('att_p2'));
    expect(useWorkbenchStore.getState().orchView).toBe('executions');
    expect(screen.getByTestId('execution-composition').getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByTestId('spawn-p2').className).toContain('is-active');
    expect(screen.getByTestId('spawn-p1').className).not.toContain('is-active');

    act(() => useWorkbenchStore.getState().setOrchView('ade'));
    fireEvent.click(attentionRow('att_run'));
    expect(useWorkbenchStore.getState().orchView).toBe('executions');
    expect(useOrchStore.getState().selected).toBe('coord');
  });

  it('congela el redimensionamiento de AgentTerminal dentro del canvas ADE y lo reactiva al volver', async () => {
    const project = { id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active', counts: { tasks: 0, active: 0, failed: 0, attention: { total: 0, by_category: {} } }, locations: [] };
    mountWith(snapshot([task('t1', { status: 'running' })]), [], async (query) => {
      if (query === 'projects_overview') return { v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [project], unassigned: {} };
      if (query === 'tasks_by_project') return { v: 1, project_id: project.id, filters: { status: 'active' }, limit: 50, tasks: [], has_more: false, next_cursor: null };
      throw new Error(`Query inesperada: ${query}`);
    }, 't1');

    expect(screen.getByTestId('agent-terminal').getAttribute('data-visible')).toBe('true');
    const projectTaskSidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    fireEvent.click(await findTreeitemById(projectTaskSidebar, 'data-project-id', project.id, new RegExp(`Project ${project.id}`)));
    expect(screen.getByTestId('agent-terminal').getAttribute('data-visible')).toBe('false');
    const operationTask = [...document.querySelectorAll('.orch__runs .orch__task')]
      .find((button) => button.querySelector('.orch__task-title')?.textContent === 't1');
    fireEvent.click(operationTask);
    expect(screen.getByTestId('agent-terminal').getAttribute('data-visible')).toBe('true');
  });

  it('sin nada pendiente de decidir no muestra la sección', () => {
    mountWith(snapshot([task('t1', { status: 'running' })]));
    expect(screen.queryByLabelText('Requiere tu atención')).toBeNull();
  });

  it('una tarea esperando aprobación en la terminal aparece con su icono de espera', () => {
    mountWith(snapshot([task('t3', { status: 'awaiting_terminal_approval' })]));
    expect(screen.getByTestId('attention-t3').textContent).toContain('Aprobar en la terminal');
    expect(document.querySelector('.orchst--waiting svg circle')).not.toBeNull();
  });
});

describe('lanzamiento pendiente', () => {
  it('con nada elegido se enseña el pendiente en lugar de la ayuda', async () => {
    const api = await import('./spawn/spawnContract');
    vi.spyOn(api.defaultSpawnApi, 'list').mockResolvedValue([pendingSpawn]);
    mountWith(snapshot([]));
    await waitFor(() => expect(screen.getByLabelText('Detalle del lanzamiento pendiente')).toBeTruthy());
    expect(screen.queryByText('Cómo se orquesta')).toBeNull();
  });
});

describe('línea de estado de cada agente', () => {
  const phased = (over) => task('p1', { phases: [{ name: 'Probando', note: 'reproduje el fallo; probando el arreglo', done: false, at: 1 }], ...over });

  it('mientras trabaja muestra la nota de su última fase', () => {
    mountWith(snapshot([phased({ status: 'running' })]));
    expect(screen.getByTestId('task-note-p1').textContent).toBe('reproduje el fallo; probando el arreglo');
  });

  it('al terminar muestra la primera línea de su resumen', () => {
    mountWith(snapshot([phased({ status: 'done', summary: '\n  Arreglé el login\nmás detalle' })]));
    expect(screen.getByTestId('task-note-p1').textContent).toBe('Arreglé el login');
  });

  it('sin nota ni resumen no ocupa una línea', () => {
    mountWith(snapshot([task('p2', { status: 'running', phases: [{ name: 'Leyendo', note: '', done: false, at: 1 }] })]));
    expect(screen.queryByTestId('task-note-p2')).toBeNull();
  });
});

describe('entorno del worktree', () => {
  it('la actividad de la tarea cuenta qué se enlazó y qué se copió', () => {
    const env = { shared: ['node_modules'], copy: ['.env'], skipped: [{ path: 'build', reason: 'git no lo ignora' }] };
    mountWith(snapshot([task('e1', { env, status: 'running' })]));
    fireEvent.click(screen.getByText('e1', { selector: '.orch__task-title' }));
    fireEvent.click(screen.getByText('Actividad'));
    expect(screen.getByTestId('worktree-env-shared').textContent).toContain('Enlazado');
    expect(screen.getByTestId('worktree-env-copy').textContent).toContain('.env');
    expect(screen.getByTestId('worktree-env-skipped').textContent).toContain('git no lo ignora');
  });

  it('una tarea sin reglas de entorno no muestra la sección', () => {
    mountWith(snapshot([task('e2', { status: 'running' })]));
    fireEvent.click(screen.getByText('e2', { selector: '.orch__task-title' }));
    fireEvent.click(screen.getByText('Actividad'));
    expect(screen.getByText('Fases')).toBeTruthy();
    expect(screen.queryByTestId('worktree-env')).toBeNull();
  });
});
