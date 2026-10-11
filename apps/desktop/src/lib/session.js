// session.js — credencial de la app. Tras entrar con correo o con el navegador,
// la sesión de este equipo (access de 30 min + refresh) vive en Rust
// (auth_session.rs), que la renueva para todas las ventanas y para `lxo issue`.
// Una API key pegada a mano no caduca y sigue en los ajustes de siempre.
import { invoke } from '@tauri-apps/api/core';

const MARGEN_MS = 2 * 60 * 1000;

let cache = null; // { token, expira (ms) }

export class SesionCaducada extends Error {
  constructor() {
    super('Tu sesión caducó o se cerró. Vuelve a iniciar sesión.');
  }
}

export const nombreDelEquipo = () => invoke('device_name').catch(() => null);

/** Guarda la sesión que acaba de entregar el login y devuelve su access. */
export async function iniciarSesion(servidor, cuerpo) {
  await invoke('auth_session_start', {
    servidor,
    access: cuerpo.access_token,
    refresh: cuerpo.refresh_token,
    expiresIn: cuerpo.expires_in,
  });
  cache = { token: cuerpo.access_token, expira: Date.now() + cuerpo.expires_in * 1000 };
  return cache.token;
}

/** Access vigente, renovado si hace falta; null si no hay sesión de este equipo.
    Con `rechazado` (el access que acaba de recibir un 401) se fuerza la
    renovación, salvo que otra ventana ya la hiciera. */
export async function tokenVigente(rechazado = null) {
  if (!rechazado && cache && cache.expira - Date.now() > MARGEN_MS) return cache.token;
  try {
    const t = await invoke('auth_token', { stale: rechazado });
    cache = t ? { token: t.token, expira: t.expira * 1000 } : null;
    return cache?.token ?? null;
  } catch (e) {
    cache = null;
    if (String(e).includes('session_expired')) throw new SesionCaducada();
    throw e;
  }
}

export async function cerrarSesion() {
  cache = null;
  await invoke('auth_logout').catch(() => {});
}
