// Collapse.jsx — despliega y pliega un panel (con su gutter) animando el
// ancho o el alto. El contenido se queda montado y con su tamaño final para
// que no se reacomode mientras se anima; solo se recorta.
export function Collapse({ open, size, axis = 'x', from = 'start', children }) {
  const style = axis === 'x' ? { width: open ? size : 0 } : { height: open ? size : 0 };
  const inner = axis === 'x' ? { width: size } : { height: size };
  return (
    <div
      className={`collapse collapse--${axis} collapse--from-${from} ${open ? 'is-open' : ''}`}
      style={style}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="collapse__inner" style={inner}>{children}</div>
    </div>
  );
}
