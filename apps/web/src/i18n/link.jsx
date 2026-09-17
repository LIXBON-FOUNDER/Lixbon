// link.jsx — Link/Navigate/useNavigate conscientes del idioma: anteponen /en
// a las rutas internas cuando el idioma activo es inglés. Los componentes de
// la app deben importar estos en vez de los de react-router-dom directamente
// (excepto para /admin, que no está traducido).
import { forwardRef } from 'react';
import {
  Link as RouterLink,
  Navigate as RouterNavigate,
  useNavigate as useRouterNavigate,
} from 'react-router-dom';
import { useLocale } from './LocaleContext';
import { withLocale } from './paths';

function localizeTo(to, locale) {
  if (typeof to === 'string') return withLocale(to, locale);
  if (to && typeof to === 'object') return { ...to, pathname: withLocale(to.pathname, locale) };
  return to;
}

export const Link = forwardRef(function Link({ to, ...props }, ref) {
  const locale = useLocale();
  return <RouterLink ref={ref} to={localizeTo(to, locale)} {...props} />;
});

export function Navigate({ to, ...props }) {
  const locale = useLocale();
  return <RouterNavigate to={localizeTo(to, locale)} {...props} />;
}

export function useNavigate() {
  const locale = useLocale();
  const navigate = useRouterNavigate();
  return (to, options) => (typeof to === 'number' ? navigate(to) : navigate(localizeTo(to, locale), options));
}
