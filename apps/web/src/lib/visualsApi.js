import { api } from './api';

const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

export const fileUrl = (id, path, version) =>
  `/api/visuals/${id}/files/${enc(path)}${version != null ? `?v=${version}` : ''}`;
export const sharedFileUrl = (token, path) => `/api/shared-visuals/${token}/files/${enc(path)}`;

export const getVisual = (id, version) =>
  api.get(`/api/visuals/${id}`, { params: version != null ? { version } : {} }).then((r) => r.data);
export const getShared = (token) => api.get(`/api/shared-visuals/${token}`).then((r) => r.data);
export const deleteVisual = (id) => api.delete(`/api/visuals/${id}`);
export const setShare = (id, on) =>
  (on ? api.post(`/api/visuals/${id}/share`) : api.delete(`/api/visuals/${id}/share`)).then((r) => r.data);
export const pushFiles = (id, files, baseVersion) =>
  api.post(`/api/visuals/${id}/files`, { files, base_version: baseVersion }).then((r) => r.data);
export const eventsUrl = (id) => `/api/visuals/${id}/events`;
export const requestRender = (id, paths) =>
  api.post(`/api/visuals/${id}/render`, { paths }).then((r) => r.data.jobs);
export const listRenders = (id) => api.get(`/api/visuals/${id}/renders`).then((r) => r.data.jobs);

// Último trabajo de render por fuente: path → {status, error}.
export function rendersPorFuente(jobs) {
  const out = {};
  for (const j of jobs) if (!out[j.path] || j.created_at > out[j.path].created_at) out[j.path] = j;
  return out;
}
export const getText = (url) =>
  api.get(url, { responseType: 'text', transformResponse: (r) => r }).then((r) => r.data);

// Las piezas se escriben con rutas del skill (__ASSETS__/brand/...) para renderizarse
// en local; en la web las fuentes y el ícono salen de /public. __REPO__ es el prefijo
// de piezas antiguas.
// `base`: carpeta del visual en la API, para que una pieza pueda usar otras imágenes
// del mismo visual con rutas relativas (capturas reales). Se quita al guardar.
const BASE_TAG = /<base data-lixbon-base[^>]*>/g;
const FONTS_TAG = /<style data-lixbon-fonts>[\s\S]*?<\/style>/g;
// Las fuentes de marca siempre disponibles (igual que en el render del servidor):
// una pieza que nombra 'Geist' sin declararla caería en una fuente del sistema.
const FUENTES = [['Bruno Ace SC', 'bruno-ace-sc-latin.woff2', '400'], ['Geist', 'geist-latin.woff2', '100 900'],
  ['Geist Mono', 'geist-mono-latin.woff2', '100 900']]
  .map(([n, f, w]) => `@font-face{font-family:'${n}';src:url('/fonts/${f}');font-weight:${w}}`).join('');
const enHead = (html, extra) => (/<head[^>]*>/i.test(html)
  ? html.replace(/<head([^>]*)>/i, (m) => `${m}${extra}`)
  : extra + html);
export const baseDe = (id, path) => `/api/visuals/${id}/files/${path.includes('/') ? `${enc(path.slice(0, path.lastIndexOf('/')))}/` : ''}`;
export const paraWeb = (html, base) => enHead(html,
  `<style data-lixbon-fonts>${FUENTES}</style>${base ? `<base data-lixbon-base href="${base}">` : ''}`)
  .replaceAll('__ASSETS__/brand/fonts/', '/fonts/')
  .replaceAll('__ASSETS__/brand/', '/')
  .replaceAll('__REPO__/apps/web/public/', '/')
  .replaceAll('__REPO__/assets/brand/', '/');
export const paraGuardar = (html) => html
  .replace(BASE_TAG, '')
  .replace(FONTS_TAG, '')
  .replaceAll("url('/fonts/", "url('__ASSETS__/brand/fonts/")
  .replaceAll('url("/fonts/', 'url("__ASSETS__/brand/fonts/')
  .replaceAll('src="/icon-', 'src="__ASSETS__/brand/icon-');

const META = /<meta\s+name="render"\s+content="(image|video)\s+(\d+x\d+)(?:\s+([\d.]+))?"/i;

export function metaDePieza(html) {
  const m = META.exec(html || '');
  return m ? { kind: m[1].toLowerCase(), size: m[2], seconds: m[3] ? parseFloat(m[3]) : 12 } : null;
}

// Agrupa los archivos de un manifiesto: cada HTML fuente con su salida (mismo
// nombre, .png o .mp4) y aparte los documentos .md.
export function piezasDe(manifest) {
  const byPath = new Map(manifest.files.map((f) => [f.path, f]));
  const stem = (p) => p.replace(/\.[^.]+$/, '');
  const pieces = manifest.files
    .filter((f) => f.path.endsWith('.html'))
    .map((f) => {
      const out = ['.png', '.jpg', '.jpeg', '.webp', '.mp4', '.webm']
        .map((e) => byPath.get(stem(f.path) + e)).find(Boolean) || null;
      // Una salida sabe de qué contenido exacto de su HTML viene (sha256); las que
      // subió un agente sin ese dato se comparan por versión.
      const origen = out?.meta?.source_sha256;
      const stale = !!out && (origen ? origen !== f.sha256 : f.version > out.version);
      return { source: f, output: out, stale };
    });
  const orphans = manifest.files.filter((f) => f.role === 'output'
    && !pieces.some((p) => p.output && p.output.path === f.path)
    && /\.(png|jpe?g|webp|mp4|webm)$/.test(f.path))
    .map((f) => ({ source: null, output: f, stale: false }));
  const docs = manifest.files.filter((f) => f.path.endsWith('.md'));
  return { pieces: [...pieces, ...orphans], docs };
}
