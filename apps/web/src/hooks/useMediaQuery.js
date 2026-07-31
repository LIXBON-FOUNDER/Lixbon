// useMediaQuery.js — puntos de corte compartidos entre CSS y JSX.
// El layout lo resuelve el CSS; estos hooks existen solo para lo que el CSS no
// puede hacer: atributos de accesibilidad (aria-hidden, inert) y estado que
// cambia de significado entre escritorio y móvil (el panel lateral es un cajón).
import { useCallback, useSyncExternalStore } from 'react';

// Mantener en sintonía con los @media de los .css:
//   compact → la navegación lateral/superior se convierte en cajón o menú
//   small   → teléfono: se apila, crecen los objetivos táctiles
export const BP_COMPACT = '(max-width: 860px)';
export const BP_SMALL = '(max-width: 640px)';

export function useMediaQuery(query) {
  const subscribe = useCallback(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false, // sin ventana (build estático): se asume escritorio
  );
}

export const useIsCompact = () => useMediaQuery(BP_COMPACT);
