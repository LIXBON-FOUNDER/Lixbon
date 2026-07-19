// settings.js — persistencia de configuración con @tauri-apps/plugin-store.
// Sustituye a localStorage para los datos duraderos (serverUrl, user):
// viven en %APPDATA%/com.usuario.app-lixbon/lixbon.settings.json, fuera del WebView.
//
// La API key es especial: en Windows se guarda cifrada en el Credential
// Manager (comandos Rust secret_*). El JSON queda como fallback para otros
// SO o si el almacén falla; la migración desde el JSON es automática.

import { load } from '@tauri-apps/plugin-store';
import { invoke } from '@tauri-apps/api/core';

export const DEFAULT_SERVER_URL = 'https://lixbon.com';

const SECRET_NAME = 'apiKey';

let storePromise = null;

function getStore() {
  if (!storePromise) {
    storePromise = load('lixbon.settings.json', { autoSave: true });
  }
  return storePromise;
}

/** ok:false = el almacén del SO no está disponible (no-Windows o error). */
async function secretGet() {
  try {
    return { ok: true, value: await invoke('secret_get', { name: SECRET_NAME }) };
  } catch {
    return { ok: false, value: null };
  }
}

async function secretSet(value) {
  try {
    await invoke('secret_set', { name: SECRET_NAME, value });
    return true;
  } catch {
    return false;
  }
}

async function secretDelete() {
  try {
    await invoke('secret_delete', { name: SECRET_NAME });
    return true;
  } catch {
    return false;
  }
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

  // API key: primero el almacén cifrado del SO; si ahí no hay nada pero el
  // JSON sí tiene una (instalaciones previas), se migra y se borra del JSON.
  let apiKey = '';
  const secret = await secretGet();
  if (secret.ok) {
    apiKey = secret.value || '';
    const plain = await store.get('apiKey');
    if (plain) {
      if (!apiKey) apiKey = plain;
      if (await secretSet(apiKey)) await store.delete('apiKey');
    }
  } else {
    apiKey = (await store.get('apiKey')) || '';
  }

  return {
    serverUrl: (await store.get('serverUrl')) || DEFAULT_SERVER_URL,
    apiKey,
    user: (await store.get('user')) || null,
  };
}

export async function saveSetting(key, value) {
  const store = await getStore();
  if (key === 'apiKey') {
    const emptied = value === null || value === undefined || value === '';
    const done = emptied ? await secretDelete() : await secretSet(value);
    if (done) {
      await store.delete('apiKey'); // que no quede copia en claro en el JSON
      return;
    }
    // Sin almacén del SO: se sigue usando el JSON como siempre.
  }
  if (value === null || value === undefined || value === '') {
    await store.delete(key);
  } else {
    await store.set(key, value);
  }
}
