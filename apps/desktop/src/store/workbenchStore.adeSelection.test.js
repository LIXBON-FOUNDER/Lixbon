import { afterEach, describe, expect, it } from 'vitest';
import { ADE_SELECTION_STORAGE_KEY, normalizeAdeSelection, readPersistedAdeSelection, useWorkbenchStore } from './workbenchStore';

// LXO-120 · la selección del ADE (Project/Task/Attempt) sobrevive a un refresh por IDs durables.
afterEach(() => localStorage.clear());

describe('selección ADE persistida', () => {
  it('conserva la forma F2 sin Attempt y añade attemptId solo si es un Attempt de esa Task', () => {
    expect(normalizeAdeSelection({ projectId: 'p', taskId: 't' })).toEqual({ projectId: 'p', taskId: 't' });
    expect(normalizeAdeSelection({ projectId: 'p', taskId: 't', attemptId: 't-a2' })).toEqual({ projectId: 'p', taskId: 't', attemptId: 't-a2' });
    expect(normalizeAdeSelection({ projectId: 'p', taskId: 't', attemptId: 'otra-a1' })).toEqual({ projectId: 'p', taskId: 't' });
    expect(normalizeAdeSelection({ projectId: 'p', taskId: 't', attemptId: 't-a0' })).toEqual({ projectId: 'p', taskId: 't' });
    expect(normalizeAdeSelection({ taskId: 't', attemptId: 't-a1' })).toEqual({ projectId: null, taskId: null });
  });

  it('escribe v2 al seleccionar y lo relee tras recargar', () => {
    useWorkbenchStore.getState().setAdeSelection({ projectId: 'p-1', taskId: 't3', attemptId: 't3-a1' });
    expect(JSON.parse(localStorage.getItem(ADE_SELECTION_STORAGE_KEY))).toEqual({ v: 2, projectId: 'p-1', taskId: 't3', attemptId: 't3-a1' });
    expect(readPersistedAdeSelection()).toEqual({ projectId: 'p-1', taskId: 't3', attemptId: 't3-a1' });
    useWorkbenchStore.getState().setAdeSelection({ projectId: 'p-1', taskId: 't3' });
    expect(readPersistedAdeSelection()).toEqual({ projectId: 'p-1', taskId: 't3' });
  });

  it('descarta lo guardado que no tiene la forma v2', () => {
    localStorage.setItem(ADE_SELECTION_STORAGE_KEY, 'no-json');
    expect(readPersistedAdeSelection()).toEqual({ projectId: null, taskId: null });
    localStorage.setItem(ADE_SELECTION_STORAGE_KEY, JSON.stringify({ v: 9, projectId: 'p' }));
    expect(readPersistedAdeSelection()).toEqual({ projectId: null, taskId: null });
  });
});
