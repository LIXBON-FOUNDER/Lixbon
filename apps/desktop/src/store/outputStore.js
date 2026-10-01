// outputStore.js — "Salida": registro por canal de lo que el IDE hace por
// debajo (comandos del agente, git, servidores MCP, diagnóstico).
import { create } from 'zustand';

const MAX_LINES = 2000;
export const CHANNELS = ['Agente', 'Git', 'MCP', 'Diagnóstico'];

export const useOutputStore = create((set, get) => ({
  logs: Object.fromEntries(CHANNELS.map((c) => [c, []])),
  channel: 'Agente',
  unread: {},
  setChannel: (channel) => set({ channel, unread: { ...get().unread, [channel]: 0 } }),
  append: (channel, text) => {
    const time = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').filter((l, i, a) => l || i < a.length - 1);
    const prev = get().logs[channel] || [];
    const next = [...prev, ...lines.map((l) => ({ time, text: l }))].slice(-MAX_LINES);
    set({
      logs: { ...get().logs, [channel]: next },
      unread: channel === get().channel ? get().unread : { ...get().unread, [channel]: (get().unread[channel] || 0) + lines.length },
    });
  },
  clear: (channel) => set({ logs: { ...get().logs, [channel]: [] } }),
}));
