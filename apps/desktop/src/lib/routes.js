// routes.js — rutas (pantallas) del proyecto para el modo Diseño, deducidas
// de las convenciones de cada framework. Es una lista para navegar la vista
// previa, no un análisis exacto: las rutas dinámicas quedan con su [param].
import { listFiles, searchInFiles } from './tauri';

const PAGE_EXT = /\.(tsx|jsx|ts|js|mdx|md|vue|svelte|astro)$/;

function fromFile(rel) {
  const p = rel.replace(/\\/g, '/');
  let m = p.match(/^(?:src\/)?app\/(.*?)(?:^|\/)?page\.(tsx|jsx|ts|js|mdx)$/);
  if (m) {
    // Next (app router): los (grupos) no cuentan en la URL.
    const segs = m[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'));
    return { route: `/${segs.join('/')}`, file: rel, kind: 'next' };
  }
  m = p.match(/^(?:src\/)?pages\/(.+)$/);
  if (m && PAGE_EXT.test(m[1]) && !/^(api\/|_)/.test(m[1]) && !/\/_/.test(m[1])) {
    const route = `/${m[1].replace(PAGE_EXT, '').replace(/(^|\/)index$/, '')}`;
    return { route: route === '/' ? '/' : route.replace(/\/$/, ''), file: rel, kind: 'pages' };
  }
  m = p.match(/^src\/routes\/(.*?)\+page\.svelte$/);
  if (m) {
    const segs = m[1].split('/').filter((s) => s && !/^\(.*\)$/.test(s));
    return { route: `/${segs.join('/')}`, file: rel, kind: 'sveltekit' };
  }
  return null;
}

export async function detectRoutes() {
  const files = await listFiles().catch(() => []);
  const byRoute = new Map();
  for (const f of files) {
    const r = fromFile(f.rel);
    if (r && !byRoute.has(r.route)) byRoute.set(r.route, { ...r, file: f.path });
  }
  if (!byRoute.size) {
    // React Router / Vue Router: `path="/x"` o `path: '/x'` en el código.
    const hits = await searchInFiles('path\\s*[=:]\\s*\\{?["\'`](/[^"\'`]*)', { isRegex: true }).catch(() => []);
    for (const h of hits) {
      if (!/\.(tsx|jsx|ts|js|vue)$/.test(h.name) || /node_modules/.test(h.path)) continue;
      const m = h.text.match(/path\s*[=:]\s*\{?["'`](\/[^"'`]*)/);
      if (m && !byRoute.has(m[1])) byRoute.set(m[1], { route: m[1], file: h.path, line: h.line, kind: 'router' });
    }
  }
  return [...byRoute.values()].sort((a, b) => (a.route === '/' ? -1 : b.route === '/' ? 1 : a.route.localeCompare(b.route)));
}
