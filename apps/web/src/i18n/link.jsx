// link.jsx — Link/Navigate/useNavigate conscientes del idioma: anteponen /en
// a las rutas internas cuando el idioma activo es inglés. Los componentes de
// la app deben importar estos en vez de los de react-router-dom directamente
// (excepto para /admin, que no está traducido).
import { forwardRef, useCallback } from 'react';
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
  // Estable a propósito: react-router-dom garantiza que su useNavigate() no
  // cambia de identidad entre renders, y varios efectos de la app (ver
  // ChatPage.jsx) meten esta función en su array de dependencias. Devolver
  // una arrow function nueva en cada render rompía esa garantía y disparaba
  // un bucle infinito (el efecto se re-ejecutaba en cada render, llamaba a
  // setState con un array/objeto nuevo, eso volvía a renderizar, etc.) que
  // dejaba a React sin oportunidad de pintar la ruta real tras navegar.
  return useCallback(
    (to, options) => (typeof to === 'number' ? navigate(to) : navigate(localizeTo(to, locale), options)),
    [navigate, locale],
  );
}
