import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import {
  NOT_REPORTED,
  ProjectsSidebar,
  TASK_STATUS_LABELS,
  toProjectSummary,
  toTaskSummary,
} from './ProjectsSidebar';
import { TASK_PAGE_LIMIT } from './coreQueries';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const ZERO = {
  question: 0,
  approval: 0,
  review_ready: 0,
  conflict: 0,
  failed: 0,
  environment_blocked: 0,
  risk: 0,
};

function attentionCounts(byCategory = {}) {
  const by_category = { ...ZERO, ...byCategory };
  return { total: Object.values(by_category).reduce((sum, value) => sum + value, 0), by_category };
}

const project = (id, name, over = {}) => ({
  id,
  name,
  state: 'active',
  status: 'active',
  counts: { tasks: 0, active: 0, failed: 0, attention: attentionCounts() },
  locations: [],
  ...over,
});

const overview = (projects, { archived = 'exclude', unassignedTasks = 0 } = {}) => ({
  v: 1,
  filters: { archived, machine: null },
  total: projects.length,
  projects,
  unassigned: {
    tasks: unassignedTasks,
    active: unassignedTasks,
    failed: 0,
    attention: attentionCounts(),
  },
});

const task = (id, over = {}) => ({
  id,
  run_id: `run-${id}`,
  parent_id: null,
  root_id: id,
  status: 'running',
  title: `Task ${id}`,
  provider: 'claude',
  model: null,
  created_at: 1_000,
  updated_at: 2_000,
  ...over,
});

const page = (projectId, status, tasks, { hasMore = false, cursor = 'cursor-1' } = {}) => ({
  v: 1,
  project_id: projectId,
  filters: { status },
  limit: TASK_PAGE_LIMIT,
  tasks,
  has_more: hasMore,
  next_cursor: hasMore ? cursor : null,
});

function mountCore({ overviews = () => overview([]), tasks = (args) => page(args.project_id, args.status, []) } = {}) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => {
    if (command !== 'orch_query') throw new Error(`comando inesperado: ${command}`);
    calls.push({ query: payload.query, args: payload.args });
    if (payload.query === 'projects_overview') return overviews(payload.args);
    if (payload.query === 'tasks_by_project') return tasks(payload.args);
    throw new Error(`query inesperada: ${payload.query}`);
  });
  return calls;
}

const taskCalls = (calls) => calls.filter((call) => call.query === 'tasks_by_project');
const onlyReadQueries = (calls) => calls.every((call) => ['projects_overview', 'tasks_by_project'].includes(call.query));
const flush = async () => {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  invoke.mockReset();
});

