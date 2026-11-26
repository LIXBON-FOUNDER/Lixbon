import { StatusIcon } from '@lixbon/icons/status';
// ActivityRail.jsx — riel de iconos del modo Editor.
import { useWorkbenchStore } from '../store/workbenchStore';
import { useGitStore } from '../store/gitStore';
import { IconFolder, IconSearch, IconGitBranch, IconExtensions } from '../components/Icons';
import { Icono } from '@lixbon/icons';

const ITEMS = [
  { view: 'files', label: 'Explorador', kbd: 'Ctrl Shift E', Icon: IconFolder },
  { view: 'search', label: 'Buscar en archivos', kbd: 'Ctrl Shift F', Icon: IconSearch },
  { view: 'extensions', label: 'Integraciones', kbd: 'Ctrl Shift X', Icon: IconExtensions },
];

export function ActivityRail() {
  const { mode, sideOpen, sideView, showSide, toggleSide, setMode } = useWorkbenchStore();
  const changes = useGitStore((s) => s.changes.length);

  const pick = (view) => (mode === 'editor' && sideOpen && sideView === view ? toggleSide() : showSide(view));

  return (
    <nav className="rail" aria-label="Vistas">
      {ITEMS.slice(0, 2).map(({ view, label, kbd, Icon }) => (
        <button key={view} className={`rail__btn ${mode === 'editor' && sideOpen && sideView === view ? 'is-active' : ''}`} onClick={() => pick(view)} aria-label={label} title={`${label} · ${kbd}`} data-tip={`${label} · ${kbd}`}>
          <Icon size={16} />
        </button>
      ))}
      <button className={`rail__btn ${mode === 'git' ? 'is-active' : ''}`} onClick={() => setMode('git')} aria-label="Cambios" title="Cambios · Ctrl Shift G" data-tip="Cambios · Ctrl Shift G">
        <IconGitBranch size={16} />
        {changes > 0 && <span className="rail__badge" />}
      </button>
      <button className={`rail__btn ${mode === 'agent' ? 'is-active' : ''}`} aria-label="Agentes" title="Agentes · Ctrl 1" data-tip="Agentes · Ctrl 1" onClick={() => setMode('agent')}><StatusIcon kind="agent" size={16} /></button>
      {ITEMS.slice(2).map(({ view, label, kbd, Icon }) => (
        <button key={view} className={`rail__btn ${mode === 'editor' && sideOpen && sideView === view ? 'is-active' : ''}`} onClick={() => pick(view)} aria-label={label} title={`${label} · ${kbd}`} data-tip={`${label} · ${kbd}`}>
          <Icon size={16} />
        </button>
      ))}
      <button type="button" className="rail__btn rail__settings" aria-label="Ajustes" title="Ajustes" onClick={() => useWorkbenchStore.getState().openSettings()}><Icono nombre="ajustes" size={16} /></button>
    </nav>
  );
}
