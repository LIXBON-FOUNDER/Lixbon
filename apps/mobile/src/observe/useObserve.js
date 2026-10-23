// observe/useObserve.js — conexión de Supervisar con el IDE elegido (LXO-111).
//
// Vive en el armazón (App) porque la usan la sección Supervisar y el menú lateral. Abre su propio socket a
// la sesión /remote del IDE (sin repetir el transcript del chat: `from_seq` al máximo), sigue si el IDE
// está conectado y su `hello`, y lleva el bootstrap del Core (LXO-107). Solo mientras se ve.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { openRemoteSocket } from '../remoteSocket';
import { useApi, useAuth } from '../state';
import { connectionView } from './connection';
import { pickHost } from './hosts';
import { useCoreBootstrap } from './useCoreBootstrap';

const HOST_KEY = 'lixbon.observe.host';
// El transcript del chat no interesa aquí: el gateway no repite nada por encima de esto.
const NO_REPLAY = Number.MAX_SAFE_INTEGER;

export function useObserve({ sessions, active }) {
  const api = useApi();
  const auth = useAuth();
  const [selectedId, setSelectedId] = useState(null);
  const { session, candidates } = useMemo(() => pickHost(sessions, selectedId), [sessions, selectedId]);
  const sessionId = session?.id || null;
  const [link, setLink] = useState('connecting');
  const [hostConnected, setHostConnected] = useState(false);
  const [meta, setMeta] = useState(null);
  const socketRef = useRef(null);
  const coreEventRef = useRef(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    AsyncStorage.getItem(HOST_KEY)
      .then((id) => id && setSelectedId((cur) => cur ?? id))
      .catch(() => {});
  }, []);

  const select = useCallback((id) => {
    setSelectedId(id);
    AsyncStorage.setItem(HOST_KEY, id).catch(() => {});
  }, []);

  useEffect(() => {
    setHostConnected(false);
    setMeta(null);
    setLink('connecting');
    if (!active || !sessionId) return undefined;
    const socket = openRemoteSocket({
      base: api.base,
      getToken: auth.currentToken,
      sessionId,
      getSeq: () => NO_REPLAY,
      onEvent: (ev) => {
        if (coreEventRef.current?.(ev)) return;
        if (ev.type === 'channel_status') {
          setHostConnected(!!ev.host_connected);
          if (ev.meta && Object.keys(ev.meta).length) setMeta(ev.meta);
        } else if (ev.type === 'hello') {
          setHostConnected(true);
          setMeta((cur) => ({ ...cur, capabilities: ev.capabilities, machine: ev.machine, title: ev.title }));
        } else if (ev.type === 'bye') {
          setHostConnected(false);
        }
      },
      onStatus: setLink,
      onEnded: () => setHostConnected(false),
      appState: AppState,
    });
    socketRef.current = socket;
    return () => {
      socketRef.current = null;
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, active]);

  const send = useCallback(async (command) => {
    const socket = socketRef.current;
    if (!socket) return { ok: false };
    const res = await socket.send(command);
    return res.retry ? { ok: false } : res;
  }, []);

  const core = useCoreBootstrap({
    enabled: active && !!sessionId,
    sessionId: sessionId || 'none',
    send,
    transportOpen: link === 'open',
    hostConnected,
    capabilities: meta?.capabilities,
  });
  coreEventRef.current = core.handleEvent;

  // Reloj para «hace X» y para que lo al día pase a desactualizado sin otra señal.
  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, [active]);

  // Pila de pantallas de la sección (App la usa para el botón Atrás de Android). Las rutas llevan ids
  // durables (`project_id`, `task_id`, `attention_id`), nunca posiciones en una lista.
  const [stack, setStack] = useState([{ name: 'home' }]);
  const push = useCallback((route) => setStack((cur) => [...cur, route]), []);
  const pop = useCallback(() => setStack((cur) => (cur.length > 1 ? cur.slice(0, -1) : cur)), []);
  const home = useCallback(() => setStack([{ name: 'home' }]), []);
  useEffect(() => home(), [sessionId, home]);

  const view = connectionView({ core: core.state, link, hostConnected, hasHost: !!session, now });
  return {
    session, candidates, select, meta, link, hostConnected,
    core: core.state, retry: core.retry, request: core.request, view, now,
    capabilities: Array.isArray(meta?.capabilities) ? meta.capabilities : null,
    stack, route: stack[stack.length - 1], push, pop, home,
  };
}
