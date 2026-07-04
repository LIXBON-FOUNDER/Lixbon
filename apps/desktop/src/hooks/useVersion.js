import { useState, useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
// Importación dinámica de Tauri para evitar errores fuera de Tauri (por ejemplo, en navegador)
let tauriUpdater = null;
import('@tauri-apps/plugin-updater')
  .then(m => {
    tauriUpdater = m;
  })
  .catch(err => {
    console.warn('Tauri updater plugin not loaded:', err);
  });

let invoke = null;
import('@tauri-apps/api/core')
  .then(m => {
    invoke = m.invoke;
  })
  .catch(err => {
    console.warn('Tauri core plugin invoke not loaded:', err);
  });

export function useVersion() {
  const { serverUrl, connectionStatus } = useAppStore();
  const [currentVersion, setCurrentVersion] = useState('0.1.0');
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  const fetchTauriVersion = async () => {
    if (invoke) {
      try {
        const v = await invoke('get_app_version');
        setCurrentVersion(v);
        return v;
      } catch (e) {
        console.error('[updater] Error obteniendo versión de Rust:', e);
      }
    }
    return currentVersion;
  };

  const checkForUpdates = async () => {
    if (!serverUrl || connectionStatus !== 'connected') return;

    try {
      // 1. Preguntar al backend de Rust la versión instalada real
      const current = await fetchTauriVersion();

      // 2. Comprobar contra el endpoint del servidor si hay actualización
      const res = await api.get(`/api/updates/check?v=${current}`);
      if (res && res.update_available) {
        setUpdateInfo(res);
      } else {
        setUpdateInfo(null);
      }
    } catch (e) {
      console.error('[updater] Error al verificar actualizaciones:', e);
    }
  };

  const installUpdate = async () => {
    if (!tauriUpdater) {
      alert('Tauri updater plugin not loaded or not running inside desktop container.');
      return;
    }

    try {
      setIsDownloading(true);
      const update = await tauriUpdater.check();
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
              setIsDownloading(false);
              break;
          }
        });
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
  }, [invoke]);

  useEffect(() => {
    checkForUpdates();
    const interval = setInterval(checkForUpdates, 30 * 60 * 1000); // Cada 30 minutos
    return () => clearInterval(interval);
  }, [serverUrl, connectionStatus]);

  return {
    currentVersion,
    updateInfo,
    isDownloading,
    downloadProgress,
    checkForUpdates,
    installUpdate
  };
}
