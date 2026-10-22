// observe/useCoreBootstrap.js — engancha el bootstrap del Core (LXO-107) a una sesión /remote.
//
// La identidad del móvil es la de su cuenta (API key en SecureStore, ver state.js) y la propiedad de la
// sesión, que comprueba el gateway. El IDE hace las lecturas con su identidad Desktop de F1. La caché va
// en AsyncStorage porque no lleva secretos y nunca es autoridad.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { createCoreBootstrap } from './bootstrap';
import { createSnapshotCache } from './cache';
import { createCoreLink } from './link';

const cache = createSnapshotCache(AsyncStorage);
// Solo códigos y contadores (ver bootstrap.js): nunca títulos, nombres ni ids.
const log = (code, fields) => {
  if (__DEV__) console.log(`[observe] ${code}`, fields || {});
};

/**
 * - `enabled`: si es `false` no se conecta nada (sección oculta o sin IDE); por defecto `true`.
 * - `sessionId`: la sesión /remote (clave de la caché).
 * - `send(command)`: entrega un comando y resuelve su acuse `{ ok, status? }`.
 * - `transportOpen`, `hostConnected`, `capabilities`: estado del enlace y `hello` del IDE.
 * Devuelve `{ state, retry, handleEvent }`; `handleEvent(ev)` es `true` si el evento era del bootstrap.
 */
export function useCoreBootstrap({ enabled = true, sessionId, send, transportOpen, hostConnected, capabilities }) {
  const [state, setState] = useState(null);
  const bootRef = useRef(null);
  const linkRef = useRef(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const linkState = useRef({ transportOpen, hostConnected, capabilities });
  linkState.current = { transportOpen, hostConnected, capabilities };

  useEffect(() => {
    if (!enabled) {
      setState(null);
      return undefined;
    }
    const link = createCoreLink({ send: (command) => sendRef.current(command) });
    const boot = createCoreBootstrap({ hostKey: sessionId, request: link.request, cache, log, onChange: setState });
    linkRef.current = link;
    bootRef.current = boot;
    boot.setLink(linkState.current);
    boot.setForeground(AppState.currentState !== 'background');
    boot.start();
    const sub = AppState.addEventListener('change', (next) => boot.setForeground(next === 'active'));
    return () => {
      sub.remove();
      boot.stop();
      link.close();
      bootRef.current = null;
      linkRef.current = null;
    };
  }, [sessionId, enabled]);

  const capsKey = Array.isArray(capabilities) ? capabilities.join(',') : '';
  useEffect(() => {
    bootRef.current?.setLink({ transportOpen, hostConnected, capabilities: Array.isArray(capabilities) ? capabilities : null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportOpen, hostConnected, capsKey]);

  const retry = useCallback(() => bootRef.current?.retry(), []);
  const handleEvent = useCallback((ev) => linkRef.current?.handleEvent(ev) ?? false, []);
  return { state, retry, handleEvent };
}
