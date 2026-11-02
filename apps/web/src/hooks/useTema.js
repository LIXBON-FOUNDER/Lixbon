import { useSyncExternalStore } from 'react';

export const CLAVE_TEMA = 'lixbon-tema';
const oyentes = new Set();
const avisar = () => oyentes.forEach((f) => f());

// La preferencia guardada es 'light', 'dark' o 'system'; lo que se pinta
// (data-theme) es siempre claro u oscuro.
function leerPreferencia() {
  try {
    const p = localStorage.getItem(CLAVE_TEMA);
    return p === 'light' || p === 'system' ? p : 'dark';
  } catch { return 'dark'; }
}

const oscuroDelSistema = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
const resolver = (pref) => (pref === 'system' ? (oscuroDelSistema() ? 'dark' : 'light') : pref);

function leer() {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

// Con «Sistema», el tema sigue al del sistema operativo mientras la página está abierta.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (leerPreferencia() !== 'system' || !document.documentElement.dataset.theme) return;
    document.documentElement.dataset.theme = resolver('system');
    avisar();
  });
}

export function fijarTema(pref) {
  try { localStorage.setItem(CLAVE_TEMA, pref); } catch { /* sin almacenamiento */ }
  document.documentElement.dataset.theme = resolver(pref);
  avisar();
}

// index.html solo aplica el tema guardado si hay esta marca: así la primera
// pintura de un visitante sin sesión es siempre oscura (founder va en claro).
const CLAVE_SESION = 'lixbon-sesion';

export function aplicarTemaDeSesion(conSesion) {
  try {
    if (conSesion) localStorage.setItem(CLAVE_SESION, '1');
    else localStorage.removeItem(CLAVE_SESION);
  } catch { /* sin almacenamiento */ }
  const tema = conSesion ? resolver(leerPreferencia()) : 'dark';
  if (document.documentElement.dataset.theme === tema) return;
  document.documentElement.dataset.theme = tema;
  avisar();
}

function suscribir(f) {
  oyentes.add(f);
  return () => oyentes.delete(f);
}

const leerTodo = () => `${leer()}|${leerPreferencia()}`;

export function useTema() {
  const [tema, preferencia] = useSyncExternalStore(suscribir, leerTodo, () => 'dark|dark').split('|');
  return { tema, preferencia, fijar: fijarTema, alternar: () => fijarTema(tema === 'dark' ? 'light' : 'dark') };
}
