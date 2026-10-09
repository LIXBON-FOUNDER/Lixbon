import { useEffect, useState } from 'react';

const TONO = 0.42;
const RECORRIDO = 420;
const ENTRADA = 1.5;
const FUENTE = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@1,9..144,300..680&text=lixbonfuder&display=swap';

// k = orden en que se recogen: de fuera hacia la l y la f.
const LETRAS = [
  { ch: 'l', clave: true },
  { ch: 'i', k: 4 }, { ch: 'x', k: 3 }, { ch: 'b', k: 2 }, { ch: 'o', k: 1 }, { ch: 'n', k: 0 },
  { ch: ' ', k: 5 },
  { ch: 'f', clave: true, f: true },
  { ch: 'o', k: 5 }, { ch: 'u', k: 4 }, { ch: 'n', k: 3 }, { ch: 'd', k: 2 }, { ch: 'e', k: 1 }, { ch: 'r', k: 0 },
];

const r = (n) => Math.round(n * 1000) / 1000;
const acota = (n) => Math.min(1, Math.max(0, n));
const sale3 = (x) => 1 - Math.pow(1 - x, 3);
const suave = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

// El diseño anima en segundos: la entrada ocupa 0–1,5 s y el cierre 2,4–5,2 s,
// que aquí se recorre con el progreso del scroll.
function estado(progreso, entrada) {
  const t = 2.4 + acota(progreso) * 2.8;
  const engrosa = suave(acota((t - 3.3) / 1.0));
  const une = suave(acota((t - 3.7) / 0.9));
  const letras = LETRAS.map((le, i) => {
    const sube = sale3(acota((entrada - (0.15 + i * 0.05)) / 0.7));
    const cierra = le.clave ? 0 : suave(acota((t - (3.0 + le.k * 0.09)) / 0.75));
    return {
      ch: le.ch,
      opacity: r((le.clave ? 1 : TONO) * sube * (1 - cierra)),
      transform: `translateY(${r((1 - sube) * 0.38)}em)`,
      fontSize: `${r(le.clave ? 1 : 1 - cierra)}em`,
      fontWeight: Math.round(le.clave ? 300 + 380 * engrosa : 300),
      marginLeft: le.f ? `${r(-0.07 * une)}em` : undefined,
    };
  });
  return { letras, trazo: r(sale3(acota((t - 4.3) / 0.7))) };
}

let fuente;
function cargarFuente() {
  fuente ??= new Promise((listo, fallo) => {
    const enlace = document.createElement('link');
    enlace.rel = 'stylesheet';
    enlace.href = FUENTE;
    enlace.onload = listo;
    enlace.onerror = fallo;
    document.head.appendChild(enlace);
  }).then(() => document.fonts.load('italic 680 46px Fraunces', 'lf'));
  return fuente;
}

export function LogoFounder({ progreso = 0, entrada = ENTRADA, className = '' }) {
  const { letras, trazo } = estado(progreso, entrada);
  return (
    <span className={`logo-founder ${className}`} role="img" aria-label="Lixbon Founder">
      {letras.map(({ ch, ...style }, i) => (
        <span key={i} className="logo-founder__l" aria-hidden="true" style={style}>{ch}</span>
      ))}
      <span
        className="logo-founder__trazo"
        aria-hidden="true"
        style={{ transform: `scaleX(${trazo})`, opacity: trazo > 0 ? 1 : 0 }}
      />
    </span>
  );
}

function useMovimientoReducido() {
  const [reducido] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  return reducido;
}

function useEntrada(reducido) {
  const [segundos, setSegundos] = useState(reducido ? ENTRADA : 0);
  useEffect(() => {
    if (reducido) return undefined;
    const inicio = performance.now();
    let cuadro = requestAnimationFrame(function paso(ahora) {
      const s = (ahora - inicio) / 1000;
      setSegundos(Math.min(s, ENTRADA));
      if (s < ENTRADA) cuadro = requestAnimationFrame(paso);
    });
    return () => cancelAnimationFrame(cuadro);
  }, [reducido]);
  return segundos;
}

function useProgresoScroll(reducido) {
  const [progreso, setProgreso] = useState(0);
  useEffect(() => {
    let cuadro = 0;
    const medir = () => {
      cuadro = 0;
      const p = acota(window.scrollY / RECORRIDO);
      setProgreso(reducido ? (p < 0.5 ? 0 : 1) : p);
    };
    const alMover = () => { if (!cuadro) cuadro = requestAnimationFrame(medir); };
    medir();
    window.addEventListener('scroll', alMover, { passive: true });
    return () => {
      window.removeEventListener('scroll', alMover);
      cancelAnimationFrame(cuadro);
    };
  }, [reducido]);
  return progreso;
}

// Un SVG de favicon no puede usar fuentes web, así que el monograma se pinta
// en un canvas cuando Fraunces ya cargó; mientras tanto queda founder.svg.
function dibujarMonograma() {
  const lado = 64;
  const lienzo = document.createElement('canvas');
  lienzo.width = lienzo.height = lado;
  const c = lienzo.getContext('2d');
  c.fillStyle = '#191917';
  c.beginPath();
  c.roundRect(0, 0, lado, lado, 14);
  c.fill();
  c.fillStyle = '#F5F4EE';
  c.font = 'italic 680 46px Fraunces';
  c.textBaseline = 'alphabetic';
  const anchoL = c.measureText('l').width;
  const solape = 46 * 0.07;
  const ancho = anchoL - solape + c.measureText('f').width;
  const x = (lado - ancho) / 2;
  const base = 44;
  c.fillText('l', x, base);
  c.fillText('f', x + anchoL - solape, base);
  c.fillRect(x + 1, base + 3, ancho - 2, 2.2);
  return lienzo.toDataURL('image/png');
}

function useFaviconFounder() {
  useEffect(() => {
    const enlaces = [...document.querySelectorAll('link[rel="icon"]')];
    const antes = enlaces.map((e) => [e.getAttribute('href'), e.getAttribute('type')]);
    const poner = (href, type) => enlaces.forEach((e) => { e.setAttribute('href', href); e.setAttribute('type', type); });
    let vivo = true;
    poner('/founder.svg', 'image/svg+xml');
    cargarFuente().then((caras) => {
      if (vivo && caras.length) poner(dibujarMonograma(), 'image/png');
    }).catch(() => {});
    return () => {
      vivo = false;
      enlaces.forEach((e, i) => {
        e.setAttribute('href', antes[i][0]);
        if (antes[i][1]) e.setAttribute('type', antes[i][1]);
        else e.removeAttribute('type');
      });
    };
  }, []);
}

export function LogoFounderScroll() {
  const reducido = useMovimientoReducido();
  useFaviconFounder();
  return <LogoFounder progreso={useProgresoScroll(reducido)} entrada={useEntrada(reducido)} />;
}
