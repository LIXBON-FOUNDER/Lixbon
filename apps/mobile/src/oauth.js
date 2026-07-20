// oauth.js — lado cliente del login con Google/Apple.
// El navegador (Custom Tab) hace el flujo contra el gateway, que guarda los
// secretos de proveedor; la app solo genera el PKCE y canjea el código:
// un código interceptado en la redirección no sirve sin el code_verifier.
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';

import { ApiException } from './api';

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// Hermes no trae btoa: base64 a mano desde bytes.
function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_CHARS[b0 >> 2];
    out += B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_CHARS[b2 & 63] : '=';
  }
  return out;
}

const b64url = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// La URL de Hermes no implementa searchParams: parseo a mano.
function queryParam(url, name) {
  const m = url.match(new RegExp(`[?&#]${name}=([^&#]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function oauthAuthorize(provider, base) {
  const verifier = b64url(bytesToBase64(Crypto.getRandomBytes(32)));
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 },
  );
  const challenge = b64url(digest);

  // El gateway solo acepta lixbon://, exp:// y la propia web (allowlist
  // anti open-redirect); la app instalada usa siempre lixbon://oauth.
  const redirectUri = 'lixbon://oauth';
  const startUrl =
    `${base}/api/auth/oauth/${provider}/start` +
    `?redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${encodeURIComponent(challenge)}`;

  let result;
  try {
    result = await WebBrowser.openAuthSessionAsync(startUrl, redirectUri);
  } catch {
    throw new ApiException('Inicio de sesión cancelado');
  }
  if (result.type !== 'success' || !result.url) {
    throw new ApiException('Inicio de sesión cancelado');
  }
  if (queryParam(result.url, 'lixbon_error') != null) {
    throw new ApiException('Inicio de sesión cancelado');
  }
  const code = queryParam(result.url, 'lixbon_code');
  if (!code) throw new ApiException('No se recibió el código de acceso');
  return { code, verifier };
}
