// adjuntos.js — qué hacer con un archivo que llega al chat, venga de donde venga
// (el botón del clip, un Ctrl+V o soltarlo sobre la ventana).
//
// Dos caminos, según lo que sea:
//
//   Documento → /api/attachments, que extrae su texto. El servidor no guarda el
//               archivo: al modelo solo le sirve el texto.
//   Imagen    → se encoge aquí mismo y va a /api/vision/describe, donde un modelo
//               multimodal la describe. Esa descripción se adjunta como texto, así
//               que la imagen funciona con CUALQUIER modelo elegido, no solo con
//               los que ven.
//
// El audio no tiene camino todavía y se dice claramente: el gateway no transcribe,
// y fingir que se adjuntó algo que el modelo no va a leer es peor que rechazarlo.
import { api } from './api';

/** Lado mayor al que se encoge una imagen antes de subirla. Suficiente para que
 *  un modelo de visión lea texto dentro de la imagen, y ahorra megabytes: una
 *  foto de móvil pasa de ~4 MB a ~200 KB. */
const LADO_MAX = 1400;
const CALIDAD = 0.85;

/** Tope de seguridad para lo que sale del navegador ya comprimido. */
const MAX_BYTES_IMAGEN = 4 * 1024 * 1024;

export function esImagen(file) {
  return (file.type || '').startsWith('image/');
}

export function esAudioOVideo(file) {
  const t = file.type || '';
  return t.startsWith('audio/') || t.startsWith('video/');
}

/** Encoge la imagen y la devuelve como JPEG. Devuelve el dataURL (para la
 *  miniatura) y el base64 pelado (que es lo que espera el modelo). */
export async function prepararImagen(file) {
  const lienzo = document.createElement('canvas');
  let ancho;
  let alto;
  let fuente;

  try {
    fuente = await createImageBitmap(file);
    ancho = fuente.width;
    alto = fuente.height;
  } catch {
    // createImageBitmap no traga algunos formatos (SVG en varios navegadores):
    // se cae a la imagen normal, que sí los pinta.
    fuente = await new Promise((listo, falla) => {
      const img = new Image();
      img.onload = () => listo(img);
      img.onerror = () => falla(new Error('formato de imagen no reconocido'));
      img.src = URL.createObjectURL(file);
    });
    ancho = fuente.naturalWidth;
    alto = fuente.naturalHeight;
  }

  const escala = Math.min(1, LADO_MAX / Math.max(ancho, alto));
  lienzo.width = Math.round(ancho * escala);
  lienzo.height = Math.round(alto * escala);
  const ctx = lienzo.getContext('2d');
  // Fondo blanco: los PNG transparentes acaban en JPEG, y sin esto lo
  // transparente se vuelve negro.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, lienzo.width, lienzo.height);
  ctx.drawImage(fuente, 0, 0, lienzo.width, lienzo.height);

  const dataUrl = lienzo.toDataURL('image/jpeg', CALIDAD);
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (base64.length * 0.75 > MAX_BYTES_IMAGEN) {
    throw new Error('La imagen es demasiado grande incluso después de comprimirla.');
  }
  return { dataUrl, base64, ancho: lienzo.width, alto: lienzo.height };
}

/** Manda la imagen al sub-agente de visión y devuelve su descripción. */
export async function describirImagen(base64) {
  const res = await api.post('/api/vision/describe', { images: [base64] });
  const descripcion = (res.data?.description || '').trim();
  if (!descripcion) throw new Error('El modelo de visión no devolvió nada.');
  return descripcion;
}

/** Sube un documento y devuelve su texto extraído. */
export async function subirDocumento(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await api.post('/api/attachments', fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data; // { filename, text, chars, truncated }
}

/** El texto de error que toca enseñar, sin tecnicismos.
 *
 * El gateway ya manda mensajes escritos para leerse ("El archivo supera el
 * límite de 5 MB"): si viene uno, ese gana. Lo que nunca debe salir a la
 * pantalla es el "Request failed with status code 502" de axios. */
export function mensajeDeError(err, nombre) {
  const detalle = err?.response?.data?.detail;
  if (typeof detalle === 'string') return detalle;
  if (detalle?.message) return detalle.message;

  const estado = err?.response?.status;
  if (estado === 401 || estado === 403) {
    return 'Inicia sesión para adjuntar archivos.';
  }
  if (estado === 402 || estado === 429) {
    return 'Has llegado al límite de tu plan por ahora.';
  }
  if (estado === 413) {
    return `${nombre} es demasiado grande.`;
  }
  if (estado >= 500) {
    return `No se pudo leer ${nombre}: el servidor no respondió bien. Inténtalo otra vez.`;
  }
  if (err?.request && !err?.response) {
    return 'Sin conexión con el servidor.';
  }
  // Errores nuestros (comprimir la imagen, formato ilegible): su texto ya está
  // escrito en español y para leerse.
  if (err?.message && !/^Request failed/.test(err.message)) {
    return `${nombre}: ${err.message}`;
  }
  return `No se pudo adjuntar ${nombre}.`;
}

/** El bloque de contexto que se antepone al mensaje del usuario. */
export function contextoDe(adjunto) {
  const cabecera = adjunto.kind === 'image'
    ? `--- Imagen adjunta: ${adjunto.filename} (descrita por un modelo de visión) ---`
    : `--- Documento adjunto: ${adjunto.filename} ---`;
  return `${cabecera}\n${adjunto.text}`;
}
