// API de Espacios y de sus agentes programados (core/gateway/routers/espacios.py).
import { api } from './api';

const datos = (r) => r.data;

export const listarEspacios = () => api.get('/api/espacios').then(datos);
export const crearEspacio = (cuerpo) => api.post('/api/espacios', cuerpo).then(datos);
export const leerEspacio = (id) => api.get(`/api/espacios/${id}`).then(datos);
export const editarEspacio = (id, cambios) => api.patch(`/api/espacios/${id}`, cambios).then(datos);
export const borrarEspacio = (id) => api.delete(`/api/espacios/${id}`).then(datos);

export function subirArchivo(id, archivo) {
  const form = new FormData();
  form.append('file', archivo);
  return api.post(`/api/espacios/${id}/archivos`, form, { headers: { 'Content-Type': 'multipart/form-data' } }).then(datos);
}
export const borrarArchivo = (id, archivoId) => api.delete(`/api/espacios/${id}/archivos/${archivoId}`).then(datos);

export const anadirNota = (id, texto) => api.post(`/api/espacios/${id}/memoria`, { texto }).then(datos);
export const aprobarNota = (id, notaId) => api.post(`/api/espacios/${id}/memoria/${notaId}/aprobar`).then(datos);
export const borrarNota = (id, notaId) => api.delete(`/api/espacios/${id}/memoria/${notaId}`).then(datos);

export const crearAgente = (id, cuerpo) => api.post(`/api/espacios/${id}/agentes`, cuerpo).then(datos);
export const leerAgente = (id) => api.get(`/api/agentes/${id}`).then(datos);
export const editarAgente = (id, cambios) => api.patch(`/api/agentes/${id}`, cambios).then(datos);
export const borrarAgente = (id) => api.delete(`/api/agentes/${id}`).then(datos);
export const ejecutarAgente = (id) => api.post(`/api/agentes/${id}/ejecutar`).then(datos);
export const leerEjecucion = (id) => api.get(`/api/ejecuciones/${id}`).then(datos);

/** Mensaje de error del backend (detail en español) o el genérico. */
export const errorDe = (e, generico) => {
  const d = e?.response?.data?.detail;
  return typeof d === 'string' ? d : d?.message || generico;
};

/** Zona horaria del navegador: el horario de los agentes es la hora local del usuario. */
export const zonaLocal = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};

// Estado de una ejecución → icono de shared/icons y su color (mismo tamaño siempre).
export const ICONO_ESTADO = {
  hecho: 'completado',
  curso: 'en-curso',
  espera: 'te-necesita',
  error: 'fallo',
  pausa: 'en-pausa',
};

// Tipo de un archivo del espacio por su extensión: icono de shared/icons y
// clave de su nombre en el diccionario (espacios.type_*).
const TIPOS = {
  md: ['archivo-markdown', 'md'], markdown: ['archivo-markdown', 'md'],
  txt: ['docs', 'txt'], text: ['docs', 'txt'], log: ['docs', 'txt'],
  csv: ['archivo-tabla', 'csv'], tsv: ['archivo-tabla', 'csv'],
  json: ['archivo-codigo', 'code'], html: ['archivo-codigo', 'code'], htm: ['archivo-codigo', 'code'],
  xml: ['archivo-codigo', 'code'], yaml: ['archivo-codigo', 'code'], yml: ['archivo-codigo', 'code'],
};
export function tipoArchivo(nombre) {
  const ext = (nombre.split('.').pop() || '').toLowerCase();
  const [icono, clave] = TIPOS[ext] || ['archivo', 'otro'];
  return { icono, clave, ext };
}
