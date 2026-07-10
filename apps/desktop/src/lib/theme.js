// theme.js — modo claro/oscuro del IDE. El modo vive en <html data-theme="…">
// (lo aplica un script inline en index.html antes del primer render) y la
// preferencia se guarda en localStorage; sin preferencia se sigue el esquema
// del sistema. Al cambiar de modo también se re-aplica el tema lixbon del
// editor, salvo que haya un tema de VSCode activo (ese manda en ambos modos).
import { useCallback, useState } from 'react';
import { setEditorThemeExts } from '../store/editorStore';
import { useExtStore } from '../store/extStore';

const STORAGE_KEY = 'lixbon-theme';

export function getTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch { /* sin localStorage: solo dura la sesión */ }
  if (!useExtStore.getState().activeTheme) setEditorThemeExts(null);
}

export function useTheme() {
  const [theme, setState] = useState(getTheme);
  const set = useCallback((next) => {
    setTheme(next);
    setState(next);
  }, []);
  return [theme, set];
}
