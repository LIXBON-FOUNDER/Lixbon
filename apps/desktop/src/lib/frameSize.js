// frameSize.js — tamaño de la ventana del IDE en cuatro escalones. El CSS lee
// `data-size` del <html> y el JS usa useFrameSize(); así las dos mitades
// deciden igual qué se muestra (nombres de modo, buscador, paneles fijos o
// cajón).
//
//   xxl ≥ 1700 · xl 1400–1699 · l 1100–1399 · m < 1100
//
// Se mide en píxeles de ventana, no de CSS: la interfaz va con zoom del
// WebView (lib/uiScale), y a 110 % una ventana de 1440 mide 1309 en CSS.
import { useSyncExternalStore } from 'react';
import { readUiScale } from './uiScale';

export const SIZES = [['xxl', 1700], ['xl', 1400], ['l', 1100], ['m', 0]];

export const sizeOf = (width) => SIZES.find(([, min]) => width >= min)[0];

const inTauri = () => typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;

const measure = () => {
  const scale = inTauri() ? readUiScale() : 1;
  return sizeOf(window.innerWidth * scale);
};

let current = 'xl';
const listeners = new Set();

const update = () => {
  const next = measure();
  if (next === current) return;
  current = next;
  document.documentElement.dataset.size = next;
  listeners.forEach((fn) => fn());
};

/** Llamar una vez al arrancar la ventana del IDE. */
export function initFrameSize() {
  current = measure();
  document.documentElement.dataset.size = current;
  window.addEventListener('resize', update);
  window.addEventListener('lixbon:ui-scale', () => setTimeout(update, 0));
}

const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export const useFrameSize = () => useSyncExternalStore(subscribe, () => current);

/** Con la ventana estrecha solo cabe un panel fijo; el otro sale como cajón. */
export const useIsCompact = () => useFrameSize() === 'm';

/** Igual que useIsCompact pero para código fuera de React (el store). */
export const isCompact = () => current === 'm';
