// No remonta (un `key={pathname}` tiraría el estado del chat): solo reinicia la
// animación al cambiar de sección o de idioma.
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useLocale } from '../i18n/LocaleContext';
import { transicion } from '../i18n/link';

function seccionDe(pathname) {
  const partes = pathname.split('/').filter(Boolean);
  if (partes[0] === 'es') partes.shift();
  const primero = partes[0] || '';
  return primero === 'c' ? '' : primero;
}

export function RouteFade({ children }) {
  const { pathname } = useLocation();
  const locale = useLocale();
  const clave = `${locale}:${seccionDe(pathname)}`;
  const caja = useRef(null);
  const anterior = useRef(clave);

  useEffect(() => {
    if (anterior.current === clave) return;
    anterior.current = clave;
    // La View Transition ya fundió una página con otra: repetirlo parpadea.
    if (transicion.activa) return;
    const el = caja.current;
    if (!el) return;
    el.classList.remove('is-entering');
    void el.offsetWidth; // fuerza el reflow: sin esto la clase se re-añade en el mismo fotograma y la animación no se reinicia
    el.classList.add('is-entering');
  }, [clave]);

  return (
    <div className="route-fade" ref={caja}>
      {children}
    </div>
  );
}
