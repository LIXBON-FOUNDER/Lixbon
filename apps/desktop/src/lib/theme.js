// theme.js — modo claro/oscuro de la app. El modo vive en <html data-theme="…">
// (lo aplica un script inline en index.html antes del primer render) y la
// preferencia se guarda en localStorage; sin preferencia se sigue el esquema
// del sistema.
import { useCallback, useState } from 'react';

const STORAGE_KEY = 'lixbon-theme';

export function getTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* sin localStorage: solo dura la sesión */ }
}

export function useTheme() {
  const [theme, setState] = useState(getTheme);
  const set = useCallback((next) => {
    setTheme(next);
    setState(next);
  }, []);
  return [theme, set];
}
