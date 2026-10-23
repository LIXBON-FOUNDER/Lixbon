// observe/connection.js — UX de conexión de Supervisar (LXO-111): qué banner se enseña, con qué texto,
// cuándo se ofrece reintentar y si una acción puede mandarse.
//
// Distingue tres capas que no se mezclan: el transporte (teléfono ↔ servidor de Lixbon), el IDE (¿está
// conectado a su sesión?) y el Core (¿responde, nos autoriza, es de nuestra versión?). Ninguna de ellas es
// un fallo de una Task: offline nunca se pinta en rojo ni como «falló».
//
// Sin dependencias de React Native.
import { STALE_MS, STATUS } from './bootstrap.js';

export const KIND = Object.freeze({
  CONNECTING: 'connecting',
  ONLINE: 'online',
  RECONNECTING: 'reconnecting',
  STALE: 'stale',
  OFFLINE: 'offline',
  UNAUTHORIZED: 'unauthorized',
  VERSION_MISMATCH: 'version_mismatch',
});

/** Hora de la última sincronización en palabras («hace 3 min»). */
export function syncedAgo(syncedAt, now) {
  if (!Number.isFinite(syncedAt)) return null;
  const s = Math.max(0, Math.round((now - syncedAt) / 1000));
  if (s < 10) return 'ahora mismo';
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'hace 1 día' : `hace ${d} días`;
}

// Diagnóstico mínimo seguro: solo códigos estables, traducidos a lo que el usuario puede hacer.
const OFFLINE_REASON = {
  host_offline: 'El IDE no está conectado a esta sesión.',
  timeout: 'El IDE no contestó a tiempo.',
  offline: 'Sin conexión con el servidor de Lixbon.',
  closed: 'La conexión se cerró.',
  compact_snapshot_unavailable: 'Lixbon en el escritorio no tiene su almacén abierto.',
  event_log_unavailable: 'Lixbon en el escritorio no tiene su historial disponible.',
  invalid_snapshot: 'El IDE mandó una respuesta incompleta.',
};
const VERSION_REASON = {
  host_without_core_snapshot: 'Tu Lixbon de escritorio es anterior a Supervisar: actualízalo.',
  unsupported_action: 'Lixbon en el escritorio o el servidor no conocen Supervisar todavía: actualiza Lixbon en el escritorio.',
  protocol_mismatch: 'Esta app y tu Lixbon de escritorio hablan versiones distintas: actualiza los dos.',
  snapshot_version_unsupported: 'Tu Lixbon de escritorio es más nuevo que esta app: actualiza la app.',
};

/**
 * - `core`: estado del bootstrap (bootstrap.js) o null.
 * - `link`: estado del socket con el servidor (`connecting` · `open` · `reconnecting`).
 * - `hostConnected`: el gateway dice que el IDE está en su sesión.
 * - `hasHost`: hay una sesión de IDE elegida.
 */
