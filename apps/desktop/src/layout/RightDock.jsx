// RightDock.jsx — el panel derecho de cada modo (el agente; en Agente, los
// cambios). Con la ventana ancha va fijo y se pliega con Collapse. Por debajo
// de 1100 px solo cabe un panel fijo —el izquierdo—: el derecho sale como
// cajón sobre el centro, con el botón de la barra superior o Ctrl Alt B, y
// se cierra con Esc o pulsando fuera.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useIsCompact } from '../lib/frameSize';
import { Collapse, GAP } from './Collapse';
import { Gutter } from './Gutter';
import { Panel } from './Panel';

export function RightDock({ open, id = 'agent', sizeKey = 'agent', className = '', visible = true, keepMountedWhenHidden = false, drawerOpen, onCloseDrawer, children }) {
  const compact = useIsCompact();
  const panelWasMounted = useRef(false);
  const size = useWorkbenchStore((s) => s.sizes[sizeKey]);
  const storedDrawer = useWorkbenchStore((s) => s.drawer);
  const storedCloseDrawer = useWorkbenchStore((s) => s.closeDrawer);
  const drawer = drawerOpen ?? storedDrawer;
  const dismissDrawer = onCloseDrawer ?? storedCloseDrawer;

  useLayoutEffect(() => {
    if (!compact || (visible && drawer)) panelWasMounted.current = true;
  }, [compact, visible, drawer]);

  useEffect(() => {
    if (!compact || !drawer || !visible) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal__overlay, .confirm__overlay')) dismissDrawer(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [compact, drawer, visible, dismissDrawer]);

  if (compact) {
    const panel = <Panel id={id} className={`drawer__panel ${className}`} style={{ width: Math.min(size, 440) }}>{children}</Panel>;
    if (!visible || !drawer) {
      if (!keepMountedWhenHidden || !panelWasMounted.current) return null;
      return <div className="rightdock__retained" aria-hidden="true" inert>{panel}</div>;
    }
    return (
      <div className="drawer" onPointerDown={(e) => { if (e.target === e.currentTarget) dismissDrawer(); }}>
        {panel}
      </div>
    );
  }

  return (
    <Collapse open={open && (visible || keepMountedWhenHidden)} size={size + GAP} from="end">
      <Gutter sizeKey={sizeKey} invert />
      <Panel id={id} className={className}>{children}</Panel>
    </Collapse>
  );
}
