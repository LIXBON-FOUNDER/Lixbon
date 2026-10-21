import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  listAdeActivity: vi.fn(),
  useCoreQuery: vi.fn(),
}));

vi.mock('./coreQueries', () => ({
  ACTIVITY_DEFAULT_LIMIT: 100,
  listAdeActivity: mocks.listAdeActivity,
}));
vi.mock('./useCoreQuery', () => ({ useCoreQuery: mocks.useCoreQuery }));

import { ActivityPanel } from './ActivityPanel.jsx';

const emptyPage = {
  v: 1,
  projection: 1,
  order: 'desc',
  items: [],
  next_cursor: 0,
  has_more: false,
  head_seq: 0,
  limit: 100,
};

function activity(seq, overrides = {}) {
  return {
    seq,
    event_id: `event-${seq}`,
    ts: 1_800_000_000_000 + seq,
    kind: 'task.created',
    v: 1,
    class: 'state',
    message_key: 'activity.task.created',
    args: {
      title: `Tarea ${seq}`,
      agent: 'codex',
      depth: 1,
      external: false,
    },
    visual: 'info',
    fallback: false,
    target: { kind: 'task', id: `task-${seq}` },
    project_id: 'project-a',
    run_id: 'run-a',
    actor: { kind: 'agent', id: `task-${seq}` },
    provenance: { channel: 'ui', client_id: 'desktop-a' },
    correlation_id: null,
    ...overrides,
  };
}

function activityPage(items, { nextCursor = 0, hasMore = false } = {}) {
  return {
    ...emptyPage,
    items,
    next_cursor: nextCursor,
    has_more: hasMore,
    head_seq: items[0]?.seq ?? 0,
  };
}

