import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { createAttemptsMemory } from './attempts';
import { STATUS } from './bootstrap';

const memory = createAttemptsMemory();
const MAX_AGE_MS = 60000;

/** Lecturas acotadas del Core. La memoria se separa por host y destino y nunca autoriza acciones. */
export function useCoreSummary(obs, action, args = {}) {
  const serializedArgs = JSON.stringify(args);
  const key = JSON.stringify([obs.session?.id, action, serializedArgs]);
  const supported = obs.capabilities?.includes(action) === true;
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  const online = foreground && obs.link === 'open' && obs.hostConnected
    && obs.core?.status !== STATUS.UNAUTHORIZED && obs.core?.status !== STATUS.VERSION_MISMATCH;
  const [entry, setEntry] = useState(() => ({ key, data: memory.recall(key), loading: false, error: null }));
  const [refreshIndex, setRefreshIndex] = useState(0);
  const force = useRef(false);
  const request = obs.request;

  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => setForeground(next === 'active'));
    return () => listener.remove();
  }, []);

  useEffect(() => {
    let active = true;
    let timer;
    const load = async () => {
      if (!supported || !online) {
        setEntry({ key, data: memory.recall(key), loading: false, error: null });
        return;
      }
      setEntry((previous) => ({ key, data: previous.key === key ? previous.data : memory.recall(key), loading: true, error: null }));
      const refresh = force.current;
      force.current = false;
      const result = await request(action, { ...JSON.parse(serializedArgs), ...(refresh ? { refresh: true } : {}) });
      if (!active) return;
      if (result.ok && result.data?.summary) {
        const data = { value: result.data.summary, at: Date.now() };
        memory.remember(key, data);
        setEntry({ key, data, loading: false, error: null });
      } else {
        setEntry((previous) => ({ ...previous, loading: false, error: result.code || result.transport || 'invalid_response' }));
      }
      const summary = result.data?.summary;
      const busy = summary?.refreshing || summary?.status === 'probing' || summary?.status === 'loading';
      timer = setTimeout(load, busy ? 3000 : 30000);
    };
    load();
    return () => { active = false; clearTimeout(timer); };
  }, [key, supported, online, action, serializedArgs, request, refreshIndex]);

  const refresh = useCallback(() => {
    force.current = true;
    setRefreshIndex((previous) => previous + 1);
  }, []);
  const current = entry.key === key ? entry : { data: memory.recall(key), loading: false, error: null };
  const stale = !online || current.loading || !!current.error || !current.data || obs.now - current.data.at >= MAX_AGE_MS;
  return { data: current.data?.value || null, at: current.data?.at, stale, loading: current.loading, error: current.error, online, supported, refresh };
}
