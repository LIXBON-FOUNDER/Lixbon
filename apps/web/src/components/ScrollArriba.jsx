// Atrás/adelante (POP) lo deja al navegador, que restaura la posición.
import { useLayoutEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

export function ScrollArriba() {
  const { pathname, hash } = useLocation();
  const tipo = useNavigationType();

  useLayoutEffect(() => {
    if (tipo === 'POP') return;
    const destino = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
    if (destino) destino.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [pathname, hash, tipo]);

  return null;
}
