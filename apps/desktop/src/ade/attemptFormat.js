import { COPY } from './adeLabels';

// Formato de datos de un Attempt sin inventar nada: lo que el Core no da es «no disponible».

export function formatUtc(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  const iso = new Date(ms).toISOString();
  return { iso, label: `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC` };
}

/** Duración solo de `started_at` y `ended_at`; si falta cualquiera, «no disponible». */
export function attemptDuration(attempt) {
  const start = attempt?.started_at;
  const end = attempt?.ended_at;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return COPY.notAvailable;
  const total = Math.round((end - start) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${s} s` : `${s} s`;
}

/** Hora que acompaña a un Attempt en listas: fin, inicio o creación, la primera que exista. */
export const attemptTime = (attempt) => formatUtc(attempt?.ended_at) ?? formatUtc(attempt?.started_at) ?? formatUtc(attempt?.created_at);

/**
 * Nombre visible de una ruta (último segmento): la ruta es ubicación, no identidad, y nunca se
 * convierte en enlace. La ruta completa queda en `title` y en la acción «Copiar ruta».
 */
export function pathName(path) {
  if (typeof path !== 'string' || !path.trim()) return null;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * Ruta relativa al repositorio si `path` está dentro de `repoRoot`; si no, solo el nombre.
 * No se resuelve nada en disco: es una comparación de texto.
 */
export function displayPath(path, repoRoot = null) {
  if (typeof path !== 'string' || !path.trim()) return null;
  const norm = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (typeof repoRoot === 'string' && repoRoot.trim()) {
    const root = norm(repoRoot);
    const full = norm(path);
    if (full.startsWith(`${root}/`)) return full.slice(root.length + 1);
  }
  return pathName(path);
}
