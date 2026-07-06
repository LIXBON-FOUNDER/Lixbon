// settings.js — persistencia de configuración con @tauri-apps/plugin-store.
// Sustituye a localStorage para los datos sensibles/duraderos (serverUrl, apiKey, user):
// viven en %APPDATA%/com.usuario.app-lixbon/lixbon.settings.json, fuera del WebView.

import { load } from '@tauri-apps/plugin-store';

export const DEFAULT_SERVER_URL = 'https://lixbon.com';

let storePromise = null;

function getStore() {
  if (!storePromise) {
    storePromise = load('lixbon.settings.json', { autoSave: true });
  }
  return storePromise;
}

/** Lee toda la configuración persistida, migrando una vez desde localStorage. */
export async function loadSettings() {
  const store = await getStore();

  // Migración one-shot desde el esquema legacy en localStorage
  const legacyKey = localStorage.getItem('lixbon_api_key');
  if (legacyKey && !(await store.get('apiKey'))) {
    await store.set('apiKey', legacyKey);
    const legacyUrl = localStorage.getItem('lixbon_server_url');
    if (legacyUrl) await store.set('serverUrl', legacyUrl);
    const legacyUser = localStorage.getItem('lixbon_user');
    if (legacyUser) {
      try { await store.set('user', JSON.parse(legacyUser)); } catch { /* corrupto: se ignora */ }
    }
  }
  localStorage.removeItem('lixbon_api_key');
  localStorage.removeItem('lixbon_server_url');
  localStorage.removeItem('lixbon_user');

  return {
    serverUrl: (await store.get('serverUrl')) || DEFAULT_SERVER_URL,
    apiKey: (await store.get('apiKey')) || '',
    user: (await store.get('user')) || null,
  };
}

export async function saveSetting(key, value) {
  const store = await getStore();
  if (value === null || value === undefined || value === '') {
    await store.delete(key);
  } else {
    await store.set(key, value);
  }
}
