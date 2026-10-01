// Panel.jsx — contenedor de sección del workbench. El que tiene el foco sube
// un peldaño de relleno y 2px; los demás quedan planos debajo.
import { useWorkbenchStore } from '../store/workbenchStore';

export function Panel({ id, className = '', style, children, as: Tag = 'section' }) {
  const focused = useWorkbenchStore((s) => s.focus === id);
  const setFocus = useWorkbenchStore((s) => s.setFocus);
  return (
    <Tag
      className={`wbpanel ${focused ? 'is-focused' : ''} ${className}`}
      style={style}
      onPointerDownCapture={() => setFocus(id)}
    >
      {children}
    </Tag>
  );
}
