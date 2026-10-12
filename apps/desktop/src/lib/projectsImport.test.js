import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importRecentProjects } from './projectsImport';

describe('importRecentProjects', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* sin almacenamiento */ }
  });

  it('envía los recientes al Core', async () => {
    const call = vi.fn().mockResolvedValue({ imported: 2, existing: 0, skipped: [], already_done: false });
    const res = await importRecentProjects(['C:/a', 'C:/b'], { call });
    expect(res.imported).toBe(2);
    expect(call).toHaveBeenCalledWith('orch_projects_import_recents', { paths: ['C:/a', 'C:/b'] });
  });

  it('una llamada repetida LLEGA al Core y es el Core quien responde already_done', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ imported: 1, existing: 0, skipped: [], already_done: false })
      .mockResolvedValueOnce({ imported: 0, existing: 0, skipped: [], already_done: true });
    const primera = await importRecentProjects(['C:/a'], { call });
    const segunda = await importRecentProjects(['C:/a'], { call });
    expect(call).toHaveBeenCalledTimes(2);
    expect(primera.already_done).toBe(false);
    expect(segunda.already_done).toBe(true);
  });

  it('no crea ni consulta ninguna marca propia en localStorage: no hay segunda decisión de migración', async () => {
    const call = vi.fn().mockResolvedValue({ already_done: false });
    const lecturas = [];
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation((k) => { lecturas.push(k); return null; });
    await importRecentProjects(['C:/a'], { call });
    expect(setItem).not.toHaveBeenCalled();
    expect(lecturas.filter((k) => /import/i.test(k))).toEqual([]);
    expect(localStorage.length).toBe(0);
    setItem.mockRestore();
    getItem.mockRestore();
  });

  it('aunque localStorage dijera «ya importé» (marca de una versión anterior), el Core sigue decidiendo', async () => {
    try { localStorage.setItem('lixbon_recents_imported', '1'); } catch { /* ignorado */ }
    const call = vi.fn().mockResolvedValue({ imported: 1, already_done: false });
    const res = await importRecentProjects(['C:/a'], { call });
    expect(call).toHaveBeenCalledTimes(1);
    expect(res.imported).toBe(1);
  });

  it('sin recientes no llama al Core', async () => {
    const call = vi.fn();
    expect(await importRecentProjects([], { call })).toBeNull();
    expect(await importRecentProjects(undefined, { call })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('filtra entradas inválidas', async () => {
    const call = vi.fn().mockResolvedValue({});
    await importRecentProjects(['C:/a', '', '  ', null, 7], { call });
    expect(call).toHaveBeenCalledWith('orch_projects_import_recents', { paths: ['C:/a'] });
  });

  it('si el Core falla (sin backend o almacén degradado) no rompe y se reintenta en el próximo arranque', async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error('sin backend')).mockResolvedValueOnce({ imported: 1 });
    expect(await importRecentProjects(['C:/a'], { call })).toBeNull();
    expect(await importRecentProjects(['C:/a'], { call })).toEqual({ imported: 1 });
    expect(call).toHaveBeenCalledTimes(2);
  });
});
