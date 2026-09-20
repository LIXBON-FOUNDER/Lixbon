// fileViewStore.js — "archivo en vista rápida" del panel Archivos.
// Ya no hay editor: seleccionar un archivo solo lo marca para su vista de
// solo lectura (FileQuickView). El agente edita el contenido real vía chat.
import { create } from 'zustand';

export const useFileViewStore = create((set, get) => ({
  peekedPath: null,
  peekedName: '',

  peek: (path, name) => set({ peekedPath: path, peekedName: name || '' }),
  clear: () => set({ peekedPath: null, peekedName: '' }),

  /** Tras renombrar/mover: si el archivo en vista rápida era ese, sigue su ruta. */
  remap: (oldPath, newPath) => {
    if (get().peekedPath === oldPath) set({ peekedPath: newPath });
  },

  /** Tras eliminar: si el archivo (o algo dentro de la carpeta) eliminado
      era el que se estaba viendo, limpia la vista rápida. */
  clearUnder: (path) => {
    const p = get().peekedPath;
    if (p && (p === path || p.startsWith(path + '/') || p.startsWith(path + '\\'))) {
      set({ peekedPath: null, peekedName: '' });
    }
  },
}));
