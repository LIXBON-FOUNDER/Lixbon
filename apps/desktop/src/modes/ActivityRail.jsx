// ActivityRail.jsx — riel de iconos del modo Editor.
import { useWorkbenchStore } from '../store/workbenchStore';
import { useGitStore } from '../store/gitStore';
import { useAppStore } from '../store/appStore';
import { IconFolder, IconSearch, IconGitBranch, IconExtensions, IconSliders } from '../components/Icons';

const ITEMS = [
  { view: 'files', label: 'Archivos', kbd: 'Ctrl Shift E', Icon: IconFolder },
  { view: 'search', label: 'Buscar', kbd: 'Ctrl Shift F', Icon: IconSearch },
  { view: 'extensions', label: 'Extensiones', kbd: 'Ctrl Shift X', Icon: IconExtensions },
];

export function ActivityRail() {
  const { sideOpen, sideView, showSide, toggleSide, setMode } = useWorkbenchStore();
  const changes = useGitStore((s) => s.changes.length);
  const openModal = useAppStore((s) => s.openModal);

  const pick = (view) => (sideOpen && sideView === view ? toggleSide() : showSide(view));

  return (
    <nav className="rail" aria-label="Vistas">
      {ITEMS.slice(0, 2).map(({ view, label, kbd, Icon }) => (
        <button key={view} className={`rail__btn ${sideOpen && sideView === view ? 'is-active' : ''}`} onClick={() => pick(view)} data-tip={`${label} · ${kbd}`}>
          <Icon size={18} />
        </button>
      ))}
      <button className="rail__btn" onClick={() => setMode('git')} data-tip="Git · Ctrl Shift G">
        <IconGitBranch size={18} />
        {changes > 0 && <span className="rail__badge" />}
      </button>
      {ITEMS.slice(2).map(({ view, label, kbd, Icon }) => (
        <button key={view} className={`rail__btn ${sideOpen && sideView === view ? 'is-active' : ''}`} onClick={() => pick(view)} data-tip={`${label} · ${kbd}`}>
          <Icon size={18} />
        </button>
      ))}
      <div className="rail__fill" />
      <button className="rail__btn" onClick={() => openModal('settings')} data-tip="Ajustes">
        <IconSliders size={18} />
      </button>
    </nav>
  );
}
