export const MAX_MS = 5 * 60 * 1000;

const FORMATOS = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function elegirFormato() {
  if (typeof MediaRecorder === 'undefined') return null;
  return FORMATOS.find((f) => MediaRecorder.isTypeSupported(f)) || '';
}

export function sePuedeGrabar() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && elegirFormato() !== null;
}

function traducir(err) {
  const n = err?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError') {
    return 'Lixbon no tiene permiso para usar el micrófono. Se concede en Ajustes de Windows → Privacidad y seguridad → Micrófono.';
  }
  if (n === 'NotFoundError' || n === 'OverconstrainedError') {
    return 'No se encontró ningún micrófono conectado.';
  }
  if (n === 'NotReadableError') {
    return 'El micrófono lo está usando otra aplicación.';
  }
  return 'No se pudo empezar a grabar.';
}

export async function grabar({ onNivel, onTiempo, onTope } = {}) {
  const formato = elegirFormato();
  if (formato === null) throw new Error('Este sistema no sabe grabar audio.');

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (e) {
    throw new Error(traducir(e));
  }

  const trozos = [];
  const rec = new MediaRecorder(stream, formato ? { mimeType: formato } : undefined);
  rec.ondataavailable = (e) => { if (e.data?.size) trozos.push(e.data); };

  const empezo = performance.now();
  let cerrado = false;

  let audioCtx = null;
  let raf = 0;
  if (onNivel) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const fuente = audioCtx.createMediaStreamSource(stream);
      const analizador = audioCtx.createAnalyser();
      analizador.fftSize = 512;
      fuente.connect(analizador);
      const muestras = new Float32Array(analizador.fftSize);
      const mirar = () => {
        analizador.getFloatTimeDomainData(muestras);
        let suma = 0;
        for (let i = 0; i < muestras.length; i += 1) suma += muestras[i] * muestras[i];
        const rms = Math.sqrt(suma / muestras.length);
        onNivel(Math.min(1, rms * 4));
        raf = requestAnimationFrame(mirar);
      };
      raf = requestAnimationFrame(mirar);
    } catch {
      audioCtx = null;
    }
  }

  const reloj = setInterval(() => {
    const va = performance.now() - empezo;
    onTiempo?.(va);
    if (va >= MAX_MS && rec.state === 'recording') {
      onTope?.();
      rec.stop();
    }
  }, 100);

  const soltar = () => {
    if (cerrado) return;
    cerrado = true;
    clearInterval(reloj);
    if (raf) cancelAnimationFrame(raf);
    audioCtx?.close().catch(() => {});
    for (const pista of stream.getTracks()) pista.stop();
  };

  const fin = new Promise((listo) => {
    rec.onstop = () => {
      const duracion_ms = Math.round(performance.now() - empezo);
      soltar();
      const tipo = rec.mimeType || formato || 'audio/webm';
      const blob = new Blob(trozos, { type: tipo });
      const sello = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const ext = tipo.includes('mp4') ? 'm4a' : tipo.includes('ogg') ? 'ogg' : 'webm';
      const file = new File([blob], `nota-de-voz-${sello}.${ext}`, { type: tipo });
      listo({ file, duracion_ms });
    };
  });

  rec.start(250);

  return {
    async parar() {
      if (rec.state !== 'inactive') rec.stop();
      return fin;
    },
    cancelar() {
      if (rec.state !== 'inactive') rec.stop();
      soltar();
      trozos.length = 0;
    },
  };
}
