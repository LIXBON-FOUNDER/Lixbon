// mascota.js — preferencias de la mascota (Gael y Leya) en el IDE. Son solo
// del IDE, independientes de las de la web: viven en la cuenta como
// settings.mascot_ide (las trae /api/auth/me, así te siguen en cualquier
// equipo) y se copian en localStorage para arrancar sin esperar a la red.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { useAppStore } from '../store/appStore';

const CLAVE = 'lixbon_mascota';
// Clave de la cuenta: la web usa `mascot`, el IDE la suya.
const CLAVE_CUENTA = 'mascot_ide';

// Mismo contrato que MASCOT_DEFAULTS en core/persistence/queries.py.
export const MASCOTA_DEFAULTS = {
  activa: true,
  personaje: 'gael',   // gael | leya | ambos
  trabajo: 'auto',     // escribir | conducir | auto (según la tarea)
  preguntar: true,     // proponer el siguiente paso al terminar
  flotante: true,      // aviso sobre otras apps al terminar
  latigo: true,        // "tlabaja" si no vuelves
  latigo_min: 2,
  dormir: true,
  dormir_min: 5,
  reducir: false,
};

// Cuadros de cada tira (public/mascotas/<personaje>-<estado>.png).
export const CUADROS = {
  idle: 12, talk: 4, look: 8, walk: 6, wave: 4, celebrate: 4, stretch: 4, scratch: 2,
  think: 2, point: 2, type: 2, sleep: 2, whip: 3, kart: 2,
};
// Milisegundos por cuadro: el ritmo de cada animación (igual que en la web).
export const MS_CUADRO = {
  idle: 220, talk: 130, look: 280, walk: 110, wave: 170, celebrate: 150, stretch: 420, scratch: 220,
  think: 480, point: 420, type: 180, sleep: 1200, whip: 250, kart: 120,
};
/** Lo que dura una vuelta completa de una animación. */
export const duracion = (estado) => (CUADROS[estado] || 1) * (MS_CUADRO[estado] || 200);
/** Un elemento al azar de una lista. */
export const alAzar = (v) => (Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v);
export const NOMBRES = { gael: 'Gael', leya: 'Leya' };

const oyentes = new Set();
let estado = leerLocal();
let pendiente = null;
let temporizador = null;
let ultimoRemoto = null;

function limpiar(raw) {
  const out = { ...MASCOTA_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, def] of Object.entries(MASCOTA_DEFAULTS)) {
    if (typeof raw[k] === typeof def) out[k] = raw[k];
  }
  return out;
}

function leerLocal() {
  try { return limpiar(JSON.parse(localStorage.getItem(CLAVE) || 'null')); } catch { return { ...MASCOTA_DEFAULTS }; }
}

function guardarLocal() {
  try { localStorage.setItem(CLAVE, JSON.stringify(estado)); } catch { /* sin almacenamiento */ }
}

function avisar() { oyentes.forEach((f) => f()); }

export function leerMascota() { return estado; }

/** Cambia una o varias preferencias; con sesión se guardan en la cuenta
    (los cambios seguidos van en un solo PATCH). */
export function fijarMascota(patch) {
  estado = { ...estado, ...patch };
  guardarLocal();
  avisar();
  if (!useAppStore.getState().apiKey) return;
  pendiente = { ...pendiente, ...patch };
  clearTimeout(temporizador);
  temporizador = setTimeout(() => {
    const envio = pendiente;
    pendiente = null;
    api.patch('/api/account/settings', { [CLAVE_CUENTA]: envio }).catch(() => { /* queda en local */ });
  }, 400);
}

// Lo que llega de la cuenta (al iniciar sesión o al refrescar el usuario)
// manda, salvo que sea lo mismo que ya se adoptó.
function adoptar(user) {
  const remoto = user?.settings?.[CLAVE_CUENTA];
  if (!remoto || pendiente) return;
  const firma = JSON.stringify(remoto);
  if (firma === ultimoRemoto) return;
  ultimoRemoto = firma;
  estado = limpiar(remoto);
  guardarLocal();
  avisar();
}
adoptar(useAppStore.getState().user);
useAppStore.subscribe((s, prev) => { if (s.user !== prev.user) adoptar(s.user); });

function suscribir(f) {
  oyentes.add(f);
  return () => oyentes.delete(f);
}

export function useMascota() {
  return useSyncExternalStore(suscribir, leerMascota);
}

// Con "ambos" se turnan: uno por arranque, elegido al azar.
const turno = Math.random() < 0.5 ? 'gael' : 'leya';
export function personajeDe(prefs) {
  return prefs.personaje === 'ambos' ? turno : prefs.personaje;
}
