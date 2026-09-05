// useCierreAnimado.js — deja que un diálogo termine su animación de salida
// antes de desaparecer del árbol.
//
// Los modales ya entraban con un pop, pero al cerrarlos se esfumaban en el
// mismo fotograma en que el padre ponía su estado a false. Este hook retrasa
// ese desmontaje lo que dura la animación: el componente se marca como
// `is-closing` (motion.css la anima) y solo después avisa al padre.
import { useCallback, useEffect, useRef, useState } from 'react';

export function useCierreAnimado(onClose, { ms = 200, bloqueado = false } = {}) {
  const [cerrando, setCerrando] = useState(false);
  const temporizador = useRef(null);

  // Si el padre desmonta el diálogo por su cuenta (una navegación, un cambio de
  // sesión), el temporizador pendiente no debe seguir vivo.
  useEffect(() => () => window.clearTimeout(temporizador.current), []);

  const cerrar = useCallback(() => {
    if (temporizador.current) return; // ya se está cerrando: un segundo clic no reinicia nada
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onClose();
      return;
    }
    setCerrando(true);
    temporizador.current = window.setTimeout(onClose, ms);
  }, [onClose, ms]);

  useEffect(() => {
    if (bloqueado) return undefined;
    const alPulsar = (ev) => { if (ev.key === 'Escape') cerrar(); };
    window.addEventListener('keydown', alPulsar);
    return () => window.removeEventListener('keydown', alPulsar);
  }, [cerrar, bloqueado]);

  return { cerrando, cerrar };
}
