import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { OrchestratorMode } from './OrchestratorMode';
import { useOrchStore } from '../store/orchStore';
import { useAppStore } from '../store/appStore';
import { useWorkbenchStore } from '../store/workbenchStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('./AgentTerminal', () => ({ AgentTerminal: () => <div data-testid="agent-terminal" /> }));
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

function mountWith(snap, pending = [], query = async () => ({}), selected = null) {
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'orch_pending_spawns' || cmd === 'orch_list_pending_spawns') return pending;
    if (cmd === 'orch_query') return query(args.query, args.args);
    return snap;
  });
  useAppStore.setState({ workspaceRoot: 'C:/repo' });
  useWorkbenchStore.setState((state) => ({
    orchView: 'executions', focus: 'orchtree', drawer: false, adeDrawer: false,
    modePanels: { ...state.modePanels, orch: { left: true, right: true, adeLeft: true, adeRight: true } },
  }));
  useOrchStore.setState({ snap, selected, init: () => {}, refresh: async () => {} });
  return render(<OrchestratorMode />);
}

beforeEach(() => invoke.mockReset());
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.removeItem('lx_orch_view'); });

describe('OrchestratorMode', () => {
  it('mantiene el selector Ejecuciones/ADE dentro del Orquestador', () => {
    mountWith(snapshot([task('t1')]), [], async () => ({}), 'execution-task');

    expect(screen.getByRole('button', { name: 'Ejecuciones' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'ADE' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ejecuciones' }).getAttribute('aria-pressed')).toBe('true');
    expect(invoke.mock.calls.filter(([command]) => command === 'orch_query')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'ADE' }));
    expect(localStorage.getItem('lx_orch_view')).toBe('"ade"');
    expect(useOrchStore.getState().selected).toBe('execution-task');
    expect(useWorkbenchStore.getState().focus).toBe('orchtree');
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
      if (query === 'tasks_by_project') return { v: 1, project_id: project.id, filters: { status: 'active' }, limit: 50, tasks: [item], has_more: true, next_cursor: 'next-page' };
      if (query === 'task_detail') return { v: 1, task: { ...item, project_id: project.id, child_ids: [], phase: null, messages: [], cwd: '', branch: null, worktree: null, merged: false, review: null, integration: null } };
      throw new Error(`Query no permitida en fixture: ${query}`);
    }, 'execution-task');

    fireEvent.click(screen.getByRole('button', { name: 'ADE' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Repo Real' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Task Real' }));

    expect((await screen.findAllByText('task-uuid-1')).length).toBeGreaterThan(0);
    expect(screen.getByText(/Vista parcial: hay más Tasks/)).toBeTruthy();
    expect(calls).toEqual([
      ['projects_overview', { archived: 'exclude' }],
      ['tasks_by_project', { project_id: 'project-uuid-1', status: 'active', limit: 50 }],
      ['task_detail', { project_id: 'project-uuid-1', task_id: 'task-uuid-1' }],
    ]);
    expect(invoke.mock.calls.filter(([command]) => command === 'orch_call')).toEqual([]);
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

    fireEvent.click(screen.getByRole('button', { name: 'ADE' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole('alert').textContent).toContain('Core degradado');
    expect(screen.getByRole('alert').textContent).toContain('projects_overview_unavailable');

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText('No hay Projects registrados.')).toBeTruthy();
    expect(attempts).toBe(2);
    expect(useWorkbenchStore.getState().orchView).toBe('ade');
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

    fireEvent.click(screen.getByRole('button', { name: 'ADE' }));
    const projectButton = await screen.findByRole('button', { name: 'Repo Real' });
    fireEvent.pointerDown(projectButton);
    fireEvent.click(projectButton);
    expect(useWorkbenchStore.getState().focus).toBe('ade-nav');

    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByText(/El Project seleccionado ya no aparece/)).toBeTruthy();
    expect((await screen.findAllByText('project-uuid-1')).length).toBeGreaterThan(0);
    expect(useWorkbenchStore.getState().focus).toBe('ade-nav');
    expect(overviewCalls).toBe(2);
  });

  it('mantiene separadas las selecciones y conserva AgentPanel montado al cambiar de vista', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'ADE' }));
    const projectButton = await screen.findByRole('button', { name: 'Repo Real' });
    fireEvent.pointerDown(projectButton);
    fireEvent.click(projectButton);
    const taskButton = await screen.findByRole('button', { name: 'Task Real' });
    fireEvent.pointerDown(taskButton);
    fireEvent.click(taskButton);

    expect(useOrchStore.getState().selected).toBe('execution-task');
    expect(document.querySelector('.chatpanel__feed')).toBe(feed);
    expect(feed.scrollTop).toBe(47);
    expect(useWorkbenchStore.getState().focus).toBe('ade-nav');
    const projectIdDescription = projectButton.getAttribute('aria-describedby');
    const taskIdDescription = taskButton.getAttribute('aria-describedby');
    expect(document.getElementById(projectIdDescription).textContent).toBe('project-uuid-1');
    expect(document.getElementById(taskIdDescription).textContent).toBe('task-uuid-1');

    fireEvent.pointerDown(projectButton);
    fireEvent.click(projectButton);
    expect(screen.getByRole('button', { name: 'Task Real' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Ejecuciones' }));
    expect(useOrchStore.getState().selected).toBe('execution-task');
    expect(useWorkbenchStore.getState().focus).toBe('ade-nav');
    expect(document.querySelector('.chatpanel__feed')).toBe(feed);
    fireEvent.click(screen.getByRole('button', { name: 'ADE' }));
    expect(screen.getByRole('button', { name: 'Repo Real' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Task Real' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('lista lo que espera una decisión y abre la revisión al elegirlo', async () => {
    mountWith(snapshot([task('t1'), task('t2', { last_review: { decision: 'accepted', head_commit: 'aaa' } })]));
    expect(screen.getByLabelText('Requiere tu atención')).toBeTruthy();
    expect(screen.getByTestId('attention-t1').textContent).toContain('Revisar diff');
    expect(screen.getByTestId('attention-t2').textContent).toContain('Lista para integrar');
    fireEvent.click(screen.getByTestId('attention-t1'));
    await waitFor(() => expect(screen.getByTestId('review-t1')).toBeTruthy());
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
