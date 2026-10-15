// La web pública (portada, empresa, novedades, soporte, legal y donativos) vive
// en founder.lixbon.com, en su propio repo. El gateway redirige estas rutas con
// un 301; aquí los enlaces salen directos para no pasar por la redirección.
import { stripLocale, withLocale } from '../i18n/paths';

export const FOUNDER_URL = 'https://founder.lixbon.com';

const RUTAS_FOUNDER = ['/about', '/team', '/company', '/news', '/support', '/legal', '/donate'];

export function esRutaFounder(to) {
  if (typeof to !== 'string' || !to.startsWith('/')) return false;
  const ruta = stripLocale(to.split(/[?#]/)[0]);
  return RUTAS_FOUNDER.some((r) => ruta === r || ruta.startsWith(`${r}/`));
}

export const urlFounder = (to = '/', locale = 'en') => `${FOUNDER_URL}${withLocale(to, locale)}`;
