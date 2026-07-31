// useViewportHeight.js — el teclado no debe tapar el compositor.
// Chrome Android encoge el layout (interactive-widget=resizes-content en el
// meta viewport), pero iOS Safari no: superpone el teclado y `100dvh` sigue
// midiendo la pantalla entera. Publicamos la altura del viewport *visual* en
// --app-vh y las superficies a pantalla completa la usan como alto.
import { useEffect } from 'react';

export function useViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined; // sin soporte: se queda el 100dvh del CSS

    const root = document.documentElement;
    const apply = () => {
      // El zoom de pellizco también encoge el viewport visual; ahí no tocamos
      // nada o el layout pegaría un salto mientras el usuario amplía.
      if (vv.scale > 1.01) root.style.removeProperty('--app-vh');
      else root.style.setProperty('--app-vh', `${Math.round(vv.height)}px`);
    };

    apply();
    vv.addEventListener('resize', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      root.style.removeProperty('--app-vh');
    };
  }, []);
}
