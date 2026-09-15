// entry-server.jsx — render en servidor para el prerender (scripts/prerender.mjs).
// Devuelve el HTML de una ruta pública y las etiquetas SEO que esa página pidió.
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { AppRoutes } from './App';
import { tomarSeoDelRender } from './lib/seo';

export function render(url) {
  const html = renderToString(
    <StaticRouter location={url}>
      <AppRoutes />
    </StaticRouter>,
  );
  return { html, seo: tomarSeoDelRender() };
}
