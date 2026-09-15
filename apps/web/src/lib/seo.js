// seo.js — título, descripción, canónica y datos estructurados por ruta.
// La web es una SPA: los buscadores que ejecutan JS leen estas etiquetas al
// renderizar; las páginas privadas se marcan noindex.
import { useEffect } from 'react';

export const SITE_URL = 'https://lixbon.com';
export const SITE_NAME = 'lixbon';
const DESCRIPCION_BASE = 'Chat con modelos de IA sobre GPUs propias: web, CLI con modo agente, '
  + 'app de escritorio, Visuals para diseñar webs y una API compatible con OpenAI.';

function meta(selector, attrs) {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement('meta');
    Object.entries(attrs).slice(0, 1).forEach(([k, v]) => el.setAttribute(k, v));
    document.head.appendChild(el);
  }
  Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
}

function setJsonLd(datos) {
  const id = 'seo-jsonld';
  let el = document.getElementById(id);
  if (!datos) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('script');
    el.id = id;
    el.type = 'application/ld+json';
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(datos);
}

export function useSeo({ title, description = DESCRIPCION_BASE, path, noindex = false, jsonLd = null } = {}) {
  useEffect(() => {
    const titulo = title ? `${title} · ${SITE_NAME}` : `${SITE_NAME} — IA en tus propias GPUs`;
    const ruta = path ?? window.location.pathname;
    const url = `${SITE_URL}${ruta === '/' ? '' : ruta.replace(/\/$/, '')}`;

    document.title = titulo;
    meta('meta[name="description"]', { name: 'description', content: description });
    meta('meta[name="robots"]', { name: 'robots', content: noindex ? 'noindex, nofollow' : 'index, follow' });
    meta('meta[property="og:title"]', { property: 'og:title', content: titulo });
    meta('meta[property="og:description"]', { property: 'og:description', content: description });
    meta('meta[property="og:url"]', { property: 'og:url', content: url });
    meta('meta[name="twitter:title"]', { name: 'twitter:title', content: titulo });
    meta('meta[name="twitter:description"]', { name: 'twitter:description', content: description });

    let canonica = document.head.querySelector('link[rel="canonical"]');
    if (!canonica) {
      canonica = document.createElement('link');
      canonica.rel = 'canonical';
      document.head.appendChild(canonica);
    }
    canonica.href = url;
    setJsonLd(noindex ? null : jsonLd);
  }, [title, description, path, noindex, jsonLd]);
}

export const ORGANIZACION = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/icon-512.png`,
};
