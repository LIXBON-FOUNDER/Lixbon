// sesion.js — Team usa la misma cuenta que el IDE: la llave y el servidor
// salen de los ajustes del IDE (lib/settings.js), no hay inicio de sesión propio.
import { loadSettings, DEFAULT_SERVER_URL } from '../../lib/settings';

let servidor = DEFAULT_SERVER_URL;

export const servidorActual = () => servidor;

export function fijarServidor(url) {
  servidor = String(url || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

export async function leerSesion() {
  const { serverUrl, apiKey, user } = await loadSettings();
  fijarServidor(serverUrl);
  return { llave: apiKey || '', usuario: user || null };
}

export async function revalidar(llave) {
  let res;
  try {
    res = await fetch(`${servidor}/api/auth/me`, {
      headers: { Authorization: `Bearer ${llave}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('No se pudo contactar con Lixbon.');
  }
  if (res.status === 401) throw new Error('La sesión del IDE caducó. Vuelve a iniciar sesión en el IDE.');
  if (!res.ok) throw new Error(`El servidor respondió ${res.status}.`);
  return (await res.json()).user;
}
