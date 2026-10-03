// mascotaVida.js — lo que hace que Gael y Leya no se vean secos (mismo
// comportamiento que en la web):
//   · useBocadillo: lo que dicen aparece con rebote y se escribe letra a letra.
//   · useAccion: una animación que dura un rato (celebrar, saludar…).
//   · useGestos: gestos sueltos en reposo (mirar a los lados, estirarse…).
//   · useCaminata: entrar y salir caminando desde el borde de la ventana.
//   · useInactivo: para la siesta.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { alAzar, duracion } from '../lib/mascota';

const sinMovimiento = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** true tras `minutos` sin teclado ni ratón. */
export function useInactivo(minutos, activo) {
  const [inactivo, setInactivo] = useState(false);
  useEffect(() => {
    if (!activo) { setInactivo(false); return undefined; }
    let t;
    const despertar = () => {
      setInactivo(false);
      clearTimeout(t);
      t = setTimeout(() => setInactivo(true), minutos * 60_000);
    };
    const eventos = ['pointermove', 'pointerdown', 'keydown', 'wheel'];
    eventos.forEach((e) => window.addEventListener(e, despertar, { passive: true }));
    despertar();
    return () => { clearTimeout(t); eventos.forEach((e) => window.removeEventListener(e, despertar)); };
  }, [minutos, activo]);
  return inactivo;
}

/** Lo que dice: aparece, se escribe solo y se va pasado `ms` (con `ms` null
    se queda hasta que se calle). */
export function useBocadillo(quieta) {
  const [b, setB] = useState(null); // { texto, n, cerrando }
  const timers = useRef([]);
  const limpiar = () => { timers.current.forEach(clearTimeout); timers.current = []; };

  const callar = useCallback(() => {
    limpiar();
    setB((x) => (x ? { ...x, cerrando: true } : x));
    timers.current.push(setTimeout(() => setB(null), 200));
  }, []);

  const decir = useCallback((texto, ms = 3600) => {
    if (!texto) return;
    limpiar();
    setB({ texto, n: quieta ? texto.length : 0, cerrando: false });
    if (ms !== null) timers.current.push(setTimeout(() => callar(), ms + texto.length * 26));
  }, [quieta, callar]);

  useEffect(() => {
    if (!b || b.n >= b.texto.length) return undefined;
    const t = setTimeout(() => setB((x) => (x ? { ...x, n: Math.min(x.texto.length, x.n + 1) } : x)), 26);
    return () => clearTimeout(t);
  }, [b]);
  useEffect(() => () => limpiar(), []);

  return {
    texto: b?.texto,
    mostrado: b ? b.texto.slice(0, b.n) : '',
    hablando: !!b && b.n < b.texto.length,
    abierto: !!b,
    cerrando: !!b?.cerrando,
    decir,
    callar,
  };
}

export function useAccion() {
  const [accion, setAccion] = useState(null);
  const t = useRef(null);
  const hacer = useCallback((estado, ms = duracion(estado)) => {
    clearTimeout(t.current);
    setAccion(estado);
    t.current = setTimeout(() => setAccion(null), ms);
  }, []);
  useEffect(() => () => clearTimeout(t.current), []);
  return [accion, hacer];
}

const GESTOS = ['look', 'look', 'look', 'scratch', 'stretch', 'wave'];
export function useGestos(activo, hacer) {
  useEffect(() => {
    if (!activo) return undefined;
    let t;
    const siguiente = () => {
      t = setTimeout(() => {
        const g = alAzar(GESTOS);
        hacer(g, duracion(g) * (g === 'scratch' ? 2 : 1));
        siguiente();
      }, 7000 + Math.random() * 9000);
    };
    siguiente();
    return () => clearTimeout(t);
  }, [activo, hacer]);
}

/** Entra caminando desde el borde `lado` ('izq' | 'der') cada vez que cambia
    `clave`. Devuelve el estilo del envoltorio, si está caminando y hacia dónde. */
const VELOCIDAD = 150; // px por segundo
export function useCaminata(ref, clave, lado, quieta) {
  const [estilo, setEstilo] = useState(null);
  const [caminando, setCaminando] = useState(false);
  const [haciaIzq, setHaciaIzq] = useState(false);
  const t = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!clave || !el || quieta || sinMovimiento()) return undefined;
    const r = el.getBoundingClientRect();
    const desde = lado === 'izq' ? -(r.right + 12) : window.innerWidth - r.left + 12;
    const ms = Math.min(3000, Math.max(500, (Math.abs(desde) / VELOCIDAD) * 1000));
    setHaciaIzq(desde > 0);
    setCaminando(true);
    setEstilo({ transform: `translateX(${desde}px)`, transition: 'none' });
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => {
      setEstilo({ transform: 'translateX(0)', transition: `transform ${ms}ms linear` });
    }));
    clearTimeout(t.current);
    t.current = setTimeout(() => { setCaminando(false); setEstilo(null); }, ms);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  useEffect(() => () => clearTimeout(t.current), []);
  return { estilo, caminando, haciaIzq };
}
