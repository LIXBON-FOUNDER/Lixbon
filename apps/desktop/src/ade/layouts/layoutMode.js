// layoutMode.js — modos de maquetación del ADE y cómo se detectan.
//
// Se mide el CONTENEDOR del ADE, no la ventana: el panel «estrecho junto al IDE» no es una ventana pequeña.
// Los umbrales son de presentación; el comportamiento (qué se puede hacer) nunca depende del modo.
import { createContext, useContext, useEffect, useState } from 'react';

export const LAYOUT_MODES = Object.freeze(['wide', 'narrow', 'mobile']);
export const BREAKPOINTS = Object.freeze({ wide: 1100, narrow: 640 });

export function modeForWidth(width) {
  if (!Number.isFinite(width) || width <= 0) return 'wide';
  if (width >= BREAKPOINTS.wide) return 'wide';
  return width >= BREAKPOINTS.narrow ? 'narrow' : 'mobile';
}

export const LayoutContext = createContext({ mode: 'wide' });
export const useLayout = () => useContext(LayoutContext);

/** @param {{current: HTMLElement|null}} ref  @param {'wide'|'narrow'|'mobile'|undefined} forced fija el modo (pruebas, vista previa) */
export function useLayoutMode(ref, forced) {
  const [mode, setMode] = useState(forced || 'wide');
  useEffect(() => {
    if (forced) { setMode(forced); return undefined; }
    const el = ref.current;
    if (!el) return undefined;
    const medir = () => setMode(modeForWidth(el.getBoundingClientRect().width));
    medir();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', medir);
      return () => window.removeEventListener('resize', medir);
    }
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, forced]);
  return mode;
}
