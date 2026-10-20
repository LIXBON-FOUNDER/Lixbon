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