function readySnapshot(items, readEpoch = 1, extra = {}) {
  return {
    status: items.length ? 'ready' : 'empty',
    data: activityPage(items, { nextCursor: items.at(-1)?.seq ?? 0, hasMore: Boolean(extra.hasMore) }),
    error: null,
    reason: null,
    updatedAt: readEpoch,
    readEpoch,
    ...extra,
  };
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('ActivityPanel', () => {
  let snapshot;
  let queryCalls;
  let retry;

  beforeEach(() => {
    snapshot = readySnapshot([activity(7), activity(6)], 1, { hasMore: true });
    queryCalls = [];
    retry = vi.fn();
    mocks.useCoreQuery.mockImplementation((...args) => {
      queryCalls.push(args);
      return { ...snapshot, retry };
    });
    mocks.listAdeActivity.mockReset().mockResolvedValue(activityPage([]));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it.each([
    [{ kind: 'global' }, { project_id: null, target_kind: null, target_id: null }],
    [{ kind: 'project', id: 'project-durable-77', name: 'Lixbon' }, { project_id: 'project-durable-77', target_kind: null, target_id: null }],
    [{ kind: 'task', id: 'task-durable-Ab_9', title: 'Preparar entrega' }, { project_id: null, target_kind: 'task', target_id: 'task-durable-Ab_9' }],
  ])('lee la actividad en el alcance durable %j', async (scope, filters) => {
    render(<ActivityPanel scope={scope} />);
    await screen.findByTestId('activity-list');

    expect(queryCalls[0]).toEqual([
      'activity_list',
      {
        cursor: 0,
        limit: 100,
        order: 'desc',
        project_id: filters.project_id,
        run_id: null,
        target_kind: filters.target_kind,
        target_id: filters.target_id,
      },
      expect.objectContaining({ enabled: true }),
    ]);
    expect(queryCalls.every(([query]) => query === 'activity_list')).toBe(true);
    expect(screen.getByTestId('activity-list').querySelector('li').getAttribute('data-seq')).toBe('7');
    if (scope.kind !== 'global') {
      expect(screen.getByTestId('activity-scope-id').textContent).toBe(scope.id);
    }
    expect(screen.getByText('Solo lectura')).toBeTruthy();
    expect(screen.queryByText(/sin leer|unread|attention/i)).toBeNull();
  });

  it('mapea solo campos contractuales y conserva el orden descendente de Core', async () => {
    const first = activity(7, {
      args: { title: 'Título humano', agent: 'codex', depth: 1, external: false },
      visual: 'error',
      payload: { secret: 'NO_RENDERIZAR' },
      summary: 'NO_INFERIR',
    });
    const second = activity(6, { event_id: 'event-6', args: { title: 'Otra tarea', agent: 'codex', depth: 0, external: false } });
    snapshot = readySnapshot([first, second], 1, { hasMore: false });
    render(<ActivityPanel />);
    const rows = await screen.findAllByRole('listitem');

    expect(rows.map((row) => row.getAttribute('data-seq'))).toEqual(['7', '6']);
    expect(screen.getByTestId('activity-message-event-7').textContent).toContain('Título humano');
    expect(screen.getByTestId('activity-event-7').getAttribute('data-severity')).toBe('danger');
    expect(document.body.textContent).not.toContain('NO_RENDERIZAR');
    expect(document.body.textContent).not.toContain('NO_INFERIR');
    expect(screen.getByTestId('activity-target-event-7').textContent).toContain('task-7');
    expect(screen.getByTestId('activity-project-event-7').textContent).toContain('project-a');
    expect(screen.getByTestId('activity-actor-event-7').textContent).toContain('task-7');
    expect(screen.getByTestId('activity-client-event-7').textContent).toContain('desktop-a');
  });

  it('deja una clave desconocida al fallback de ActivityTimeline', async () => {
    snapshot = readySnapshot([activity(7, {
      message_key: 'activity.future_event',
      args: { text: 'NO_INFERIR' },
      kind: 'future.event',
      payload: { message: 'NO_INFERIR' },
    })], 1);
    render(<ActivityPanel />);

    expect((await screen.findByTestId('activity-message-event-7')).textContent).toBe('Evento desconocido');
    expect(document.body.textContent).not.toContain('NO_INFERIR');
  });

  it('pagina con el cursor numérico exclusivo y elimina duplicados sin reordenar', async () => {
    snapshot = readySnapshot([activity(9), activity(8)], 1, { hasMore: true });
    mocks.listAdeActivity.mockResolvedValue(activityPage(
      [activity(8), activity(7)],
      { nextCursor: 7, hasMore: true },
    ));
    render(<ActivityPanel scope={{ kind: 'project', id: 'project-a' }} />);

    fireEvent.click(await screen.findByTestId('activity-load-more'));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(mocks.listAdeActivity).toHaveBeenCalledWith({
      cursor: 8,
      limit: 100,
      order: 'desc',
      projectId: 'project-a',
      runId: null,
      targetKind: null,
      targetId: null,
    });
    expect(screen.getAllByRole('listitem').map((row) => row.getAttribute('data-seq')))
      .toEqual(['9', '8', '7']);
  });

  it('descarta páginas anexadas cuando avanza el epoch de la lectura base', async () => {
    snapshot = readySnapshot([activity(9), activity(8)], 1, { hasMore: true });
    mocks.listAdeActivity.mockResolvedValue(activityPage(
      [activity(7)],
      { nextCursor: 7, hasMore: true },
    ));
    const view = render(<ActivityPanel />);
    fireEvent.click(await screen.findByTestId('activity-load-more'));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));

    snapshot = readySnapshot([activity(9), activity(8)], 2, { hasMore: true });
    view.rerender(<ActivityPanel />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.queryByTestId('activity-event-7')).toBeNull();
  });

  it('ignora una respuesta de página que llega después de cambiar el epoch base', async () => {
    const pendingPage = deferred();
    snapshot = readySnapshot([activity(9), activity(8)], 1, { hasMore: true });
    mocks.listAdeActivity.mockReturnValue(pendingPage.promise);
    const view = render(<ActivityPanel />);
    fireEvent.click(await screen.findByTestId('activity-load-more'));

    snapshot = readySnapshot([activity(10), activity(9)], 2, { hasMore: true });
    view.rerender(<ActivityPanel />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    await act(async () => pendingPage.resolve(activityPage([activity(7)], { nextCursor: 7, hasMore: true })));

    expect(screen.getAllByRole('listitem').map((row) => row.getAttribute('data-seq'))).toEqual(['10', '9']);
  });

  it('conserva filas base al desconectarse y deduplica la lectura tras reconectar', async () => {
    snapshot = readySnapshot([activity(9), activity(8)], 1, { hasMore: true });
    mocks.listAdeActivity.mockResolvedValue(activityPage([activity(7)], { nextCursor: 7, hasMore: true }));
    const view = render(<ActivityPanel />);
    fireEvent.click(await screen.findByTestId('activity-load-more'));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));

    snapshot = {
      ...snapshot,
      status: 'stale',
      error: 'connection refused',
      reason: 'disconnected',
    };
    view.rerender(<ActivityPanel />);
    expect(await screen.findByTestId('activity-stale')).toBeTruthy();
    expect(screen.getByTestId('activity-event-9')).toBeTruthy();
    expect(screen.queryByTestId('activity-event-7')).toBeNull();
    expect(screen.getByTestId('activity-timeline').getAttribute('data-status')).toBe('error');
    expect(screen.getByRole('alert').textContent).toMatch(/desconectad/i);

    snapshot = readySnapshot([
      activity(10),
      activity(9),
      activity(8, { event_id: 'event-9' }),
    ], 2, { hasMore: false });
    view.rerender(<ActivityPanel />);
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    expect(screen.getAllByRole('listitem').map((row) => row.getAttribute('data-seq'))).toEqual(['10', '9']);
  });

  it.each([
    ['disconnected', 'error', /desconectad/i],
    ['error', 'error', /error|fallida/i],
    ['degraded', 'degraded', /degradado/i],
  ])('representa el estado inicial %s como %s', async (status, timelineStatus, message) => {
    snapshot = { status, data: null, error: `${status}: lectura fallida`, reason: status, readEpoch: 0 };
    render(<ActivityPanel />);
    const timeline = await screen.findByTestId('activity-timeline');
    expect(timeline.getAttribute('data-status')).toBe(timelineStatus);
    if (timelineStatus === 'error') expect(screen.getByRole('alert').textContent).toMatch(message);
    else expect(screen.getByTestId('activity-degraded').textContent).toMatch(message);
  });

  it('preserva loading y empty como estados de la línea de tiempo', async () => {
    snapshot = { status: 'loading', data: null, error: null, reason: null, readEpoch: 0 };
    const view = render(<ActivityPanel />);
    expect((await screen.findByTestId('activity-timeline')).getAttribute('data-status')).toBe('loading');

    snapshot = readySnapshot([], 1);
    view.rerender(<ActivityPanel />);
    await waitFor(() => expect(screen.getByTestId('activity-empty')).toBeTruthy());
    expect(screen.getByTestId('activity-timeline').getAttribute('data-status')).toBe('ready');
  });

  it('una página anterior fallida conserva la cabecera y ofrece reintento', async () => {
    snapshot = readySnapshot([activity(9), activity(8)], 1, { hasMore: true });
    mocks.listAdeActivity.mockRejectedValue(new Error('activity_read_failed'));
    render(<ActivityPanel />);
    fireEvent.click(await screen.findByTestId('activity-load-more'));

    expect(await screen.findByTestId('activity-stale')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
