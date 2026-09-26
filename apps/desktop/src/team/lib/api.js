import { servidorActual } from './sesion';

let llave = '';

export function usarLlave(nueva) {
  llave = nueva || '';
}

async function pedir(ruta, { metodo = 'GET', cuerpo, timeout = 15000 } = {}) {
  let res;
  try {
    res = await fetch(`${servidorActual()}${ruta}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        ...(llave ? { Authorization: `Bearer ${llave}` } : {}),
      },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error('No se pudo contactar con Lixbon Team.');
  }

  if (res.status === 401) throw new Error('La sesión caducó o fue revocada.');
  if (res.status === 204) return null;

  const datos = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(datos?.detail || `El servidor respondió ${res.status}.`);
  }
  return datos;
}

export const bootstrap = () => pedir('/api/team/bootstrap');

export const crearProyecto = (nombre) =>
  pedir('/api/team/projects', { metodo: 'POST', cuerpo: { nombre } });

export const editarProyecto = (id, cambios) =>
  pedir(`/api/team/projects/${id}`, { metodo: 'PATCH', cuerpo: cambios });

export const borrarProyecto = (id) =>
  pedir(`/api/team/projects/${id}`, { metodo: 'DELETE' });

export const invitarMiembro = (proyectoId, identificador) =>
  pedir(`/api/team/projects/${proyectoId}/members`, {
    metodo: 'POST',
    cuerpo: { identificador },
  });

export const quitarMiembro = (proyectoId, usuarioId) =>
  pedir(`/api/team/projects/${proyectoId}/members/${usuarioId}`, { metodo: 'DELETE' });

export const crearCanal = (proyectoId, { nombre, tipo = 'publico', tema = '' }) =>
  pedir(`/api/team/projects/${proyectoId}/channels`, {
    metodo: 'POST',
    cuerpo: { nombre, tipo, tema },
  });

export const editarCanal = (canalId, cambios) =>
  pedir(`/api/team/channels/${canalId}`, { metodo: 'PATCH', cuerpo: cambios });

export const borrarCanal = (canalId) =>
  pedir(`/api/team/channels/${canalId}`, { metodo: 'DELETE' });

export const sumarACanal = (canalId, usuarioId) =>
  pedir(`/api/team/channels/${canalId}/members`, {
    metodo: 'POST',
    cuerpo: { usuario_id: usuarioId },
  });

export const sacarDeCanal = (canalId, usuarioId) =>
  pedir(`/api/team/channels/${canalId}/members/${usuarioId}`, { metodo: 'DELETE' });

export function listarMensajes(canalId, { antesDe = 0, limite = 50, hiloDe = '' } = {}) {
  const q = new URLSearchParams({ limite: String(limite) });
  if (antesDe) q.set('antes_de', String(antesDe));
  if (hiloDe) q.set('hilo_de', hiloDe);
  return pedir(`/api/team/channels/${canalId}/messages?${q}`);
}

export const enviarMensaje = (canalId, clientId, texto, adjuntos = [], respondeA = null) =>
  pedir(`/api/team/channels/${canalId}/messages`, {
    metodo: 'POST',
    cuerpo: { client_id: clientId, texto, adjuntos, responde_a: respondeA },
  });

export const editarMensaje = (mensajeId, texto) =>
  pedir(`/api/team/messages/${mensajeId}`, { metodo: 'PATCH', cuerpo: { texto } });

export const borrarMensaje = (mensajeId) =>
  pedir(`/api/team/messages/${mensajeId}`, { metodo: 'DELETE' });

export const abrirDirecto = (usuarioId) =>
  pedir('/api/team/dms', { metodo: 'POST', cuerpo: { usuario_id: usuarioId } });

export const buscarUsuarios = (q) =>
  pedir(`/api/team/users/search?q=${encodeURIComponent(q)}`);

export const pedirAmistad = (identificador) =>
  pedir('/api/team/friends/requests', { metodo: 'POST', cuerpo: { identificador } });

export const aceptarAmistad = (usuarioId) =>
  pedir(`/api/team/friends/requests/${usuarioId}/accept`, { metodo: 'POST' });

export const quitarAmigo = (usuarioId) =>
  pedir(`/api/team/friends/${usuarioId}`, { metodo: 'DELETE' });

export const ponerPresencia = (estado) =>
  pedir('/api/team/presence', { metodo: 'PUT', cuerpo: { estado } });