describe('ProjectsSidebar', () => {
  it.each([1, 10])('renderiza %i Projects con una sola lectura y sin fan-out', async (count) => {
    const projects = Array.from({ length: count }, (_, index) => project(`project-${index}`, `Alpha ${index}`));
    const calls = mountCore({ overviews: () => overview(projects) });
    const { container } = render(<ProjectsSidebar />);

    await screen.findByText('Alpha 0');
    expect(container.querySelectorAll('li[data-project-id]')).toHaveLength(count);
    expect(calls).toEqual([{ query: 'projects_overview', args: { archived: 'exclude' } }]);
    expect(taskCalls(calls)).toHaveLength(0);
  });

  it('soporta 100 Projects sin fan-out: solo consulta el overview hasta expandir', async () => {
    const projects = Array.from({ length: 100 }, (_, index) => project(`project-${String(index).padStart(3, '0')}`, `Alpha ${index}`));
    const calls = mountCore({ overviews: () => overview(projects) });
    const { container } = render(<ProjectsSidebar />);

    await screen.findByText('Alpha 0');
    expect(container.querySelectorAll('li[data-project-id]')).toHaveLength(100);
    expect(calls).toEqual([{ query: 'projects_overview', args: { archived: 'exclude' } }]);
    expect(onlyReadQueries(calls)).toBe(true);

    for (const id of ['project-000', 'project-001', 'project-099']) {
      fireEvent.click(container.querySelector(`li[data-project-id="${id}"]`));
    }
    await waitFor(() => expect(taskCalls(calls)).toHaveLength(3));
    expect(taskCalls(calls).map((call) => call.args.project_id).sort())
      .toEqual(['project-000', 'project-001', 'project-099']);
    expect(taskCalls(calls).every((call) => call.args.status === 'active' && call.args.limit === TASK_PAGE_LIMIT)).toBe(true);
  });

  it('carga Tasks de forma perezosa al expandir y el polling solo refresca los Projects expandidos', async () => {
    vi.useFakeTimers();
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha'), project('project-b', 'Beta')]),
      tasks: (args) => page(args.project_id, args.status, [task(`${args.project_id}-task`)]),
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    expect(calls).toHaveLength(1);

    fireEvent.click(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();
    expect(taskCalls(calls)).toHaveLength(1);
    expect(taskCalls(calls)[0].args).toEqual({ project_id: 'project-a', status: 'active', limit: TASK_PAGE_LIMIT });

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(calls.filter((call) => call.query === 'projects_overview')).toHaveLength(2);
    expect(taskCalls(calls)).toHaveLength(2);
    expect(taskCalls(calls).every((call) => call.args.project_id === 'project-a')).toBe(true);
  });

  it('pagina con el cursor opaco del Core y deduplica por ID durable en orden keyset', async () => {
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => (args.cursor
        ? page(args.project_id, args.status, [task('t2'), task('t3')])
        : page(args.project_id, args.status, [task('t1'), task('t2')], { hasMore: true, cursor: 'cursor-1' })),
    });
    const { container } = render(<ProjectsSidebar />);

    fireEvent.click(await screen.findByRole('treeitem', { name: /Alpha/ }));
    await screen.findByText('Task t1');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks' }));
    await screen.findByText('Task t3');

    expect(screen.getAllByText('Task t2')).toHaveLength(1);
    expect([...container.querySelectorAll('li[data-task-id]')].map((node) => node.getAttribute('data-task-id')))
      .toEqual(['t3', 't2', 't1']);
    expect(taskCalls(calls).map((call) => call.args.cursor)).toEqual([undefined, 'cursor-1']);
  });

  it('si el Core reinició la clave del cursor vuelve a la primera página sin duplicar', async () => {
    let moreAttempts = 0;
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) return page(args.project_id, args.status, [task('t1')], { hasMore: true, cursor: 'cursor-1' });
        moreAttempts += 1;
        if (moreAttempts === 1) throw new Error('tasks_invalid_cursor: cursor inválido para esta versión o consulta');
        return page(args.project_id, args.status, [task('t1')]);
      },
    });
    render(<ProjectsSidebar />);

    fireEvent.click(await screen.findByRole('treeitem', { name: /Alpha/ }));
    await screen.findByText('Task t1');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks' }));

    await screen.findByText(/El Core se reinició y el cursor caducó/);
    expect(screen.getAllByText('Task t1')).toHaveLength(1);
    await waitFor(() => expect(taskCalls(calls)).toHaveLength(3));
  });

  it('descarta una página en vuelo si la cabecera de Tasks queda stale', async () => {
    vi.useFakeTimers();
    let headReads = 0;
    let resolveMore;
    const morePage = new Promise((resolve) => { resolveMore = resolve; });
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (args.cursor) return morePage;
        headReads += 1;
        if (headReads > 1) throw new Error('tasks_by_project_read_failed');
        return page(args.project_id, args.status, [task('t1')], { hasMore: true, cursor: 'cursor-1' });
      },
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    fireEvent.click(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();
    expect(screen.getByText('Task t1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Cargando…' })).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.getByText(/Datos desactualizados/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cargar más Tasks' })).toBeNull();

    await act(async () => {
      resolveMore(page('project-a', 'active', [task('t2')]));
    });
    await flush();
    expect(screen.queryByText('Task t2')).toBeNull();
    expect(screen.getByText('Task t1')).toBeTruthy();
    expect(taskCalls(calls).some((call) => call.args.cursor === 'cursor-1')).toBe(true);
  });

  it('expone el filtro explícito active/final/all y las finalizadas son descubribles', async () => {
    const calls = mountCore({
      overviews: () => overview([
        project('project-a', 'Alpha', { status: 'failed', counts: { tasks: 2, active: 1, failed: 1, attention: attentionCounts() } }),
      ]),
      tasks: (args) => page(args.project_id, args.status, args.status === 'final'
        ? [task('t-final', { status: 'failed', title: 'Task final' })]
        : [task('t-active', { status: 'waiting', title: 'Task activa' })]),
    });
    render(<ProjectsSidebar />);

    expect(screen.getByTestId('active-view-hint').textContent).toMatch(/finalizadas quedan ocultas/i);
    fireEvent.click(await screen.findByRole('treeitem', { name: /Alpha/ }));
    await screen.findByText('Task activa');

    fireEvent.click(screen.getByRole('radio', { name: 'Finalizadas' }));
    await screen.findByText('Task final');
    expect(screen.queryByText('Task activa')).toBeNull();
    expect(screen.queryByTestId('active-view-hint')).toBeNull();
    const finalRow = screen.getByRole('treeitem', { name: /Task final/ });
    expect(finalRow.getAttribute('data-final')).toBe('true');
    expect(finalRow.getAttribute('data-status')).toBe('failed');
    expect(within(finalRow).getByText(TASK_STATUS_LABELS.failed)).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Todas' }));
    await waitFor(() => expect(taskCalls(calls).some((call) => call.args.status === 'all')).toBe(true));
    expect(screen.getByRole('radio', { name: 'Todas' }).checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Activas' }).checked).toBe(false);
  });

  it('el badge de Attention sale solo de counts.attention del overview', async () => {
    const calls = mountCore({
      overviews: () => overview([
        project('project-a', 'Alpha', {
          status: 'attention',
          counts: { tasks: 5, active: 5, failed: 0, attention: attentionCounts({ question: 1, review_ready: 1, failed: 1 }) },
        }),
        project('project-b', 'Beta', { counts: { tasks: 1, active: 1, failed: 0, attention: attentionCounts() } }),
      ]),
      tasks: (args) => page(args.project_id, args.status, [
        task('t1'), task('t2'), task('t3'), task('t4'), task('t5'),
      ]),
    });
    render(<ProjectsSidebar />);

    const badge = await screen.findByTestId('project-attention-project-a');
    expect(badge.textContent).toBe('Attention 3');
    expect(badge.getAttribute('data-attention-total')).toBe('3');
    expect(badge.getAttribute('title')).toContain('Pregunta 1');
    expect(badge.getAttribute('title')).toContain('Revisión lista 1');
    expect(screen.getByTestId('project-status-project-a').textContent).toBe('Con Attention');
    expect(screen.queryByTestId('project-attention-project-b')).toBeNull();

    fireEvent.click(screen.getByRole('treeitem', { name: /Alpha/ }));
    await screen.findByText('Task t1');
    expect(screen.getAllByRole('treeitem', { name: /^Task t/ })).toHaveLength(5);
    expect(screen.getByTestId('project-attention-project-a').textContent).toBe('Attention 3');
    expect(calls.every((call) => call.query !== 'attention_list')).toBe(true);
  });

  it('no muestra unread: no existe una fuente autoritativa separada', async () => {
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => page(args.project_id, args.status, [task('t1')]),
    });
    render(<ProjectsSidebar />);

    fireEvent.click(await screen.findByRole('treeitem', { name: /Alpha/ }));
    await screen.findByText('Task t1');
    expect(screen.queryByText(/unread/i)).toBeNull();
    expect(screen.queryByText(/sin leer/i)).toBeNull();
    expect(document.querySelectorAll('[data-unread]')).toHaveLength(0);
    expect(onlyReadQueries(calls)).toBe(true);
  });

  it('trata host, origen, rama y worktree como metadato y usa «No informado» cuando faltan', async () => {
    mountCore({
      overviews: () => overview([
        project('project-a', 'Alpha', {
          locations: [{ machine: 'vps-1', path: '/srv/alpha', primary: true, state: 'ok', last_seen: 1 }],
        }),
        project('project-b', 'Beta', { locations: [] }),
      ]),
      tasks: (args) => page(args.project_id, args.status, [task('t1', { model: null })]),
    });
    render(<ProjectsSidebar />);

    const alpha = await screen.findByRole('treeitem', { name: /Alpha/ });
    expect(alpha.textContent).toContain('Host vps-1');
    expect(alpha.textContent).toContain('Origen /srv/alpha');
    const beta = screen.getByRole('treeitem', { name: /Beta/ });
    expect(beta.textContent).toContain(`Host ${NOT_REPORTED}`);
    expect(beta.textContent).toContain(`Origen ${NOT_REPORTED}`);

    fireEvent.click(beta);
    const taskRow = await screen.findByRole('treeitem', { name: /Task t1/ });
    expect(taskRow.textContent).toContain('Proveedor claude');
    expect(taskRow.textContent).toContain(`Modelo ${NOT_REPORTED}`);
    expect(taskRow.textContent).toContain(`Rama ${NOT_REPORTED}`);
    expect(taskRow.textContent).toContain(`Worktree ${NOT_REPORTED}`);
    expect(taskRow.getAttribute('data-task-id')).toBe('t1');
  });

  it('muestra el metadato de provenance sin convertirlo en categoría ni identidad', async () => {
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => page(args.project_id, args.status, [
        task('t1', { branch: 'feat/x', worktree: '/wt/x', provider: 'codex', model: 'gpt-5' }),
      ]),
    });
    render(<ProjectsSidebar />);

    fireEvent.click(await screen.findByRole('treeitem', { name: /Alpha/ }));
    const taskRow = await screen.findByRole('treeitem', { name: /Task t1/ });
    expect(taskRow.textContent).toContain('Rama feat/x');
    expect(taskRow.textContent).toContain('Worktree /wt/x');
    expect(taskRow.textContent).toContain('Proveedor codex');
    expect(taskRow.textContent).toContain('Modelo gpt-5');
    expect(document.querySelectorAll('[data-branch]')).toHaveLength(0);
    expect(taskRow.getAttribute('data-task-id')).toBe('t1');
  });

  it('selecciona por ID durable, notifica por callback y mantiene Task y Project consistentes', async () => {
    const onSelectProject = vi.fn();
    const onSelectTask = vi.fn();
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha'), project('project-b', 'Beta')]),
      tasks: (args) => page(args.project_id, args.status, [task(`${args.project_id}-task`)]),
    });
    render(<ProjectsSidebar onSelectProject={onSelectProject} onSelectTask={onSelectTask} />);

    fireEvent.click(await screen.findByRole('treeitem', { name: /Alpha/ }));
    expect(onSelectProject).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'project-a', name: 'Alpha' }));

    const taskRow = await screen.findByRole('treeitem', { name: /Task project-a-task/ });
    fireEvent.click(taskRow);
    expect(onSelectTask).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: 'project-a-task', projectId: 'project-a' }));
    expect(taskRow.getAttribute('aria-selected')).toBe('true');
    expect(taskRow.getAttribute('tabindex')).toBe('0');
    // El árbol es de selección única: el Project queda como contexto visual, no como fila seleccionada.
    const alpha = screen.getByRole('treeitem', { name: /Alpha/ });
    expect(alpha.getAttribute('aria-selected')).toBe('false');
    expect(alpha.getAttribute('tabindex')).toBe('-1');
    expect(alpha.classList.contains('is-context')).toBe(true);

    fireEvent.click(screen.getByRole('treeitem', { name: /Beta/ }));
    expect(onSelectTask).toHaveBeenLastCalledWith(null, { projectId: 'project-b', taskId: null });
    expect(screen.getByRole('treeitem', { name: /Task project-a-task/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('treeitem', { name: /Beta/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('navega con el teclado y no depende de índices ni etiquetas', async () => {
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha'), project('project-b', 'Beta')]),
      tasks: (args) => page(args.project_id, args.status, [
        task(`${args.project_id}-t1`, { created_at: 2_000 }),
        task(`${args.project_id}-t2`, { created_at: 1_000 }),
      ]),
    });
    render(<ProjectsSidebar />);

    const alpha = await screen.findByRole('treeitem', { name: /Alpha/ });
    const beta = screen.getByRole('treeitem', { name: /Beta/ });
    expect(alpha.getAttribute('tabindex')).toBe('0');
    expect(beta.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(alpha, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(beta);
    expect(beta.getAttribute('tabindex')).toBe('0');
    expect(alpha.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(beta, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(alpha);

    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    await waitFor(() => expect(alpha.getAttribute('aria-expanded')).toBe('true'));
    const firstTask = await screen.findByRole('treeitem', { name: /Task project-a-t1/ });
    await flush();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(firstTask);
    // El foco de la Task no lo pisa el onFocus burbujeante del Project: la fila activa es la Task.
    expect(firstTask.getAttribute('tabindex')).toBe('0');
    expect(alpha.getAttribute('tabindex')).toBe('-1');

    fireEvent.keyDown(firstTask, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(alpha);
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(firstTask);

    fireEvent.keyDown(firstTask, { key: 'End' });
    expect(document.activeElement).toBe(beta);
    fireEvent.keyDown(beta, { key: 'Home' });
    expect(document.activeElement).toBe(alpha);

    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
    await waitFor(() => expect(alpha.getAttribute('aria-expanded')).toBe('false'));

    fireEvent.keyDown(alpha, { key: 'Enter' });
    await waitFor(() => expect(alpha.getAttribute('aria-expanded')).toBe('true'));
    expect(alpha.getAttribute('aria-selected')).toBe('true');

    const taskRow = await screen.findByRole('treeitem', { name: /Task project-a-t1/ });
    fireEvent.keyDown(taskRow, { key: ' ' });
    expect(taskRow.getAttribute('aria-selected')).toBe('true');
  });

  it('los botones anidados conservan su teclado y no pliegan el Project', async () => {
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => page(args.project_id, args.status, [task('t1')], { hasMore: true }),
    });
    render(<ProjectsSidebar />);

    const alpha = await screen.findByRole('treeitem', { name: /Alpha/ });
    fireEvent.click(alpha);
    const more = await screen.findByRole('button', { name: 'Cargar más Tasks' });
    more.focus();

    fireEvent.keyDown(more, { key: 'Enter' });
    expect(alpha.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(more);

    fireEvent.keyDown(more, { key: ' ' });
    expect(alpha.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(more);
  });

  it('distingue visualmente estados activos, en espera, fallidos y finales', async () => {
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha', { status: 'active' })]),
      tasks: (args) => page(args.project_id, args.status, args.status === 'all'
        ? [
          task('t-running', { status: 'running', title: 'Running' }),
          task('t-waiting', { status: 'waiting', title: 'Waiting' }),
          task('t-failed', { status: 'failed', title: 'Failed' }),
          task('t-done', { status: 'done', title: 'Done' }),
        ]
        : [task('t-running', { status: 'running', title: 'Running' })]),
    });
    render(<ProjectsSidebar />);

    const alpha = await screen.findByRole('treeitem', { name: /Alpha/ });
    expect(alpha.querySelector('.ps__badge--status-active')).toBeTruthy();
    fireEvent.click(alpha);
    await screen.findByText('Running');
    fireEvent.click(screen.getByRole('radio', { name: 'Todas' }));

    const badgeOf = (title) => screen.getByRole('treeitem', { name: new RegExp(title) })
      .querySelector('.ps__badge--task');
    await waitFor(() => expect(badgeOf('Failed')).toBeTruthy());
    expect(badgeOf('Running').classList.contains('ps__badge--active')).toBe(true);
    expect(badgeOf('Waiting').classList.contains('ps__badge--waiting')).toBe(true);
    expect(badgeOf('Failed').classList.contains('ps__badge--failed')).toBe(true);
    expect(badgeOf('Failed').classList.contains('ps__badge--final')).toBe(true);
    expect(badgeOf('Done').classList.contains('ps__badge--done')).toBe(true);
    expect(badgeOf('Done').classList.contains('ps__badge--final')).toBe(true);
  });

  it('las actualizaciones en segundo plano no roban foco ni cambian selección o expansión', async () => {
    vi.useFakeTimers();
    let tick = 0;
    mountCore({
      overviews: () => {
        tick += 1;
        return overview([
          project('project-a', 'Alpha', { counts: { tasks: 2, active: 2, failed: 0, attention: attentionCounts() } }),
          tick === 1 ? project('project-b', 'Beta') : project('project-c', 'Gamma'),
        ]);
      },
      tasks: (args) => page(args.project_id, args.status, tick === 1
        ? [task('t1')]
        : [task('t0', { created_at: 5_000, title: 'Task nueva' }), task('t1', { title: 'Task renombrada' })]),
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();

    fireEvent.click(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();
    const taskRow = screen.getByRole('treeitem', { name: /Task t1/ });
    fireEvent.click(taskRow);
    taskRow.focus();
    expect(document.activeElement).toBe(taskRow);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();

    expect(document.activeElement).toBe(taskRow);
    expect(document.querySelector('li[data-task-id="t1"]')).toBe(taskRow);
    expect(document.querySelector('li[data-task-id="t1"]').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('treeitem', { name: /Alpha/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Task nueva')).toBeTruthy();
    expect(screen.queryByText('Beta')).toBeNull();
    expect(screen.getByText('Gamma')).toBeTruthy();
  });

  it('si la fila enfocada desaparece del Core no se roba el foco a otra fila', async () => {
    vi.useFakeTimers();
    let tick = 0;
    mountCore({
      overviews: () => {
        tick += 1;
        return overview(tick === 1 ? [project('project-a', 'Alpha'), project('project-b', 'Beta')] : [project('project-a', 'Alpha')]);
      },
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();

    const beta = screen.getByRole('treeitem', { name: /Beta/ });
    beta.focus();
    expect(document.activeElement).toBe(beta);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();

    const live = screen.getAllByRole('treeitem');
    expect(live).toHaveLength(1);
    expect(live[0]).not.toBe(document.activeElement);
    expect(live[0].getAttribute('tabindex')).toBe('0');
  });

  it('conserva selección, expansión e IDs durables cuando el Project sale del overview', async () => {
    vi.useFakeTimers();
    let tick = 0;
    mountCore({
      overviews: () => {
        tick += 1;
        return overview(tick === 2 ? [] : [project('project-a', 'Alpha')]);
      },
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();

    const alpha = screen.getByRole('treeitem', { name: /Alpha/ });
    fireEvent.click(alpha);
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(alpha.getAttribute('aria-expanded')).toBe('true');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.getByText(/El Project seleccionado \(project-a\) ya no aparece/)).toBeTruthy();
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    const alphaAgain = screen.getByRole('treeitem', { name: /Alpha/ });
    expect(alphaAgain.getAttribute('aria-selected')).toBe('true');
    expect(alphaAgain.getAttribute('aria-expanded')).toBe('true');
  });

  it('conserva y notifica la expansión por Project', async () => {
    const changes = [];
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha'), project('project-b', 'Beta')]),
      tasks: (args) => page(args.project_id, args.status, [task(`${args.project_id}-t1`)]),
    });
    render(<ProjectsSidebar onExpandedChange={(ids) => changes.push(ids)} />);

    fireEvent.click(await screen.findByRole('treeitem', { name: /Alpha/ }));
    fireEvent.click(screen.getByRole('treeitem', { name: /Beta/ }));
    expect(changes).toEqual([['project-a'], ['project-a', 'project-b']]);

    fireEvent.click(screen.getByRole('treeitem', { name: /Alpha/ }));
    expect(changes).toEqual([['project-a'], ['project-a', 'project-b'], ['project-b']]);
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /Alpha/ }).getAttribute('aria-expanded')).toBe('false'));
    expect(screen.getByRole('treeitem', { name: /Beta/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('representa Core degradado en el overview y reintenta la lectura', async () => {
    let attempts = 0;
    const calls = mountCore({
      overviews: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('projects_overview_unavailable: almacén Core no disponible');
        return overview([project('project-a', 'Alpha')]);
      },
    });
    render(<ProjectsSidebar />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Core degradado');
    expect(alert.textContent).toContain('projects_overview_unavailable');

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar lectura' }));
    expect(await screen.findByRole('treeitem', { name: /Alpha/ })).toBeTruthy();
    expect(calls.every((call) => call.query === 'projects_overview')).toBe(true);
    expect(invoke.mock.calls.every(([command]) => command === 'orch_query')).toBe(true);
  });

  it('presenta el error de Tasks dentro del Project expandido y reintenta solo esa lectura', async () => {
    let attempts = 0;
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        attempts += 1;
        if (attempts === 1) throw new Error('tasks_read_failed: falló la lectura de SQLite');
        return page(args.project_id, args.status, [task('t1')]);
      },
    });
    render(<ProjectsSidebar />);

    fireEvent.click(await screen.findByRole('treeitem', { name: /Alpha/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Core no pudo leer este dato.');
    expect(alert.textContent).toContain('tasks_read_failed');

    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar lectura' }));
    expect(await screen.findByText('Task t1')).toBeTruthy();
    expect(onlyReadQueries(calls)).toBe(true);
  });

  it('conserva la última respuesta correcta mientras el overview está stale', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    mountCore({
      overviews: () => {
        attempts += 1;
        if (attempts === 2) throw new Error('projects_overview_read_failed: falló la lectura de SQLite');
        return overview([project('project-a', 'Alpha')]);
      },
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    expect(screen.getByRole('treeitem', { name: /Alpha/ })).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.getByText(/Datos desactualizados/)).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: /Alpha/ })).toBeTruthy();
  });

  it('no consulta el Core cuando la vista está inactiva', async () => {
    render(<ProjectsSidebar active={false} />);
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.getByTestId('projects-sidebar').getAttribute('aria-hidden')).toBe('true');
  });

  it('transporta el filtro archived al overview', async () => {
    const calls = mountCore({ overviews: (args) => overview([], { archived: args.archived }) });
    render(<ProjectsSidebar archived="only" />);
    await flush();
    expect(calls).toEqual([{ query: 'projects_overview', args: { archived: 'only' } }]);
  });

  it('no ofrece Attempts, creación, reintento de Tasks, drag/drop ni mission-map', async () => {
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => page(args.project_id, args.status, [task('t1')]),
    });
    render(<ProjectsSidebar />);
    fireEvent.click(await screen.findByRole('treeitem', { name: /Alpha/ }));
    await screen.findByText('Task t1');

    expect(screen.queryByRole('button', { name: /crear Task|nueva Task|reintentar Task|Attempt|mission/i })).toBeNull();
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-attempt-id], [data-mission]')).toHaveLength(0);
  });

  it('avisa de las Tasks sin Project sin inventar identidad', async () => {
    mountCore({ overviews: () => overview([project('project-a', 'Alpha')], { unassignedTasks: 4 }) });
    render(<ProjectsSidebar />);

    await screen.findByRole('treeitem', { name: /Alpha/ });
    const hint = screen.getByTestId('unassigned-hint');
    expect(hint.textContent).toContain('4 Tasks del Core sin Project');
    expect(screen.queryAllByRole('treeitem')).toHaveLength(1);
  });

  it('los resúmenes de selección exponen los IDs durables del contrato', () => {
    const projectSummary = toProjectSummary(project('project-a', 'Alpha', {
      locations: [{ machine: 'vps-1', path: '/srv/alpha', primary: false, state: 'ok', last_seen: 1 }],
      counts: { tasks: 3, active: 2, failed: 1, attention: attentionCounts({ risk: 1 }) },
    }));
    expect(projectSummary).toEqual({
      projectId: 'project-a',
      name: 'Alpha',
      state: 'active',
      status: 'active',
      taskCounts: { tasks: 3, active: 2, failed: 1 },
      attentionTotal: 1,
      host: 'vps-1',
      origin: '/srv/alpha',
    });

    const taskSummary = toTaskSummary(task('t12', { parent_id: 't10', root_id: 't10', model: null }), 'project-a');
    expect(taskSummary).toMatchObject({
      taskId: 't12',
      projectId: 'project-a',
      runId: 'run-t12',
      parentId: 't10',
      rootId: 't10',
      model: null,
      branch: null,
      worktree: null,
    });
  });
});
