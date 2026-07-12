// indexStore.js — estado de construcción del índice semántico del codebase (B3).
import { create } from 'zustand';
import { buildIndex, indexStatus } from '../lib/codebaseIndex';

export const useIndexStore = create((set, get) => ({
  building: false,
  progress: { done: 0, total: 0 },
  status: { exists: false, count: 0, model: '', createdAt: null },
  error: '',
  controller: null,

  refreshStatus: async () => {
    try { set({ status: await indexStatus() }); } catch { /* sin workspace */ }
  },

  build: async () => {
    if (get().building) return;
    const controller = new AbortController();
    set({ building: true, error: '', progress: { done: 0, total: 0 }, controller });
    try {
      const status = await buildIndex(
        (p) => set({ progress: { done: p.done || 0, total: p.total || 0 } }),
        controller.signal,
      );
      set({ status });
    } catch (e) {
      set({ error: String(e?.message || e) });
    } finally {
      set({ building: false, controller: null });
    }
  },

  cancel: () => { get().controller?.abort(); },
}));
