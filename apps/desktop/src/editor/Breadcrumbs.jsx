// Breadcrumbs.jsx — ruta del archivo activo bajo las pestañas (relativa al
// workspace). Clic en cualquier segmento abre el explorador, que ya hace
// auto-reveal del archivo activo.
import { useEditorStore } from '../store/editorStore';
import { useAppStore } from '../store/appStore';
import { IconChevronRight } from '../components/Icons';

/** Abre el panel del explorador sin plegarlo si ya estaba abierto
    (openLeftPanel conmuta; aquí queremos "asegurar visible"). */
function revealExplorer() {
  const app = useAppStore.getState();
  localStorage.setItem('lixbon_left_view', 'explorer');
  useAppStore.setState({ leftView: 'explorer' });
  if (!app.panels.explorer) app.togglePanel('explorer');
}

export function Breadcrumbs() {
  const activePath = useEditorStore((s) => s.activePath);
  const workspaceRoot = useAppStore((s) => s.workspaceRoot);
  if (!activePath) return null;

  let rel = activePath;
  if (workspaceRoot && activePath.startsWith(workspaceRoot)) {
    rel = activePath.slice(workspaceRoot.length).replace(/^[\\/]+/, '');
  }
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (!parts.length) return null;

  return (
    <nav className="breadcrumbs" aria-label="Ruta del archivo activo">
      {parts.map((part, i) => (
        <span key={i} className="breadcrumbs__seg">
          {i > 0 && <IconChevronRight size={10} />}
          <button
            className={`breadcrumbs__btn ${i === parts.length - 1 ? 'is-file' : ''}`}
            title="Mostrar en el explorador"
            onClick={revealExplorer}
          >
            {part}
          </button>
        </span>
      ))}
    </nav>
  );
}
