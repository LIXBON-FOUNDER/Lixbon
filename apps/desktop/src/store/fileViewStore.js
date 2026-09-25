// fileViewStore.js — pestañas del editor: archivos abiertos, su contenido en
// memoria, la versión en disco (mtime) y el estado de guardado.
// `peek`/`peekedPath` se mantienen porque el árbol y Quick Open los usan.
import { create } from 'zustand';
import { readFileContent, statFile, writeFileContent } from '../lib/tauri';
import { showConfirm } from '../lib/confirm';
import { useProblemsStore } from './problemsStore';

const nameOf = (path) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
const isUnder = (p, dir) => p === dir || p.startsWith(dir + '/') || p.startsWith(dir + '\\');

export const useFileViewStore = create((set, get) => ({
  tabs: [], // { path, name, content, saved, mtime, loading, error }
  activePath: null,
  peekedPath: null,
  peekedName: '',
  // Ruta y hora del último archivo que tocó el agente (para marcar la pestaña).
  agentTouched: {},
  cursor: null, // { line, col, selected } de la pestaña activa
  reveal: null, // { path, line, ts }: el editor salta a esa línea al verlo

  setCursor: (cursor) => set({ cursor }),

  revealLine: async (path, line, name) => {
    await get().open(path, name);
    set({ reveal: { path, line, ts: Date.now() } });
  },

  _activate: (path) => {
    const tab = get().tabs.find((t) => t.path === path);
    set({ activePath: path, peekedPath: path, peekedName: tab ? tab.name : '' });
  },

  open: async (path, name) => {
    if (get().tabs.some((t) => t.path === path)) {
      get()._activate(path);
      return;
    }
    const tab = { path, name: name || nameOf(path), content: '', saved: '', mtime: null, loading: true, error: '' };
    set({ tabs: [...get().tabs, tab] });
    get()._activate(path);
    try {
      const [content, mtime] = await Promise.all([readFileContent(path), statFile(path).catch(() => null)]);
      get()._patch(path, { content, saved: content, mtime, loading: false });
    } catch (e) {
      get()._patch(path, { loading: false, error: String(e) });
    }
  },

  peek: (path, name) => get().open(path, name),

  /** Pestaña que no es un archivo (detalle de un servidor MCP…): `path` con
      esquema propio, p. ej. `mcp://github`. */
  openVirtual: (path, name) => {
    if (!get().tabs.some((t) => t.path === path)) {
      set({ tabs: [...get().tabs, { path, name, content: '', saved: '', mtime: null, loading: false, error: '', virtual: true }] });
    }
    get()._activate(path);
  },

  _patch: (path, patch) => set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, ...patch } : t)) }),

  update: (path, content) => get()._patch(path, { content }),

  isDirty: (path) => {
    const t = get().tabs.find((x) => x.path === path);
    return !!t && !t.loading && t.content !== t.saved;
  },

  save: async (path = get().activePath) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab || tab.loading || tab.content === tab.saved) return true;
    try {
      const mtime = await writeFileContent(path, tab.content, tab.mtime);
      get()._patch(path, { saved: tab.content, mtime });
      useProblemsStore.getState().scheduleAfterSave();
      return true;
    } catch (e) {
      if (!String(e).startsWith('CONFLICT')) {
        get()._patch(path, { error: String(e) });
        return false;
      }
      const { choice } = await showConfirm({
        title: 'El archivo cambió en disco',
        message: `${tab.name} se modificó fuera del editor desde que lo abriste.`,
        options: [
          { id: 'overwrite', label: 'Sobrescribir', kind: 'danger' },
          { id: 'reload', label: 'Cargar la versión del disco', kind: 'primary' },
          { id: 'cancel', label: 'Cancelar' },
        ],
      });
      if (choice === 'overwrite') {
        const mtime = await writeFileContent(path, tab.content, null);
        get()._patch(path, { saved: tab.content, mtime });
        return true;
      }
      if (choice === 'reload') await get().reload(path);
      return false;
    }
  },

  saveAll: async () => {
    for (const t of get().tabs) {
      if (t.content !== t.saved) await get().save(t.path);
    }
  },

  reload: async (path) => {
    const [content, mtime] = await Promise.all([readFileContent(path), statFile(path).catch(() => null)]);
    get()._patch(path, { content, saved: content, mtime, error: '' });
  },

  /** Tras un cambio en disco (agente, git, editor externo): recarga las
      pestañas limpias cuyo mtime cambió. Las que tienen cambios sin guardar
      no se tocan; al guardarlas saltará el aviso de conflicto. */
  syncFromDisk: async (fromAgent = false) => {
    for (const t of get().tabs) {
      if (t.loading || t.content !== t.saved) continue;
      const mtime = await statFile(t.path).catch(() => null);
      if (mtime == null || mtime === t.mtime) continue;
      await get().reload(t.path).catch(() => {});
      if (fromAgent) set({ agentTouched: { ...get().agentTouched, [t.path]: Date.now() } });
    }
  },

  close: async (path) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return;
    if (tab.content !== tab.saved) {
      const { choice } = await showConfirm({
        title: 'Cambios sin guardar',
        message: `¿Guardar los cambios de ${tab.name}?`,
        options: [
          { id: 'save', label: 'Guardar', kind: 'primary' },
          { id: 'discard', label: 'No guardar', kind: 'danger' },
          { id: 'cancel', label: 'Cancelar' },
        ],
      });
      if (choice === 'cancel') return;
      if (choice === 'save' && !(await get().save(path))) return;
    }
    const tabs = get().tabs;
    const idx = tabs.findIndex((t) => t.path === path);
    const next = tabs.filter((t) => t.path !== path);
    set({ tabs: next });
    if (get().activePath === path) {
      const neighbour = next[Math.min(idx, next.length - 1)];
      if (neighbour) get()._activate(neighbour.path);
      else set({ activePath: null, peekedPath: null, peekedName: '' });
    }
  },

  activate: (path) => get()._activate(path),

  clear: () => set({ activePath: null, peekedPath: null, peekedName: '' }),

  remap: (oldPath, newPath) => {
    const tabs = get().tabs.map((t) => {
      if (!isUnder(t.path, oldPath)) return t;
      const path = newPath + t.path.slice(oldPath.length);
      return { ...t, path, name: nameOf(path) };
    });
    const ap = get().activePath;
    set({ tabs });
    if (ap && isUnder(ap, oldPath)) get()._activate(newPath + ap.slice(oldPath.length));
  },

  clearUnder: (path) => {
    const tabs = get().tabs.filter((t) => !isUnder(t.path, path));
    set({ tabs });
    const ap = get().activePath;
    if (ap && isUnder(ap, path)) {
      if (tabs[0]) get()._activate(tabs[0].path);
      else set({ activePath: null, peekedPath: null, peekedName: '' });
    }
  },
}));

export const useEditorTabs = useFileViewStore;
