import { DOCS_INDEX } from './pages/docsIndex.js';
import { GUIAS_INDEX } from './pages/guiasIndex.js';
import { withLocale } from './i18n/paths.js';

export const SITE_URL = 'https://lixbon.com';

const BASE = [
  { path: '/plans', priority: '0.9', changefreq: 'monthly' },
  { path: '/visuals', priority: '0.8', changefreq: 'monthly' },
  { path: '/apps', priority: '0.8', changefreq: 'monthly' },
  { path: '/skills', priority: '0.7', changefreq: 'weekly' },
  { path: '/status', priority: '0.5', changefreq: 'hourly' },
  { path: '/docs', priority: '0.8', changefreq: 'weekly' },
  { path: '/guides', priority: '0.8', changefreq: 'weekly' },
  ...GUIAS_INDEX.map((s) => ({ path: `/guides/${s.id}`, priority: '0.7', changefreq: 'monthly' })),
  ...DOCS_INDEX.map((s) => ({ path: `/docs/${s.id}`, priority: '0.7', changefreq: 'weekly' })),
];

export const RUTAS_PUBLICAS = BASE.flatMap((r) => [
  { ...r, locale: 'en' },
  { ...r, path: withLocale(r.path, 'es'), locale: 'es' },
]);
