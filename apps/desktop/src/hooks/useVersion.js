import { useState, useEffect, useRef } from 'react';
import { check as checkUpdater } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { api } from '../lib/api';
import { getAppVersion } from '../lib/tauri';

export function useVersion() {
  const [currentVersion, setCurrentVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const pendingRef = useRef(null);

  const dismissUpdate = () => setDismissed(true);

  // Compara "x.y.z[-pre]" numéricamente. Devuelve >0 si a > b, 0 si iguales,
  // <0 si a < b, o null si alguna no es parseable (en ese caso no se decide aquí).
  const compareVersions = (a, b) => {
    const parse = (v) => {
      const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
    };
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return null;
    for (let i = 0; i < 3; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  };

  const fetchTauriVersion = async () => {
    try {
      const v = await getAppVersion();
      setCurrentVersion(v);
      return v;
    } catch (e) {
      console.error('[updater] Error obteniendo versión de Rust:', e);
      return currentVersion;
    }
  };

  // Se pregunta al updater de Tauri, no al servidor conectado: el manifiesto
  // firmado vive en lixbon.com y así el aviso llega aunque el IDE esté
  // apuntando a otro servidor o todavía no haya conectado.
  const checkForUpdates = async () => {
    try {
      const current = await fetchTauriVersion();
      const update = await checkUpdater();
      const cmp = update ? compareVersions(update.version, current) : null;
      if (!update || (cmp !== null && cmp <= 0)) {
        pendingRef.current = null;
        setUpdateInfo(null);
        return;
      }
      let extra = null;
      try { extra = await api.get(`/api/updates/check?v=${current}`); } catch { /* solo son las notas */ }
      const notes = String(update.body || '').split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
      pendingRef.current = update;
      setUpdateInfo({
        ...(extra?.latest_version === update.version ? extra : {}),
        latest_version: update.version,
        release_date: extra?.release_date || update.date,
        changelog: extra?.latest_version === update.version && extra?.changelog?.length ? extra.changelog : notes,
      });
      setDismissed(false);
    } catch (e) {
      console.error('[updater] Error al verificar actualizaciones:', e);
    }
  };

  const installUpdate = async () => {
    try {
      setIsDownloading(true);
      const update = pendingRef.current || await checkUpdater();
      if (update) {
        let downloaded = 0;
        let contentLength = 0;
        
        await update.downloadAndInstall((event) => {
          switch (event.event) {
            case 'Started':
              contentLength = event.data.contentLength || 0;
              break;
            case 'Progress':
              downloaded += event.data.chunkLength;
              if (contentLength > 0) {
                setDownloadProgress(Math.round((downloaded / contentLength) * 100));
              }
              break;
            case 'Finished':
              break;
          }
        });
        // Instalado: reiniciar la app para arrancar en la versión nueva.
        await relaunch();
      } else {
        setIsDownloading(false);
        alert('No se detectó la actualización al intentar instalar. Verifica que la versión sea superior a la actual.');
      }
    } catch (error) {
      console.error('[updater] Error instalando actualización:', error);
      setIsDownloading(false);
      alert('Error al instalar la actualización. Es posible que el archivo esté corrupto o que la firma (.sig) sea inválida. Detalle: ' + error.message);
    }
  };

  useEffect(() => {
    fetchTauriVersion();
  }, []);

  useEffect(() => {
    checkForUpdates();
    const interval = setInterval(checkForUpdates, 30 * 60 * 1000); // Cada 30 minutos
    return () => clearInterval(interval);
  }, []);

  return {
    currentVersion,
    updateInfo,
    isDownloading,
    downloadProgress,
    dismissed,
    dismissUpdate,
    checkForUpdates,
    installUpdate
  };
}
