// codexTermStore.js — pestañas de terminal de Codex, a nivel de aplicación. Viven aparte de
// las sesiones de chat y del modo Agente: cambiar de modo desmonta la vista, no el PTY.
// La suscripción a los eventos del host es una sola, del store (no de la vista), y guarda un
// búfer de respaldo por pestaña. El PTY solo se cierra al cerrar la pestaña o la app.
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { codexTerm as defaultApi, appendCapped, FALLBACK_BUFFER_CAP } from './codexTermContract';

let seq = 0;
let api = defaultApi;
let started = null;                 // Promise de la suscripción global
const viewers = new Map();          // term_id → Set<(ev) => void>  (vistas montadas)

/** Para pruebas: otro adaptador. Reinicia la suscripción. */
export function configureCodexTerm(next, { cap } = {}) {
  api = next || defaultApi;
  started = null;
  viewers.clear();
  if (cap) bufferCap = cap;
}
let bufferCap = FALLBACK_BUFFER_CAP;
export const codexTermApi = () => api;

/** Suscripción única a codex-term-output/exit; idempotente. */
export function ensureCodexTermEvents() {
  if (started) return started;
  started = (async () => {
    const offOut = await api.onAnyOutput((term_id, data, s) => {
      useCodexTermStore.getState().appendOutput(term_id, data, s);
      viewers.get(term_id)?.forEach((fn) => fn({ type: 'output', data, seq: s }));
    });
    const offExit = await api.onAnyExit((term_id, code) => {
      useCodexTermStore.getState().markExit(term_id, code);
      viewers.get(term_id)?.forEach((fn) => fn({ type: 'exit', code }));
    });
    return () => { offOut(); offExit(); };
  })();
  return started;
}

/** Una vista se engancha a la salida en vivo de su term_id. Devuelve el desenganche. */
export function attachViewer(term_id, fn) {
  if (!viewers.has(term_id)) viewers.set(term_id, new Set());
  viewers.get(term_id).add(fn);
  return () => viewers.get(term_id)?.delete(fn);
}

export const useCodexTermStore = create((set, get) => ({
  tabs: [],          // [{ key, term_id, cwd, model, effort, argv, warnings, policy, exited, code }]
  activeKey: null,   // pestaña de Codex a la vista; null = se ve el chat
  launcher: false,   // panel previo al lanzamiento abierto
  launcherResume: null, // { id, title, cwd, model } si el panel es para reanudar una sesión guardada
  /** Búfer de respaldo por term_id: { data (≤ ~1 MB, recortado por delante), seq }. */
  buffers: {},

  openLauncher: (resume = null) => set({ launcher: true, launcherResume: resume, activeKey: null }),
  cancelLauncher: () => set({ launcher: false, launcherResume: null }),
  /** Tras codex_term_open: añade la pestaña, la activa y asegura la suscripción. */
  addTab: (res, { cwd, model, effort, title }) => {
    ensureCodexTermEvents();
    const key = `codex-tab-${++seq}`;
    const tab = { key, term_id: res.term_id, title: title || null, cwd, model: model || null, effort: effort || null, argv: res.argv || [], warnings: res.warnings || [], policy: res.policy ?? null, exited: false, code: null };
    set({ tabs: [...get().tabs, tab], activeKey: key, launcher: false, launcherResume: null, buffers: { ...get().buffers, [res.term_id]: { data: '', seq: null } } });
    return key;
  },
  activate: (key) => { if (get().tabs.some((t) => t.key === key)) set({ activeKey: key, launcher: false, launcherResume: null }); },
  deactivate: () => set({ activeKey: null, launcher: false, launcherResume: null }),
  appendOutput: (term_id, data, s) => {
    const b = get().buffers[term_id];
    if (!b) return; // pestaña ya cerrada o desconocida
    if (s !== null && s !== undefined && b.seq !== null && s <= b.seq) return; // repetido
    set({ buffers: { ...get().buffers, [term_id]: { data: appendCapped(b.data, data, bufferCap), seq: s ?? b.seq } } });
  },
  markExit: (term_id, code) => set({ tabs: get().tabs.map((t) => (t.term_id === term_id ? { ...t, exited: true, code } : t)) }),
  /** Cerrar la pestaña es lo único (con cerrar la app) que cierra el PTY. */
  closeTab: (key) => {
    const tab = get().tabs.find((t) => t.key === key);
    if (!tab) return;
    api.close(tab.term_id).catch(() => {});
    const tabs = get().tabs.filter((t) => t.key !== key);
    const buffers = { ...get().buffers };
    delete buffers[tab.term_id];
    viewers.delete(tab.term_id);
    set({ tabs, buffers, activeKey: get().activeKey === key ? (tabs.at(-1)?.key ?? null) : get().activeKey });
  },
  /**
   * Al arrancar o recargar la webview: rehace las pestañas con codex_term_list (las ya
   * terminadas salen como terminadas con su código). Cada vista se repinta al montarse con
   * codex_term_buffer. No duplica pestañas que ya estén.
   */
  rehydrate: async () => {
    ensureCodexTermEvents();
    const list = await api.list();
    const known = new Set(get().tabs.map((t) => t.term_id));
    const add = list.filter((x) => !known.has(x.term_id)).map((x) => ({
      key: `codex-tab-${++seq}`, term_id: x.term_id, cwd: x.cwd, model: x.model, effort: x.effort, argv: x.argv, warnings: [], policy: x.policy, exited: x.exited, code: x.code,
    }));
    if (!add.length) return 0;
    const buffers = { ...get().buffers };
    for (const t of add) buffers[t.term_id] = { data: '', seq: null };
    set({ tabs: [...get().tabs, ...add], buffers });
    return add.length;
  },
}));

// Sin cierre en beforeunload: recargar la webview también lo dispara y mataría los PTY que
// rehydrate() debe recuperar. Al cerrar la app los cierra el host.

/** Elegir otro chat saca a Codex de la vista. Montar de nuevo (al volver de otro modo) no cuenta como elegir. */
export function useLeaveCodexOnChatChange(chatKey) {
  const last = useRef(chatKey);
  useEffect(() => {
    if (last.current === chatKey) return;
    last.current = chatKey;
    useCodexTermStore.getState().deactivate();
  }, [chatKey]);
}
