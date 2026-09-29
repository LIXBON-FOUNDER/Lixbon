import { create } from 'zustand';

let seq = 0;

export const useToastStore = create((set, get) => ({
  toasts: [],
  show: (text, { tone = 'info', action = null, ms = 4000 } = {}) => {
    const id = ++seq;
    set({ toasts: [...get().toasts, { id, text, tone, action }] });
    setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = (text, opts) => useToastStore.getState().show(text, opts);
