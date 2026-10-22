// observe/cache.js — caché local de la última snapshot del Core (LXO-107).
//
// NO es autoridad: solo sirve para pintar algo al abrir la app mientras llega la snapshot real, y lo que
// sale de aquí se muestra siempre como desactualizado. Va en AsyncStorage porque no lleva secretos (la
// snapshot del Core no incluye spec, rutas ni credenciales); el token sigue en SecureStore.

import { SUPPORTED_SNAPSHOT_VERSION } from './bootstrap.js';

export const CACHE_VERSION = 1;
const PREFIX = 'lixbon.observe.cache.v1:';
/** Tope defensivo: la snapshot del Core cabe en 128 KiB; algo mayor no se guarda. */
export const MAX_CACHE_CHARS = 192 * 1024;

const keyOf = (hostKey) => `${PREFIX}${String(hostKey).slice(0, 120)}`;

/** `storage` tiene la forma de AsyncStorage: `getItem`, `setItem`, `removeItem` (promesas). */
export function createSnapshotCache(storage) {
  return {
    async load(hostKey) {
      try {
        const raw = await storage.getItem(keyOf(hostKey));
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (
          entry?.v !== CACHE_VERSION ||
          entry.hostKey !== hostKey ||
          entry.snapshot?.snapshot_version !== SUPPORTED_SNAPSHOT_VERSION ||
          !Number.isSafeInteger(entry.cursor) ||
          !Number.isFinite(entry.savedAt)
        ) {
          return null;
        }
        return { snapshot: entry.snapshot, cursor: entry.cursor, savedAt: entry.savedAt };
      } catch {
        return null;
      }
    },
    async save(hostKey, { snapshot, cursor, savedAt }) {
      try {
        const raw = JSON.stringify({ v: CACHE_VERSION, hostKey, savedAt, cursor, snapshot });
        if (raw.length > MAX_CACHE_CHARS) return false;
        await storage.setItem(keyOf(hostKey), raw);
        return true;
      } catch {
        return false;
      }
    },
    async clear(hostKey) {
      try {
        await storage.removeItem(keyOf(hostKey));
      } catch {
        // sin caché no pasa nada
      }
    },
  };
}
