// codexTermStore.js — pestañas de terminal de Codex del modo Agente. Viven aparte de las
// sesiones de chat (useSessionsStore): no son conversaciones y nunca pasan por newSession.
import { create } from 'zustand';

let seq = 0;

export const useCodexTermStore = create((set, get) => ({
  tabs: [],          // [{ key, term_id, cwd, model, effort, argv, warnings, policy, exited, code }]
  activeKey: null,   // pestaña de Codex a la vista; null = se ve el chat
  launcher: false,   // panel previo al lanzamiento abierto

  openLauncher: () => set({ launcher: true, activeKey: null }),
  cancelLauncher: () => set({ launcher: false }),
  /** Tras codex_term_open: añade la pestaña y la activa. */
  addTab: (res, { cwd, model, effort }) => {
    const key = `codex-tab-${++seq}`;
    const tab = { key, term_id: res.term_id, cwd, model: model || null, effort: effort || null, argv: res.argv || [], warnings: res.warnings || [], policy: res.policy ?? null, exited: false, code: null };
    set({ tabs: [...get().tabs, tab], activeKey: key, launcher: false });
    return key;
  },
  activate: (key) => { if (get().tabs.some((t) => t.key === key)) set({ activeKey: key, launcher: false }); },
  /** Vuelve al chat (p. ej. al elegir una sesión de chat). */
  deactivate: () => set({ activeKey: null, launcher: false }),
  markExit: (term_id, code) => set({ tabs: get().tabs.map((t) => (t.term_id === term_id ? { ...t, exited: true, code } : t)) }),
  /** Quitar la pestaña desmonta su terminal, que llama a codex_term_close. */
  closeTab: (key) => {
    const tabs = get().tabs.filter((t) => t.key !== key);
    set({ tabs, activeKey: get().activeKey === key ? (tabs.at(-1)?.key ?? null) : get().activeKey });
  },
}));
