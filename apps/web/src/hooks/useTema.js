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

// index.html solo aplica el tema guardado si hay esta marca: así la primera
// pintura de un visitante sin sesión es siempre oscura (founder va en claro).
const CLAVE_SESION = 'lixbon-sesion';

export function aplicarTemaDeSesion(conSesion) {
  let guardado = null;
  try {
    if (conSesion) localStorage.setItem(CLAVE_SESION, '1');
    else localStorage.removeItem(CLAVE_SESION);
    guardado = localStorage.getItem(CLAVE_TEMA);
  } catch { /* sin almacenamiento */ }
  const tema = conSesion && guardado === 'light' ? 'light' : 'dark';
  if (document.documentElement.dataset.theme === tema) return;
  document.documentElement.dataset.theme = tema;
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
