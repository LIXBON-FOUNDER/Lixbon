import { servidorActual } from './sesion';

export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_POR_MENSAJE = 10;

const EXT_PROHIBIDAS = new Set([
  '.exe', '.msi', '.bat', '.cmd', '.com', '.scr', '.ps1', '.dll', '.jar', '.apk', '.sh',
]);

const extension = (nombre) => {
  const punto = String(nombre || '').lastIndexOf('.');
  return punto >= 0 ? nombre.slice(punto).toLowerCase() : '';
};

export function revisar(file) {
  if (!file) return 'No se eligió ningún archivo.';
  if (file.size === 0) return 'El archivo está vacío.';
  if (file.size > MAX_BYTES) {
    return `«${file.name}» pesa ${(file.size / 1024 / 1024).toFixed(1)} MB y el límite son 25 MB.`;
  }
  if (EXT_PROHIBIDAS.has(extension(file.name))) {
    return `Los archivos ${extension(file.name)} no se pueden enviar.`;
  }
  return '';
}

export function tipoProbable(file) {
  const m = file.type || '';
  if (m.startsWith('image/') && m !== 'image/svg+xml') return 'imagen';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'archivo';
}

function medirImagen(url) {
  return new Promise((listo) => {
    const img = new Image();
    img.onload = () => listo({ ancho: img.naturalWidth, alto: img.naturalHeight });
    img.onerror = () => listo({});
    img.src = url;
  });
}

function medirMedio(url, esVideo) {
  return new Promise((listo) => {
    const el = document.createElement(esVideo ? 'video' : 'audio');
    const acabar = () => {
      const d = el.duration;
      const duracion_ms = Number.isFinite(d) ? Math.round(d * 1000) : null;
      listo({
        duracion_ms,
        ...(esVideo ? { ancho: el.videoWidth || null, alto: el.videoHeight || null } : {}),
      });
    };
    el.onloadedmetadata = acabar;
    el.onerror = () => listo({});
    el.preload = 'metadata';
    el.src = url;
  });
}

export async function medir(file) {
  const tipo = tipoProbable(file);
  if (tipo === 'archivo') return {};
  const url = URL.createObjectURL(file);
  try {
    if (tipo === 'imagen') return await medirImagen(url);
    return await medirMedio(url, tipo === 'video');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function subir({ canalId, file, llave, medidas = {}, onProgreso }) {
  const xhr = new XMLHttpRequest();

  const promesa = new Promise((listo, fallo) => {
    const form = new FormData();
    form.append('canal_id', canalId);
    for (const [clave, valor] of Object.entries(medidas)) {
      if (valor != null) form.append(clave, String(valor));
    }
    form.append('file', file, file.name);

    xhr.open('POST', `${servidorActual()}/api/team/attachments`);
    xhr.setRequestHeader('Authorization', `Bearer ${llave}`);
    xhr.responseType = 'json';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgreso) onProgreso(e.loaded / e.total);
    };

    xhr.onload = () => {
      const cuerpo = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgreso?.(1);
        listo(cuerpo);
        return;
      }
      fallo(new Error(cuerpo?.detail || `El servidor respondió ${xhr.status}.`));
    };
    xhr.onerror = () => fallo(new Error('No se pudo subir el archivo.'));
    xhr.onabort = () => fallo(new Error('Subida cancelada.'));

    xhr.send(form);
  });

  return { promesa, cancelar: () => xhr.abort() };
}

export async function renovarUrl(adjuntoId, llave) {
  const res = await fetch(`${servidorActual()}/api/team/attachments/${adjuntoId}/url`, {
    headers: { Authorization: `Bearer ${llave}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('No se pudo renovar el enlace.');
  return res.json();
}

export function formatDuracion(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const seg = total % 60;
  return `${min}:${String(seg).padStart(2, '0')}`;
}
