// useAdeQuery.js — consulta al AdeClient con estados cargando / listo / error.
//
// Se vuelve a ejecutar cuando el cliente avisa de un cambio (`subscribe`) o cambian las dependencias.
// Mientras recarga conserva los datos anteriores (no parpadea); al cambiar de dependencias, no: pasaría
// por datos de otra entidad.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAde } from './AdeProvider';

export function useAdeQuery(fn, deps = []) {
  const { client, version } = useAde();
  const [estado, setEstado] = useState({ status: 'loading', data: null, error: null });
  const [manual, setManual] = useState(0);
  const peticion = useRef(0);
  const clave = useRef(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const claveActual = JSON.stringify(deps);

  useEffect(() => {
    const id = ++peticion.current;
    const cambioDeEntidad = clave.current !== claveActual;
    clave.current = claveActual;
    if (cambioDeEntidad) setEstado({ status: 'loading', data: null, error: null });
    Promise.resolve()
      .then(() => fnRef.current(client))
      .then(
        (data) => id === peticion.current && setEstado({ status: 'ready', data, error: null }),
        (error) => id === peticion.current && setEstado((s) => ({ status: 'error', data: cambioDeEntidad ? null : s.data, error })),
      );
  }, [client, version, manual, claveActual]);

  const reload = useCallback(() => {
    setEstado((s) => ({ status: 'loading', data: s.data, error: null }));
    setManual((n) => n + 1);
  }, []);
  return { ...estado, reload };
}
