// SidePanel.jsx — panel lateral colapsable y redimensionable (explorador / chat).
import { useRef, useState } from 'react';

const MIN_W = 200;
const MAX_W = 520;

export function SidePanel({ side = 'left', width, onWidthChange, title, actions, children }) {
  const [dragging, setDragging] = useState(false);
  const frame = useRef(null);

  const startDrag = (e) => {
    e.preventDefault();
    setDragging(true);
    const startX = e.clientX;
    const startW = width;

    const onMove = (ev) => {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX;
        onWidthChange(Math.min(MAX_W, Math.max(MIN_W, startW + delta)));
      });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <aside className={`sidepanel sidepanel--${side}`} style={{ width }}>
      {title !== undefined && (
        <div className="sidepanel__header">
          <span>{title}</span>
          {actions && <div className="sidepanel__header-actions">{actions}</div>}
        </div>
      )}
      <div className="sidepanel__content">{children}</div>
      <div
        className={`sidepanel__resizer ${dragging ? 'is-dragging' : ''}`}
        onPointerDown={startDrag}
      />
    </aside>
  );
}
