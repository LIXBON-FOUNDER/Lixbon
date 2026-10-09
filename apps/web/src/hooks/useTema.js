import { useSyncExternalStore } from 'react';

export const CLAVE_TEMA = 'lixbon-tema';
const oyentes = new Set();

function leer() {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function fijarTema(tema) {
  document.documentElement.dataset.theme = tema;
  try { localStorage.setItem(CLAVE_TEMA, tema); } catch { /* sin almacenamiento */ }
  oyentes.forEach((f) => f());
}

function suscribir(f) {
  oyentes.add(f);
  return () => oyentes.delete(f);
}

export function useTema() {
  const tema = useSyncExternalStore(suscribir, leer, () => 'light');
  return { tema, alternar: () => fijarTema(tema === 'dark' ? 'light' : 'dark') };
}
