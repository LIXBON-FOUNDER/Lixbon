// observe/hosts.js — qué IDE muestra Supervisar (LXO-111). Una sesión /remote es un IDE (host). Sin
// selector multihost completo: se usa el elegido o, si no hay, el primero en línea. Sin dependencias.

/** Igual que remoteSessions.isOnline: `host_connected` del gateway manda sobre el `status` de la BD. */
export function sessionOnline(session) {
  if (!session || session.status === 'ended') return false;
  return typeof session.host_connected === 'boolean' ? session.host_connected : session.status === 'online';
}

/**
 * - El elegido sigue elegido aunque se desconecte (se ve «IDE desconectado», no se salta a otro).
 * - Sin elección válida: el primero en línea; si no hay ninguno, el primero de la lista.
 * Devuelve `{ session, candidates }`; `candidates` son las sesiones abiertas, las en línea primero.
 */
export function pickHost(sessions, selectedId) {
  const open = (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.id && s.status !== 'ended');
  const candidates = [...open.filter(sessionOnline), ...open.filter((s) => !sessionOnline(s))];
  const chosen = (selectedId && open.find((s) => s.id === selectedId)) || candidates[0] || null;
  return { session: chosen, candidates };
}

/** Nombre corto del host para la cabecera: máquina o título de la sesión. */
export function hostName(session, meta) {
  const name = meta?.machine || session?.machine || session?.title || session?.workspace;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : 'IDE';
}
