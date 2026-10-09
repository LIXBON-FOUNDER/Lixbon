import { lazy, useState } from 'react';

const cargados = new Map();

// Como React.lazy, pero si el módulo ya se cargó (precarga antes de montar, o
// en el prerender) pinta directamente sin pasar por Suspense: así el HTML
// prerenderizado no se sustituye por un hueco ni renderToString se queda en
// el fallback. La elección se fija al montar para no remontar la página.
export function perezosa(importar, nombre = 'default') {
  const cargar = () => importar().then((m) => { cargados.set(importar, m); return m[nombre]; });
  const Diferida = lazy(() => cargar().then((C) => ({ default: C })));
  function Pagina(props) {
    const [Directa] = useState(() => cargados.get(importar)?.[nombre]);
    return Directa ? <Directa {...props} /> : <Diferida {...props} />;
  }
  Pagina.cargar = cargar;
  return Pagina;
}
