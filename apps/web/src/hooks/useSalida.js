import { useEffect, useState } from 'react';

/** Mantiene montado un elemento unos ms tras cerrarlo para animar la salida. */
export function useSalida(abierto, ms = 150) {
  const [montado, setMontado] = useState(abierto);
  useEffect(() => {
    if (abierto) { setMontado(true); return undefined; }
    const t = setTimeout(() => setMontado(false), ms);
    return () => clearTimeout(t);
  }, [abierto, ms]);
  return { montado: abierto || montado, cerrando: !abierto && montado };
}
