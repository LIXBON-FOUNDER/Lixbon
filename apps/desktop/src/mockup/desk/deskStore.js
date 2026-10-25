// deskStore.js — navegación del marco integrado: modo activo y paneles. Es lo único que la maqueta del Desktop añade al «Core» de mentira.
import { create } from 'zustand';

export const MODES = ['agent', 'editor', 'design', 'git', 'orch'];
const initial = () => ({ mode: 'orch', left: true, right: true, bottom: true, seq: 0, via: 'mouse' });

export const useDesk = create((set, get) => ({
  ...initial(),
  reset: () => set(initial()),
  /** `via`: 'key' no anima (se repite cientos de veces al día); 'mouse' hace un fundido corto. */
  setMode: (mode, via = 'mouse') => { if (MODES.includes(mode) && mode !== get().mode) set((s) => ({ mode, via, seq: s.seq + 1 })); },
  toggle: (panel) => set((s) => ({ [panel]: !s[panel] })),
}));
