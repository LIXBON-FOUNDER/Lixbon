import { useEffect } from 'react';
import { useLocale } from '../i18n/LocaleContext';
import { localeDePath, otherLocalePath, withLocale } from '../i18n/paths';

export const SITE_URL = 'https://lixbon.com';
export const SITE_NAME = 'lixbon';
const DESCRIPCION_BASE = {
  es: 'Chat con modelos de IA sobre GPUs que operamos: web, CLI con modo agente, '
    + 'app de escritorio, Visuals para diseñar webs y una API compatible con OpenAI.',
  en: 'Chat with AI models on GPUs we operate: web, CLI with agent mode, '
    + 'desktop app, Visuals to design websites, and an OpenAI-compatible API.',
};
const TITULO_BASE = { es: `${SITE_NAME} — IA en GPUs que operamos`, en: `${SITE_NAME} — AI on GPUs we operate` };
const OG_LOCALE = { es: 'es_ES', en: 'en_US' };

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

function etiquetas({ title, description, path, noindex, jsonLd }) {
  const locale = localeDePath(path);
  const titulo = title ? `${title} · ${SITE_NAME}` : TITULO_BASE[locale];
  const limpio = path === '/' || path === '/es' ? path : path.replace(/\/$/, '');
  const url = `${SITE_URL}${limpio}`;
  const urlEs = `${SITE_URL}${locale === 'en' ? otherLocalePath(limpio) : limpio}`;
  const urlEn = `${SITE_URL}${locale === 'es' ? otherLocalePath(limpio) : limpio}`;
  return { titulo, description, url, noindex, jsonLd, ogLocale: OG_LOCALE[locale], alternates: { es: urlEs, en: urlEn } };
}

// En el prerender no hay efectos: la página deja aquí lo que pidió y el
// script lo inyecta en el <head> del HTML estático.
let seoDelRender = null;
export function tomarSeoDelRender() {
  const s = seoDelRender;
  seoDelRender = null;
  return s;
}

function setAlternates(alternates) {
  ['es', 'en', 'x-default'].forEach((hreflang) => {
    const selector = `link[rel="alternate"][hreflang="${hreflang}"]`;
    let el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement('link');
      el.rel = 'alternate';
      el.hreflang = hreflang;
      document.head.appendChild(el);
    }
    el.href = hreflang === 'x-default' ? alternates.en : alternates[hreflang];
  });
}

// Las páginas pasan su ruta en inglés (`/plans`); se lleva al idioma que se
// está pintando para que /es/plans sea canónica de sí misma y no de /plans.
export function useSeo({ title, description, path, noindex = false, jsonLd = null } = {}) {
  const locale = useLocale();
  const resolvedPath = withLocale(path ?? (typeof window === 'undefined' ? '/' : window.location.pathname), locale);
  const finalDescription = description ?? DESCRIPCION_BASE[localeDePath(resolvedPath)];
  if (typeof window === 'undefined') {
    seoDelRender = etiquetas({ title, description: finalDescription, path: resolvedPath, noindex, jsonLd });
  }
  useEffect(() => {
    const { titulo, url, ogLocale, alternates } = etiquetas({
      title, description: finalDescription, path: resolvedPath, noindex, jsonLd,
    });

    document.title = titulo;
    meta('meta[name="description"]', { name: 'description', content: finalDescription });
    meta('meta[name="robots"]', { name: 'robots', content: noindex ? 'noindex, nofollow' : 'index, follow' });
    meta('meta[property="og:title"]', { property: 'og:title', content: titulo });
    meta('meta[property="og:description"]', { property: 'og:description', content: finalDescription });
    meta('meta[property="og:url"]', { property: 'og:url', content: url });
    meta('meta[property="og:locale"]', { property: 'og:locale', content: ogLocale });
    meta('meta[name="twitter:title"]', { name: 'twitter:title', content: titulo });
    meta('meta[name="twitter:description"]', { name: 'twitter:description', content: finalDescription });

    let canonica = document.head.querySelector('link[rel="canonical"]');
    if (!canonica) {
      canonica = document.createElement('link');
      canonica.rel = 'canonical';
      document.head.appendChild(canonica);
    }
    canonica.href = url;
    setAlternates(alternates);
    setJsonLd(noindex ? null : jsonLd);
  }, [title, finalDescription, resolvedPath, noindex, jsonLd]);
}

// La marca (Organization y WebSite) va fija en index.html: lixbon.com/ redirige
// al chat y no tiene portada propia, así que la lleva cada página.
