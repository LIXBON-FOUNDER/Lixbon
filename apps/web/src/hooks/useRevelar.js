// useRevelar.js — entradas al hacer scroll en la web pública. Marca el
// contenedor con `.revelar-listo` y añade `.is-visible` a cada [data-revelar]
// de dentro la primera vez que entra en la ventana. Sin JavaScript (o en el
// HTML prerenderizado) no se oculta nada: el estado inicial lo pone la clase
// del contenedor, no el marcado.
import { useEffect, useRef } from 'react';

export function useRevelar() {
  const ref = useRef(null);
  useEffect(() => {
    const raiz = ref.current;
    if (!raiz) return undefined;
    const nodos = [...raiz.querySelectorAll('[data-revelar]')];
    if (raiz.hasAttribute('data-revelar')) nodos.push(raiz);
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      nodos.forEach((n) => n.classList.add('is-visible'));
      return undefined;
    }
    raiz.classList.add('revelar-listo');
    const io = new IntersectionObserver((entradas) => {
      entradas.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('is-visible');
        io.unobserve(e.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    nodos.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);
  return ref;
}
