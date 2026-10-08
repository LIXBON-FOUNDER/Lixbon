import { useCallback, useEffect, useRef, useState } from 'react';

export function useCierreAnimado(onClose, { ms = 200, bloqueado = false } = {}) {
  const [cerrando, setCerrando] = useState(false);
  const temporizador = useRef(null);

  useEffect(() => () => window.clearTimeout(temporizador.current), []);

  const cerrar = useCallback(() => {
    if (temporizador.current) return;
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
