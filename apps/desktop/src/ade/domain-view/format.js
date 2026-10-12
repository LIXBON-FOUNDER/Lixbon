// format.js — formato de tiempos e ids para la interfaz (puro, recibe `now`).
export { countdown } from '../../orch/terminalApprovalContract';

/** «hace 5 min», «hace 3 h», «ayer», «hace 4 d». Recibe ms desde epoch. */
export function formatAgo(ts, now) {
  if (!Number.isFinite(ts)) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return 'ahora';
  const min = Math.round(s / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} d`;
}

/** Duración corta: «45 s», «12 min», «2 h 5 min». */
export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export const shortCommit = (sha) => (typeof sha === 'string' && sha ? sha.slice(0, 7) : '');

/** Duración de un intento: hasta que terminó, o hasta ahora si sigue vivo. */
export const attemptDuration = (attempt, now) => formatDuration((attempt.endedAt ?? now) - attempt.startedAt);
