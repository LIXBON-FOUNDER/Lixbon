// Onda de la grabación: barras con el volumen real del micrófono que entran
// por la derecha y avanzan hacia la izquierda, como una nota de voz. Si
// hablas, se mueve; si no se mueve, el micrófono no te está oyendo.
import { useEffect, useRef, useState } from 'react';

const ANCHO_BARRA = 3;
const HUECO = 2;
const CADA_MS = 70; // una barra nueva cada 70 ms

export function OndaVoz({ stream }) {
  const lienzo = useRef(null);

  useEffect(() => {
    const canvas = lienzo.current;
    if (!stream || !canvas) return undefined;
    const ctx = new AudioContext();
    const fuente = ctx.createMediaStreamSource(stream);
    const analizador = ctx.createAnalyser();
    analizador.fftSize = 1024;
    fuente.connect(analizador);
    const muestras = new Float32Array(analizador.fftSize);
    const g = canvas.getContext('2d');
    let niveles = [];
    let ultimo = 0;
    let pico = 0;
    let raf = 0;

    const pintar = (ahora) => {
      raf = requestAnimationFrame(pintar);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      // Entre barra y barra se guarda el pico, para no perder sílabas cortas.
      analizador.getFloatTimeDomainData(muestras);
      let suma = 0;
      for (let i = 0; i < muestras.length; i += 1) suma += muestras[i] * muestras[i];
      pico = Math.max(pico, Math.sqrt(suma / muestras.length));
      const caben = Math.max(1, Math.floor(w / (ANCHO_BARRA + HUECO)));
      if (ahora - ultimo >= CADA_MS) {
        ultimo = ahora;
        // Curva suave: la voz normal (RMS 0,02–0,2) llena bien la altura.
        niveles.push(Math.min(1, Math.sqrt(pico * 6)));
        pico = 0;
        if (niveles.length > caben) niveles = niveles.slice(-caben);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.fillStyle = getComputedStyle(canvas).color;
      // Pista de puntos tenues: se ve dónde va a ir la onda desde el primer instante.
      g.globalAlpha = 0.22;
      for (let x = 0; x + ANCHO_BARRA <= w; x += ANCHO_BARRA + HUECO) {
        g.beginPath();
        g.roundRect(x, (h - 2) / 2, ANCHO_BARRA, 2, 1);
        g.fill();
      }
      g.globalAlpha = 1;
      const desde = w - niveles.length * (ANCHO_BARRA + HUECO);
      niveles.forEach((n, i) => {
        const alto = Math.max(2, n * (h - 2));
        const x = desde + i * (ANCHO_BARRA + HUECO);
        g.beginPath();
        g.roundRect(x, (h - alto) / 2, ANCHO_BARRA, alto, ANCHO_BARRA / 2);
        g.fill();
      });
    };
    raf = requestAnimationFrame(pintar);
    return () => {
      cancelAnimationFrame(raf);
      fuente.disconnect();
      ctx.close();
    };
  }, [stream]);

  return <canvas ref={lienzo} className="onda-voz" aria-hidden="true" />;
}

// Tiempo grabado (m:ss) desde `desde`.
export function TiempoGrabado({ desde }) {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAhora(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((ahora - desde) / 1000));
  return <span className="dictado__tiempo">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>;
}
