import { useCallback, useState } from 'react';

const STORAGE_KEY = 'lixbon-theme';
const PREFERENCES = ['system', 'light', 'dark'];
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function readThemePreference() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return PREFERENCES.includes(stored) ? stored : 'dark';
  } catch {
    return 'dark';
  }
}

function resolve(preference) {
  if (preference === 'system') return media.matches ? 'dark' : 'light';
  return preference;
}

export function getTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(preference) {
  const next = PREFERENCES.includes(preference) ? preference : 'dark';
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch { /* sin localStorage: solo dura la sesión */ }
  document.documentElement.dataset.theme = resolve(next);
}

media.addEventListener('change', () => {
  if (readThemePreference() === 'system') document.documentElement.dataset.theme = resolve('system');
});

export function useTheme() {
  const [preference, setState] = useState(readThemePreference);
  const set = useCallback((next) => {
    setTheme(next);
    setState(next);
  }, []);
  return [preference, set];
}
