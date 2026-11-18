import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { KIND } from './connection';

/** Fresh private reads; the generation also invalidates an open confirmation dialog. */
export function usePrivateView(obs, action, args, enabled = true) {
  const key = JSON.stringify([obs.session?.id, action, args]);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [reload, setReload] = useState(0);
  const [entry, setEntry] = useState({ key, data: null, error: null, loading: false, fresh: false });
  const current = useRef({});
  const generation = useRef(0);
  const supported = obs.capabilities?.includes(action) === true;
  const online = enabled && foreground && supported && obs.view.kind === KIND.ONLINE;
  const cursor = obs.core?.snapshot?.cursor?.events;
  const request = obs.request;
  const value = entry.key === key ? entry : { data: null, error: null, loading: false, fresh: false };
  current.current = { key, online, fresh: value.fresh, generation: generation.current };
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    let active = true;
    generation.current += 1;
    current.current.fresh = false;
    setEntry((old) => ({ key, data: old.key === key ? old.data : null, error: null, loading: !!online, fresh: false }));
    if (online) request(action, JSON.parse(JSON.stringify(args))).then((result) => {
      if (!active) return;
      setEntry((old) => result.ok
        ? { key, data: result.data?.result, error: null, loading: false, fresh: true }
        : { ...old, error: result.code || result.transport || 'unconfirmed', loading: false, fresh: false });
    });
    return () => { active = false; };
    // args is represented by key; callers may pass a new literal per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, online, cursor, reload, request]);
  const invalidate = () => {
    generation.current += 1;
    current.current.fresh = false;
    setEntry((old) => ({ ...old, fresh: false }));
  };
  return { ...value, supported, online, current, invalidate, refresh: () => setReload((n) => n + 1) };
}
