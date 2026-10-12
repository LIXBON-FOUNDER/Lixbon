// AdeProvider.jsx — monta el cliente (AdeClient) y el host (AdeHost) para todo el árbol del ADE.
// Las pantallas y componentes solo hablan con esto: nunca importan MockAdeClient ni CoreAdeClient.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createNullHost } from '../host/AdeHost';
import { INTENTS, AVAILABILITY, unavailableCapability } from '../client/intents';

const AdeContext = createContext(null);

/** Texto de un error para la persona. Los AdeError traen código y, a veces, el slice que lo resolverá. */
export function errorText(e) {
  if (!e) return 'Error desconocido.';
  const base = e.message || String(e);
  return e.slice && e.code !== 'core_not_implemented' ? `${base} (requiere ${e.slice})` : base;
}

export function AdeProvider({ client, host: hostProp, now = Date.now, children }) {
  const host = useMemo(() => hostProp || createNullHost(), [hostProp]);
  const [version, setVersion] = useState(0);
  const [capState, setCapState] = useState({ loaded: false, capabilities: {}, connection: null, error: null });
  const [notices, setNotices] = useState([]);
  const seq = useRef(0);

  useEffect(() => {
    let vivo = true;
    Promise.all([client.getCapabilities(), client.getConnection()]).then(
      ([capabilities, connection]) => vivo && setCapState({ loaded: true, capabilities, connection, error: null }),
      (error) => vivo && setCapState({ loaded: true, capabilities: {}, connection: null, error }),
    );
    return () => { vivo = false; };
  }, [client, version]);

  useEffect(() => {
    try {
      return client.subscribe(() => setVersion((v) => v + 1));
    } catch {
      return undefined; // p. ej. CoreAdeClient sin implementar: la interfaz funciona sin avisos en vivo
    }
  }, [client]);

  const notify = useCallback((n) => {
    seq.current += 1;
    setNotices((l) => [...l.slice(-3), { id: seq.current, ...n }]);
  }, []);
  const dismissNotice = useCallback((id) => setNotices((l) => l.filter((n) => n.id !== id)), []);

  /** Decisión del Core. Nunca lanza: devuelve { ok, result | error } y avisa a la persona. */
  const run = useCallback(async (intent) => {
    try {
      const result = await client.dispatch(intent);
      notify({ tone: 'ok', simulated: Boolean(result.simulated), text: result.message || 'Hecho.' });
      return { ok: true, result };
    } catch (error) {
      notify({ tone: 'error', text: errorText(error) });
      return { ok: false, error };
    }
  }, [client, notify]);

  /** Capacidad del cliente (abrir diff, terminal, IDE…). */
  const runHost = useCallback(async (intent) => {
    try {
      const result = await host.perform(intent);
      return { ok: true, result };
    } catch (error) {
      notify({ tone: 'error', text: errorText(error) });
      return { ok: false, error };
    }
  }, [host, notify]);

  const value = useMemo(() => ({
    client, host, now, version, run, runHost, notices, notify, dismissNotice,
    connection: capState.connection, capabilities: capState.capabilities, capabilitiesLoaded: capState.loaded, capabilitiesError: capState.error,
  }), [client, host, now, version, run, runHost, notices, notify, dismissNotice, capState]);

  return <AdeContext.Provider value={value}>{children}</AdeContext.Provider>;
}

export function useAde() {
  const v = useContext(AdeContext);
  if (!v) throw new Error('useAde necesita <AdeProvider>.');
  return v;
}

/** Capacidad de un intent: del Core si es una decisión, del host si es una navegación. */
export function useCapability(intentId) {
  const { host, capabilities, capabilitiesLoaded } = useAde();
  return useMemo(() => {
    const def = INTENTS[intentId];
    const cap = def?.owner === 'host' ? host.getCapabilities()[intentId] : capabilities[intentId];
    const resuelta = cap || unavailableCapability(intentId, capabilitiesLoaded ? undefined : 'Cargando capacidades…');
    return { ...resuelta, usable: resuelta.availability !== AVAILABILITY.unavailable, label: def?.label || intentId, owner: def?.owner || 'core' };
  }, [intentId, host, capabilities, capabilitiesLoaded]);
}
