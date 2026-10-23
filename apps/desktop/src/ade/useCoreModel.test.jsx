import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { coreModelFromState, useCoreModel } from './useCoreModel';
import { CANONICAL, ERRORS, VARIANTS } from './testFixtures/coreModelFixtures';

// LXO-120 · una sola decisión legacy / task_attempt_v1, con los dos modos y cada error.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => invoke.mockReset());
const flush = async () => { await act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }); };

describe('useCoreModel', () => {
  it('task_attempt_v1 con la fixture canónica', async () => {
    invoke.mockResolvedValue(CANONICAL['core_model.v1.json']);
    const { result } = renderHook(() => useCoreModel());
    expect(result.current.mode).toBe('unknown');
    await flush();
    expect(result.current).toMatchObject({ mode: 'task_attempt_v1', vNext: true, modelKey: 'task_attempt_v1' });
    expect(invoke).toHaveBeenCalledWith('orch_query', { query: 'core_model', args: {} });
  });

  it('legacy cuando el Core lo declara, cuando responde core_model_inactive o cuando no conoce la query', async () => {
    for (const reply of [() => Promise.resolve(VARIANTS.coreModelLegacy), () => Promise.reject(ERRORS.inactive), () => Promise.reject(ERRORS.unknownCommand), () => Promise.reject(ERRORS.forbiddenAction)]) {
      invoke.mockReset();
      invoke.mockImplementation(reply);
      const { result, unmount } = renderHook(() => useCoreModel());
      await flush();
      expect(result.current.mode).toBe('legacy');
      expect(result.current.vNext).toBe(false);
      unmount();
    }
  });

  it('un fallo real es error (no legacy ni vNext) y conserva su código', () => {
    expect(coreModelFromState({ data: null, error: ERRORS.unavailable })).toMatchObject({ mode: 'error', vNext: false, code: 'model_unavailable' });
    expect(coreModelFromState({ data: { core_model: 'otro' }, error: null })).toMatchObject({ mode: 'unknown', vNext: false });
    expect(coreModelFromState({ data: null, error: null, status: 'loading' }).mode).toBe('unknown');
  });

  it('inactivo: no pide la lectura cuando está oculto', () => {
    renderHook(() => useCoreModel({ active: false }));
    expect(invoke).not.toHaveBeenCalled();
  });
});
