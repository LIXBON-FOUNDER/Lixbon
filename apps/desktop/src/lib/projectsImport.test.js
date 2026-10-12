import { describe, it, expect, vi } from 'vitest';
import { importRecentProjects } from './projectsImport';

function memoria() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) };
}

describe('importRecentProjects', () => {
  it('envía los recientes al Core una sola vez y recuerda que ya lo hizo', async () => {
    const call = vi.fn().mockResolvedValue({ imported: 2, existing: 0, skipped: [] });
    const storage = memoria();
    const res = await importRecentProjects(['C:/a', 'C:/b'], { call, storage });
    expect(res.imported).toBe(2);
    expect(call).toHaveBeenCalledWith('orch_projects_import_recents', { paths: ['C:/a', 'C:/b'] });
    expect(await importRecentProjects(['C:/a'], { call, storage })).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('sin recientes no llama ni marca nada: si luego los hay, se importan', async () => {
    const call = vi.fn().mockResolvedValue({ imported: 1 });
    const storage = memoria();
    expect(await importRecentProjects([], { call, storage })).toBeNull();
    expect(await importRecentProjects(undefined, { call, storage })).toBeNull();
    expect(call).not.toHaveBeenCalled();
    await importRecentProjects(['C:/a'], { call, storage });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('filtra entradas inválidas', async () => {
    const call = vi.fn().mockResolvedValue({});
    await importRecentProjects(['C:/a', '', '  ', null, 7], { call, storage: memoria() });
    expect(call).toHaveBeenCalledWith('orch_projects_import_recents', { paths: ['C:/a'] });
  });

  it('si el Core falla (sin backend o almacén degradado) no rompe ni marca: se reintenta', async () => {
    const call = vi.fn().mockRejectedValue(new Error('sin backend'));
    const storage = memoria();
    expect(await importRecentProjects(['C:/a'], { call, storage })).toBeNull();
    expect(storage.getItem('lixbon_recents_imported')).toBeNull();
    call.mockResolvedValue({ imported: 1 });
    await importRecentProjects(['C:/a'], { call, storage });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('tolera un almacenamiento que lanza', async () => {
    const call = vi.fn().mockResolvedValue({ imported: 1 });
    const storage = { getItem: () => { throw new Error('bloqueado'); }, setItem: () => { throw new Error('bloqueado'); } };
    await expect(importRecentProjects(['C:/a'], { call, storage })).resolves.toEqual({ imported: 1 });
  });
});
