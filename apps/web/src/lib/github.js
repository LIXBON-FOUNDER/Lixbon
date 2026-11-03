// Conector de GitHub: cada usuario conecta SU cuenta (GitHub App de Lixbon) y
// adjunta un repo al chat de forma explícita. Sin repo adjunto, el modelo no
// recibe nada de GitHub.
import { api } from './api';

export const MODOS = ['auto', 'manual', 'ask', 'plan'];
const CLAVE_MODO = 'lixbon.github.modo';
const CLAVE_REPO = (convId) => `lixbon.github.repo.${convId}`;

// El estado se pide una vez por carga de página: lo comparten el menú del
// chat y la página de Integraciones.
let estadoEnCurso = null;
// El último estado que respondió el servidor: las vistas lo pintan al montar
// y luego refrescan, sin pasar por «sin configurar» mientras llega.
let ultimoEstado;

/** El último estado conocido (undefined si aún no se ha pedido nunca). */
export const estadoGithubConocido = () => ultimoEstado;

export function estadoGithub({ fresco = false } = {}) {
  if (fresco || !estadoEnCurso) {
    estadoEnCurso = api.get('/api/connectors/github').then((r) => { ultimoEstado = r.data; return r.data; }).catch((err) => {
      estadoEnCurso = null;
      throw err;
    });
  }
  return estadoEnCurso;
}

export const reposGithub = () => api.get('/api/connectors/github/repos').then((r) => r.data);

export async function desconectarGithub() {
  await api.delete('/api/connectors/github');
  estadoEnCurso = null;
  if (ultimoEstado) ultimoEstado = { ...ultimoEstado, connected: false, login: null };
}

/** Navegación completa (no fetch): GitHub necesita la ventana para autorizar. */
export function conectarGithub(next = window.location.pathname) {
  const base = import.meta.env.VITE_API_URL || '';
  window.location.assign(`${base}/api/connectors/github/start?next=${encodeURIComponent(next)}`);
}

export function leerModo() {
  try {
    const m = localStorage.getItem(CLAVE_MODO);
    return MODOS.includes(m) ? m : 'manual';
  } catch { return 'manual'; }
}

export function guardarModo(modo) {
  try { localStorage.setItem(CLAVE_MODO, modo); } catch { /* modo privado */ }
}

/** Repo adjunto a una conversación: se recuerda al volver a ella. */
export function leerRepo(convId) {
  if (!convId) return null;
  try {
    const r = JSON.parse(localStorage.getItem(CLAVE_REPO(convId)) || 'null');
    return r?.full_name ? r : null;
  } catch { return null; }
}

export function guardarRepo(convId, repo) {
  if (!convId) return;
  try {
    if (repo) localStorage.setItem(CLAVE_REPO(convId), JSON.stringify({ full_name: repo.full_name, default_branch: repo.default_branch }));
    else localStorage.removeItem(CLAVE_REPO(convId));
  } catch { /* modo privado */ }
}
