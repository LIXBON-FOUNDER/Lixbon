// prerender.mjs — HTML estático de las páginas públicas para los buscadores.
//
// Tras `vite build`, renderiza cada ruta de rutasPublicas.js con React en Node
// y escribe dist/_prerender/<ruta>/index.html: el shell de dist/index.html con
// el contenido ya pintado y las etiquetas SEO de esa página en el <head>. El
// gateway sirve ese archivo cuando la petición no trae cookie de sesión; con
// sesión sigue sirviendo el shell de la SPA.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const dist = resolve('dist');
const { render } = await import(pathToFileURL(resolve('dist-ssr/entry-server.js')).href);
const { RUTAS_PUBLICAS } = await import(pathToFileURL(resolve('src/rutasPublicas.js')).href);
const plantilla = await readFile(resolve(dist, 'index.html'), 'utf8');

const escapar = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const meta = (html, selector, valor) => html.replace(selector, (m) => m.replace(/content="[^"]*"/, `content="${escapar(valor)}"`));

function conCabecera(html, seo) {
  if (!seo) return html;
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${escapar(seo.titulo)}</title>`);
  out = meta(out, /<meta name="description"[^>]*>/, seo.description);
  out = meta(out, /<meta property="og:title"[^>]*>/, seo.titulo);
  out = meta(out, /<meta property="og:description"[^>]*>/, seo.description);
  out = meta(out, /<meta property="og:url"[^>]*>/, seo.url);
  out = meta(out, /<meta name="twitter:title"[^>]*>/, seo.titulo);
  out = meta(out, /<meta name="twitter:description"[^>]*>/, seo.description);
  out = out.replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${escapar(seo.url)}" />`);
  const extra = [
    `<meta name="robots" content="${seo.noindex ? 'noindex, nofollow' : 'index, follow'}" />`,
    seo.jsonLd ? `<script type="application/ld+json">${JSON.stringify(seo.jsonLd).replace(/</g, '\\u003c')}</script>` : '',
  ].filter(Boolean).join('\n    ');
  return out.replace('</head>', `    ${extra}\n  </head>`);
}

let n = 0;
for (const { path } of RUTAS_PUBLICAS) {
  const { html, seo } = render(path);
  const pagina = conCabecera(plantilla, seo).replace('<div id="root"></div>', `<div id="root">${html}</div>`);
  const carpeta = resolve(dist, '_prerender', path === '/' ? '' : path.slice(1));
  await mkdir(carpeta, { recursive: true });
  await writeFile(resolve(carpeta, 'index.html'), pagina);
  n += 1;
}
console.log(`prerender: ${n} páginas en dist/_prerender`);
