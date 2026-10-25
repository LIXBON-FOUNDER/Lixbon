// layout.jsx — utilidades del showcase (no forman parte de las superficies).
import { useLayoutEffect, useRef, useState } from 'react';

/** Renderiza una superficie a su tamaño de diseño (w×h) y la escala para caber en el contenedor. */
export function Scaled({ w, h, children, max = 1 }) {
  const ref = useRef(null);
  const [k, setK] = useState(0.4);
  useLayoutEffect(() => {
    const el = ref.current;
    const calc = () => { const r = el.getBoundingClientRect(); if (r.width && r.height) setK(Math.max(0.1, Math.min(max, r.width / w, r.height / h))); };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [w, h, max]);
  return (
    <div ref={ref} className="scaled">
      <div className="scaled__box" style={{ width: w * k, height: h * k }}>
        <div style={{ width: w, height: h, transform: `scale(${k})`, transformOrigin: 'top left' }}>{children}</div>
      </div>
    </div>
  );
}
