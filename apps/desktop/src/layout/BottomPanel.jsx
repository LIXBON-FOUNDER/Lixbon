// BottomPanel.jsx — dock inferior con la Terminal. Ya no es un panel de
// primer nivel: se abre bajo demanda (Ctrl+`) desde un icono discreto del
// riel. Se mantiene SIEMPRE montado (oculto con display:none desde AppShell)
// para no matar las sesiones de PTY al plegarlo.
import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { TerminalPanel } from '../editor/TerminalPanel';
import { IconX } from '../components/Icons';

const MIN_H = 120;
const MAX_H = 640;

export function BottomPanel() {
  const { panelHeights, setPanelHeight, toggleTerminal } = useAppStore();
  const frame = useRef(null);

  const startDrag = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = panelHeights.terminal || 240;
    const onMove = (ev) => {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        setPanelHeight('terminal', Math.min(MAX_H, Math.max(MIN_H, startH + (startY - ev.clientY))));
      });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="dock" style={{ height: panelHeights.terminal || 240 }}>
      <div className="dock__resizer" onPointerDown={startDrag} />

      <div className="dock__head">
        <span className="dock__title">Terminal</span>
        <button className="icon-btn" onClick={toggleTerminal} title="Ocultar terminal (Ctrl+`)">
          <IconX size={15} />
        </button>
      </div>

      <div className="dock__body">
        <TerminalPanel />
      </div>
    </div>
  );
}
