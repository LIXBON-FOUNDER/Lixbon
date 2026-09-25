// reviewStore.js — revisión de lo que cambió el agente. La base de cada
// archivo es su contenido antes de la primera edición pendiente (el snapshot
// de esa llamada); aceptar un bloque suelto la adelanta y se guarda aquí.
import { create } from 'zustand';
import { useChatStore } from './chatStore';
import { useAppStore } from './appStore';

export const useReviewStore = create((set, get) => ({
  overrides: {},
  setOverride: (rel, text) => set({ overrides: { ...get().overrides, [rel]: text } }),
  clearOverride: (rel) => {
    const { [rel]: _drop, ...rest } = get().overrides;
    set({ overrides: rest });
  },
  clearAll: () => set({ overrides: {} }),
}));

/** rel → { baseline (null = el archivo no existía), indices } de lo pendiente. */
export function pendingChanges(messages) {
  const map = new Map();
  messages.forEach((m, index) => {
    const snap = m.snapshot;
    if (m.role !== 'tool' || m.reverted || m.accepted || snap?.kind !== 'file') return;
    const entry = map.get(snap.path) || { baseline: snap.oldContent, indices: [] };
    entry.indices.push(index);
    map.set(snap.path, entry);
  });
  return map;
}

export function relOf(absPath) {
  const root = useAppStore.getState().workspaceRoot;
  if (!root || !absPath?.startsWith(root)) return null;
  return absPath.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
}

/** Base con la que comparar `absPath`, o undefined si no hay nada que revisar. */
export function useBaseline(absPath) {
  const rel = relOf(absPath);
  const baseline = useChatStore((s) => (rel ? pendingChanges(s.messages).get(rel)?.baseline : undefined));
  const override = useReviewStore((s) => (rel ? s.overrides[rel] : undefined));
  if (baseline === undefined) return undefined;
  return override !== undefined ? override : baseline;
}
