// useTema.js — tema claro/oscuro de toda la web. Un solo estado compartido
// (varios botones lo cambian), guardado en localStorage y aplicado como
// data-theme en <html>; index.html lo lee antes del primer pintado.
import { useSyncExternalStore } from 'react';

export const CLAVE_TEMA = 'lixbon-tema';
const oyentes = new Set();

function leer() {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
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
  const tema = useSyncExternalStore(suscribir, leer, () => 'dark');
  return { tema, alternar: () => fijarTema(tema === 'dark' ? 'light' : 'dark') };
}
