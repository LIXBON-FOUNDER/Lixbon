// useAnchoredPopover.js — posición fija (viewport) de un popover anclado a un
// elemento, creciendo hacia arriba desde su borde superior. Para usar junto a
// un createPortal(document.body): igual que Select.jsx, cualquier ancestro
// con overflow:hidden (el sidebar/chat redondeados, que lo necesitan para la
// animación de plegado) recorta un popover normal — el portal lo evita.
import { useLayoutEffect, useState } from 'react';

export function useAnchoredAbove(anchorRef, open, { gap = 8, align = 'left', matchWidth = false } = {}) {
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) { setPos(null); return undefined; }
    const compute = () => {
      const r = anchorRef.current.getBoundingClientRect();
      setPos({
        bottom: window.innerHeight - r.top + gap,
        ...(align === 'right' ? { right: window.innerWidth - r.right } : { left: r.left }),
        ...(matchWidth ? { width: r.width } : {}),
      });
    };
    compute();
    // Si la ventana cambia de tamaño la posición fija deja de valer.
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [open, anchorRef, gap, align, matchWidth]);

  return pos;
}
