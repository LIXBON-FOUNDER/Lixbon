// UpdateModal.jsx — aviso de actualización que baja desde el centro-superior.
// Pregunta al usuario si desea descargar e instalar la versión nueva, muestra
// número y fecha, y enlaza a la web con todos los cambios de esa versión.
import { openExternal } from '../lib/tauri';

function formatDate(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function UpdateModal({ updateInfo, serverUrl, onInstall, onDismiss, isDownloading, downloadProgress }) {
  if (!updateInfo) return null;

  const version = updateInfo.latest_version || updateInfo.version || '';
  const date = formatDate(updateInfo.release_date);
  const title = updateInfo.title || 'Nueva versión disponible';

  // El changelog puede llegar como lista o como texto; se muestran los primeros ítems.
  const changelog = Array.isArray(updateInfo.changelog)
    ? updateInfo.changelog
    : updateInfo.changelog
      ? [updateInfo.changelog]
      : [];

  const openNovedades = () => {
    const base = (serverUrl || 'https://lixbon.com').replace(/\/+$/, '');
    openExternal(`${base}/novedades${version ? `#v${version}` : ''}`);
  };

  return (
    <div className="update-modal" role="dialog" aria-modal="false" aria-label="Actualización disponible">
      <div className="update-modal__head">
        <div className="update-modal__title-wrap">
          <span className="update-modal__eyebrow">Actualización disponible</span>
          <h3 className="update-modal__title">{title}</h3>
        </div>
        <span className="update-modal__badge">
          v{version}{date ? ` · ${date}` : ''}
        </span>
      </div>

      {changelog.length > 0 && (
        <ul className="update-modal__changelog">
          {changelog.slice(0, 4).map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}

      <button type="button" className="update-modal__link" onClick={openNovedades}>
        Ver novedades de esta versión en la web
      </button>

      {isDownloading ? (
        <div className="update-modal__progress">
          <div className="update-modal__bar">
            <div className="update-modal__bar-fill" style={{ width: `${downloadProgress}%` }} />
          </div>
          <span className="update-modal__progress-text">Descargando e instalando… {downloadProgress}%</span>
        </div>
      ) : (
        <>
          <p className="update-modal__question">¿Deseas descargar e instalar la actualización ahora?</p>
          <div className="update-modal__actions">
            <button type="button" className="pill-btn pill-btn--outline" onClick={onDismiss}>
              Ahora no
            </button>
            <button type="button" className="pill-btn pill-btn--primary" onClick={onInstall}>
              Descargar e instalar
            </button>
          </div>
        </>
      )}
    </div>
  );
}
