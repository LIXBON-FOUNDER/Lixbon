// Dictado por voz. El motor se elige por navegador antes de pedir nada:
// - Chrome, Edge y Safari traen reconocimiento de voz que funciona: escribe
//   mientras hablas.
// - El resto (Brave, Opera, Firefox, Arc…) o no lo trae o lo trae roto
//   (Brave lo expone pero siempre falla con «network»): se graba el audio y lo
//   transcribe Whisper dentro del navegador, en un worker. El audio no sale del
//   equipo y el gateway no interviene.
// En los dos casos se expone el `stream` del micrófono para pintar la onda.
import { useCallback, useEffect, useRef, useState } from 'react';

const Reconocimiento =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

const PUEDE_GRABAR =
  typeof window !== 'undefined'
  && typeof window.MediaRecorder !== 'undefined'
  && Boolean(navigator.mediaDevices?.getUserMedia)
  && typeof WebAssembly !== 'undefined';

// Errores del reconocimiento del navegador que no se arreglan reintentando:
// red de seguridad por si la detección acierta mal; se sigue con Whisper.
const SIN_SERVICIO = new Set(['network', 'service-not-allowed', 'language-not-supported']);

// ¿El reconocimiento del navegador funciona de verdad aquí? Solo en los que
// tienen servicio de voz detrás; los demás Chromium exponen la API sin él.
function vozDelNavegador() {
  if (!Reconocimiento || typeof navigator === 'undefined') return false;
  if (navigator.brave) return false;
  const marcas = navigator.userAgentData?.brands?.map((b) => b.brand) || [];
  if (marcas.length) return marcas.some((b) => b === 'Google Chrome' || b === 'Microsoft Edge');
  // Sin userAgentData: Safari (macOS e iOS), que usa el dictado del sistema.
  const ua = navigator.userAgent || '';
  return /Safari\//.test(ua) && /Version\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg\/|OPR\//.test(ua);
}

const MOTOR = typeof window === 'undefined'
  ? null
  : vozDelNavegador() ? 'navegador' : PUEDE_GRABAR ? 'local' : null;

const idiomaCorto = () => (navigator.language || 'es').slice(0, 2).toLowerCase();

// Un solo worker para toda la página: el modelo se carga una vez.
let worker = null;
const oyentes = new Set();
function elWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/whisper.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => oyentes.forEach((f) => f(e.data));
  }
  return worker;
}

// Whisper espera audio mono a 16 kHz en Float32.
async function aMuestras(blob) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (buf.numberOfChannels === 1) return buf.getChannelData(0);
    const a = buf.getChannelData(0);
    const b = buf.getChannelData(1);
    const mono = new Float32Array(a.length);
    for (let i = 0; i < a.length; i += 1) mono[i] = (a[i] + b[i]) / 2;
    return mono;
  } finally {
    ctx.close();
  }
}

const errorDeMicro = (err) => (
  err?.name === 'NotAllowedError' ? 'not-allowed' : err?.name === 'NotFoundError' ? 'audio-capture' : 'start'
);

