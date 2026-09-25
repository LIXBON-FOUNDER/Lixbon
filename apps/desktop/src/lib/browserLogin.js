// browserLogin.js — inicio de sesión con la cuenta de lixbon.com en el
// navegador del sistema (PKCE contra core/gateway/routers/ide_auth.py): el
// verificador nunca sale del equipo; al navegador solo viaja su hash.
import { listen } from '@tauri-apps/api/event';
import { authLoopbackStart, openExternal } from './tauri';

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

export async function browserLogin(serverUrl, signal) {
  const verifier = randomToken();
  const state = randomToken();
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));

  let settle;
  const callback = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const unlisten = await Promise.all([
    listen('auth:callback', (e) => settle.resolve(e.payload)),
    listen('auth:timeout', () => settle.reject(new Error('El navegador no volvió a tiempo. Inténtalo de nuevo.'))),
  ]);
  signal?.addEventListener('abort', () => settle.reject(new DOMException('cancelado', 'AbortError')));

  try {
    const port = await authLoopbackStart();
    const q = new URLSearchParams({ redirect_uri: `http://127.0.0.1:${port}/callback`, state, challenge, method: 'S256' });
    await openExternal(`${serverUrl}/ide/connect?${q}`);

    const { token, state: back } = await callback;
    if (back !== state || !token) throw new Error('La respuesta del navegador no corresponde a esta solicitud.');

    const res = await fetch(`${serverUrl}/api/auth/ide/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, verifier }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.api_key) throw new Error(body.detail || `El servidor respondió con un error (${res.status}).`);
    return { apiKey: body.api_key, user: body.user };
  } finally {
    unlisten.forEach((u) => u());
  }
}
