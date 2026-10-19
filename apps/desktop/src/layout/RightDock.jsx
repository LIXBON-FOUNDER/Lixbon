// RightDock.jsx — el panel derecho de cada modo (el agente; en Agente, los
// cambios). Con la ventana ancha va fijo y se pliega con Collapse. Por debajo
// de 1100 px solo cabe un panel fijo —el izquierdo—: el derecho sale como
// cajón sobre el centro, con el botón de la barra superior o Ctrl Alt B, y
// se cierra con Esc o pulsando fuera.
import { useEffect } from 'react';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useIsCompact } from '../lib/frameSize';
import { Collapse, GAP } from './Collapse';
import { Gutter } from './Gutter';
import { Panel } from './Panel';

export function RightDock({ open, id = 'agent', sizeKey = 'agent', className = '', children }) {
  const compact = useIsCompact();
  const size = useWorkbenchStore((s) => s.sizes[sizeKey]);
  const drawer = useWorkbenchStore((s) => s.drawer);
  const closeDrawer = useWorkbenchStore((s) => s.closeDrawer);

  useEffect(() => {
    if (!compact || !drawer) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal__overlay, .confirm__overlay')) closeDrawer(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact, drawer, closeDrawer]);

  if (compact) {
    if (!drawer) return null;
    return (
      <div className="drawer" onPointerDown={(e) => { if (e.target === e.currentTarget) closeDrawer(); }}>
        <Panel id={id} className={`drawer__panel ${className}`} style={{ width: Math.min(size, 440) }}>{children}</Panel>
      </div>
    );
  }

  return (
    <Collapse open={open} size={size + GAP} from="end">
      <Gutter sizeKey={sizeKey} invert />
      <Panel id={id} className={className}>{children}</Panel>
    </Collapse>
  );
}
