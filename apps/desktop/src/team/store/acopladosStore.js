// acopladosStore.js — qué conversaciones se ven en el panel derecho del IDE.
// La lista vive en el almacén del disco (común a las dos ventanas) y cada
// cambio se anuncia con un evento para que la otra ventana se entere al momento.
import { create } from 'zustand';
import { emit, listen } from '@tauri-apps/api/event';
import { leerSeguidos, guardarSeguidos } from '../lib/seguidos';

const EVENTO = 'team:acoplados';
let escuchando = false;

export const useAcopladosStore = create((set, get) => ({
  ids: null,

  cargar: async () => {
    if (!escuchando) {
      escuchando = true;
      listen(EVENTO, (e) => { if (Array.isArray(e.payload)) set({ ids: e.payload }); }).catch(() => {});
    }
    if (get().ids !== null) return;
    set({ ids: await leerSeguidos() });
  },

  alternar: (id) => {
    const actuales = get().ids || [];
    const puesto = !actuales.includes(id);
    get().poner(puesto ? [...actuales, id] : actuales.filter((x) => x !== id));
    return puesto;
  },

  poner: (ids) => {
    set({ ids });
    guardarSeguidos(ids);
    emit(EVENTO, ids).catch(() => {});
  },
}));
