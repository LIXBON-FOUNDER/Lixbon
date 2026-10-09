const PREFIJO = '/es';

function tienePrefijo(pathname, prefijo) {
  return pathname === prefijo || pathname.startsWith(`${prefijo}/`);
}

export function localeDePath(pathname) {
  return tienePrefijo(pathname, PREFIJO) ? 'es' : 'en';
}

export function withLocale(pathname, locale) {
  if (locale !== 'es' || typeof pathname !== 'string') return pathname;
  if (!pathname.startsWith('/') || tienePrefijo(pathname, PREFIJO)) return pathname;
  return pathname === '/' ? PREFIJO : `${PREFIJO}${pathname}`;
}

export function stripLocale(pathname) {
  return tienePrefijo(pathname, PREFIJO) ? pathname.slice(PREFIJO.length) || '/' : pathname;
}

export function otherLocalePath(pathname) {
  return localeDePath(pathname) === 'es' ? stripLocale(pathname) : withLocale(pathname, 'es');
}

// Antes el español iba sin prefijo y el inglés bajo /en.
export function sinPrefijoLegacyEn(pathname) {
  return tienePrefijo(pathname, '/en') ? pathname.slice(3) || '/' : null;
}

const CLAVE_IDIOMA = 'lixbon-idioma';

export function idiomaGuardado() {
  try { return localStorage.getItem(CLAVE_IDIOMA); } catch { return null; }
}

export function guardarIdioma(locale) {
  try { localStorage.setItem(CLAVE_IDIOMA, locale); } catch { /* sin almacenamiento */ }
}

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
