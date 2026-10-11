import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { RUTAS_PUBLICAS, SITE_URL } from './src/rutasPublicas.js'

const RUTAS = RUTAS_PUBLICAS

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

export default defineConfig({
  plugins: [react(), sitemap()],
  server: {
    proxy: {
      // Mismo origen vía proxy para que la cookie de sesión funcione sin CORS.
      '/api': 'http://localhost:8000',
      '/v1': 'http://localhost:8000',
      '/mcp': 'http://localhost:8000',
      // El login del CLI y del escritorio (/ide/connect) lo sirve el gateway.
      '/ide': 'http://localhost:8000',
    },
  },
})
