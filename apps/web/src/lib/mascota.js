// mascota.js — preferencias de la mascota (Gael y Leya), compartidas por toda
// la web. Un solo estado (como useTema): se guarda en localStorage para que
// funcione sin sesión y, con sesión, en la cuenta (settings.mascot), que es
// lo que lee también el IDE. Lo de la cuenta manda al iniciar sesión.
import { useSyncExternalStore } from 'react';
import { api } from './api';

export const CLAVE_MASCOTA = 'lixbon-mascota';

// Mismo contrato que MASCOT_DEFAULTS en core/persistence/queries.py.
export const MASCOTA_DEFAULTS = {
  activa: true,
  personaje: 'gael',   // gael | leya | ambos
  trabajo: 'auto',     // IDE: escribir | conducir | auto
  preguntar: true,     // IDE
  flotante: true,      // IDE
  latigo: true,        // IDE
  latigo_min: 2,
  dormir: true,
  dormir_min: 5,
  guia: true,          // lixbon.com, docs y guías
  reducir: false,
};

// Cuadros de cada tira de sprites (public/mascotas/<personaje>-<estado>.png).
export const CUADROS = { idle: 2, type: 2, think: 1, sleep: 2, point: 1, wave: 2, whip: 3, kart: 2 };

const oyentes = new Set();
let estado = MASCOTA_DEFAULTS;
let leido = false;
let conCuenta = false;
let pendiente = null;
let temporizador = null;

function limpiar(raw) {
  const out = { ...MASCOTA_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, def] of Object.entries(MASCOTA_DEFAULTS)) {
    if (typeof raw[k] === typeof def) out[k] = raw[k];
  }
  return out;
}

function leer() {
  if (!leido && typeof window !== 'undefined') {
    leido = true;
    try { estado = limpiar(JSON.parse(localStorage.getItem(CLAVE_MASCOTA) || 'null')); } catch { /* sin almacenamiento */ }
  }
  return estado;
}

function guardarLocal() {
  try { localStorage.setItem(CLAVE_MASCOTA, JSON.stringify(estado)); } catch { /* sin almacenamiento */ }
}

function avisar() { oyentes.forEach((f) => f()); }

/** Cambia una o varias preferencias. Con sesión se guarda también en la
    cuenta, agrupando cambios seguidos en un solo PATCH. */
export function fijarMascota(patch) {
  estado = { ...leer(), ...patch };
  guardarLocal();
  avisar();
  if (!conCuenta) return;
  pendiente = { ...pendiente, ...patch };
  clearTimeout(temporizador);
  temporizador = setTimeout(() => {
    const envio = pendiente;
    pendiente = null;
    api.patch('/api/account/settings', { mascot: envio }).catch(() => { /* queda en local */ });
  }, 400);
}

/** La sesión cambió: con cuenta se adopta lo guardado en ella. */
let cuentaAdoptada = null;
export function sincronizarConCuenta(user) {
  conCuenta = Boolean(user);
  // Solo al entrar con otra cuenta: después, lo que se cambia aquí es más
  // nuevo que la copia que trae el objeto de usuario.
  const remoto = user?.settings?.mascot;
  if (!remoto || user.id === cuentaAdoptada) return;
  cuentaAdoptada = user.id;
  estado = limpiar(remoto);
  leido = true;
  guardarLocal();
  avisar();
}

function suscribir(f) {
  oyentes.add(f);
  return () => oyentes.delete(f);
}

export function useMascota() {
  return useSyncExternalStore(suscribir, leer, () => MASCOTA_DEFAULTS);
}

// Con "ambos" se turnan: uno por visita, elegido al azar la primera vez.
let turno = null;
export function personajeDe(prefs) {
  if (prefs.personaje !== 'ambos') return prefs.personaje;
  if (!turno) turno = Math.random() < 0.5 ? 'gael' : 'leya';
  return turno;
}

export const NOMBRES = { gael: 'Gael', leya: 'Leya' };
