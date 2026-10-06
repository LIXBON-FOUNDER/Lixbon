// browserLogin.js — inicio de sesión en el navegador del sistema, siempre con
// PKCE: el verificador nunca sale del equipo; al navegador solo viaja su hash.
// Dos puertas: la cuenta de lixbon.com (core/gateway/routers/ide_auth.py) y
// Google o GitHub (core/gateway/routers/oauth.py). Las dos vuelven al mismo
// servidor efímero de auth_loopback.rs.
import { listen } from '@tauri-apps/api/event';
import { authLoopbackStart, openExternal } from './tauri';

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const challengeOf = async (verifier) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

async function roundTrip(signal, urlFor) {
  let settle;
  const callback = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const unlisten = await Promise.all([
    listen('auth:callback', (e) => settle.resolve(e.payload)),
    listen('auth:timeout', () => settle.reject(new Error('El navegador no volvió a tiempo. Inténtalo de nuevo.'))),
  ]);
  signal?.addEventListener('abort', () => settle.reject(new DOMException('cancelado', 'AbortError')));
  try {
    const port = await authLoopbackStart();
    await openExternal(urlFor(`http://127.0.0.1:${port}/callback`));
    return await callback;
  } finally {
    unlisten.forEach((u) => u());
  }
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.api_key) throw new Error(body.detail || `El servidor respondió con un error (${res.status}).`);
  return { apiKey: body.api_key, user: body.user };
}

export async function browserLogin(serverUrl, signal) {
  const verifier = randomToken();
  const state = randomToken();
  const challenge = await challengeOf(verifier);
  const { token, state: back } = await roundTrip(signal, (redirect) =>
    `${serverUrl}/ide/connect?${new URLSearchParams({ redirect_uri: redirect, state, challenge, method: 'S256' })}`);
  if (back !== state || !token) throw new Error('La respuesta del navegador no corresponde a esta solicitud.');
  return postJson(`${serverUrl}/api/auth/ide/exchange`, { token, verifier });
}

export const PROVIDER_NAMES = { github: 'GitHub', google: 'Google' };

export async function oauthProviders(serverUrl) {
  try {
    const res = await fetch(`${serverUrl}/api/auth/oauth/providers`, { signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    return (body.providers || []).filter((p) => PROVIDER_NAMES[p]);
  } catch {
    return [];
  }
}

export async function oauthLogin(serverUrl, provider, signal) {
  const verifier = randomToken();
  const challenge = await challengeOf(verifier);
  const { code, error } = await roundTrip(signal, (redirect) =>
    `${serverUrl}/api/auth/oauth/${provider}/start?${new URLSearchParams({ redirect_uri: redirect, code_challenge: challenge })}`);
  if (error || !code) throw new Error(`Cancelaste el inicio de sesión con ${PROVIDER_NAMES[provider]}.`);
  return postJson(`${serverUrl}/api/auth/oauth/exchange`, {
    code, code_verifier: verifier, issue_api_key: true, key_name: 'Lixbon IDE',
  });
}
