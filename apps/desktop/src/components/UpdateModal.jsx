// UpdateModal.jsx — aviso de actualización: tarjeta abajo a la derecha que se
// ve en cualquier vista del IDE, con número, fecha, novedades y la opción de
// descargar e instalar.
import { openExternal } from '../lib/tauri';
import { IconDownload, IconX } from './Icons';

function formatDate(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString('es', { day: 'numeric', month: 'long' });
}

export function UpdateModal({ updateInfo, serverUrl, onInstall, onDismiss, isDownloading, downloadProgress, error }) {
  if (!updateInfo) return null;

  const version = updateInfo.latest_version || updateInfo.version || '';
  const date = formatDate(updateInfo.release_date);
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
        <span className="update-modal__icon"><IconDownload size={15} /></span>
        <div className="update-modal__title-wrap">
          <h3 className="update-modal__title">{updateInfo.title || 'Nueva versión de Lixbon'}</h3>
          <span className="update-modal__badge">v{version}{date ? ` · ${date}` : ''}</span>
        </div>
        {!isDownloading && (
          <button type="button" className="ic update-modal__close" onClick={onDismiss} title="Ahora no">
            <IconX size={12} />
          </button>
        )}
      </div>

      {changelog.length > 0 && (
        <ul className="update-modal__changelog">
          {changelog.slice(0, 3).map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      )}
      <button type="button" className="update-modal__link" onClick={openNovedades}>Ver todas las novedades</button>

      {isDownloading ? (
        <div className="update-modal__progress">
          <div className="update-modal__bar">
            <div className="update-modal__bar-fill" style={{ width: `${downloadProgress}%` }} />
          </div>
          <span className="update-modal__progress-text">
            {downloadProgress < 100 ? `Descargando… ${downloadProgress}%` : 'Instalando; Lixbon se reiniciará'}
          </span>
        </div>
      ) : (
        <>
          {error && <p className="update-modal__error" role="alert">{error}</p>}
          <div className="update-modal__actions">
            <button type="button" className="pill-btn pill-btn--outline" onClick={onDismiss}>Ahora no</button>
            <button type="button" className="pill-btn pill-btn--primary" onClick={onInstall}>Actualizar y reiniciar</button>
          </div>
        </>
      )}
    </div>
  );
}