export function connectionView({ core, link, hostConnected, hasHost = true, now = Date.now() }) {
  const lastSync = core?.syncedAt ? syncedAgo(core.syncedAt, now) : null;
  const hasData = !!core?.snapshot;
  const base = { lastSync, hasData, fromCache: !!core?.fromCache, code: core?.reason || null };

  if (!hasHost) {
    return {
      ...base,
      kind: KIND.OFFLINE,
      tone: 'muted',
      title: 'Ningún IDE conectado',
      detail: 'Abre Lixbon en el escritorio y activa Remoto (/remote) para ver aquí su trabajo.',
      retry: false,
      canMutate: false,
    };
  }
  const status = core?.status;
  if (status === STATUS.UNAUTHORIZED) {
    return { ...base, kind: KIND.UNAUTHORIZED, tone: 'error', title: 'Sesión no autorizada', detail: 'Tu sesión caducó o ya no tiene acceso a este IDE. Vuelve a iniciar sesión y reintenta.', retry: true, canMutate: false };
  }
  if (status === STATUS.VERSION_MISMATCH) {
    return {
      ...base,
      kind: KIND.VERSION_MISMATCH,
      tone: 'error',
      title: 'Versiones incompatibles',
      detail: VERSION_REASON[core.reason] || 'Actualiza Lixbon en el escritorio y esta app.',
      retry: true,
      canMutate: false,
    };
  }
  // El socket se está rehaciendo: «reconectando», no «sin conexión».
  if (link === 'reconnecting') {
    return {
      ...base,
      kind: KIND.RECONNECTING,
      tone: 'warn',
      title: 'Reconectando…',
      detail: hasData ? 'Lo que ves es de la última sincronización.' : 'Buscando el servidor de Lixbon.',
      retry: false,
      canMutate: false,
    };
  }
  // Primera conexión del socket: con caché se ven los datos guardados, marcados.
  if (link === 'connecting') {
    return hasData
      ? { ...base, kind: KIND.STALE, tone: 'warn', title: 'Datos guardados', detail: 'Es lo último que se guardó en este teléfono; conectando para actualizarlo.', retry: false, canMutate: false }
      : { ...base, kind: KIND.CONNECTING, tone: 'muted', title: 'Conectando…', detail: null, retry: false, canMutate: false };
  }
  if (link !== 'open' || !hostConnected || status === STATUS.OFFLINE) {
    const reason = !hostConnected ? 'host_offline' : link !== 'open' ? 'offline' : core?.reason;
    return {
      ...base,
      kind: KIND.OFFLINE,
      tone: 'muted',
      title: hostConnected === false ? 'IDE desconectado' : 'Sin conexión',
      detail: `${OFFLINE_REASON[reason] || OFFLINE_REASON.offline}${hasData ? ' Lo que ves es de la última sincronización.' : ''}`,
      retry: true,
      canMutate: false,
    };
  }
  if (!hasData || status === STATUS.CONNECTING || !status) {
    return { ...base, kind: KIND.CONNECTING, tone: 'muted', title: 'Conectando con el IDE…', detail: null, retry: false, canMutate: false };
  }
  const fresh = !core.fromCache && Number.isFinite(core.syncedAt) && now - core.syncedAt < STALE_MS;
  if (status === STATUS.STALE || !fresh) {
    return {
      ...base,
      kind: KIND.STALE,
      tone: 'warn',
      title: core.fromCache ? 'Datos guardados' : 'Desactualizado',
      detail: core.fromCache ? 'Es lo último que se guardó en este teléfono; se está actualizando.' : 'No se ha podido actualizar últimamente.',
      retry: true,
      canMutate: false,
    };
  }
  return { ...base, kind: KIND.ONLINE, tone: 'ok', title: 'En línea', detail: null, retry: false, canMutate: true };
}

/** Texto para lectores de pantalla: título, detalle y última sincronización. */
export function connectionA11y(view) {
  const parts = [view.title, view.detail, view.lastSync ? `Última sincronización ${view.lastSync}` : null];
  return parts.filter(Boolean).map((p) => p.trim().replace(/[.…]+$/, '')).join('. ');
}

/**
 * Puerta para acciones mutantes futuras (responder, aprobar…): solo con confirmación en línea. Devuelve
 * `{ allowed, reason }`; offline nunca puede aparentar que se mandó.
 */
export function actionGate(view) {
  if (view.canMutate) return { allowed: true, reason: null };
  const reason = {
    [KIND.UNAUTHORIZED]: 'Vuelve a iniciar sesión para hacer esto.',
    [KIND.VERSION_MISMATCH]: 'Actualiza Lixbon para hacer esto.',
    [KIND.STALE]: 'Actualiza primero: los datos no están al día.',
  }[view.kind];
  return { allowed: false, reason: reason || 'Sin conexión con el IDE: no se puede mandar nada ahora.' };
}
