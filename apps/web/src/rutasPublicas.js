// rutasPublicas.js — las páginas que se indexan: alimentan el sitemap y el
// prerender (HTML estático para los buscadores). Sin JSX.
import { DOCS_INDEX } from './pages/docsIndex.js';
import { LEGAL_INDEX } from './pages/legalIndex.js';
import { GUIAS_INDEX } from './pages/guiasIndex.js';

export const SITE_URL = 'https://lixbon.com';

export const RUTAS_PUBLICAS = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/planes', priority: '0.9', changefreq: 'monthly' },
  { path: '/visuals', priority: '0.8', changefreq: 'monthly' },
  { path: '/aplicaciones', priority: '0.8', changefreq: 'monthly' },
  { path: '/novedades', priority: '0.6', changefreq: 'weekly' },
  { path: '/status', priority: '0.5', changefreq: 'hourly' },
  { path: '/docs', priority: '0.8', changefreq: 'weekly' },
  { path: '/guias', priority: '0.8', changefreq: 'weekly' },
  ...GUIAS_INDEX.map((s) => ({ path: `/guias/${s.id}`, priority: '0.7', changefreq: 'monthly' })),
  ...DOCS_INDEX.map((s) => ({ path: `/docs/${s.id}`, priority: '0.7', changefreq: 'weekly' })),
  ...LEGAL_INDEX.map((s) => ({ path: `/legal/${s.id}`, priority: '0.4', changefreq: 'yearly' })),
];
