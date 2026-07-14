// BottomPanel.jsx — dock inferior del IDE, con pestañas (como el de VSCode).
// Aloja el Terminal y los Problemas del linter: son salidas de herramientas, no
// documentos, así que no deben robarle el sitio al editor.
//
// Las dos vistas se mantienen MONTADAS (se ocultan con display:none) para no
// matar las sesiones de PTY al cambiar de pestaña.
import { useRef } from 'react';
import { useAppStore } from '../store/appStore';
import { useProblemsStore } from '../store/problemsStore';
import { TerminalPanel } from '../editor/TerminalPanel';
import { ProblemsPanel } from '../sections/Problems/ProblemsPanel';
import { IconX } from '../components/Icons';

const MIN_H = 120;
const MAX_H = 640;

const TABS = [
  { id: 'problems', label: 'Problemas' },
  { id: 'terminal', label: 'Terminal' },
];

export function BottomPanel() {
  const { bottomView, showBottomPanel, panelHeights, setPanelHeight, togglePanel } = useAppStore();
  const diagnostics = useProblemsStore((s) => s.diagnostics);
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
        <div className="dock__tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`dock__tab ${bottomView === t.id ? 'is-active' : ''}`}
              onClick={() => showBottomPanel(t.id)}
            >
              {t.label}
              {t.id === 'problems' && diagnostics.length > 0 && (
                <span className="dock__badge">{diagnostics.length}</span>
              )}
            </button>
          ))}
        </div>

        <button
          className="icon-btn"
          onClick={() => togglePanel('terminal')}
          title="Ocultar panel (Ctrl+`)"
        >
          <IconX size={15} />
        </button>
      </div>

      <div className="dock__body">
        <div className="dock__view" style={{ display: bottomView === 'problems' ? 'flex' : 'none' }}>
          <ProblemsPanel />
        </div>
        <div className="dock__view" style={{ display: bottomView === 'terminal' ? 'flex' : 'none' }}>
          <TerminalPanel />
        </div>
      </div>
    </div>
  );
}
