// Popover.jsx — menú anclado a un elemento, montado en <body> para que ningún
// panel con overflow:hidden lo recorte. Se cierra con clic fuera o Escape.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredAbove } from '../lib/useAnchoredPopover';

export function Popover({ anchorRef, open, onClose, align = 'left', below = true, className = '', children }) {
  const popRef = useRef(null);
  const pos = useAnchoredAbove(anchorRef, open, { align, below, gap: 6 });
  const [fit, setFit] = useState(null);

  // Que nunca se salga de la ventana: si el menú queda cortado por la izquierda
  // o la derecha se desplaza lo justo, y si no cabe a lo alto se limita su
  // altura (el menú ya hace scroll). `translate` es independiente del
  // `transform` de la animación de entrada.
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!open || !pos || !el) { setFit(null); return; }
    const PAD = 8;
    const r = el.getBoundingClientRect();
    let dx = 0;
    if (r.left < PAD) dx = PAD - r.left;
    else if (r.right > window.innerWidth - PAD) dx = window.innerWidth - PAD - r.right;
    const room = below ? window.innerHeight - r.top - PAD : r.bottom - PAD;
    setFit({ dx, room: Math.max(160, Math.floor(room)) });
  }, [open, pos, below, children]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (anchorRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={popRef}
      className={`pop ${className}`}
      style={{ ...pos, ...(fit ? { translate: fit.dx ? `${fit.dx}px 0` : undefined, '--pop-max': `${fit.room}px` } : {}) }}
    >
      {children}
    </div>,
    document.body,
  );
}
