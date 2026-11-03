// Transcripción de voz dentro del navegador (Whisper vía transformers.js).
// Es el plan B del dictado cuando el navegador no trae reconocimiento de voz
// propio (Brave, Firefox…): el audio no sale del equipo. El modelo se
// descarga la primera vez y queda en la caché del navegador.
import { pipeline } from '@huggingface/transformers';

const MODELO = 'onnx-community/whisper-base';

let cargando = null;

async function tieneWebGPU() {
  try {
    return Boolean(await navigator.gpu?.requestAdapter());
  } catch {
    return false;
  }
}

function cargar() {
  if (cargando) return cargando;
  cargando = (async () => {
    const gpu = await tieneWebGPU();
    const progreso = {};
    const avisar = (p) => {
      // Varios archivos a la vez: se informa del total de bytes.
      if (p.status === 'progress' && p.file) {
        progreso[p.file] = { cargado: p.loaded || 0, total: p.total || 0 };
        const vals = Object.values(progreso);
        const total = vals.reduce((a, v) => a + v.total, 0);
        const cargado = vals.reduce((a, v) => a + v.cargado, 0);
        // Tope en 99: el 100 lo marca «listo», cuando el modelo ya está cargado.
        if (total > 0) self.postMessage({ tipo: 'progreso', pct: Math.min(99, Math.round((cargado / total) * 100)) });
      }
    };
    return pipeline('automatic-speech-recognition', MODELO, {
      device: gpu ? 'webgpu' : 'wasm',
      // En GPU el codificador pierde mucha calidad cuantizado; en CPU, q8 es
      // el equilibrio entre tamaño, velocidad y acierto.
      dtype: gpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
      progress_callback: avisar,
    });
  })();
  cargando.catch(() => { cargando = null; });
  return cargando;
}

self.onmessage = async ({ data }) => {
  // Mientras se graba ya se va bajando el modelo: al soltar no hay que esperar
  // la descarga entera.
  if (data.tipo === 'precargar') {
    cargar()
      .then(() => self.postMessage({ tipo: 'listo' }))
      .catch((err) => self.postMessage({ tipo: 'error', id: null, mensaje: String(err?.message || err) }));
    return;
  }
  const { id, audio, idioma } = data;
  try {
    const transcribir = await cargar();
    self.postMessage({ tipo: 'listo' });
    const salida = await transcribir(audio, {
      language: idioma || null,
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const bruto = (Array.isArray(salida) ? salida.map((s) => s.text).join(' ') : salida.text) || '';
    // Whisper rotula lo que no es voz: «[Música]», «[BLANK_AUDIO]», «(risas)».
    // Eso no es lo que el usuario dictó.
    const texto = bruto
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/^\s*\([^)]*\)\s*$/, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    self.postMessage({ tipo: 'texto', id, texto });
  } catch (err) {
    self.postMessage({ tipo: 'error', id, mensaje: String(err?.message || err) });
  }
};
