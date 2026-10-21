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
const clickProject = (row) => fireEvent.click(row.querySelector('.ps__name'));
const flush = async () => {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const mockScrollIntoView = (node) => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(node, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  return scrollIntoView;
};

const scrollPrototypeRestorers = [];
const trackScrollIntoView = () => {
  const previous = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const calls = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(options) { calls.push({ element: this, options }); },
  });
  scrollPrototypeRestorers.push(() => {
    if (previous) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', previous);
    else delete HTMLElement.prototype.scrollIntoView;
  });
  return calls;
};

afterEach(() => {
  cleanup();
  for (const restore of scrollPrototypeRestorers.splice(0)) restore();
  document.body.removeAttribute('tabindex');
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

  it('emite metadata completa del Project controlado por ID desde su único overview', async () => {
    const selectedProject = project('project-a', 'Alpha', {
      counts: { tasks: 3, active: 2, failed: 1, attention: attentionCounts({ question: 1 }) },
      locations: [{ machine: 'machine-a', path: 'C:/repos/alpha', primary: true, state: 'ok', last_seen: 1_760_000_000_000 }],
    });
    const betaProject = project('project-b', 'Beta');
    const calls = mountCore({ overviews: () => overview([selectedProject, betaProject]) });
    const onProjectSnapshot = vi.fn();
    const { rerender } = render(
      <ProjectsSidebar
        selection={{ projectId: 'project-a', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );

    await screen.findByRole('treeitem', { name: /Alpha/ });
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith({
      projectId: 'project-a',
      queryState: 'ready',
      project: {
        id: 'project-a',
        projectId: 'project-a',
        name: 'Alpha',
        state: 'active',
        status: 'active',
        counts: selectedProject.counts,
        locations: selectedProject.locations,
      },
      error: null,
      reason: null,
    }));
    expect(calls.filter((call) => call.query === 'projects_overview')).toHaveLength(1);

    rerender(
      <ProjectsSidebar
        selection={{ projectId: 'project-b', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith({
      projectId: 'project-b',
      queryState: 'ready',
      project: {
        id: 'project-b', projectId: 'project-b', name: 'Beta', state: 'active', status: 'active',
        counts: betaProject.counts, locations: betaProject.locations,
      },
      error: null,
      reason: null,
    }));
    expect(calls.filter((call) => call.query === 'projects_overview')).toHaveLength(1);
  });

  it('emite missing si un overview completo no contiene el ID controlado', async () => {
    const onProjectSnapshot = vi.fn();
    mountCore({ overviews: () => overview([project('project-b', 'Beta')]) });
    render(
      <ProjectsSidebar
        selection={{ projectId: 'missing-project', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );

    await screen.findByRole('treeitem', { name: /Beta/ });
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith({
      projectId: 'missing-project', queryState: 'missing', project: null, error: null, reason: null,
    }));
  });

  it('emite missing cuando un overview vacío confirma que el Project seleccionado no existe', async () => {
    const onProjectSnapshot = vi.fn();
    mountCore({ overviews: () => overview([]) });
    render(
      <ProjectsSidebar
        selection={{ projectId: 'project-a', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );

    await screen.findByText('No hay Projects registrados con este filtro del Core.');
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith({
      projectId: 'project-a', queryState: 'missing', project: null, error: null, reason: null,
    }));
  });

  it('emite loading mientras espera el primer overview de la selección', async () => {
    const pendingOverview = deferred();
    const onProjectSnapshot = vi.fn();
    mountCore({ overviews: () => pendingOverview.promise });
    render(
      <ProjectsSidebar
        selection={{ projectId: 'project-a', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );

    await flush();
    expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', queryState: 'loading', project: null, error: null, reason: null,
    }));

    pendingOverview.resolve(overview([project('project-a', 'Alpha')]));
    await screen.findByRole('treeitem', { name: /Alpha/ });
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', queryState: 'ready', reason: null,
    })));
  });

  it('no completa campos ausentes del Project con valores inferidos', async () => {
    const sparseProject = { id: 'project-sparse', name: 'Sparse', state: 'active' };
    const onProjectSnapshot = vi.fn();
    mountCore({ overviews: () => overview([sparseProject]) });
    render(
      <ProjectsSidebar
        selection={{ projectId: 'project-sparse', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );

    await screen.findByRole('treeitem', { name: /Sparse/ });
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith({
      projectId: 'project-sparse',
      queryState: 'ready',
      project: { id: 'project-sparse', projectId: 'project-sparse', name: 'Sparse', state: 'active' },
      error: null,
      reason: null,
    }));
  });

  it('emite error sin metadata inventada cuando el overview falla antes de una respuesta', async () => {
    const onProjectSnapshot = vi.fn();
    mountCore({ overviews: () => { throw new Error('projects_overview_read_failed'); } });
    render(
      <ProjectsSidebar
        selection={{ projectId: 'project-a', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );

    await screen.findByRole('alert');
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith({
      projectId: 'project-a', queryState: 'error', project: null, error: 'projects_overview_read_failed', reason: null,
    }));
  });

  it.each([
    ['projects_overview_disconnected: Core desconectado', 'disconnected'],
    ['projects_overview_unavailable: almacén no disponible', 'degraded'],
    ['projects_overview_read_failed', 'error'],
  ])('preserva el estado inicial %s del overview', async (message, queryState) => {
    const onProjectSnapshot = vi.fn();
    mountCore({ overviews: () => { throw new Error(message); } });
    render(
      <ProjectsSidebar
        selection={{ projectId: 'project-a', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );

    await screen.findByRole('alert');
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', queryState, project: null, error: message, reason: null,
    })));
  });

  it('mantiene refreshing separado de stale durante un polling sano', async () => {
    vi.useFakeTimers();
    const pendingRefresh = deferred();
    let reads = 0;
    const onProjectSnapshot = vi.fn();
    mountCore({
      overviews: () => {
        reads += 1;
        return reads === 1 ? overview([project('project-a', 'Alpha')]) : pendingRefresh.promise;
      },
    });
    render(
      <ProjectsSidebar
        pollMs={1_000}
        selection={{ projectId: 'project-a', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );
    await flush();
    expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ queryState: 'ready', reason: null }));

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', queryState: 'refreshing', project: expect.objectContaining({ projectId: 'project-a' }),
      error: null, reason: null,
    }));
    expect(screen.getByRole('tree', { name: 'Projects y Tasks del Core' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByText(/Datos desactualizados/)).toBeNull();

    pendingRefresh.resolve(overview([project('project-a', 'Alpha')]));
    await flush();
    expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ queryState: 'ready', reason: null }));
  });

  it('conserva metadata marcada stale mientras no se pueda actualizar el overview', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const selectedProject = project('project-a', 'Alpha');
    const onProjectSnapshot = vi.fn();
    mountCore({
      overviews: () => {
        reads += 1;
        if (reads > 1) throw new Error('projects_overview_disconnected');
        return overview([selectedProject]);
      },
    });
    render(
      <ProjectsSidebar
        pollMs={1_000}
        selection={{ projectId: 'project-a', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );

    await flush();
    expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ queryState: 'ready' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', queryState: 'stale', project: expect.objectContaining({ projectId: 'project-a' }),
      error: 'projects_overview_disconnected',
      reason: 'disconnected',
    }));
  });

  it('soporta 100 Projects sin fan-out: solo consulta el overview hasta expandir', async () => {
    const projects = Array.from({ length: 100 }, (_, index) => project(`project-${String(index).padStart(3, '0')}`, `Alpha ${index}`));
    const calls = mountCore({ overviews: () => overview(projects) });
    const { container } = render(<ProjectsSidebar />);

    await screen.findByText('Alpha 0');
    const projectRows = container.querySelectorAll('li[data-project-id]');
    expect(projectRows).toHaveLength(100);
    expect(projectRows[0].getAttribute('aria-posinset')).toBe('1');
    expect(projectRows[0].getAttribute('aria-setsize')).toBe('100');
    expect(projectRows[99].getAttribute('aria-posinset')).toBe('100');
    expect(projectRows[99].getAttribute('aria-setsize')).toBe('100');
    expect(calls).toEqual([{ query: 'projects_overview', args: { archived: 'exclude' } }]);
    expect(onlyReadQueries(calls)).toBe(true);

    for (const id of ['project-000', 'project-001', 'project-099']) {
      clickProject(container.querySelector(`li[data-project-id="${id}"]`));
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

    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
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

    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
    await screen.findByText('Task t1');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await screen.findByText('Task t3');

    expect(screen.getAllByText('Task t2')).toHaveLength(1);
    expect([...container.querySelectorAll('li[data-task-id]')].map((node) => node.getAttribute('data-task-id')))
      .toEqual(['t3', 't2', 't1']);
    expect(taskCalls(calls).map((call) => call.args.cursor)).toEqual([undefined, 'cursor-1']);
  });

  it('no reconcilia tres páginas cargadas cuando el polling devuelve la misma cabecera', async () => {
    vi.useFakeTimers();
    const cursors = [];
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) return page(args.project_id, args.status, [task('head')], { hasMore: true, cursor: 'cursor-1' });
        cursors.push(args.cursor);
        const index = Number(args.cursor.slice('cursor-'.length));
        return page(args.project_id, args.status, [task(`page-${index}`, { created_at: 1_000 - index })], {
          hasMore: true,
          cursor: `cursor-${index + 1}`,
        });
      },
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();

    for (let index = 0; index < 3; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
      await flush();
    }
    expect(cursors).toEqual(['cursor-1', 'cursor-2', 'cursor-3']);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();

    expect(cursors).toEqual(['cursor-1', 'cursor-2', 'cursor-3']);
    expect(screen.queryByTestId('stale-task-pages-project-a')).toBeNull();
    expect(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' })).toBeTruthy();
    expect(onlyReadQueries(calls)).toBe(true);
  });

  it('reconcilia todas las páginas cargadas desde el cursor nuevo cuando cambia la cabecera', async () => {
    vi.useFakeTimers();
    let headReads = 0;
    const cursors = [];
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) {
          headReads += 1;
          return headReads === 1
            ? page(args.project_id, args.status, [task('head-old')], { hasMore: true, cursor: 'old-1' })
            : page(args.project_id, args.status, [task('head-new', { created_at: 5_000 })], { hasMore: true, cursor: 'new-1' });
        }
        cursors.push(args.cursor);
        if (args.cursor === 'old-1') return page(args.project_id, args.status, [task('old-page-1')], { hasMore: true, cursor: 'old-2' });
        if (args.cursor === 'old-2') return page(args.project_id, args.status, [task('old-page-2')], { hasMore: true, cursor: 'old-3' });
        if (args.cursor === 'new-1') return page(args.project_id, args.status, [task('new-page-1')], { hasMore: true, cursor: 'new-2' });
        if (args.cursor === 'new-2') return page(args.project_id, args.status, [task('new-page-2')], { hasMore: true, cursor: 'new-3' });
        return page(args.project_id, args.status, [task('new-page-3')]);
      },
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();
    expect(screen.getByText('Task old-page-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();
    expect(screen.getByText('Task old-page-2')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();

    expect(cursors).toEqual(['old-1', 'old-2', 'new-1', 'new-2']);
    expect(screen.getByText('Task new-page-1')).toBeTruthy();
    expect(screen.getByText('Task new-page-2')).toBeTruthy();
    expect(screen.queryByText('Task old-page-1')).toBeNull();
    expect(screen.queryByText('Task old-page-2')).toBeNull();
    expect(screen.queryByTestId('stale-task-pages-project-a')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();
    expect(screen.getByText('Task new-page-3')).toBeTruthy();
    expect(cursors.at(-1)).toBe('new-3');
  });

  it('no cancela una carga de página en curso durante un polling idéntico', async () => {
    vi.useFakeTimers();
    const pendingPage = deferred();
    const cursors = [];
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) return page(args.project_id, args.status, [task('head')], { hasMore: true, cursor: 'cursor-1' });
        cursors.push(args.cursor);
        return pendingPage.promise;
      },
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(cursors).toEqual(['cursor-1']);

    const loadedPage = page('project-a', 'active', [task('loaded-during-poll')], { hasMore: true, cursor: 'cursor-2' });
    await act(async () => {
      pendingPage.resolve(loadedPage);
      await pendingPage.promise;
    });
    await flush();
    expect(screen.getByText('Task loaded-during-poll')).toBeTruthy();
    expect(screen.queryByTestId('stale-task-pages-project-a')).toBeNull();
  });

  it('conserva las páginas como stale ante error de reconciliación y reintenta el cursor', async () => {
    vi.useFakeTimers();
    let headReads = 0;
    let reconcileAttempts = 0;
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) {
          headReads += 1;
          return page(args.project_id, args.status, [task(headReads === 1 ? 'head-old' : 'head-new')], {
            hasMore: true,
            cursor: headReads === 1 ? 'old-1' : 'new-1',
          });
        }
        if (args.cursor === 'old-1') return page(args.project_id, args.status, [task('old-page')], { hasMore: true, cursor: 'old-2' });
        if (args.cursor === 'new-1') {
          reconcileAttempts += 1;
          if (reconcileAttempts === 1) throw new Error('tasks_read_failed: lectura de reconciliación');
          return page(args.project_id, args.status, [task('new-page')], { hasMore: true, cursor: 'new-2' });
        }
        return page(args.project_id, args.status, [task('next-page')]);
      },
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();
    expect(screen.getByText('Task old-page')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    const stale = screen.getByTestId('stale-task-pages-project-a');
    expect(stale.textContent).toContain('tasks_read_failed');
    expect(screen.getByText('Task old-page')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reintentar actualización de páginas de Tasks de Alpha' }));
    await flush();
    expect(screen.getByText('Task new-page')).toBeTruthy();
    expect(reconcileAttempts).toBe(2);
    expect(screen.queryByText('Task old-page')).toBeNull();
    expect(screen.queryByTestId('stale-task-pages-project-a')).toBeNull();
  });

  it.each([1, 10, 100])('carga el dataset de %i Tasks y pagina 100 en dos respuestas', async (count) => {
    const dataset = Array.from({ length: count }, (_, index) => task(
      `task-${String(index + 1).padStart(3, '0')}`,
      { created_at: (count - index) * 1_000 },
    ));
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) {
          return page(args.project_id, args.status, dataset.slice(0, TASK_PAGE_LIMIT), {
            hasMore: count > TASK_PAGE_LIMIT,
            cursor: 'cursor-dataset',
          });
        }
        return page(args.project_id, args.status, [dataset[TASK_PAGE_LIMIT - 1], ...dataset.slice(TASK_PAGE_LIMIT)]);
      },
    });
    const { container } = render(<ProjectsSidebar />);

    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
    await waitFor(() => expect(container.querySelectorAll('li[data-task-id]')).toHaveLength(Math.min(count, TASK_PAGE_LIMIT)));
    const firstPageRows = container.querySelectorAll('li[data-task-id]');
    expect(firstPageRows[0].getAttribute('aria-posinset')).toBe('1');
    expect(firstPageRows[0].getAttribute('aria-setsize')).toBe(count > TASK_PAGE_LIMIT ? '-1' : String(count));
    if (count > TASK_PAGE_LIMIT) {
      fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
      await waitFor(() => expect(container.querySelectorAll('li[data-task-id]')).toHaveLength(count));
    }

    expect([...container.querySelectorAll('li[data-task-id]')].map((node) => node.getAttribute('data-task-id')))
      .toEqual(dataset.map((item) => item.id));
    const taskRows = container.querySelectorAll('li[data-task-id]');
    expect(taskRows[taskRows.length - 1].getAttribute('aria-posinset')).toBe(String(count));
    expect(taskRows[taskRows.length - 1].getAttribute('aria-setsize')).toBe(String(count));
    expect(taskCalls(calls).map((call) => call.args.cursor))
      .toEqual(count > TASK_PAGE_LIMIT ? [undefined, 'cursor-dataset'] : [undefined]);
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

    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
    await screen.findByText('Task t1');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));

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
    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();
    expect(screen.getByText('Task t1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Cargando Tasks de Alpha' })).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.getByText(/Datos desactualizados/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cargar más Tasks de Alpha' })).toBeNull();

    await act(async () => {
      resolveMore(page('project-a', 'active', [task('t2')]));
    });
    await flush();
    expect(screen.queryByText('Task t2')).toBeNull();
    expect(screen.getByText('Task t1')).toBeTruthy();
    expect(taskCalls(calls).some((call) => call.args.cursor === 'cursor-1')).toBe(true);
  });

  it('retiene las páginas cargadas y restaura el foco tras recuperar una cabecera desconectada', async () => {
    vi.useFakeTimers();
    let headReads = 0;
    let pageReads = 0;
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (args.cursor) {
          pageReads += 1;
          return pageReads === 1
            ? page(args.project_id, args.status, [task('t2', { created_at: 900 })], { hasMore: true, cursor: 'cursor-2' })
            : page(args.project_id, args.status, [task('t2', { created_at: 900 })]);
        }
        headReads += 1;
        if (headReads === 2) throw new Error('disconnected: Core IPC closed');
        return page(args.project_id, args.status, [task('t1', { created_at: 2_000 })], {
          hasMore: true,
          cursor: 'cursor-1',
        });
      },
    });
    const { container } = render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    const alpha = screen.getByRole('treeitem', { name: /Alpha/ });
    clickProject(alpha);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();
    expect(screen.getByText('Task t2')).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.getByText(/Core desconectado/)).toBeTruthy();
    expect(screen.getByText('Task t1')).toBeTruthy();
    expect(screen.getByText('Task t2')).toBeTruthy();
    expect(screen.getByTestId('stale-task-pages-project-a').textContent).toContain('Se conservan las páginas adicionales');
    const stalePageRow = container.querySelector('li[data-task-id="t2"]');
    expect(stalePageRow.querySelector('.ps__badge--stale')).toBeTruthy();
    expect(stalePageRow.getAttribute('aria-setsize')).toBe('-1');
    expect(screen.queryByRole('button', { name: 'Cargar más Tasks de Alpha' })).toBeNull();

    const retryHead = screen.getByRole('button', { name: 'Reintentar lectura de las Tasks de Alpha' });
    retryHead.focus();
    fireEvent.click(retryHead);
    await flush();
    expect(document.activeElement).toBe(alpha);
    expect(screen.getByText('Task t2')).toBeTruthy();

    const retryPages = screen.getByRole('button', { name: 'Reintentar actualización de páginas de Tasks de Alpha' });
    retryPages.focus();
    fireEvent.click(retryPages);
    await flush();
    expect(screen.queryByTestId('stale-task-pages-project-a')).toBeNull();
    expect(document.activeElement.getAttribute('role')).toBe('treeitem');
    expect(document.activeElement.getAttribute('data-task-id')).toBe('t2');
    expect(screen.getByText('Task t2')).toBeTruthy();
  });

  it('reconcilia título y estado de páginas cargadas tras refrescar la cabecera', async () => {
    vi.useFakeTimers();
    let headReads = 0;
    let resolveFreshPage;
    const freshPage = new Promise((resolve) => { resolveFreshPage = resolve; });
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (args.cursor === 'cursor-old') {
          return page(args.project_id, args.status, [task('t2', { title: 'Task antigua', status: 'running', created_at: 900 })]);
        }
        if (args.cursor === 'cursor-new') return freshPage;
        headReads += 1;
        return page(args.project_id, args.status, [task('t1', { created_at: 2_000 })], {
          hasMore: true,
          cursor: headReads === 1 ? 'cursor-old' : 'cursor-new',
        });
      },
    });
    const { container } = render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();

    const oldRow = screen.getByRole('treeitem', { name: /Task antigua/ });
    fireEvent.click(oldRow);
    oldRow.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();

    expect(screen.getByTestId('stale-task-pages-project-a')).toBeTruthy();
    expect(oldRow.getAttribute('aria-label')).toMatch(/^Datos desactualizados/);
    expect(oldRow.querySelector('.ps__badge--stale')).toBeTruthy();
    expect(taskCalls(calls).map((call) => call.args.cursor)).toEqual([undefined, 'cursor-old', undefined, 'cursor-new']);

    await act(async () => { resolveFreshPage(page('project-a', 'active', [task('t2', {
      title: 'Task actualizada', status: 'waiting', created_at: 900,
    })])); });
    await flush();

    const freshRow = screen.getByRole('treeitem', { name: /Task actualizada/ });
    expect(freshRow).toBe(oldRow);
    expect(freshRow.getAttribute('data-status')).toBe('waiting');
    expect(freshRow.getAttribute('aria-selected')).toBe('true');
    expect(freshRow.querySelector('.ps__badge--stale')).toBeNull();
    expect(document.activeElement).toBe(freshRow);
    expect(container.querySelectorAll('li[data-task-id="t2"]')).toHaveLength(1);
    expect(screen.queryByText('Task antigua')).toBeNull();
  });

  it('libera el lock al recuperar una cabecera stale y un finally viejo no bloquea la página nueva', async () => {
    vi.useFakeTimers();
    let headReads = 0;
    let moreReads = 0;
    let resolveObsoletePage;
    let resolveCurrentPage;
    const obsoletePage = new Promise((resolve) => { resolveObsoletePage = resolve; });
    const currentPage = new Promise((resolve) => { resolveCurrentPage = resolve; });
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (args.cursor) {
          moreReads += 1;
          return moreReads === 1 ? obsoletePage : currentPage;
        }
        headReads += 1;
        if (headReads === 2) throw new Error('tasks_by_project_read_failed');
        return page(args.project_id, args.status, [task('t1')], {
          hasMore: true,
          cursor: headReads === 1 ? 'cursor-old' : 'cursor-current',
        });
      },
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.getByText(/Datos desactualizados/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cargar más Tasks de Alpha' })).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();
    expect(screen.getByRole('button', { name: 'Cargando Tasks de Alpha' }).disabled).toBe(true);

    await act(async () => { resolveObsoletePage(page('project-a', 'active', [task('t-obsolete')])); });
    await flush();
    expect(screen.getByRole('button', { name: 'Cargando Tasks de Alpha' }).disabled).toBe(true);

    await act(async () => { resolveCurrentPage(page('project-a', 'active', [task('t-current')])); });
    await flush();
    expect(screen.getByText('Task t-current')).toBeTruthy();
    expect(screen.queryByText('Task t-obsolete')).toBeNull();
    expect(taskCalls(calls).some((call) => call.args.cursor === 'cursor-current')).toBe(true);
  });

  it('cambio de filtro invalida la petición anterior sin dejar que su finally libere la nueva', async () => {
    let resolveActivePage;
    let resolveFinalPage;
    const activePage = new Promise((resolve) => { resolveActivePage = resolve; });
    const finalPage = new Promise((resolve) => { resolveFinalPage = resolve; });
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (args.cursor) return args.status === 'active' ? activePage : finalPage;
        return args.status === 'active'
          ? page(args.project_id, args.status, [task('t-active')], { hasMore: true, cursor: 'cursor-active' })
          : page(args.project_id, args.status, [task('t-final')], { hasMore: true, cursor: 'cursor-final' });
      },
    });
    render(<ProjectsSidebar />);
    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
    await screen.findByText('Task t-active');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));

    fireEvent.click(screen.getByRole('radio', { name: 'Finalizadas' }));
    await screen.findByText('Task t-final');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();
    expect(taskCalls(calls).map((call) => call.args.cursor)).toEqual([undefined, 'cursor-active', undefined, 'cursor-final']);

    await act(async () => { resolveActivePage(page('project-a', 'active', [task('t-active-obsolete')])); });
    await flush();
    expect(screen.getByRole('button', { name: 'Cargando Tasks de Alpha' }).disabled).toBe(true);

    await act(async () => { resolveFinalPage(page('project-a', 'final', [task('t-final-next')])); });
    await flush();
    expect(screen.getByText('Task t-final-next')).toBeTruthy();
    expect(screen.queryByText('Task t-active-obsolete')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Finalizadas' }).checked).toBe(true);
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
    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
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

    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
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

    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
    await screen.findByText('Task t1');
    expect(screen.queryByText(/unread/i)).toBeNull();
    expect(screen.queryByText(/sin leer/i)).toBeNull();
    expect(document.querySelectorAll('[data-unread]')).toHaveLength(0);
    expect(onlyReadQueries(calls)).toBe(true);
  });

  it('trata host, origen, rama y worktree como metadato y reserva los ausentes para el detalle', async () => {
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

    clickProject(beta);
    const taskRow = await screen.findByRole('treeitem', { name: /Task t1/ });
    expect(taskRow.textContent).toContain('Proveedor claude');
    expect(taskRow.textContent).toContain(`Modelo ${NOT_REPORTED}`);
    expect(taskRow.textContent).toContain('Rama Solo en detalle');
    expect(taskRow.textContent).toContain('Worktree Solo en detalle');
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

    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
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

    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
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

    clickProject(screen.getByRole('treeitem', { name: /Beta/ }));
    expect(onSelectTask).toHaveBeenLastCalledWith(null, { projectId: 'project-b', taskId: null });
    expect(screen.getByRole('treeitem', { name: /Task project-a-task/ }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('treeitem', { name: /Beta/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('sigue la selección externa, expande el Project y conserva filtro, expansión y foco', async () => {
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha'), project('project-b', 'Beta')]),
      tasks: (args) => page(args.project_id, args.status, [
        task(`${args.project_id}-task`, { status: 'done' }),
      ]),
    });
    const { rerender } = render(
      <ProjectsSidebar
        selection={{ projectId: 'project-a', taskId: null }}
      />,
    );

    const alpha = await screen.findByRole('treeitem', { name: /Alpha/ });
    const beta = screen.getByRole('treeitem', { name: /Beta/ });
    await waitFor(() => expect(alpha.getAttribute('aria-expanded')).toBe('true'));
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(alpha.classList.contains('is-selected')).toBe(true);
    expect(beta.getAttribute('aria-expanded')).toBe('false');

    const finalFilter = screen.getByRole('radio', { name: 'Finalizadas' });
    fireEvent.click(finalFilter);
    finalFilter.focus();
    expect(document.activeElement).toBe(finalFilter);

    rerender(
      <ProjectsSidebar
        selection={{ projectId: 'project-b', taskId: null }}
      />,
    );
    await waitFor(() => expect(beta.getAttribute('aria-selected')).toBe('true'));
    await waitFor(() => expect(beta.getAttribute('aria-expanded')).toBe('true'));
    expect(alpha.getAttribute('aria-selected')).toBe('false');
    expect(alpha.getAttribute('aria-expanded')).toBe('true');
    expect(beta.getAttribute('aria-expanded')).toBe('true');
    expect(finalFilter.checked).toBe(true);
    expect(document.activeElement).toBe(finalFilter);

    const taskRow = await screen.findByRole('treeitem', { name: /Task project-b-task/ });

    rerender(
      <ProjectsSidebar
        selection={{ projectId: 'project-b', taskId: 'project-b-task' }}
      />,
    );

    await waitFor(() => expect(taskRow.getAttribute('aria-selected')).toBe('true'));
    expect(taskRow.classList.contains('is-selected')).toBe(true);
    expect(alpha.getAttribute('aria-selected')).toBe('false');
    expect(beta.getAttribute('aria-selected')).toBe('false');
    expect(beta.classList.contains('is-context')).toBe(true);
    expect(alpha.getAttribute('aria-expanded')).toBe('true');
    expect(beta.getAttribute('aria-expanded')).toBe('true');
    expect(finalFilter.checked).toBe(true);
    expect(document.activeElement).toBe(finalFilter);
  });

  it('revela por scroll los cambios controlados de Project y Task sin mover el foco', async () => {
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha'), project('project-b', 'Beta')]),
      tasks: (args) => page(args.project_id, args.status, [task(`${args.project_id}-task`)]),
    });
    const { rerender } = render(
      <ProjectsSidebar selection={{ projectId: 'project-a', taskId: null }} />,
    );

    await screen.findByRole('treeitem', { name: /Alpha/ });
    const beta = screen.getByRole('treeitem', { name: /Beta/ });
    const scrollBeta = mockScrollIntoView(beta);
    const filter = screen.getByRole('radio', { name: 'Activas' });
    filter.focus();

    rerender(<ProjectsSidebar selection={{ projectId: 'project-b', taskId: null }} />);
    await waitFor(() => expect(scrollBeta).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' }));
    expect(document.activeElement).toBe(filter);

    const taskRow = await screen.findByRole('treeitem', { name: /Task project-b-task/ });
    const scrollTask = mockScrollIntoView(taskRow);
    rerender(<ProjectsSidebar selection={{ projectId: 'project-b', taskId: 'project-b-task' }} />);

    await waitFor(() => expect(scrollTask).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' }));
    expect(document.activeElement).toBe(filter);
  });

  it('sigue la selección controlada de una Task hasta una página posterior y solo hace scroll', async () => {
    const scrollCalls = trackScrollIntoView();
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (args.status !== 'all') return page(args.project_id, args.status, [task('active-first')]);
        if (!args.cursor) return page(args.project_id, args.status, [task('all-first')], { hasMore: true, cursor: 'all-cursor-1' });
        return page(args.project_id, args.status, [task('target', { status: 'done' })]);
      },
    });
    const { rerender } = render(
      <ProjectsSidebar selection={{ projectId: 'project-a', taskId: null }} />,
    );
    await screen.findByText('Task active-first');

    const activeFilter = screen.getByRole('radio', { name: 'Activas' });
    activeFilter.focus();
    rerender(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'target' }} />);

    const target = await screen.findByRole('treeitem', { name: /Task target/ });
    await waitFor(() => expect(scrollCalls.some(({ element }) => element === target)).toBe(true));
    expect(screen.getByRole('radio', { name: 'Todas' }).checked).toBe(true);
    expect(target.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(activeFilter);
    expect(taskCalls(calls).map(({ args }) => [args.status, args.cursor])).toEqual([
      ['active', undefined],
      ['all', undefined],
      ['all', 'all-cursor-1'],
    ]);
  });

  it('mantiene montada la región status al anunciar el cambio automático a Todas', async () => {
    const scrollCalls = trackScrollIntoView();
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => args.status === 'all'
        ? page(args.project_id, args.status, [task('final-target', { status: 'failed' })])
        : page(args.project_id, args.status, [task('active-first')]),
    });
    const { rerender } = render(
      <ProjectsSidebar selection={{ projectId: 'project-a', taskId: null }} />,
    );
    await screen.findByText('Task active-first');
    const notice = screen.getByTestId('selection-filter-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-live')).toBe('polite');
    expect(notice.getAttribute('aria-atomic')).toBe('true');
    expect(notice.textContent).toBe('');
    const activeFilter = screen.getByRole('radio', { name: 'Activas' });
    activeFilter.focus();

    rerender(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'final-target' }} />);

    const target = await screen.findByRole('treeitem', { name: /Task final-target/ });
    await waitFor(() => expect(scrollCalls.some(({ element }) => element === target)).toBe(true));
    expect(screen.getByRole('radio', { name: 'Todas' }).checked).toBe(true);
    expect(screen.getByTestId('selection-filter-notice')).toBe(notice);
    expect(notice.textContent).toContain('Filtro cambiado automáticamente a Todas');
    expect(taskCalls(calls).map(({ args }) => args.status)).toEqual(['active', 'all']);
    expect(document.activeElement).toBe(activeFilter);
  });

  it('anuncia después del montaje una Task controlada que ya aparece en la primera página', async () => {
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => page(args.project_id, args.status, [task('present-task', { status: 'running', title: 'Present target' })]),
    });
    render(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'present-task' }} />);

    const notice = screen.getByTestId('selection-filter-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.className).toBe('ps__live-region--sr-only');
    expect(notice.textContent).toBe('');
    const activeFilter = screen.getByRole('radio', { name: 'Activas' });
    activeFilter.focus();

    const target = await screen.findByRole('treeitem', { name: /Present target/ });
    await waitFor(() => expect(notice.textContent).toContain('Task seleccionada: Present target.'));

    expect(screen.getByTestId('selection-filter-notice')).toBe(notice);
    expect(notice.className).toBe('ps__live-region--sr-only');
    expect(screen.getByRole('radio', { name: 'Activas' }).checked).toBe(true);
    expect(target.getAttribute('aria-selected')).toBe('true');
    expect(taskCalls(calls).map(({ args }) => args.status)).toEqual(['active']);
    expect(document.activeElement).toBe(activeFilter);
  });

  it('limpia el anuncio al cambiar de Project y conserva el foco', async () => {
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha'), project('project-b', 'Beta')]),
      tasks: (args) => page(
        args.project_id,
        args.status,
        [task(args.project_id === 'project-a' ? 'alpha-task' : 'beta-task', {
          title: args.project_id === 'project-a' ? 'Alpha selected' : 'Beta task',
        })],
      ),
    });
    const { rerender } = render(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'alpha-task' }} />);
    const notice = screen.getByTestId('selection-filter-notice');
    await waitFor(() => expect(notice.textContent).toContain('Task seleccionada: Alpha selected.'));
    const activeFilter = screen.getByRole('radio', { name: 'Activas' });
    activeFilter.focus();

    rerender(<ProjectsSidebar selection={{ projectId: 'project-b', taskId: null }} />);
    await waitFor(() => expect(notice.textContent).toBe(''));

    expect(screen.getByTestId('selection-filter-notice')).toBe(notice);
    expect(screen.getByRole('treeitem', { name: /Beta\. Project project-b/ }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(activeFilter);
  });

  it('al montar con selección durable busca una Task fuera de la primera página sin mover el foco', async () => {
    const scrollCalls = trackScrollIntoView();
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => (args.cursor
        ? page(args.project_id, args.status, [task('initial-target', { status: 'done' })])
        : page(args.project_id, args.status, [task('initial-first')], { hasMore: true, cursor: 'initial-cursor' })),
    });
    render(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'initial-target' }} />);

    const target = await screen.findByRole('treeitem', { name: /Task initial-target/ });
    await waitFor(() => expect(scrollCalls.some(({ element }) => element === target)).toBe(true));
    expect(screen.getByRole('radio', { name: 'Todas' }).checked).toBe(true);
    expect(screen.getByTestId('selection-filter-notice').textContent).toContain('initial-target');
    expect(target.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).not.toBe(target);
    expect(taskCalls(calls).map(({ args }) => [args.status, args.cursor])).toEqual([
      ['active', undefined],
      ['all', undefined],
      ['all', 'initial-cursor'],
    ]);
  });

  it('cancela la página automática anterior cuando cambia la selección durable', async () => {
    const oldPage = deferred();
    const newPage = deferred();
    const scrollCalls = trackScrollIntoView();
    let cursorReads = 0;
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) return page(args.project_id, args.status, [task('change-first')], { hasMore: true, cursor: 'change-cursor' });
        cursorReads += 1;
        return cursorReads === 1
          ? oldPage.promise
          : newPage.promise;
      },
    });
    const { rerender } = render(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'old-target' }} />);
    await waitFor(() => expect(taskCalls(calls).filter(({ args }) => args.cursor).length).toBe(1));
    const notice = screen.getByTestId('selection-filter-notice');
    expect(notice.textContent).toContain('old-target');
    const allFilter = screen.getByRole('radio', { name: 'Todas' });
    allFilter.focus();

    rerender(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'new-target' }} />);
    await waitFor(() => expect(taskCalls(calls).filter(({ args }) => args.cursor).length).toBe(2));
    expect(screen.getByTestId('selection-filter-notice')).toBe(notice);
    expect(notice.textContent).toBe('');
    expect(document.activeElement).toBe(allFilter);

    await act(async () => {
      newPage.resolve(page('project-a', 'all', [task('new-target')]));
      await newPage.promise;
    });
    const target = await screen.findByRole('treeitem', { name: /Task new-target/ });
    await waitFor(() => expect(scrollCalls.some(({ element }) => element === target)).toBe(true));
    await waitFor(() => expect(notice.textContent).toContain('Task seleccionada: Task new-target.'));
    expect(document.activeElement).toBe(allFilter);

    await act(async () => {
      oldPage.resolve(page('project-a', 'all', [task('old-target')]));
      await oldPage.promise;
    });
    await flush();

    expect(screen.queryByRole('treeitem', { name: /Task old-target/ })).toBeNull();
    expect(screen.getByRole('treeitem', { name: /Task new-target/ }).getAttribute('aria-selected')).toBe('true');
    expect(scrollCalls.some(({ element }) => element.getAttribute('data-task-id') === 'old-target')).toBe(false);
  });

  it('cancela la búsqueda automática y su scroll cuando el usuario cambia el filtro', async () => {
    const pendingPage = deferred();
    const scrollCalls = trackScrollIntoView();
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (args.status === 'final') return page(args.project_id, args.status, []);
        if (!args.cursor) return page(args.project_id, args.status, [task('manual-first')], { hasMore: true, cursor: 'manual-cursor' });
        return pendingPage.promise;
      },
    });
    render(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'manual-target' }} />);
    await waitFor(() => expect(taskCalls(calls).some(({ args }) => args.cursor === 'manual-cursor')).toBe(true));
    const notice = screen.getByTestId('selection-filter-notice');
    expect(notice.textContent).toContain('manual-target');

    const finalFilter = screen.getByRole('radio', { name: 'Finalizadas' });
    finalFilter.focus();
    fireEvent.click(finalFilter);
    await waitFor(() => expect(taskCalls(calls).some(({ args }) => args.status === 'final')).toBe(true));
    expect(finalFilter.checked).toBe(true);
    expect(screen.getByTestId('selection-filter-notice')).toBe(notice);
    expect(notice.textContent).toBe('');

    await act(async () => {
      pendingPage.resolve(page('project-a', 'all', [task('manual-target')]));
      await pendingPage.promise;
    });
    await flush();

    expect(finalFilter.checked).toBe(true);
    expect(document.activeElement).toBe(finalFilter);
    expect(screen.queryByRole('treeitem', { name: /Task manual-target/ })).toBeNull();
    expect(scrollCalls).toHaveLength(0);
  });

  it('confirma la ausencia solo después de completar todas las páginas con status all', async () => {
    const secondPage = deferred();
    const finalPage = deferred();
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (args.status !== 'all') return page(args.project_id, args.status, []);
        if (!args.cursor) return page(args.project_id, args.status, [task('all-first')], { hasMore: true, cursor: 'all-cursor-1' });
        if (args.cursor === 'all-cursor-1') return secondPage.promise;
        return finalPage.promise;
      },
    });
    const { rerender } = render(
      <ProjectsSidebar selection={{ projectId: 'project-a', taskId: null }} />,
    );
    await screen.findByRole('treeitem', { name: /Alpha/ });
    rerender(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'absent-target' }} />);

    await waitFor(() => expect(taskCalls(calls).some(({ args }) => args.cursor === 'all-cursor-1')).toBe(true));
    expect(screen.queryByTestId('selected-task-missing')).toBeNull();
    await act(async () => {
      secondPage.resolve(page('project-a', 'all', [task('all-second')], { hasMore: true, cursor: 'all-cursor-2' }));
      await secondPage.promise;
    });
    await waitFor(() => expect(taskCalls(calls).some(({ args }) => args.cursor === 'all-cursor-2')).toBe(true));
    expect(screen.queryByTestId('selected-task-missing')).toBeNull();

    await act(async () => {
      finalPage.resolve(page('project-a', 'all', []));
      await finalPage.promise;
    });
    expect(await screen.findByTestId('selected-task-missing')).toBeTruthy();
    expect(taskCalls(calls).map(({ args }) => [args.status, args.cursor])).toEqual([
      ['active', undefined],
      ['all', undefined],
      ['all', 'all-cursor-1'],
      ['all', 'all-cursor-2'],
    ]);
  });

  it('reanuda la búsqueda de una selección durable después de un cursor inválido', async () => {
    let headReads = 0;
    let cursorReads = 0;
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) {
          if (args.status !== 'all') return page(args.project_id, args.status, [task('active-first')]);
          headReads += 1;
          return headReads === 1
            ? page(args.project_id, args.status, [task('invalid-first')], { hasMore: true, cursor: 'invalid-cursor' })
            : page(args.project_id, args.status, [task('invalid-target', { status: 'done' })]);
        }
        cursorReads += 1;
        throw new Error('tasks_invalid_cursor: cursor inválido para esta consulta');
      },
    });
    render(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'invalid-target' }} />);

    const target = await screen.findByRole('treeitem', { name: /Task invalid-target/ });
    expect(target.getAttribute('aria-selected')).toBe('true');
    expect(headReads).toBe(2);
    expect(cursorReads).toBe(1);
    expect(screen.queryByTestId('selected-task-missing')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Todas' }).checked).toBe(true);
  });

  it('limpia la ausencia si una reconciliación posterior carga la Task seleccionada', async () => {
    vi.useFakeTimers();
    let headReads = 0;
    const cursors = [];
    const scrollCalls = trackScrollIntoView();
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) {
          if (args.status !== 'all') return page(args.project_id, args.status, [task('active-first')]);
          headReads += 1;
          return headReads === 1
            ? page(args.project_id, args.status, [task('reconcile-head-old')], { hasMore: true, cursor: 'old-head-cursor' })
            : page(args.project_id, args.status, [task('reconcile-head-new')], { hasMore: true, cursor: 'new-head-cursor' });
        }
        cursors.push(args.cursor);
        return args.cursor === 'old-head-cursor'
          ? page(args.project_id, args.status, [task('reconcile-old-page')])
          : page(args.project_id, args.status, [task('reconcile-target', { status: 'done' })]);
      },
    });
    render(<ProjectsSidebar pollMs={1_000} selection={{ projectId: 'project-a', taskId: 'reconcile-target' }} />);
    await flush();
    expect(screen.getByTestId('selected-task-missing')).toBeTruthy();
    expect(cursors).toEqual(['old-head-cursor']);

    const allFilter = screen.getByRole('radio', { name: 'Todas' });
    allFilter.focus();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();

    const target = screen.getByRole('treeitem', { name: /Task reconcile-target/ });
    expect(target.getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByTestId('selected-task-missing')).toBeNull();
    expect(cursors).toEqual(['old-head-cursor', 'new-head-cursor']);
    expect(document.activeElement).toBe(allFilter);
    expect(scrollCalls).toHaveLength(0);
    expect(taskCalls(calls).some(({ args }) => args.cursor === 'new-head-cursor')).toBe(true);
  });

  it('preserva la navegación durante error de página y desconexión del Core', async () => {
    vi.useFakeTimers();
    const scrollCalls = trackScrollIntoView();
    let headReads = 0;
    let pageReads = 0;
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (args.status !== 'all') return page(args.project_id, args.status, []);
        if (!args.cursor) {
          headReads += 1;
          if (headReads === 2) throw new Error('disconnected: Core IPC closed');
          return page(args.project_id, args.status, [task('all-first')], { hasMore: true, cursor: 'all-cursor-1' });
        }
        pageReads += 1;
        if (pageReads === 1) throw new Error('tasks_read_failed: lectura de página fallida');
        return page(args.project_id, args.status, [task('target')]);
      },
    });
    const { rerender } = render(
      <ProjectsSidebar pollMs={1_000} selection={{ projectId: 'project-a', taskId: null }} />,
    );
    await flush();
    const activeFilter = screen.getByRole('radio', { name: 'Activas' });
    activeFilter.focus();
    rerender(<ProjectsSidebar pollMs={1_000} selection={{ projectId: 'project-a', taskId: 'target' }} />);
    await flush();
    expect(screen.getByRole('alert').textContent).toContain('tasks_read_failed');
    expect(screen.queryByTestId('selected-task-missing')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.getByText(/Core desconectado/)).toBeTruthy();
    expect(screen.queryByTestId('selected-task-missing')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.getByRole('button', { name: 'Reintentar carga de Tasks de Alpha' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar carga de Tasks de Alpha' }));
    await flush();
    const target = screen.getByRole('treeitem', { name: /Task target/ });
    expect(scrollCalls.some(({ element }) => element === target)).toBe(true);
    expect(document.activeElement).toBe(activeFilter);
    expect(screen.queryByTestId('selected-task-missing')).toBeNull();
    expect(taskCalls(calls).some(({ args }) => args.status === 'all' && args.cursor === 'all-cursor-1')).toBe(true);
  });

  it('no cambia el filtro ni avisa si la primera lectura falla sin datos con selección controlada', async () => {
    const calls = mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: () => { throw new Error('tasks_read_failed: falló la lectura de SQLite'); },
    });
    render(<ProjectsSidebar selection={{ projectId: 'project-a', taskId: 'durable-target' }} />);

    const alert = await screen.findByRole('alert');
    await flush();
    expect(alert.textContent).toContain('tasks_read_failed');
    expect(screen.getByRole('radio', { name: 'Activas' }).checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Todas' }).checked).toBe(false);
    expect(screen.getByTestId('selection-filter-notice').textContent).toBe('');
    expect(screen.queryByTestId('selected-task-missing')).toBeNull();
    expect(taskCalls(calls).map(({ args }) => args.status)).toEqual(['active']);
  });

  it('conserva scroll y foco al refrescar y reconectar con los mismos IDs controlados', async () => {
    vi.useFakeTimers();
    let tick = 0;
    mountCore({
      overviews: () => {
        tick += 1;
        if (tick === 2) throw new Error('projects_overview_disconnected: Core desconectado');
        return overview([project('project-a', 'Alpha')]);
      },
    });
    const { container } = render(
      <ProjectsSidebar pollMs={1_000} selection={{ projectId: 'project-a', taskId: null }} />,
    );
    await flush();

    const row = screen.getByRole('treeitem', { name: /Alpha/ });
    const scrollRow = mockScrollIntoView(row);
    const tree = container.querySelector('.ps__tree');
    tree.scrollTop = 173;
    const filter = screen.getByRole('radio', { name: 'Activas' });
    filter.focus();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.getByText(/Datos desactualizados/)).toBeTruthy();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.getByRole('treeitem', { name: /Alpha/ })).toBe(row);
    expect(tree.scrollTop).toBe(173);
    expect(document.activeElement).toBe(filter);
    expect(scrollRow).not.toHaveBeenCalled();
  });

  it('en modo controlado notifica la selección del usuario sin cambiar los IDs suministrados', async () => {
    const onSelectProject = vi.fn();
    const onSelectTask = vi.fn();
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha'), project('project-b', 'Beta')]),
      tasks: (args) => page(args.project_id, args.status, [task(`${args.project_id}-task`)]),
    });
    const { rerender } = render(
      <ProjectsSidebar
        selection={{ projectId: 'project-a', taskId: null }}
        onSelectProject={onSelectProject}
        onSelectTask={onSelectTask}
      />,
    );

    const alpha = await screen.findByRole('treeitem', { name: /Alpha/ });
    const beta = screen.getByRole('treeitem', { name: /Beta/ });
    clickProject(beta);
    expect(onSelectProject).toHaveBeenCalledTimes(1);
    expect(onSelectProject).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'project-b', name: 'Beta' }));
    expect(onSelectTask).not.toHaveBeenCalled();
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(beta.getAttribute('aria-selected')).toBe('false');

    const taskRow = await screen.findByRole('treeitem', { name: /Task project-b-task/ });
    fireEvent.click(taskRow);

    expect(onSelectProject).toHaveBeenCalledTimes(2);
    expect(onSelectProject).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'project-b', name: 'Beta' }));
    expect(onSelectTask).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: 'project-b-task', projectId: 'project-b' }));
    expect(alpha.getAttribute('aria-selected')).toBe('true');
    expect(taskRow.getAttribute('aria-selected')).toBe('false');

    rerender(
      <ProjectsSidebar
        selection={{ projectId: 'project-b', taskId: 'project-b-task' }}
        onSelectProject={onSelectProject}
        onSelectTask={onSelectTask}
      />,
    );
    await waitFor(() => expect(taskRow.getAttribute('aria-selected')).toBe('true'));
    expect(alpha.getAttribute('aria-selected')).toBe('false');
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
    clickProject(alpha);
    const more = await screen.findByRole('button', { name: 'Cargar más Tasks de Alpha' });
    more.focus();

    fireEvent.keyDown(more, { key: 'Enter' });
    expect(alpha.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(more);

    fireEvent.keyDown(more, { key: ' ' });
    expect(alpha.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(more);

    fireEvent.click(more);
    expect(alpha.getAttribute('aria-expanded')).toBe('true');
  });

  it('la tarjeta visible activa el Project y el contenido anidado conserva su interacción', async () => {
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => page(args.project_id, args.status, []),
    });
    render(<ProjectsSidebar />);

    const alpha = await screen.findByRole('treeitem', { name: /Alpha/ });
    clickProject(alpha);
    await screen.findByText(/Este Project no tiene Tasks activas/);
    expect(alpha.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(alpha.querySelector('.ps__meta'));
    await waitFor(() => expect(alpha.getAttribute('aria-expanded')).toBe('false'));
    clickProject(alpha);
    await screen.findByText(/Este Project no tiene Tasks activas/);
    expect(alpha.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(alpha.querySelector('.ps__empty'));
    expect(alpha.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(alpha);
    await waitFor(() => expect(alpha.getAttribute('aria-expanded')).toBe('false'));
  });

  it('mantiene el foco en una fila utilizable cuando desaparece el botón de paginación', async () => {
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => (args.cursor
        ? page(args.project_id, args.status, [task('t2', { created_at: 2_000 })])
        : page(args.project_id, args.status, [task('t1', { created_at: 1_000 })], { hasMore: true, cursor: 'cursor-1' })),
    });
    render(<ProjectsSidebar />);

    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
    const more = await screen.findByRole('button', { name: 'Cargar más Tasks de Alpha' });
    more.focus();
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.click(more);
    await screen.findByText('Task t2');
    await waitFor(() => expect(document.activeElement.getAttribute('role')).toBe('treeitem'));
    expect(document.activeElement.getAttribute('tabindex')).toBe('0');
    expect(screen.queryByRole('button', { name: 'Cargar más Tasks de Alpha' })).toBeNull();
    expect(screen.getByRole('treeitem', { name: /Alpha/ }).getAttribute('aria-expanded')).toBe('true');
  });

  it('devuelve el foco al botón habilitado tras una carga iniciada con teclado', async () => {
    const pendingPage = deferred();
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (args.cursor === 'cursor-1') return pendingPage.promise;
        if (args.cursor === 'cursor-2') return page(args.project_id, args.status, [task('t2')]);
        return page(args.project_id, args.status, [task('t1')], { hasMore: true, cursor: 'cursor-1' });
      },
    });
    render(<ProjectsSidebar />);
    const alpha = await screen.findByRole('treeitem', { name: /Alpha/ });
    clickProject(alpha);
    const more = await screen.findByRole('button', { name: 'Cargar más Tasks de Alpha' });
    more.focus();
    fireEvent.keyDown(more, { key: 'Enter' });
    fireEvent.click(more);
    await waitFor(() => expect(more.disabled).toBe(true));
    more.blur();
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    const firstPage = page('project-a', 'active', [task('t1-loaded')], { hasMore: true, cursor: 'cursor-2' });
    await act(async () => {
      pendingPage.resolve(firstPage);
      await pendingPage.promise;
    });
    document.body.removeAttribute('tabindex');

    const returnedButton = await screen.findByRole('button', { name: 'Cargar más Tasks de Alpha' });
    await waitFor(() => expect(document.activeElement).toBe(returnedButton));
    fireEvent.keyDown(returnedButton, { key: 'Enter' });
    fireEvent.click(returnedButton);
    await screen.findByText('Task t2');
    expect(alpha.getAttribute('aria-expanded')).toBe('true');
  });

  it('no recupera el foco tras un blur deliberado antes de que desaparezca el botón', async () => {
    vi.useFakeTimers();
    let headReads = 0;
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) {
          headReads += 1;
          return headReads === 1
            ? page(args.project_id, args.status, [task('head-old')], { hasMore: true, cursor: 'old-1' })
            : page(args.project_id, args.status, [task('head-new', { created_at: 5_000 })], { hasMore: true, cursor: 'new-1' });
        }
        if (args.cursor === 'old-1') return page(args.project_id, args.status, [task('old-page')], { hasMore: true, cursor: 'old-2' });
        return page(args.project_id, args.status, []);
      },
    });
    render(<ProjectsSidebar pollMs={1_000} />);
    await flush();
    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    await flush();
    expect(screen.getByText('Task old-page')).toBeTruthy();
    const more = screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' });
    more.focus();
    more.blur();
    expect(document.activeElement).toBe(document.body);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flush();
    expect(screen.queryByRole('button', { name: /páginas de Tasks de Alpha/ })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('identifica el Project en el reintento de una página fallida', async () => {
    let moreAttempts = 0;
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) return page(args.project_id, args.status, [task('t1')], { hasMore: true, cursor: 'cursor-1' });
        moreAttempts += 1;
        if (moreAttempts === 1) throw new Error('tasks_read_failed: falló la lectura de página');
        return page(args.project_id, args.status, [task('t2')]);
      },
    });
    render(<ProjectsSidebar />);

    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cargar más Tasks de Alpha' }));
    const alert = await screen.findByRole('alert');
    const retry = within(alert).getByRole('button', { name: 'Reintentar carga de Tasks de Alpha' });
    fireEvent.click(retry);
    await screen.findByText('Task t2');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('restaura el foco al árbol tras reintentar una página fallida', async () => {
    let attempts = 0;
    mountCore({
      overviews: () => overview([project('project-a', 'Alpha')]),
      tasks: (args) => {
        if (!args.cursor) return page(args.project_id, args.status, [task('t1')], { hasMore: true, cursor: 'cursor-1' });
        attempts += 1;
        if (attempts === 1) throw new Error('tasks_read_failed: lectura de página fallida');
        return page(args.project_id, args.status, [task('t2')], { hasMore: true, cursor: 'cursor-2' });
      },
    });
    render(<ProjectsSidebar />);
    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cargar más Tasks de Alpha' }));

    const retry = await screen.findByRole('button', { name: 'Reintentar carga de Tasks de Alpha' });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    await screen.findByText('Task t2');
    expect(screen.getByRole('button', { name: 'Cargar más Tasks de Alpha' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement.getAttribute('role')).toBe('treeitem'));
    expect(document.activeElement.closest('[role="tree"]')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
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
    clickProject(alpha);
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

    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
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
    clickProject(alpha);
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

    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
    clickProject(screen.getByRole('treeitem', { name: /Beta/ }));
    expect(changes).toEqual([['project-a'], ['project-a', 'project-b']]);

    clickProject(screen.getByRole('treeitem', { name: /Alpha/ }));
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

    const retry = screen.getByRole('button', { name: 'Reintentar lectura de Projects' });
    retry.focus();
    fireEvent.click(retry);
    expect(await screen.findByRole('treeitem', { name: /Alpha/ })).toBeTruthy();
    expect(document.activeElement.getAttribute('type')).toBe('radio');
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

    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Core no pudo leer este dato.');
    expect(alert.textContent).toContain('tasks_read_failed');

    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar lectura de las Tasks de Alpha' }));
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

  it('publica idle explícito, sin loading perpetuo, mientras la vista está inactiva', async () => {
    const onProjectSnapshot = vi.fn();
    const calls = mountCore({ overviews: () => overview([project('project-a', 'Alpha')]) });
    render(
      <ProjectsSidebar
        active={false}
        selection={{ projectId: 'project-a', taskId: null }}
        onProjectSnapshot={onProjectSnapshot}
      />,
    );
    await flush();

    expect(calls).toEqual([]);
    expect(onProjectSnapshot).toHaveBeenLastCalledWith({
      projectId: 'project-a', queryState: 'idle', project: null, error: null, reason: null,
    });
    expect(onProjectSnapshot.mock.calls.map(([snapshot]) => snapshot.queryState)).not.toContain('loading');
  });

  it('al reactivarse no publica la lectura previa como vigente y conserva foco y selección', async () => {
    const onProjectSnapshot = vi.fn();
    const onSelectProject = vi.fn();
    const onSelectTask = vi.fn();
    const refresh = deferred();
    let reads = 0;
    const calls = mountCore({
      overviews: () => {
        reads += 1;
        return reads === 1 ? overview([project('project-a', 'Alpha')]) : refresh.promise;
      },
    });
    const selection = { projectId: 'project-a', taskId: null };
    const props = { selection, onProjectSnapshot, onSelectProject, onSelectTask };
    const { rerender } = render(
      <>
        <input aria-label="Foco externo" />
        <ProjectsSidebar active {...props} />
      </>,
    );
    await screen.findByRole('treeitem', { name: /Alpha/ });
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ queryState: 'ready' })));
    const external = screen.getByLabelText('Foco externo');
    external.focus();

    rerender(
      <>
        <input aria-label="Foco externo" />
        <ProjectsSidebar active={false} {...props} />
      </>,
    );
    await flush();
    expect(onProjectSnapshot).toHaveBeenLastCalledWith({
      projectId: 'project-a', queryState: 'idle', project: null, error: null, reason: null,
    });
    expect(calls.filter((call) => call.query === 'projects_overview')).toHaveLength(1);

    onProjectSnapshot.mockClear();
    rerender(
      <>
        <input aria-label="Foco externo" />
        <ProjectsSidebar active {...props} />
      </>,
    );
    await flush();

    // Reactivar dispara una lectura nueva; mientras llega, solo se publica `refreshing`, nunca `ready` previo.
    expect(calls.filter((call) => call.query === 'projects_overview')).toHaveLength(2);
    expect(onProjectSnapshot.mock.calls.map(([snapshot]) => snapshot.queryState)).toEqual(['refreshing']);
    expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', project: expect.objectContaining({ projectId: 'project-a', name: 'Alpha' }),
    }));

    refresh.resolve(overview([project('project-a', 'Alpha renombrado')]));
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a',
      queryState: 'ready',
      project: expect.objectContaining({ projectId: 'project-a', name: 'Alpha renombrado' }),
    })));
    expect(document.activeElement).toBe(external);
    expect(onSelectProject).not.toHaveBeenCalled();
    expect(onSelectTask).not.toHaveBeenCalled();
  });

  it('mantiene stale al reactivarse oculta hasta iniciar y completar una lectura nueva', async () => {
    const visibilityState = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const onProjectSnapshot = vi.fn();
    const refresh = deferred();
    let reads = 0;
    const calls = mountCore({
      overviews: () => {
        reads += 1;
        return reads === 1 ? overview([project('project-a', 'Alpha')]) : refresh.promise;
      },
    });
    const props = {
      pollMs: 60_000,
      selection: { projectId: 'project-a', taskId: null },
      onProjectSnapshot,
    };
    const { rerender } = render(<ProjectsSidebar active {...props} />);

    await screen.findByRole('treeitem', { name: /Alpha/ });
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({ queryState: 'ready' })));

    rerender(<ProjectsSidebar active={false} {...props} />);
    await flush();
    expect(onProjectSnapshot).toHaveBeenLastCalledWith({
      projectId: 'project-a', queryState: 'idle', project: null, error: null, reason: null,
    });

    onProjectSnapshot.mockClear();
    visibilityState.mockReturnValue('hidden');
    rerender(<ProjectsSidebar active {...props} />);
    await flush();

    expect(calls.filter((call) => call.query === 'projects_overview')).toHaveLength(1);
    expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a',
      queryState: 'stale',
      project: expect.objectContaining({ projectId: 'project-a', name: 'Alpha' }),
      error: null,
      reason: null,
    }));
    expect(onProjectSnapshot.mock.calls.map(([snapshot]) => snapshot.queryState)).not.toContain('ready');

    visibilityState.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a', queryState: 'refreshing', project: expect.objectContaining({ name: 'Alpha' }),
    })));
    expect(calls.filter((call) => call.query === 'projects_overview')).toHaveLength(2);

    refresh.resolve(overview([project('project-a', 'Alpha renombrado')]));
    await waitFor(() => expect(onProjectSnapshot).toHaveBeenLastCalledWith(expect.objectContaining({
      projectId: 'project-a',
      queryState: 'ready',
      project: expect.objectContaining({ projectId: 'project-a', name: 'Alpha renombrado' }),
    })));
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
    clickProject(await screen.findByRole('treeitem', { name: /Alpha/ }));
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
