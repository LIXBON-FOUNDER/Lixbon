// Popover.jsx — menú anclado a un elemento, montado en <body> para que ningún
// panel con overflow:hidden lo recorte. Se cierra con clic fuera o Escape.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredAbove } from '../lib/useAnchoredPopover';

export function Popover({ anchorRef, open, onClose, align = 'left', below = true, className = '', children }) {
  const popRef = useRef(null);
  const pos = useAnchoredAbove(anchorRef, open, { align, below, gap: 6 });

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
    <div ref={popRef} className={`pop ${className}`} style={pos}>{children}</div>,
    document.body,
  );
}
