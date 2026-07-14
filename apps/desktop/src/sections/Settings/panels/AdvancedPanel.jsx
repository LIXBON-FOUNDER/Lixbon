// AdvancedPanel.jsx — servidor (gateway) y actualizaciones de la app.
import { useState } from 'react';
import { useAppStore } from '../../../store/appStore';
import { useVersion } from '../../../hooks/useVersion';

function normalizeUrl(raw) {
  let url = (raw || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export function AdvancedPanel() {
  const { serverUrl, setServerUrl } = useAppStore();
  const { currentVersion, checkForUpdates, updateInfo } = useVersion();

  const [urlInput, setUrlInput] = useState(serverUrl);
  const [urlStatus, setUrlStatus] = useState(null); // { ok, text }
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateChecked, setUpdateChecked] = useState(false);

  const handleTestUrl = async () => {
    const url = normalizeUrl(urlInput);
    if (!url) return;
    setUrlStatus({ ok: null, text: 'Comprobando…' });
    const start = performance.now();
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        setServerUrl(url);
        setUrlInput(url);
        setUrlStatus({ ok: true, text: `Conectado y guardado (${Math.round(performance.now() - start)} ms)` });
      } else {
        setUrlStatus({ ok: false, text: `El servidor respondió ${res.status}.` });
      }
    } catch {
      setUrlStatus({ ok: false, text: 'No se pudo conectar con esa URL.' });
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateChecked(false);
    try {
      await checkForUpdates();
    } finally {
      setCheckingUpdate(false);
      setUpdateChecked(true);
    }
  };

  return (
    <>
      <section className="settings__panel">
        <h3 className="settings__panel-title">Servidor</h3>
        <p className="settings__hint">
          URL del gateway de lixbon. Solo cámbiala si usas un túnel o despliegue propio.
        </p>
        <div className="settings__inline">
          <input
            className="settings__input"
            type="text"
            value={urlInput}
            onChange={(e) => { setUrlInput(e.target.value); setUrlStatus(null); }}
            spellCheck={false}
          />
          <button className="pill-btn pill-btn--outline" onClick={handleTestUrl}>
            Probar y guardar
          </button>
        </div>
        {urlStatus && (
          <p className={`settings__status ${urlStatus.ok === false ? 'is-error' : ''}`}>
            {urlStatus.text}
          </p>
        )}
      </section>

      <section className="settings__panel">
        <h3 className="settings__panel-title">Actualizaciones</h3>
        <div className="settings__rows">
          <div className="settings__row">
            <span className="settings__row-label">Versión instalada</span>
            <span className="settings__row-value">v{currentVersion || '…'}</span>
          </div>
        </div>
        <div className="settings__actions">
          <button className="pill-btn pill-btn--outline" onClick={handleCheckUpdate} disabled={checkingUpdate}>
            {checkingUpdate ? 'Buscando…' : 'Buscar actualizaciones'}
          </button>
        </div>
        {updateChecked && (
          <p className="settings__status">
            {updateInfo
              ? `Hay una versión nueva (${updateInfo.latest_version || 'disponible'}): usa el aviso superior para instalarla.`
              : 'Estás en la última versión.'}
          </p>
        )}
      </section>
    </>
  );
}
