// Gutter.jsx — el hueco de 6px entre paneles es también su tirador de tamaño.
// `dir="x"` redimensiona anchos, `dir="y"` altos; `invert` para paneles que
// crecen hacia la izquierda o hacia arriba (agente, terminal).
import { useRef } from 'react';
import { useWorkbenchStore } from '../store/workbenchStore';

export function Gutter({ dir = 'x', sizeKey, invert = false, onDoubleClick }) {
  const frame = useRef(0);

  const start = (e) => {
    e.preventDefault();
    const { sizes, setSize, persistSizes } = useWorkbenchStore.getState();
    const origin = dir === 'x' ? e.clientX : e.clientY;
    const initial = sizes[sizeKey];
    document.body.classList.add(dir === 'x' ? 'is-resizing-x' : 'is-resizing-y');

    const move = (ev) => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const delta = (dir === 'x' ? ev.clientX : ev.clientY) - origin;
        setSize(sizeKey, initial + (invert ? -delta : delta));
      });
    };
    const up = () => {
      document.body.classList.remove('is-resizing-x', 'is-resizing-y');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      persistSizes();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      className={`gutter gutter--${dir}`}
      onPointerDown={start}
      onDoubleClick={onDoubleClick}
      role="separator"
      aria-orientation={dir === 'x' ? 'vertical' : 'horizontal'}
    />
  );
}
