// useAdeRouter.js — router mínimo en memoria, con sincronización opcional con location.hash.
// No toca appStore.js ni el modo activo del IDE: el ADE navega dentro de sí mismo.
import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { formatRoute, parseRoute, routes, sameRoute } from './routes';

const NavContext = createContext(null);

export function useAdeRouter({ initial, syncHash = false } = {}) {
  const sync = useRef(syncHash && typeof window !== 'undefined');
  const [historia, setHistoria] = useState(() => [initial || (sync.current ? parseRoute(window.location.hash) : routes.home())]);
  const route = historia[historia.length - 1];

  const navigate = useCallback((r, { replace = false } = {}) => {
    setHistoria((h) => {
      if (sameRoute(h[h.length - 1], r)) return h;
      return replace ? [...h.slice(0, -1), r] : [...h, r];
    });
  }, []);
  const back = useCallback(() => setHistoria((h) => (h.length > 1 ? h.slice(0, -1) : h)), []);

  useEffect(() => {
    if (!sync.current) return;
    const destino = formatRoute(route);
    if (window.location.hash !== destino) window.history.replaceState(null, '', destino);
  }, [route]);

  useEffect(() => {
    if (!sync.current) return undefined;
    const alCambiar = () => navigate(parseRoute(window.location.hash));
    window.addEventListener('hashchange', alCambiar);
    return () => window.removeEventListener('hashchange', alCambiar);
  }, [navigate]);

  return { route, navigate, back, canGoBack: historia.length > 1 };
}

export function NavProvider({ value, children }) {
  return createElement(NavContext.Provider, { value }, children);
}

export function useNav() {
  const v = useContext(NavContext);
  if (!v) throw new Error('useNav necesita <NavProvider> (lo monta AdeApp).');
  return v;
}
