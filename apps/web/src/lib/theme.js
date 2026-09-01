// theme.js — modo claro/oscuro. El tema vive en <html data-theme="…">
// (lo aplica un script inline en index.html antes del primer render) y la
// preferencia explícita del usuario se guarda en localStorage; sin preferencia
// se sigue el esquema del sistema (prefers-color-scheme).
import { useCallback, useState } from 'react';

const STORAGE_KEY = 'lixbon-theme';

/** Aplica un cambio de tema con transición en vez de a corte.
 *
 * Dos caminos, en orden de calidad:
 *   1. View Transitions, donde exista: el navegador funde la pantalla entera,
 *      incluidas imágenes y sombras, sin que nosotros listemos propiedades.
 *   2. Una clase temporal en <html> que hace transicionar colores y bordes de
 *      todo (motion.css). Se quita al terminar: dejarla puesta pondría una
 *      transición encima de cada hover de la interfaz.
 *
 * Quien pide menos movimiento en su sistema recibe el cambio instantáneo, que
 * es justo lo que ha pedido. */
function conTransicion(aplicar) {
  const raiz = document.documentElement;
  const quieto = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (quieto) {
    aplicar();
    return;
  }
  if (typeof document.startViewTransition === 'function') {
    document.startViewTransition(aplicar);
    return;
  }
  raiz.classList.add('theme-anim');
  aplicar();
  window.setTimeout(() => raiz.classList.remove('theme-anim'), 340);
}

export function getTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme) {
  conTransicion(() => {
    document.documentElement.dataset.theme = theme;
  });
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* modo privado sin localStorage: solo dura la sesión */ }
}

// Preferencia explícita: 'light' | 'dark' | 'system' (system = sin key guardada,
// se sigue prefers-color-scheme, igual que el script inline de index.html).
export function getThemePreference() {
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function setThemePreference(pref) {
  if (pref === 'system') {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* noop */ }
    const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    conTransicion(() => {
      document.documentElement.dataset.theme = sys;
    });
  } else {
    setTheme(pref);
  }
}

export function useTheme() {
  const [theme, setState] = useState(getTheme);
  const toggle = useCallback(() => {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next);
    setState(next);
  }, []);
  return [theme, toggle];
}
