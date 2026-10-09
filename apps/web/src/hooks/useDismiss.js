// En táctil no existe `mouseleave`: sin esto los menús quedaban abiertos.
import { useEffect } from 'react';

export function useDismiss(open, ref, onClose) {
  useEffect(() => {
    if (!open) return undefined;

    // `ref` envuelve al disparador y al menú: pulsar el disparador solo cierra
    // por su propio onClick, no dos veces.
    const onPointerDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, ref, onClose]);
}
