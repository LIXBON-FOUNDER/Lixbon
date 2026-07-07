import { useState, useEffect } from 'react';
import { check as checkUpdater } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useAppStore } from '../store/appStore';
import { api } from '../lib/api';
import { getAppVersion } from '../lib/tauri';

export function useVersion() {
  const { serverUrl, connectionStatus } = useAppStore();
  const [currentVersion, setCurrentVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState(null);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const dismissUpdate = () => setDismissed(true);

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

  const checkForUpdates = async () => {
    if (!serverUrl || connectionStatus !== 'connected') return;

    try {
      // 1. Preguntar al backend de Rust la versión instalada real
      const current = await fetchTauriVersion();

      // 2. Comprobar contra el endpoint del servidor si hay actualización
      const res = await api.get(`/api/updates/check?v=${current}`);
      if (res && res.update_available) {
        setUpdateInfo(res);
        setDismissed(false); // una versión nueva vuelve a mostrar el aviso
      } else {
        setUpdateInfo(null);
      }
    } catch (e) {
      console.error('[updater] Error al verificar actualizaciones:', e);
    }
  };

  const installUpdate = async () => {
    try {
      setIsDownloading(true);
      const update = await checkUpdater();
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
  }, [serverUrl, connectionStatus]);

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
