// Coding: sesiones en la nube (/api/coding/*). La conversación va por el relay
// /remote (lib/remote.js); aquí solo lo propio del entorno.
import { api } from './api';

export const estadoCoding = () => api.get('/api/coding/estado').then((r) => r.data);

export const crearSesion = (repo, mode, model, base, espacioId) =>
  api.post('/api/coding/sessions', {
    repo, mode, model: model || undefined, base: base || undefined, espacio_id: espacioId || undefined,
  }).then((r) => r.data);

export const ramasRepo = (repo) => api.get('/api/coding/branches', { params: { repo } }).then((r) => r.data);
export const prsSesion = (id) => api.get(`/api/coding/sessions/${id}/prs`).then((r) => r.data.prs || []);

// Sesiones del CLI, el IDE o la nube: renombrar, fijar, archivar y quitar.
export const cambiarRemota = (id, cambios) => api.patch(`/api/remote/sessions/${id}`, cambios).then((r) => r.data.session);
export const terminarRemota = (id) => api.delete(`/api/remote/sessions/${id}`);
export const olvidarRemota = (id) => api.post(`/api/remote/sessions/${id}/forget`);

// El último entorno elegido en «Nueva sesión» (repo, base y modo).
const ENTORNO_KEY = 'lixbon.coding.entorno';
export const leerEntorno = () => { try { return JSON.parse(localStorage.getItem(ENTORNO_KEY) || 'null'); } catch { return null; } };
export const guardarEntorno = (e) => { try { localStorage.setItem(ENTORNO_KEY, JSON.stringify(e)); } catch { /* sin almacenamiento */ } };

// imagenes: base64 sin prefijo (ChatInput las da así).
export const enviarMensaje = (id, text, imagenes = []) => api.post(`/api/coding/sessions/${id}/prompt`, {
  text,
  attachments: imagenes.length
    ? imagenes.map((b64, i) => ({ kind: 'image', name: `imagen-${i + 1}.jpg`, base64: b64, mime: 'image/jpeg' }))
    : undefined,
}).then((r) => r.data);

export const pausarSesion = (id) => api.post(`/api/coding/sessions/${id}/pause`).then((r) => r.data);
export const reanudarSesion = (id) => api.post(`/api/coding/sessions/${id}/resume`).then((r) => r.data);
export const reintentarSesion = (id) => api.post(`/api/coding/sessions/${id}/retry`).then((r) => r.data);
export const eliminarSesion = (id) => api.delete(`/api/coding/sessions/${id}`);
export const cambiarSesion = (id, cambios) => api.patch(`/api/coding/sessions/${id}`, cambios).then((r) => r.data);
export const pedirPr = (id, title = '', body = '') =>
  api.post(`/api/coding/sessions/${id}/pr`, { title, body }).then((r) => r.data);

// La vista previa se sirve desde el gateway con la ruta completa: la app se
// arranca con esa ruta base (LIXBON_PREVIEW_BASE en el entorno).
// Siempre relativa: la vista previa solo se deja enmarcar desde el mismo
// origen (X-Frame-Options SAMEORIGIN). En desarrollo la sirve el proxy de Vite.
export const urlVistaPrevia = (id, port, path = '/') =>
  `/api/coding/sessions/${id}/preview/${port}/${String(path || '/').replace(/^\/+/, '')}`;

export const MODOS_CODING = ['auto', 'manual', 'ask', 'plan'];

// Sesión de Coding activa según su entorno (en marcha o arrancando).
export const entornoActivo = (s) => ['preparando', 'activa'].includes(s?.sandbox?.estado);
