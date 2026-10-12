// useNow.js — reloj de la interfaz. Usa el `now` del AdeProvider (inyectable en pruebas) y se refresca
// cada `ms` para que «hace 5 min» y las cuentas atrás sigan vivas.
import { useEffect, useState } from 'react';
import { useAde } from './AdeProvider';

export function useNow(ms = 30000) {
  const { now } = useAde();
  const [t, setT] = useState(() => now());
  useEffect(() => {
    setT(now());
    const id = setInterval(() => setT(now()), ms);
    return () => clearInterval(id);
  }, [now, ms]);
  return t;
}
