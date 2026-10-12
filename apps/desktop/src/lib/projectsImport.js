import { invoke } from '@tauri-apps/api/core';

const FLAG = 'lixbon_recents_imported';

/**
 * Entrega al Core, UNA sola vez, las carpetas recientes de la interfaz (`lixbon_recents`) para que
 * las registre como proyectos (slice D).
 *
 * El Core es quien manda: recuerda en SQLite que ya importó (`meta.projects_recents_imported`) y
 * repetir la llamada es inocuo. La marca de `localStorage` solo ahorra la llamada. No pregunta nada:
 * lo ambiguo (un clon de un proyecto ya registrado en otra ruta) lo omite el Core y se confirma
 * después con «Añadir proyecto». Sin backend (vite solo) o con el almacén degradado no hace nada y
 * se reintenta en el siguiente arranque.
 *
 * `call` y `storage` son inyectables para las pruebas.
 */
export async function importRecentProjects(paths, { call = invoke, storage = globalThis.localStorage } = {}) {
  try {
    if (storage?.getItem(FLAG)) return null;
  } catch { /* sin almacenamiento: se llama igualmente */ }
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim());
  // Sin recientes no se marca nada: si más tarde los hay, se importarán.
  if (list.length === 0) return null;
  try {
    const res = await call('orch_projects_import_recents', { paths: list });
    try { storage?.setItem(FLAG, '1'); } catch { /* no es grave */ }
    return res;
  } catch {
    return null;
  }
}
