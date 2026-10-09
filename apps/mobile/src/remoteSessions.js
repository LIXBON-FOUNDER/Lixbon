// remoteSessions.js — la lista de sesiones /remote de la cuenta, en vivo. Vive
// en el armazón (no en la pantalla Remoto) porque la usan el menú lateral, la
// sección Remoto y el punto de "sesión en curso" del selector Chat · Remoto.
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiException } from './api';
import { keepStreamAlive, openEventStream } from './remote';
import { useApi, useAuth } from './state';

// Las sesiones de antes de que el host anunciara su agente son de Lixbon.
export const agentOf = (session, meta) => meta?.agent || session?.agent || 'lixbon';

export function isOnline(session) {
  if (session.status === 'ended') return false;
  // host_connected lo calcula el gateway desde el hub y es la verdad viva; el
  // status de la BD puede ir por detrás (el barrido corre cada pocos minutos).
  return typeof session.host_connected === 'boolean' ? session.host_connected : session.status === 'online';
}

export function timeAgo(iso, short = false) {
  const t = Date.parse(iso || '');
  if (!t) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return short ? `${min} min` : `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return short ? `${h} h` : `hace ${h} h`;
  const d = Math.round(h / 24);
  if (short) return `${d} d`;
  return d === 1 ? 'ayer' : `hace ${d} días`;
}

export function useRemoteSessions() {
  const api = useApi();
  const auth = useAuth();
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/api/remote/sessions');
      if (!aliveRef.current) return;
      // El historial vive en el IDE y el CLI: aquí solo las sesiones abiertas.
      const list = Array.isArray(res?.sessions) ? res.sessions : [];
      setSessions(list.filter((sx) => sx.status !== 'ended'));
      setError(null);
    } catch (err) {
      // El fallo se muestra: una lista vacía "porque sí" hacía parecer que el
      // IDE no había publicado la sesión cuando el problema era la petición.
      if (aliveRef.current) setError(err instanceof ApiException ? err.message : 'Sin conexión con el servidor');
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [api]);

  // Cuando se ejecuta /remote en el IDE o el CLI la sesión aparece al instante.
  // Cada (re)conexión relee la lista: lo emitido con el stream caído no se reenvía.
  useEffect(() => {
    aliveRef.current = true;
    const patch = (id, fields) => setSessions((cur) => cur.map((sx) => (sx.id === id ? { ...sx, ...fields } : sx)));
    const stop = keepStreamAlive(({ ok, retry }) => {
      load();
      return openEventStream({
        base: api.base,
        token: auth.apiKey,
        path: '/api/remote/subscribe',
        onEvent: (ev) => {
          ok();
          if (ev.type === 'session_created' && ev.session) {
            setSessions((cur) => [ev.session, ...cur.filter((sx) => sx.id !== ev.session.id)]);
          } else if (ev.type === 'session_updated' && ev.session) {
            patch(ev.session.id, ev.session);
          } else if (ev.type === 'session_online' || ev.type === 'session_offline') {
            const online = ev.type === 'session_online';
            patch(ev.session_id, { status: online ? 'online' : 'offline', host_connected: online });
          } else if (ev.type === 'session_ended') {
            setSessions((cur) => cur.filter((sx) => sx.id !== ev.session_id));
          }
        },
        onEnd: () => retry(false),
        onError: () => retry(true),
      });
    });
    return () => {
      aliveRef.current = false;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.base, auth.apiKey]);

  return { sessions, loading, error, refresh: load, live: sessions.some(isOnline) };
}
