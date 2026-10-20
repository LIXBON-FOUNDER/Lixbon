// supervision/useSupervision.js — estado vivo del prototipo: el store, un reloj
// que avanza cada 5 s mientras se ve (para «hace X» y para que lo al día se
// vuelva viejo; parado no re-renderiza el resto de la app) y
// la pila de pantallas, que App usa para el botón Atrás de Android.
import { useCallback, useEffect, useRef, useState } from 'react';

import { act, initialState, reducer } from './store.js';

export function useSupervision(visible) {
  const [state, setState] = useState(() => initialState(Date.now()));
  const [now, setNow] = useState(Date.now());
  const [stack, setStack] = useState([{ name: 'home' }]);
  const ref = useRef(state);
  ref.current = state;

  useEffect(() => {
    if (!visible) return undefined;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      setState((s) => reducer(s, { type: 'tick', now: at }));
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [visible]);

  const dispatch = useCallback((action) => {
    const at = Date.now();
    setNow(at);
    setState((s) => reducer(s, { ...action, now: at }));
  }, []);

  // Intenta una decisión y devuelve el veredicto (send, queue, refresh,
  // desktop o blocked) para que la pantalla diga exactamente qué pasó.
  const decideNow = useCallback((action) => {
    const at = Date.now();
    const { state: next, verdict } = act(ref.current, action, at);
    ref.current = next;
    setNow(at);
    setState(next);
    return verdict;
  }, []);

  const push = useCallback((route) => setStack((s) => [...s, route]), []);
  const pop = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const home = useCallback(() => setStack([{ name: 'home' }]), []);

  return { state, now, dispatch, decide: decideNow, stack, route: stack[stack.length - 1], push, pop, home };
}
