// RouteFade.jsx — el fundido entre una página y la siguiente.
//
// Antes, navegar era un corte seco: React desmontaba una pantalla y pintaba la
// otra en el mismo fotograma. Esto reinicia una animación de entrada cada vez
// que cambia la SECCIÓN, no la URL: dentro del chat se pasa de /c/a a /c/b sin
// parpadeo, porque es la misma pantalla con otra conversación. También se
// reinicia al cambiar de idioma (aunque la sección sea la misma), para que
// pasar a /en no se sienta como un salto seco.
//
// No remonta a nadie (nada de `key={pathname}`, que tiraría el estado del chat
// y volvería a pedir la conversación al servidor): solo reinicia una clase.
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useLocale } from '../i18n/LocaleContext';

/** La sección a la que pertenece una ruta. El chat y una conversación concreta
 *  son la misma; /planes y /docs son distintas. */
function seccionDe(pathname) {
  const partes = pathname.split('/').filter(Boolean);
  if (partes[0] === 'en') partes.shift();
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
