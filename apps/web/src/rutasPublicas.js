// rutasPublicas.js — las páginas que se indexan: alimentan el sitemap y el
// prerender (HTML estático para los buscadores). Sin JSX. Cada ruta en
// español se repite con el prefijo /en: mismo slug, dos idiomas.
import { DOCS_INDEX } from './pages/docsIndex.js';
import { LEGAL_INDEX } from './pages/legalIndex.js';
import { GUIAS_INDEX } from './pages/guiasIndex.js';
import { withLocale } from './i18n/paths.js';

export const SITE_URL = 'https://lixbon.com';

const BASE = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/plans', priority: '0.9', changefreq: 'monthly' },
  { path: '/visuals', priority: '0.8', changefreq: 'monthly' },
  { path: '/apps', priority: '0.8', changefreq: 'monthly' },
  { path: '/news', priority: '0.6', changefreq: 'weekly' },
  { path: '/status', priority: '0.5', changefreq: 'hourly' },
  { path: '/docs', priority: '0.8', changefreq: 'weekly' },
  { path: '/guides', priority: '0.8', changefreq: 'weekly' },
  ...GUIAS_INDEX.map((s) => ({ path: `/guides/${s.id}`, priority: '0.7', changefreq: 'monthly' })),
  ...DOCS_INDEX.map((s) => ({ path: `/docs/${s.id}`, priority: '0.7', changefreq: 'weekly' })),
  ...LEGAL_INDEX.map((s) => ({ path: `/legal/${s.id}`, priority: '0.4', changefreq: 'yearly' })),
];

export const RUTAS_PUBLICAS = BASE.flatMap((r) => [
  { ...r, locale: 'es' },
  { ...r, path: withLocale(r.path, 'en'), locale: 'en' },
]);
