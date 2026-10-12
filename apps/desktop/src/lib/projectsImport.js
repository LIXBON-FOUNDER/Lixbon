import { invoke } from '@tauri-apps/api/core';

/**
 * Entrega al Core las carpetas recientes de la interfaz (`lixbon_recents`) para que las registre
 * como proyectos (slice D).
 *
 * EL CORE ES LA ÚNICA AUTORIDAD de esta importación. Aquí NO hay ninguna marca de «ya importé»: se
 * envían los recientes en cada arranque y es el Core quien decide, con `meta.projects_recents_imported`
 * (en SQLite), si realmente hay que importar; si ya lo hizo responde `already_done: true` y no toca
 * nada. Así una base nueva o restaurada, que no tiene esa marca, vuelve a importar aunque
 * `localStorage` ya «recuerde» otra cosa. `localStorage` solo conserva `lixbon_recents`: la fuente de
 * las rutas históricas de la interfaz, no una segunda decisión de migración.
 *
 * No pregunta nada: lo ambiguo (un clon de un proyecto ya registrado en otra ruta) lo omite el Core y
 * se confirma después. Sin backend (vite solo) o con el almacén degradado no hace nada y se reintenta
 * en el siguiente arranque.
 *
 * `call` es inyectable para las pruebas.
 */
export async function importRecentProjects(paths, { call = invoke } = {}) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.trim());
  // Sin recientes no hay nada que enviar (y el Core no marca nada: si luego los hay, se importan).
  if (list.length === 0) return null;
  try {
    return await call('orch_projects_import_recents', { paths: list });
  } catch {
    return null;
  }
}
