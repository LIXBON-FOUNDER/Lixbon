// terminalStore.js — sesiones del panel de terminal integrado.
// El objeto xterm vive fuera de React (en TerminalPanel), aquí solo la lista de
// sesiones y cuál está activa. La creación real del PTY la hace TerminalPanel.

import { create } from 'zustand';
import { termClose, termWrite } from '../lib/tauri';

const SHELL_LABEL = {
  powershell: 'PowerShell',
  cmd: 'cmd',
  bash: 'bash',
  zsh: 'zsh',
};

let seq = 1;

export const useTerminalStore = create((set, get) => ({
  sessions: [], // [{ key, id, shell, title }]  id lo rellena TerminalPanel al abrir el PTY
  activeKey: null,
  pending: {}, // key -> comando encolado hasta que el PTY tenga id (Run/Build)

  /** Registra una sesión nueva (aún sin id de PTY) y la deja activa. */
  addSession: (shell = 'powershell') => {
    const key = `term-${seq++}`;
    const session = { key, id: null, shell, title: SHELL_LABEL[shell] || shell };
    set((s) => ({ sessions: [...s.sessions, session], activeKey: key }));
    return key;
  },

  /** Guarda el id de PTY que devolvió el backend para una sesión. */
  setSessionId: (key, id) =>
    set((s) => ({
      sessions: s.sessions.map((t) => (t.key === key ? { ...t, id } : t)),
    })),

  /** Comando pendiente para una sesión (lo lanza TerminalInstance al tener id). */
  takePending: (key) => {
    const cmd = get().pending[key];
    if (cmd == null) return null;
    set((s) => {
      const next = { ...s.pending };
      delete next[key];
      return { pending: next };
    });
    return cmd;
  },

  /** Ejecuta un comando en el terminal activo (crea uno si no hay). Lo usan Run/Build y Git. */
  runCommand: (cmd) => {
    const { sessions, activeKey, addSession } = get();
    const active = sessions.find((t) => t.key === activeKey);
    if (active?.id) {
      termWrite(active.id, cmd + '\r').catch(() => {});
      return;
    }
    const key = active ? active.key : addSession('powershell');
    set((s) => ({ pending: { ...s.pending, [key]: cmd } }));
  },

  setActive: (key) => set({ activeKey: key }),

  closeSession: async (key) => {
    const { sessions, activeKey } = get();
    const session = sessions.find((t) => t.key === key);
    if (session?.id) {
      try { await termClose(session.id); } catch { /* ya cerrado */ }
    }
    const remaining = sessions.filter((t) => t.key !== key);
    const nextActive =
      activeKey === key ? (remaining[remaining.length - 1]?.key ?? null) : activeKey;
    set({ sessions: remaining, activeKey: nextActive });
  },
}));