export function useDictado(onTexto) {
  const [stream, setStream] = useState(null); // micrófono abierto = grabando
  const [desde, setDesde] = useState(0);
  const [transcribiendo, setTranscribiendo] = useState(false);
  const [progreso, setProgreso] = useState(null);
  const [error, setError] = useState('');
  const motor = useRef(null);
  const grabador = useRef(null);
  const micro = useRef(null);
  const pendiente = useRef(null);
  const forzarLocal = useRef(false);
  const alTexto = useRef(onTexto);
  alTexto.current = onTexto;

  const cerrarMicro = useCallback(() => {
    micro.current?.getTracks().forEach((t) => t.stop());
    micro.current = null;
    setStream(null);
  }, []);

  useEffect(() => {
    const oir = (msg) => {
      if (msg.tipo === 'progreso') {
        setProgreso(msg.pct);
      } else if (msg.tipo === 'listo') {
        setProgreso(null);
      } else if (msg.tipo === 'texto' && msg.id === pendiente.current) {
        pendiente.current = null;
        setTranscribiendo(false);
        if (msg.texto) alTexto.current?.(msg.texto);
      } else if (msg.tipo === 'error' && (msg.id === pendiente.current || msg.id === null)) {
        console.warn('[dictado] whisper:', msg.mensaje);
        pendiente.current = null;
        setTranscribiendo(false);
        setProgreso(null);
        setError('local');
      }
    };
    oyentes.add(oir);
    return () => {
      oyentes.delete(oir);
      // Al desmontar hay que pararlo a mano: el micrófono seguiría abierto.
      try { motor.current?.stop(); } catch { /* ya estaba parado */ }
      try { grabador.current?.stop(); } catch { /* ya estaba parado */ }
      micro.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const empezarLocal = useCallback((s) => {
    const trozos = [];
    const rec = new MediaRecorder(s);
    rec.ondataavailable = (e) => { if (e.data.size) trozos.push(e.data); };
    rec.onstop = async () => {
      grabador.current = null;
      cerrarMicro();
      if (rec.cancelado || !trozos.length) return;
      const id = Date.now();
      pendiente.current = id;
      setTranscribiendo(true);
      try {
        const audio = await aMuestras(new Blob(trozos, { type: rec.mimeType }));
        elWorker().postMessage({ id, audio, idioma: idiomaCorto() }, [audio.buffer]);
      } catch (err) {
        console.warn('[dictado] no se pudo leer el audio:', err);
        pendiente.current = null;
        setTranscribiendo(false);
        setError('local');
      }
    };
    rec.start();
    grabador.current = rec;
    // Se baja el modelo mientras hablas (solo tarda la primera vez).
    elWorker().postMessage({ tipo: 'precargar' });
  }, [cerrarMicro]);

  const empezarNavegador = useCallback((s) => {
    const r = new Reconocimiento();
    r.lang = navigator.language || 'es-ES';
    r.continuous = true;
    // Solo se entregan los tramos ya cerrados: los provisionales cambian solos
    // mientras hablas y harían bailar el texto dentro de la caja.
    r.interimResults = false;
    r.onresult = (evento) => {
      let nuevo = '';
      for (let i = evento.resultIndex; i < evento.results.length; i += 1) {
        if (evento.results[i].isFinal) nuevo += evento.results[i][0].transcript;
      }
      if (nuevo.trim()) alTexto.current?.(nuevo.trim());
    };
    // `error` es el código del navegador; el texto lo pone quien pinta el
    // aviso. Silencio o parada a mano no son fallos: el dictado termina.
    r.onerror = (evento) => {
      if (motor.current === r) motor.current = null;
      if (SIN_SERVICIO.has(evento.error) && PUEDE_GRABAR && micro.current) {
        // La detección falló: se sigue grabando con Whisper sin cortar.
        forzarLocal.current = true;
        empezarLocal(micro.current);
        return;
      }
      cerrarMicro();
      if (evento.error !== 'no-speech' && evento.error !== 'aborted') {
        console.warn('[dictado] error del reconocimiento de voz:', evento.error, evento.message || '');
        setError(evento.error || 'unknown');
      }
    };
    r.onend = () => {
      if (motor.current !== r) return;
      motor.current = null;
      cerrarMicro();
    };
    try {
      r.start();
      motor.current = r;
    } catch (err) {
      console.warn('[dictado] no se pudo iniciar:', err);
      cerrarMicro();
      setError('start');
    }
  }, [cerrarMicro, empezarLocal]);

  const empezar = useCallback(async () => {
    if (micro.current || pendiente.current) return;
    const local = MOTOR === 'local' || forzarLocal.current;
    if (!local && MOTOR !== 'navegador') { setError('service-not-allowed'); return; }
    let s;
    try {
      s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setError(errorDeMicro(err));
      return;
    }
    micro.current = s;
    setError('');
    setDesde(Date.now());
    setStream(s);
    if (local) empezarLocal(s);
    else empezarNavegador(s);
  }, [empezarLocal, empezarNavegador]);

  // Detener: con Whisper, transcribe lo grabado; con el navegador, lo dicho
  // ya está escrito.
  const detener = useCallback(() => {
    if (grabador.current) {
      try { grabador.current.stop(); } catch { cerrarMicro(); }
      return;
    }
    const r = motor.current;
    motor.current = null;
    try { r?.stop(); } catch { /* noop */ }
    cerrarMicro();
  }, [cerrarMicro]);

  // Cancelar: se descarta el audio sin transcribir.
  const cancelar = useCallback(() => {
    if (grabador.current) {
      grabador.current.cancelado = true;
      try { grabador.current.stop(); } catch { cerrarMicro(); }
      return;
    }
    const r = motor.current;
    motor.current = null;
    try { r?.abort(); } catch { /* noop */ }
    cerrarMicro();
  }, [cerrarMicro]);

  return {
    soportado: MOTOR !== null,
    escuchando: Boolean(stream),
    stream,
    desde,
    // '' | 'cargando' (bajando el modelo, solo la primera vez) | 'transcribiendo'
    estado: progreso !== null ? 'cargando' : transcribiendo ? 'transcribiendo' : '',
    progreso,
    error,
    empezar,
    detener,
    cancelar,
  };
}
