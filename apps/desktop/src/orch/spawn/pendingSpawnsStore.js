import { create } from 'zustand';
import { defaultSpawnApi, spawnField } from './spawnContract';

const idOf = (x) => spawnField(x, 'pendingId');
let started = false;

/** Los pendientes vencen solos: con la vista del orquestador desmontada alguien tiene que seguir escuchando. */
export const usePendingSpawnsStore = create((set) => ({
  items: [],
  start: (api = defaultSpawnApi) => {
    if (started) return;
    started = true;
    api.list().then((xs) => {
      if (!Array.isArray(xs)) return;
      set((s) => {
        const seen = new Set(s.items.map(idOf));
        return { items: [...s.items, ...xs.filter((x) => !seen.has(idOf(x)))] };
      });
    }).catch(() => {});
    api.subscribe({
      onPending: (p) => set((s) => (s.items.some((x) => idOf(x) === idOf(p)) ? s : { items: [...s.items, p] })),
      onResolved: (r) => set((s) => ({ items: s.items.filter((x) => idOf(x) !== idOf(r)) })),
    });
  },
}));

export function resetPendingSpawnsStoreForTests() {
  started = false;
  usePendingSpawnsStore.setState({ items: [] });
}
