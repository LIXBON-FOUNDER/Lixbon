// Welcome.jsx — pantalla de bienvenida (D4): abrir carpeta, clonar y recientes.
// Se muestra en el centro cuando no hay carpeta de trabajo abierta.
import { useAppStore } from '../../store/appStore';
import { pickDirectory } from '../../lib/tauri';
import { IconFolderOpen, IconGitBranch, IconX } from '../../components/Icons';

function baseName(p) {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
}

export function Welcome() {
  const recents = useAppStore((s) => s.recentFolders);
  const openWorkspace = useAppStore((s) => s.openWorkspace);
  const removeRecent = useAppStore((s) => s.removeRecent);
  const openLeftPanel = useAppStore((s) => s.openLeftPanel);

  const openFolder = async () => {
    const dir = await pickDirectory({ title: 'Abrir carpeta de trabajo' });
    if (dir) {
      try { await openWorkspace(dir); }
      catch (e) { alert('No se pudo abrir la carpeta: ' + e); }
    }
  };

  const openRecent = async (path) => {
    try { await openWorkspace(path); }
    catch { removeRecent(path); } // ya no existe
  };

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <span className="brand welcome__brand">LIXBON</span>
        <p className="welcome__tagline">Tu IDE con IA local. Empieza abriendo una carpeta.</p>

        <div className="welcome__actions">
          <button className="welcome__action" onClick={openFolder}>
            <IconFolderOpen size={18} />
            <span>Abrir carpeta…</span>
          </button>
          <button className="welcome__action" onClick={() => openLeftPanel('git')}>
            <IconGitBranch size={18} />
            <span>Clonar repositorio…</span>
          </button>
        </div>

        {recents.length > 0 && (
          <div className="welcome__recents">
            <h4 className="welcome__recents-title">Recientes</h4>
            {recents.map((p) => (
              <div key={p} className="welcome__recent">
                <button className="welcome__recent-open" onClick={() => openRecent(p)} title={p}>
                  <span className="welcome__recent-name">{baseName(p)}</span>
                  <span className="welcome__recent-path">{p}</span>
                </button>
                <button
                  className="icon-btn welcome__recent-remove"
                  onClick={() => removeRecent(p)}
                  title="Quitar de recientes"
                >
                  <IconX size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
