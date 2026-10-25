// previewSource.js — qué alimenta el modo Orquestar: el Core real o la vista previa con datos simulados.
// La vista previa es la maqueta del ADE dentro del producto: sirve para diseñar y probar lo que el Core
// aún no da (Compare, Proof Pack, Review, Hosts, Usage…). Nunca lee ni escribe el Core.
// En desarrollo está disponible siempre; en el binario solo si se activa en Ajustes › Orquestador.
import { create } from 'zustand';

const SOURCE_KEY = 'lx_ade_source';
const ENABLED_KEY = 'lx_ade_preview_enabled';

const read = (key) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key, value) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* sin almacenamiento: la elección dura la sesión */ }
};

const devBuild = () => Boolean(import.meta.env?.DEV);
const enabledFromStorage = () => devBuild() || read(ENABLED_KEY) === '1';
const sourceFromStorage = () => (enabledFromStorage() && read(SOURCE_KEY) === 'preview' ? 'preview' : 'core');

export const usePreviewSource = create((set, get) => ({
  /** La persona puede elegir la vista previa (siempre en desarrollo; en el binario, si la activó). */
  available: enabledFromStorage(),
  /** Lo que se ve en Orquestar: `core` o `preview`. */
  source: sourceFromStorage(),
  setSource: (source) => {
    if (source !== 'core' && source !== 'preview') return;
    if (source === 'preview' && !get().available) return;
    write(SOURCE_KEY, source);
    set({ source });
  },
  /** Ajustes › Orquestador. Desactivarla devuelve Orquestar al Core. */
  setAvailable: (on) => {
    const available = devBuild() || Boolean(on);
    write(ENABLED_KEY, on ? '1' : null);
    if (!available) write(SOURCE_KEY, null);
    set({ available, source: available ? get().source : 'core' });
  },
}));

export const PREVIEW_DEV_BUILD = devBuild;
