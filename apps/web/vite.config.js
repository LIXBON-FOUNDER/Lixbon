import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { DOCS_INDEX } from './src/pages/docsIndex.js'

const SITE_URL = 'https://lixbon.com'

// Rutas públicas indexables; las privadas (cuenta, admin, chats) van en robots.txt.
const RUTAS = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/planes', priority: '0.9', changefreq: 'monthly' },
  { path: '/visuals', priority: '0.8', changefreq: 'monthly' },
  { path: '/aplicaciones', priority: '0.8', changefreq: 'monthly' },
  { path: '/novedades', priority: '0.6', changefreq: 'weekly' },
  { path: '/docs', priority: '0.8', changefreq: 'weekly' },
  ...DOCS_INDEX.map((s) => ({ path: `/docs/${s.id}`, priority: '0.7', changefreq: 'weekly' })),
]

function sitemap() {
  return {
    name: 'lixbon-sitemap',
    generateBundle() {
      const hoy = new Date().toISOString().slice(0, 10)
      const urls = RUTAS.map((r) => [
        '  <url>',
        `    <loc>${SITE_URL}${r.path}</loc>`,
        `    <lastmod>${hoy}</lastmod>`,
        `    <changefreq>${r.changefreq}</changefreq>`,
        `    <priority>${r.priority}</priority>`,
        '  </url>',
      ].join('\n')).join('\n')
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          urls,
          '</urlset>',
          '',
        ].join('\n'),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), sitemap()],
  server: {
    proxy: {
      // En dev la web corre en :5173 y el gateway en :8000 — mismo origen
      // vía proxy para que la cookie de sesión funcione sin CORS.
      '/api': 'http://localhost:8000',
      '/v1': 'http://localhost:8000',
    },
  },
})
