import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { queryAdeCore } from './coreQueries';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { useCoreQuery } from './useCoreQuery';

vi.mock('./coreQueries', () => ({ queryAdeCore: vi.fn() }));

/** Promesa pendiente que el caso de prueba resuelve cuando quiere. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  queryAdeCore.mockReset();
  // El registro de peticiones outstanding es de módulo: una petición a medio camino de un caso
  // envenenaría el siguiente.
  resetOutstandingQueries();
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

  it('el plazo agotado no declara una desconexión: no hay evidencia de transporte roto', async () => {
    queryAdeCore.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const { result } = renderHook(() => useCoreQuery('projects_overview', {}));

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.status).not.toBe('disconnected');
    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('ade_query_timeout');
  });

  it('un fallo de transporte con evidencia sí se declara desconectado', async () => {
    queryAdeCore.mockRejectedValue(new Error('disconnected: Core IPC closed'));
    const { result } = renderHook(() => useCoreQuery('projects_overview', {}));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.status).toBe('disconnected');
  });

  it('un Core degradado se declara degradado, no desconectado', async () => {
    queryAdeCore.mockRejectedValue(new Error('resource_inventory_unavailable: almacén no disponible'));
    const { result } = renderHook(() => useCoreQuery('resource_inventory', { project_id: null, probe: true }));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.status).toBe('degraded');
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

  it('transporta el inventario de recursos con su project_id y su sondeo', async () => {
    queryAdeCore.mockResolvedValue({ repos: [], worktrees: [], preserved_branches: [] });
    renderHook(() => useCoreQuery('resource_inventory', { project_id: 'project-1', probe: false }));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(queryAdeCore).toHaveBeenCalledWith('resource_inventory', { projectId: 'project-1', probe: false });
  });

  it('da a resource_inventory un umbral propio: el sondeo de git del Core puede pasar de los 10 s', async () => {
    queryAdeCore.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    const { result } = renderHook(() => useCoreQuery('resource_inventory', { project_id: null, probe: true }));

    // El umbral genérico de 10 s descartaría una respuesta legítima del Core: aquí no se agota.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(result.current.status).not.toBe('disconnected');
    expect(result.current.error).toBeNull();

    // Pasado el umbral propio se informa el agotamiento, sin declarar una desconexión.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(result.current.status).not.toBe('disconnected');
    expect(result.current.status).toBe('error');
    expect(result.current.error).toContain('ade_query_timeout');
  });
});

describe('useCoreQuery: umbral visual y escaneos solapados (LXO-101)', () => {
  it('una lectura más lenta que el umbral no abre un segundo escaneo y se recupera cuando responde', async () => {
    const late = deferred();
    queryAdeCore.mockImplementation(() => late.promise);
    vi.useFakeTimers();
    const { result } = renderHook(() => useCoreQuery('resource_inventory', { project_id: null, probe: true }, { pollMs: 1_000 }));

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(queryAdeCore).toHaveBeenCalledTimes(1);
    expect(result.current.status).not.toBe('disconnected');
    expect(result.current.error).toContain('ade_query_timeout');

    // La petición sigue viva en el Core: el poll no abre otro escaneo.
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(queryAdeCore).toHaveBeenCalledTimes(1);

    // Respuesta tardía: se aplica y no se duplica el escaneo.
    await act(async () => {
      late.resolve({ repos: [], worktrees: [], preserved_branches: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeNull();
    expect(queryAdeCore).toHaveBeenCalledTimes(1);
  });

  it('el poll, el reintento y el cambio de argumentos no solapan escaneos mientras la petición sigue viva', async () => {
    const late = deferred();
    queryAdeCore.mockImplementation(() => late.promise);
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ projectId }) => useCoreQuery('resource_inventory', { project_id: projectId, probe: true }, { pollMs: 1_000 }),
      { initialProps: { projectId: null } },
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(queryAdeCore).toHaveBeenCalledTimes(1);

    // El poll no abre otro escaneo.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(queryAdeCore).toHaveBeenCalledTimes(1);

    // Un reintento tampoco: se engancha a la petición viva.
    await act(async () => { result.current.retry(); await vi.advanceTimersByTimeAsync(1_000); });
    expect(queryAdeCore).toHaveBeenCalledTimes(1);

    // Un cambio de argumentos tampoco: la lectura nueva se APLAZA hasta que se libere el hueco.
    await act(async () => { rerender({ projectId: 'project-2' }); await vi.advanceTimersByTimeAsync(5_000); });
    expect(queryAdeCore).toHaveBeenCalledTimes(1);

    // Cuando la primera se resuelve, la lectura aplazada sale: secuencial, nunca solapada.
    await act(async () => {
      late.resolve({ repos: [], worktrees: [], preserved_branches: [] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(queryAdeCore).toHaveBeenCalledTimes(2);
    expect(queryAdeCore).toHaveBeenLastCalledWith('resource_inventory', { projectId: 'project-2', probe: true });
  });

  it('al agotarse el umbral se conserva la última foto y la respuesta tardía la actualiza', async () => {
    const late = deferred();
    const first = { repos: [], worktrees: [], preserved_branches: [], machine: 'machine-1' };
    queryAdeCore.mockResolvedValueOnce(first).mockImplementation(() => late.promise);
    vi.useFakeTimers();
    const { result } = renderHook(() => useCoreQuery('resource_inventory', { project_id: null, probe: true }, { pollMs: 1_000 }));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.status).toBe('ready');
    const photo = result.current.data;

    // La segunda lectura se queda viva: al agotarse el umbral se conserva la última foto.
    await act(async () => { await vi.advanceTimersByTimeAsync(35_000); });
    expect(result.current.status).toBe('stale');
    expect(result.current.data).toBe(photo);
    expect(result.current.reason).toBe('timeout');
    expect(queryAdeCore).toHaveBeenCalledTimes(2);

    // La respuesta llega tarde y actualiza la foto: recuperación sin escaneo duplicado.
    await act(async () => {
      late.resolve({ ...first, machine: 'machine-2' });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe('ready');
    expect(result.current.data.machine).toBe('machine-2');
    expect(queryAdeCore).toHaveBeenCalledTimes(2);
  });

  it('un fallo tardío conserva la última foto y deja reintentar después', async () => {
    const late = deferred();
    const first = { repos: [], worktrees: [], preserved_branches: [] };
    queryAdeCore.mockResolvedValueOnce(first).mockImplementation(() => late.promise);
    vi.useFakeTimers();
    const { result } = renderHook(() => useCoreQuery('resource_inventory', { project_id: null, probe: true }, { pollMs: 1_000 }));

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(queryAdeCore).toHaveBeenCalledTimes(2);

    await act(async () => {
      late.reject(new Error('resource_inventory_read_failed'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status).toBe('stale');
    expect(result.current.data).toBe(first);

    // El hueco quedó libre: el siguiente poll vuelve a preguntar al Core.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(queryAdeCore).toHaveBeenCalledTimes(3);
  });
});
