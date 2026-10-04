// visualStudio.js — lo que comparten el estudio de Visuals y el panel del chat:
// aplicar la respuesta del modelo (bloques file: y edit:) sobre los archivos
// guardados del visual, el contexto que se le da al modelo y el guardado.
import { aplicarEdiciones, extraerArchivos, extraerEdiciones } from './visuals';
import { api } from './api';
import { fileUrl, getText, getVisual, pushFiles } from './visualsApi';

export const esPagina = (path) => /\.(html?|svg)$/i.test(path || '');

const ordenar = (files) => files.slice().sort((a, b) => (a.name === 'index.html' ? -1 : b.name === 'index.html' ? 1
  : a.name.localeCompare(b.name)));

/** Las páginas (HTML/SVG fuente) de una versión, con su código. */
export async function cargarPaginas(id, manifest) {
  const fuentes = manifest.files.filter((f) => esPagina(f.path) && f.role === 'source');
  const codes = await Promise.all(fuentes.map((f) => getText(fileUrl(id, f.path, manifest.viewing)).catch(() => '')));
  return ordenar(fuentes.map((f, i) => ({ name: f.path, code: codes[i], version: f.version })));
}

// En el chat general un ```html es una respuesta normal; solo cuenta como
// visual si el bloque lleva su nombre (file:index.html) o es una edición.
const NOMBRADO = /```\s*(?:file|edit):\s*([\w./-]+\.(?:html?|svg))/gi;

export function tieneVisual(texto) {
  return /```\s*(?:file|edit):\s*[\w./-]+\.(?:html?|svg)/i.test(texto || '');
}

/** Aplica una respuesta del modelo sobre `actuales` ([{name, code}]).
 *  `enCurso`: incluye el archivo que aún se está escribiendo (vista en vivo).
 *  Devuelve todos los archivos, los que cambian, los fallos de edición y el abierto. */
export function aplicarRespuesta(actuales, texto, { enCurso = false, estricto = false } = {}) {
  const nombrados = estricto ? new Set([...(texto || '').matchAll(NOMBRADO)].map((m) => m[1].replace(/^\.?\//, ''))) : null;
  const archivos = extraerArchivos(texto).filter((a) => (a.cerrado || enCurso) && (!nombrados || nombrados.has(a.name)));
  const ediciones = extraerEdiciones(texto).filter((e) => e.cerrado);
  const porNombre = new Map(actuales.map((f) => [f.name, f]));
  const cambiadas = new Map();
  const fallos = [];
  for (const a of archivos) cambiadas.set(a.name, { name: a.name, code: a.code, cerrado: a.cerrado });
  for (const e of ediciones) {
    const base = cambiadas.get(e.name) || porNombre.get(e.name);
    if (!base) { fallos.push({ name: e.name, motivo: 'no existe ese archivo' }); continue; }
    try {
      cambiadas.set(e.name, { name: e.name, code: aplicarEdiciones(base.code, e.pares), cerrado: true });
    } catch (err) {
      fallos.push({ name: e.name, motivo: `no encontré «${err.message}»` });
    }
  }
  const files = ordenar([...actuales.filter((f) => !cambiadas.has(f.name)), ...cambiadas.values()]);
  const abierto = archivos.find((a) => !a.cerrado) || null;
  const editando = extraerEdiciones(texto).find((e) => !e.cerrado) || null;
  return { files, cambiadas: [...cambiadas.values()].filter((f) => f.cerrado), fallos, abierto, editando };
}

/** El historial sin el código de los archivos: el modelo recibe el estado real
 *  en `contextoArchivos`, que puede haber cambiado desde fuera (editor, agentes). */
// `soloPaginas`: en el chat general los file: de documentos (docx, xlsx…) se quedan.
export function compactarHistorial(messages, { soloPaginas = false } = {}) {
  const bloque = soloPaginas
    ? /```\s*(file|edit):\s*([\w./-]+\.(?:html?|svg))[^\n`]*\n[\s\S]*?(?:\n```|$)/g
    : /```\s*(file|edit):\s*([^\n`]+)\n[\s\S]*?(?:\n```|$)/g;
  return messages.map((m) => (m.role !== 'assistant' ? m : {
    ...m,
    content: (m.content || '').replace(bloque, (_, tipo, nombre) => `[${tipo === 'edit' ? 'editó' : 'escribió'} ${nombre.trim()}]`),
  }));
}

const MAX_CONTEXTO = 120_000;

export function contextoArchivos(files, version) {
  if (!files.length) return '';
  let restante = MAX_CONTEXTO;
  const bloques = files.map((f) => {
    if (f.code.length > restante) return `(${f.name}: ${f.code.length} caracteres, no cabe aquí; si necesitas cambiarlo, reescríbelo entero)`;
    restante -= f.code.length;
    return `\`\`\`file:${f.name}\n${f.code}\n\`\`\``;
  });
  return `\n\nARCHIVOS ACTUALES DEL VISUAL (versión ${version}). Son la verdad: el usuario puede haberlos retocado. `
    + `Para cambiarlos usa bloques edit: copiando el SEARCH de aquí.\n\n${bloques.join('\n\n')}`;
}

/** Guarda los archivos cambiados como versión nueva. Si otro (el editor, un
 *  agente) guardó antes, se reaplica la respuesta sobre su versión. */
export async function guardarRespuesta(id, baseVersion, cambiadas, reaplicar) {
  const enviar = (files, base) => pushFiles(id, files.map((f) => ({ path: f.name, role: 'source', text: f.code })), base);
  try {
    return { ...(await enviar(cambiadas, baseVersion)), reaplicada: false };
  } catch (err) {
    if (err.response?.data?.detail?.code !== 'stale_base' || !reaplicar) throw err;
    const manifest = await getVisual(id);
    const nuevas = reaplicar(await cargarPaginas(id, manifest));
    return { ...(await enviar(nuevas, manifest.version)), reaplicada: true };
  }
}

export const crearVisual = (body) => api.post('/api/visuals', body).then((r) => r.data);
export const actualizarVisual = (id, patch) => api.patch(`/api/visuals/${id}`, patch).then((r) => r.data);
export const listarVisuals = (params) => api.get('/api/visuals', { params }).then((r) => r.data.items);
export const listarVersiones = (id) => api.get(`/api/visuals/${id}/versions`).then((r) => r.data.items);
export const visualDeConversacion = (cid) => listarVisuals({ conversation_id: cid, limit: 1 }).then((l) => l[0] || null);

export function tituloDe(files, fallback) {
  const index = files.find((f) => f.name === 'index.html') || files[0];
  const m = index && /<title>([^<]{1,120})<\/title>/i.exec(index.code);
  return (m && m[1].trim()) || fallback;
}
