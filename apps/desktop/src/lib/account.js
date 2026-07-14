// account.js — foto de perfil y refresco del usuario.
//
// La imagen vive en el gateway (R2), así que web e IDE muestran la misma: es el
// mismo usuario en la misma base de datos.

export const MAX_AVATAR_BYTES = 3 * 1024 * 1024; // 3 MB
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const AVATAR_ACCEPT = AVATAR_TYPES.join(',');

/** Motivo por el que el archivo no vale, o '' si vale. El servidor revalida
    igualmente (y comprueba la firma del archivo, no solo el tipo declarado). */
export function validateAvatar(file) {
  if (!file) return 'No se eligió ninguna imagen.';
  if (!AVATAR_TYPES.includes(file.type)) {
    return 'Solo se admiten imágenes PNG, JPG, WEBP o GIF.';
  }
  if (file.size > MAX_AVATAR_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return `La imagen pesa ${mb} MB y el límite son 3 MB.`;
  }
  return '';
}

/** URL absoluta de la foto (el gateway la devuelve relativa). */
export function avatarSrc(serverUrl, user) {
  return user?.avatar_url ? `${serverUrl}${user.avatar_url}` : null;
}

async function readError(res) {
  const body = await res.json().catch(() => null);
  return body?.detail?.message || body?.detail || `El servidor respondió ${res.status}.`;
}

export async function uploadAvatar(serverUrl, apiKey, file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${serverUrl}/api/account/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form, // sin Content-Type: lo pone el navegador con su boundary
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()).avatar_url;
}

export async function removeAvatar(serverUrl, apiKey) {
  const res = await fetch(`${serverUrl}/api/account/avatar`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(await readError(res));
}

/** Vuelve a leer el usuario del servidor (tras cambiar la foto o el plan). */
export async function fetchMe(serverUrl, apiKey) {
  const res = await fetch(`${serverUrl}/api/auth/me`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()).user;
}
