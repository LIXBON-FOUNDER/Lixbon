// theme.js — modo claro/oscuro. El tema vive en <html data-theme="…">
// (lo aplica un script inline en index.html antes del primer render) y la
// preferencia explícita del usuario se guarda en localStorage; sin preferencia
// se sigue el esquema del sistema (prefers-color-scheme).
import { useCallback, useState } from 'react';

const STORAGE_KEY = 'lixbon-theme';

export function getTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
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
    document.documentElement.dataset.theme = sys;
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
