import { useEffect, useState } from 'react';

export function useSalida(abierto, ms = 150) {
  const [montado, setMontado] = useState(abierto);
  useEffect(() => {
    if (abierto) { setMontado(true); return undefined; }
    const t = setTimeout(() => setMontado(false), ms);
    return () => clearTimeout(t);
  }, [abierto, ms]);
  return { montado: abierto || montado, cerrando: !abierto && montado };
}
