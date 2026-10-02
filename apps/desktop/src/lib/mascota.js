// mascota.js — preferencias de la mascota (Gael y Leya) en el IDE. Son las
// mismas que en la web: viven en la cuenta (settings.mascot, que trae
// /api/auth/me) y se copian en localStorage para arrancar sin esperar a la red.
// Cambiarlas aquí las guarda también en la cuenta.
import { useSyncExternalStore } from 'react';
import { api } from './api';
import { useAppStore } from '../store/appStore';

const CLAVE = 'lixbon_mascota';

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
  guia: true,          // solo web
  reducir: false,
};

// Cuadros de cada tira (public/mascotas/<personaje>-<estado>.png).
export const CUADROS = { idle: 2, type: 2, think: 1, sleep: 2, point: 1, wave: 2, whip: 3, kart: 2 };
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
    api.patch('/api/account/settings', { mascot: envio }).catch(() => { /* queda en local */ });
  }, 400);
}

// Lo que llega de la cuenta (al iniciar sesión o al refrescar el usuario)
// manda, salvo que sea lo mismo que ya se adoptó.
function adoptar(user) {
  const remoto = user?.settings?.mascot;
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
