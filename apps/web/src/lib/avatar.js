// avatar.js — foto de perfil. Comparte endpoint (y por tanto imagen) con el IDE.
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

export function initialOf(user) {
  return (user?.first_name || user?.username || user?.email || '?')[0].toUpperCase();
}
