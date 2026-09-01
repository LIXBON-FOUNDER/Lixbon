// useDictado.js — dictar el mensaje en vez de escribirlo.
//
// Usa el reconocimiento de voz del propio navegador (Chrome, Edge, Safari): no
// sube el audio a ningún sitio nuestro y no necesita nada en el gateway, que
// hoy no sabe transcribir. Donde el navegador no lo trae, `soportado` es false
// y el botón del micrófono ni se pinta — mejor que un botón que no hace nada.
import { useCallback, useEffect, useRef, useState } from 'react';

const Reconocimiento =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export function useDictado(onTexto) {
  const [escuchando, setEscuchando] = useState(false);
  const [error, setError] = useState('');
  const motor = useRef(null);
  const alTexto = useRef(onTexto);
  alTexto.current = onTexto;

  useEffect(() => () => {
    // Al desmontar hay que pararlo a mano: el micrófono seguiría abierto.
    try { motor.current?.stop(); } catch { /* ya estaba parado */ }
  }, []);

  const alternar = useCallback(() => {
    if (!Reconocimiento) return;

    if (motor.current) {
      try { motor.current.stop(); } catch { /* noop */ }
      motor.current = null;
      setEscuchando(false);
      return;
    }

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

    r.onerror = (evento) => {
      setError(evento.error === 'not-allowed'
        ? 'No diste permiso al micrófono.'
        : 'No se pudo escuchar el micrófono.');
      motor.current = null;
      setEscuchando(false);
    };

    r.onend = () => {
      motor.current = null;
      setEscuchando(false);
    };

    try {
      r.start();
      motor.current = r;
      setError('');
      setEscuchando(true);
    } catch {
      setError('No se pudo iniciar el dictado.');
    }
  }, []);

  return { soportado: !!Reconocimiento, escuchando, error, alternar };
}
