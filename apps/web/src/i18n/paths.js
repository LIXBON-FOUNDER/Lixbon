// paths.js — prefijo /en de las rutas y mapas de slugs viejos (español) a los
// nuevos slugs en inglés, para redirigir enlaces e índices antiguos.
export function withLocale(pathname, locale) {
  if (locale !== 'en' || typeof pathname !== 'string') return pathname;
  if (!pathname.startsWith('/') || pathname === '/en' || pathname.startsWith('/en/')) return pathname;
  return pathname === '/' ? '/en' : `/en${pathname}`;
}

export function otherLocalePath(pathname) {
  if (pathname === '/en' || pathname.startsWith('/en/')) {
    return pathname.slice(3) || '/';
  }
  return pathname === '/' ? '/en' : `/en${pathname}`;
}

// id viejo (antes del rename a slugs en inglés) -> id nuevo
export const LEGACY_DOC_IDS = {
  introduccion: 'introduction',
  'primeros-pasos': 'getting-started',
  'usar-api-key': 'using-your-api-key',
  'precios-api': 'api-pricing',
  planes: 'plans',
  facturacion: 'billing',
  privacidad: 'privacy',
};

export const LEGACY_GUIDE_IDS = {
  'api-compatible-openai-espanol': 'openai-compatible-api',
  'usar-qwen-3-5-desde-python': 'qwen-3-5-python',
  'agente-de-codigo-en-la-terminal': 'cli-agent-mode',
  'ia-con-datos-privados-gpus-propias': 'private-data-own-gpus',
};

// AccountPage.jsx: pestaña de /account/:section (no se prerenderiza, no necesita
// entrada en rutasPublicas.js, pero sí redirección para enlaces/marcadores viejos).
export const LEGACY_ACCOUNT_SECTIONS = {
  cuenta: 'profile',
  privacidad: 'privacy',
  facturacion: 'billing',
  uso: 'usage',
};

export const LEGACY_LEGAL_IDS = {
  privacidad: 'privacy',
  terminos: 'terms',
  reembolsos: 'refunds',
};
