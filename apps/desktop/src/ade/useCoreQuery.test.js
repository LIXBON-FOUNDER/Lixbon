import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { queryAdeCore } from './coreQueries';
import { useCoreQuery } from './useCoreQuery';

vi.mock('./coreQueries', () => ({ queryAdeCore: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  queryAdeCore.mockReset();
});

describe('useCoreQuery', () => {
  it('no consulta Core cuando la vista ADE no está activa', () => {
    renderHook(() => useCoreQuery('projects_overview', {}, { enabled: false }));
    expect(queryAdeCore).not.toHaveBeenCalled();
  });

  it('conserva la última respuesta y muestra stale si falla la actualización', async () => {
    const data = { projects: [{ id: 'project-1', name: 'Repo' }] };
    queryAdeCore.mockResolvedValueOnce(data).mockRejectedValueOnce(new Error('projects_overview_read_failed'));
    vi.useFakeTimers();
    const { result } = renderHook(() => useCoreQuery('projects_overview', {}, { pollMs: 1_000 }));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.status).toBe('ready');
    expect(result.current.data).toBe(data);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.status).toBe('stale');
    expect(result.current.data).toBe(data);
  });

  it('mantiene la versión semántica al recibir un payload idéntico y la avanza cuando cambia', async () => {
    let tick = 0;
    queryAdeCore.mockImplementation(async () => {
      tick += 1;
      return { projects: [{ id: tick < 3 ? 'project-1' : 'project-2', name: 'Repo' }] };
    });
    vi.useFakeTimers();
    const { result } = renderHook(() => useCoreQuery('projects_overview', {}, { pollMs: 1_000 }));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const initialData = result.current.data;
    const initialVersion = result.current.updatedAt;
    expect(initialData.projects[0].id).toBe('project-1');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.updatedAt).toBe(initialVersion);
    expect(result.current.data).toBe(initialData);
    expect(result.current.status).toBe('ready');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.data.projects[0].id).toBe('project-2');
    expect(result.current.updatedAt).toBeGreaterThan(initialVersion);
  });

  it('avanza readEpoch en cada lectura correcta aunque el payload sea idéntico y lo conserva al fallar', async () => {
    let fail = false;
    queryAdeCore.mockImplementation(async () => {
      if (fail) throw new Error('ade_query_timeout: Core no respondió a tiempo');
      return { projects: [{ id: 'project-1', name: 'Repo' }] };
    });
    vi.useFakeTimers();
    const { result } = renderHook(() => useCoreQuery('projects_overview', {}, { pollMs: 1_000 }));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const { data, updatedAt, readEpoch } = result.current;
    expect(readEpoch).toBeGreaterThan(0);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.data).toBe(data);
    expect(result.current.updatedAt).toBe(updatedAt);
    expect(result.current.readEpoch).toBe(readEpoch + 1);

    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.status).toBe('stale');
    expect(result.current.readEpoch).toBe(readEpoch + 1);

    fail = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(result.current.status).toBe('ready');
    expect(result.current.updatedAt).toBe(updatedAt);
    expect(result.current.readEpoch).toBe(readEpoch + 2);
  });

  it('marca disconnected si la query no responde dentro del plazo', async () => {
    queryAdeCore.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const { result } = renderHook(() => useCoreQuery('projects_overview', {}));

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.status).toBe('disconnected');
    expect(result.current.error).toContain('ade_query_timeout');
  });

  it('transporta el status del contrato en tasks_by_project', async () => {
    queryAdeCore.mockResolvedValue({ tasks: [] });
    renderHook(() => useCoreQuery('tasks_by_project', { project_id: 'project-1', status: 'final', limit: 50 }));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(queryAdeCore).toHaveBeenCalledWith('tasks_by_project', { projectId: 'project-1', status: 'final' });
  });

  it('transporta los filtros numéricos de activity_list y marca empty sin items', async () => {
    queryAdeCore.mockResolvedValue({ items: [] });
    const { result } = renderHook(() => useCoreQuery('activity_list', {
      cursor: 25,
      limit: 50,
      order: 'desc',
      project_id: 'project-1',
      run_id: 'run-1',
      target_kind: 'task',
      target_id: 'task-1',
    }));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(queryAdeCore).toHaveBeenCalledWith('activity_list', {
      cursor: 25,
      limit: 50,
      order: 'desc',
      projectId: 'project-1',
      runId: 'run-1',
      targetKind: 'task',
      targetId: 'task-1',
    });
    expect(result.current.status).toBe('empty');
  });

  it('pausa el polling mientras la ventana está oculta y actualiza al volver', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    queryAdeCore.mockResolvedValue({ projects: [] });
    vi.useFakeTimers();
    renderHook(() => useCoreQuery('projects_overview', {}, { pollMs: 1_000 }));

    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(queryAdeCore).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(queryAdeCore).toHaveBeenCalled();
  });
});
