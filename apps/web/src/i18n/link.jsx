// Usar estos en vez de los de react-router-dom (salvo /admin, sin traducir).
import { forwardRef, useCallback, useEffect } from 'react';
import {
  Link as RouterLink,
  Navigate as RouterNavigate,
  useLocation,
  useNavigate as useRouterNavigate,
} from 'react-router-dom';
import { useLocale } from './LocaleContext';
import { withLocale } from './paths';
import { esRutaFounder, urlFounder } from '../lib/founder';

function localizeTo(to, locale) {
  if (typeof to === 'string') return withLocale(to, locale);
  if (to && typeof to === 'object') return { ...to, pathname: withLocale(to.pathname, locale) };
  return to;
}

export const Link = forwardRef(function Link({ to, ...props }, ref) {
  const locale = useLocale();
  if (esRutaFounder(to)) return <a ref={ref} href={urlFounder(to, locale)} {...props} />;
  return <RouterLink ref={ref} to={localizeTo(to, locale)} {...props} />;
});

// Para rutas que se mudaron a founder.lixbon.com y llegan por navegación interna.
export function IrAFounder() {
  const { pathname, search, hash } = useLocation();
  useEffect(() => { window.location.replace(`${urlFounder(pathname)}${search}${hash}`); }, [pathname, search, hash]);
  return null;
}

export function Navigate({ to, ...props }) {
  const locale = useLocale();
  return <RouterNavigate to={localizeTo(to, locale)} {...props} />;
}

export function useNavigate() {
  const locale = useLocale();
  const navigate = useRouterNavigate();
  // Estable a propósito: varios efectos (ChatPage) la ponen en sus dependencias y
  // una función nueva en cada render provocaba un bucle infinito.
  return useCallback(
    (to, options) => (typeof to === 'number' ? navigate(to) : navigate(localizeTo(to, locale), options)),
    [navigate, locale],
  );
}
