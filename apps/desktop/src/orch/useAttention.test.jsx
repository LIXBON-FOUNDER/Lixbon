import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAttentionTotals } from './useAttention';
import { useOrchStore } from '../store/orchStore';
import { usePendingSpawnsStore, resetPendingSpawnsStoreForTests } from './spawn/pendingSpawnsStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const task = (id, over = {}) => ({ id, run: 'r1', parent: 'c', status: 'done', branch: `b/${id}`, head_commit: 'a', created: 1, last_review: null, last_integration: null, ...over });
const snap = (extra = {}) => ({
  runs: { r1: { id: 'r1', closed: false }, r2: { id: 'r2', closed: true } },
  tasks: { c: task('c', { parent: null, branch: null, status: 'running' }), t1: task('t1'), t2: task('t2', { run: 'r2' }) },
  messages: [{ id: 1, kind: 'question' }, { id: 2, kind: 'question' }, { id: 3, kind: 'reply', reply_to: 2 }],
  ...extra,
});

beforeEach(() => { resetPendingSpawnsStoreForTests(); useOrchStore.setState({ snap: snap() }); });
afterEach(() => resetPendingSpawnsStoreForTests());

describe('useAttentionTotals', () => {
  it('suma tareas por revisar, preguntas sin responder y lanzamientos pendientes, ignorando runs cerrados', () => {
    const { result } = renderHook(() => useAttentionTotals());
    expect(result.current).toEqual({ pending: 0, tasks: 1, questions: 1, total: 2 });
    act(() => usePendingSpawnsStore.setState({ items: [{ pending_id: 'p1' }, { pending_id: 'p2' }] }));
    expect(result.current).toEqual({ pending: 2, tasks: 1, questions: 1, total: 4 });
  });

  it('sin snapshot no hay nada que atender', () => {
    useOrchStore.setState({ snap: null });
    const { result } = renderHook(() => useAttentionTotals());
    expect(result.current.total).toBe(0);
  });
});

describe('pendingSpawnsStore', () => {
  it('escucha una sola vez, suma lo que llega y quita lo resuelto', async () => {
    const h = {};
    const api = { list: vi.fn(async () => [{ pending_id: 'a' }]), subscribe: vi.fn((cbs) => Object.assign(h, cbs)) };
    usePendingSpawnsStore.getState().start(api);
    usePendingSpawnsStore.getState().start(api);
    await Promise.resolve(); await Promise.resolve();
    expect(api.subscribe).toHaveBeenCalledTimes(1);
    act(() => h.onPending({ pending_id: 'b' }));
    act(() => h.onPending({ pending_id: 'b' }));
    expect(usePendingSpawnsStore.getState().items.map((x) => x.pending_id)).toEqual(['a', 'b']);
    act(() => h.onResolved({ pending_id: 'a', outcome: 'expired' }));
    expect(usePendingSpawnsStore.getState().items.map((x) => x.pending_id)).toEqual(['b']);
  });
});
