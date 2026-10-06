import { useSyncExternalStore } from 'react';

export const themeMode = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

export function watchTheme(onChange) {
  const observer = new MutationObserver(() => onChange(themeMode()));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

export const useThemeMode = () => useSyncExternalStore(watchTheme, themeMode);
