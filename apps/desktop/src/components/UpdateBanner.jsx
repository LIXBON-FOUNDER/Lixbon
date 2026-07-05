// UpdateBanner.jsx — aviso fino sobre el editor cuando hay versión nueva.
export function UpdateBanner({ updateInfo, onInstall, isDownloading, downloadProgress }) {
  if (!updateInfo) return null;

  const version = updateInfo.latest_version || updateInfo.version || '';

  return (
    <div className="update-banner">
      <span className="update-banner__text">
        <strong>Actualización disponible{version ? ` — v${version}` : ''}.</strong>
        {updateInfo.changelog ? ` ${updateInfo.changelog}` : ''}
      </span>
      {isDownloading ? (
        <span className="update-banner__progress">Descargando… {downloadProgress}%</span>
      ) : (
        <button className="pill-btn pill-btn--primary" onClick={onInstall}>
          Actualizar
        </button>
      )}
    </div>
  );
}
