// observe/status.js — texto del indicador mínimo de conexión con el Core (LXO-107).
// Las pantallas de LXO-108…111 harán la UX completa; esto solo dice en qué estado está el bootstrap.
import { STATUS } from './bootstrap.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
}

/** `{ tone, text, retry }`: tono para el punto de color, texto y si se ofrece reintentar. */
export function coreStatusLabel(state, now = Date.now()) {
  if (!state) return null;
  const s = state.snapshot;
  const counts = s
    ? `${plural(s.projects.total, 'proyecto', 'proyectos')} · ${plural(s.active_tasks.total, 'tarea activa', 'tareas activas')}${s.attention.total ? ` · ${plural(s.attention.total, 'pide atención', 'piden atención')}` : ''}`
    : '';
  switch (state.status) {
    case STATUS.CONNECTING:
      return { tone: 'muted', text: 'Core · conectando…', retry: false };
    case STATUS.ONLINE:
      return { tone: 'ok', text: `Core · en línea · ${counts}`, retry: false };
    case STATUS.STALE:
      return { tone: 'warn', text: `Core · desactualizado (${state.syncedAt ? ago(now - state.syncedAt) : 'sin fecha'}) · ${counts}`, retry: false };
    case STATUS.OFFLINE:
      return { tone: 'muted', text: s ? `Core · sin conexión · ${counts}` : 'Core · sin conexión con el IDE', retry: true };
    case STATUS.UNAUTHORIZED:
      return { tone: 'error', text: 'Core · sesión no autorizada: vuelve a iniciar sesión', retry: true };
    case STATUS.VERSION_MISMATCH:
      return { tone: 'error', text: 'Core · versión incompatible: actualiza Lixbon en el escritorio y en el móvil', retry: true };
    default:
      return null;
  }
}
