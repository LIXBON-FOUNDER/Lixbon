// Usar estos en vez de los de react-router-dom (salvo /admin, sin traducir).
import { forwardRef, useCallback, useEffect } from 'react';
import { flushSync } from 'react-dom';
import {
  Link as RouterLink,
  Navigate as RouterNavigate,
  useLocation,
  useNavigate as useRouterNavigate,
} from 'react-router-dom';
import { useLocale } from './LocaleContext';
import { stripLocale, withLocale } from './paths';
import { esRutaFounder, urlFounder } from '../lib/founder';

function localizeTo(to, locale) {
  if (typeof to === 'string') return withLocale(to, locale);
  if (to && typeof to === 'object') return { ...to, pathname: withLocale(to.pathname, locale) };
  return to;
}

// Sección = primer tramo de la ruta sin idioma (/c/:id cuenta como el chat).
function seccionDe(ruta) {
  const primero = stripLocale(String(ruta || '').split(/[?#]/)[0]).split('/').filter(Boolean)[0] || '';
  return primero === 'c' ? 'chat' : primero || 'chat';
}

// RouteFade no repite su fundido cuando ya lo hizo la View Transition.
export const transicion = { activa: false };

// Al cambiar de sección (chat → Visuals, Ajustes, admin…) la navegación va
// dentro de una View Transition: el navegador funde la página vieja con la
// nueva. Dentro de la misma sección, o sin soporte, se navega sin más.
export function conTransicion(desde, hacia, navegar) {
  const cambia = typeof hacia === 'string' && seccionDe(desde) !== seccionDe(hacia);
  const quieto = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!cambia || quieto || typeof document === 'undefined' || !document.startViewTransition) {
    navegar();
    return;
  }
  // La transición espera a pintar un fotograma para capturar la página vieja;
  // si la pestaña no pinta (en segundo plano), se navega sin ella.
  let hecho = false;
  const ir = () => {
    if (hecho) return;
    hecho = true;
    flushSync(navegar);
  };
  transicion.activa = true;
  const vt = document.startViewTransition(ir);
  vt.finished.catch(() => {}).finally(() => { transicion.activa = false; });
  setTimeout(() => {
    if (hecho) return;
    vt.skipTransition();
    ir();
  }, 400);
}

export const Link = forwardRef(function Link({ to, onClick, replace, state, target, ...props }, ref) {
  const locale = useLocale();
  const { pathname } = useLocation();
  const navigate = useRouterNavigate();
  if (esRutaFounder(to)) return <a ref={ref} href={urlFounder(to, locale)} target={target} onClick={onClick} {...props} />;
  const destino = localizeTo(to, locale);
  const alPulsar = (e) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || target) return;
    if (typeof destino !== 'string') return;
    e.preventDefault();
    conTransicion(pathname, destino, () => navigate(destino, { replace, state }));
  };
  return <RouterLink ref={ref} to={destino} replace={replace} state={state} target={target} onClick={alPulsar} {...props} />;
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
  return useCallback((to, options) => {
    if (typeof to === 'number') return navigate(to);
    const destino = localizeTo(to, locale);
    return conTransicion(window.location.pathname, destino, () => navigate(destino, options));
  }, [navigate, locale]);
}
