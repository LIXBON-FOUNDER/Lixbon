// ServerPage.jsx — Ajustes → Conexión y versión: la URL del gateway y las
// actualizaciones de la app.
import { useState } from 'react';
import { useAppStore } from '../../../store/appStore';
import { useVersion } from '../../../hooks/useVersion';
import { SpinRing } from '../../../components/Ring';
import { IconServer } from '../../../components/Icons';
import { PageHead, SectionHead } from '../SettingsParts';

function normalizeUrl(raw) {
  let url = (raw || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url;
}

export function ServerPage() {
  const { serverUrl, setServerUrl } = useAppStore();
  const { currentVersion, checkForUpdates, updateInfo, showUpdate } = useVersion();
  const [urlInput, setUrlInput] = useState(serverUrl);
  const [urlStatus, setUrlStatus] = useState(null); // { ok: true|false|null, text }
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState('');

  const testUrl = async () => {
    const url = normalizeUrl(urlInput);
    if (!url) return;
    setUrlStatus({ ok: null, text: 'Comprobando…' });
    const start = performance.now();
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        setServerUrl(url);
        setUrlInput(url);
        setUrlStatus({ ok: true, text: `Conectado y guardado (${Math.round(performance.now() - start)} ms).` });
      } else {
        setUrlStatus({ ok: false, text: `El servidor respondió ${res.status}.` });
      }
    } catch {
      setUrlStatus({ ok: false, text: 'No se pudo conectar con esa URL.' });
    }
  };

  const checkUpdate = async () => {
    setChecking(true);
    setCheckResult('');
    try {
      const info = await checkForUpdates();
      if (info) showUpdate();
      setCheckResult(info ? '' : 'Estás en la última versión.');
    } catch (e) {
      setCheckResult(`No se pudo comprobar: ${e?.message || e}`);
    } finally {
      setChecking(false);
    }
  };

  const dirty = normalizeUrl(urlInput) !== serverUrl;

  return (
    <div className="spage">
      <PageHead icon={IconServer} title="Conexión y versión" sub="A qué servidor de lixbon se conecta el IDE y qué versión tienes." />

      <section className="ssec rise rise--1">
        <SectionHead label="Servidor" hint="URL del gateway de lixbon. Solo cámbiala si usas un túnel o un despliegue propio." />
        <div className="ssec ssec--card">
          <div className="srv__row">
            <div className="field field--strong srv__url">
              <input
                className="mono"
                value={urlInput}
                spellCheck={false}
                onChange={(e) => { setUrlInput(e.target.value); setUrlStatus(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') testUrl(); }}
              />
            </div>
            <button className="btn btn--ghost" onClick={testUrl} disabled={urlStatus?.ok === null}>
              {urlStatus?.ok === null && <SpinRing size={12} />}{dirty ? 'Probar y guardar' : 'Probar conexión'}
            </button>
          </div>
          {urlStatus && (
            <span className={`srow__hint ${urlStatus.ok === false ? 'is-warn' : urlStatus.ok ? 'is-ok' : ''}`}>{urlStatus.text}</span>
          )}
        </div>
      </section>

      <section className="ssec rise rise--2">
        <SectionHead label="Actualizaciones" />
        <div className="ssec ssec--card ssec--rows">
          <div className="srow">
            <div className="srow__text">
              <span className="srow__label">Versión instalada</span>
              <span className={`srow__hint ${updateInfo ? 'is-ok' : ''}`}>
                {updateInfo ? `Hay una versión nueva: v${updateInfo.latest_version}.` : checkResult || 'Lixbon busca actualizaciones solo cada pocos minutos.'}
              </span>
            </div>
            <div className="ssec__actions">
              <span className="mono srow__value">v{currentVersion || '…'}</span>
              {updateInfo
                ? <button className="btn btn--primary btn--sm" onClick={showUpdate}>Instalar v{updateInfo.latest_version}</button>
                : <button className="btn btn--ghost btn--sm" onClick={checkUpdate} disabled={checking}>{checking && <SpinRing size={12} />}Buscar ahora</button>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
