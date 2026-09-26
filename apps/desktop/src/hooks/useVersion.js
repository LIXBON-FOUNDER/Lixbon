import { useEffect } from 'react';
import { create } from 'zustand';
import { check as checkUpdater } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { api } from '../lib/api';
import { getAppVersion } from '../lib/tauri';

const CHECK_EVERY_MS = 30 * 60 * 1000;
const RETRY_MS = 60 * 1000;

// Compara "x.y.z[-pre]" numéricamente. >0 si a > b, 0 si iguales, <0 si a < b,
// o null si alguna no es parseable (en ese caso no se decide aquí).
function compareVersions(a, b) {
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
}

let pending = null;
let started = false;

// Un solo estado para toda la app: antes cada pantalla que usaba el hook
// tenía el suyo, y lo que encontraba Ajustes nunca llegaba al aviso superior.
const useUpdateStore = create((set, get) => ({
  currentVersion: '',
  updateInfo: null,
  isDownloading: false,
  downloadProgress: 0,
  dismissed: false,
  error: '',

  dismissUpdate: () => set({ dismissed: true }),

  fetchVersion: async () => {
    try {
      const v = await getAppVersion();
      set({ currentVersion: v });
      return v;
    } catch (e) {
      console.error('[updater] Error obteniendo versión de Rust:', e);
      return get().currentVersion;
    }
  },

  // Se pregunta al updater de Tauri, no al servidor conectado: el manifiesto
  // firmado vive en lixbon.com y así el aviso llega aunque el IDE esté
  // apuntando a otro servidor o todavía no haya conectado.
  checkForUpdates: async () => {
    const current = await get().fetchVersion();
    const update = await checkUpdater();
    const cmp = update ? compareVersions(update.version, current) : null;
    if (!update || (cmp !== null && cmp <= 0)) {
      pending = null;
      set({ updateInfo: null });
      return null;
    }
    let extra = null;
    try { extra = await api.get(`/api/updates/check?v=${current}`); } catch { /* solo son las notas */ }
    const same = extra?.latest_version === update.version;
    const notes = String(update.body || '').split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
    pending = update;
    const info = {
      ...(same ? extra : {}),
      latest_version: update.version,
      release_date: extra?.release_date || update.date,
      changelog: same && extra?.changelog?.length ? extra.changelog : notes,
    };
    const known = get().updateInfo?.latest_version === update.version;
    set({ updateInfo: info, ...(known ? {} : { dismissed: false, error: '' }) });
    return info;
  },

  showUpdate: () => set({ dismissed: false }),

  installUpdate: async () => {
    set({ isDownloading: true, downloadProgress: 0, error: '' });
    try {
      const update = pending || await checkUpdater();
      if (!update) {
        set({ isDownloading: false, error: 'No se encontró la actualización. Vuelve a buscarla en Ajustes.' });
        return;
      }
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength || 0;
        if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          if (total > 0) set({ downloadProgress: Math.round((downloaded / total) * 100) });
        }
      });
      await relaunch();
    } catch (error) {
      console.error('[updater] Error instalando actualización:', error);
      set({ isDownloading: false, error: `No se pudo instalar: ${error?.message || error}` });
    }
  },
}));

async function runCheck() {
  try {
    await useUpdateStore.getState().checkForUpdates();
    setTimeout(runCheck, CHECK_EVERY_MS);
  } catch (e) {
    // Al arrancar la red a veces no está lista: se reintenta pronto.
    console.error('[updater] Error al verificar actualizaciones:', e);
    setTimeout(runCheck, RETRY_MS);
  }
}

export function useVersion() {
  const state = useUpdateStore();
  useEffect(() => {
    if (started) return;
    started = true;
    runCheck();
  }, []);
  return state;
}
