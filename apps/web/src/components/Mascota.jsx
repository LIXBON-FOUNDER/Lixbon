// Mascota.jsx — Gael y Leya en la web. Tres piezas:
//   · SpriteMascota: un estado animado (tira de cuadros pixel art).
//   · MascotaChat: sentada junto al compositor; piensa, escribe o se duerme.
//   · MascotaGuia: acompaña la lectura en las páginas públicas y comenta la
//     sección que estás viendo, siempre en un margen o en la esquina, nunca
//     encima del texto. Un clic la oculta; queda un botoncito para traerla.
// Las preferencias viven en lib/mascota.js (Ajustes › Mascota).
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n/useT';
import { CUADROS, NOMBRES, fijarMascota, personajeDe, sincronizarConCuenta, useMascota } from '../lib/mascota';

/** Al iniciar o cerrar sesión, la mascota toma los ajustes de la cuenta. */
export function MascotaSync() {
  const { user } = useAuth();
  useEffect(() => { sincronizarConCuenta(user); }, [user]);
  return null;
}

export function SpriteMascota({ personaje, estado = 'idle', tam = 96, espejo = false, quieta = false, className = '' }) {
  const cuadros = CUADROS[estado] || 1;
  return (
    <span
      aria-hidden="true"
      className={`mascota-sprite mascota-sprite--${estado} ${espejo ? 'is-espejo' : ''} ${quieta ? 'is-quieta' : ''} ${className}`}
      style={{
        '--w': `${tam}px`,
        '--n': cuadros,
        backgroundImage: `url(/mascotas/${personaje}-${estado}.png)`,
      }}
    />
  );
}

export function Bocadillo({ children, className = '' }) {
  return <span className={`mascota-bocadillo ${className}`}>{children}</span>;
}

// La mascota solo existe en el navegador: en el prerender no se pinta, así el
// HTML del servidor y el del primer render coinciden.
function useMontado() {
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);
  return montado;
}

/** true tras `minutos` sin que el usuario mueva el ratón, toque o escriba. */
function useInactivo(minutos, activo) {
  const [inactivo, setInactivo] = useState(false);
  useEffect(() => {
    if (!activo) { setInactivo(false); return undefined; }
    let t;
    const despertar = () => {
      setInactivo(false);
      clearTimeout(t);
      t = setTimeout(() => setInactivo(true), minutos * 60_000);
    };
    const eventos = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];
    eventos.forEach((e) => window.addEventListener(e, despertar, { passive: true }));
    despertar();
    return () => {
      clearTimeout(t);
      eventos.forEach((e) => window.removeEventListener(e, despertar));
    };
  }, [minutos, activo]);
  return inactivo;
}

/** Mensaje que se muestra un rato y se va solo. */
function useMomento() {
  const [momento, setMomento] = useState(null);
  const t = useRef(null);
  const mostrar = (texto, ms = 2600, estado = 'wave') => {
    clearTimeout(t.current);
    setMomento({ texto, estado });
    t.current = setTimeout(() => setMomento(null), ms);
  };
  useEffect(() => () => clearTimeout(t.current), []);
  return [momento, mostrar];
}

// ── Chat ────────────────────────────────────────────────────────────────

/** `ocupado`: el modelo está respondiendo. `escribiendo`: ya llegan tokens
    (si no, está pensando). */
export function MascotaChat({ ocupado, escribiendo }) {
  const prefs = useMascota();
  const montado = useMontado();
  const t = useT('mascota');
  const dormido = useInactivo(prefs.dormir_min, prefs.activa && prefs.dormir && !ocupado);
  const [momento, mostrar] = useMomento();
  const antes = useRef(ocupado);

  // Al terminar una respuesta, saluda un momento.
  useEffect(() => {
    if (antes.current && !ocupado) mostrar(t('chat.done'));
    antes.current = ocupado;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocupado]);

  if (!montado || !prefs.activa) return null;
  const quien = personajeDe(prefs);
  const nombre = NOMBRES[quien];

  let estado = 'idle';
  let rotulo = nombre;
  if (ocupado) {
    estado = escribiendo ? 'type' : 'think';
    rotulo = t(escribiendo ? 'chat.writing' : 'chat.thinking', { name: nombre });
  } else if (momento) {
    estado = momento.estado;
  } else if (dormido) {
    estado = 'sleep';
    rotulo = t('chat.sleeping', { name: nombre });
  }

  const pinchar = () => {
    if (ocupado) return;
    const frases = t('chat.poke');
    mostrar(frases[Math.floor(Math.random() * frases.length)], 2400);
  };

  return (
    <div className={`mascota-chat mascota-chat--${estado}`}>
      {momento && !ocupado && <Bocadillo>{momento.texto}</Bocadillo>}
      {estado === 'think' && <span className="mascota-puntos" aria-hidden="true"><i /><i /><i /></span>}
      {estado === 'sleep' && <span className="mascota-zzz" aria-hidden="true"><i>z</i><i>z</i><i>Z</i></span>}
      <button type="button" className="mascota-chat__boton" onClick={pinchar} aria-label={rotulo} title={rotulo}>
        <SpriteMascota personaje={quien} estado={estado} tam={96} quieta={prefs.reducir} className="mascota-chat__grande" />
        <SpriteMascota personaje={quien} estado={estado} tam={48} quieta={prefs.reducir} className="mascota-chat__chica" />
      </button>
    </div>
  );
}

// ── Guía de las páginas públicas ────────────────────────────────────────

const ANCHO_BOCADILLO = 150;
// Bajo la barra pública (60px) y con sitio para el bocadillo encima.
const TOPE_SUPERIOR = 140;


// Lo que cuenta como contenido: si la mascota (o su bocadillo) cae encima de
// algo de esto, ese sitio no vale.
const CONTENIDO = 'figure, img, svg, video, canvas, p, h1, h2, h3, h4, li, pre, table, a, button, input, textarea, label, .codeblock, .docs__callout, nav, header, footer';

/** ¿Está libre de contenido la caja (en coordenadas de la ventana)? Se mira
    por rectángulos y no con elementsFromPoint, que se salta lo que tiene
    pointer-events: none (las ilustraciones, por ejemplo). */
function cajaLibre(x, y, w, h) {
  if (x < 0 || y < 0 || x + w > window.innerWidth || y + h > window.innerHeight) return false;
  for (const el of document.querySelectorAll(CONTENIDO)) {
    if (el.closest('.mascota-guia, .mascota-volver')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.left < x + w && r.right > x && r.top < y + h && r.bottom > y) return false;
  }
  return true;
}

function clasificar(el, i, t) {
  const clave = el.dataset.mascota;
  if (clave) return t(`guide.${clave}`);
  if (el.matches('.docs__callout')) return t('guide.callout');
  if (el.matches('pre, .codeblock')) return t('guide.code');
  if (el.matches('table, .docs__table-wrap')) return t('guide.table');
  const frases = t('guide.headings');
  return frases[i % frases.length];
}

/** `selector`: los elementos que puede comentar, en orden de lectura. */
export function MascotaGuia({ selector }) {
  const prefs = useMascota();
  const montado = useMontado();
  const t = useT('mascota');
  const dormido = useInactivo(prefs.dormir_min, prefs.activa && prefs.guia && prefs.dormir);
  const [pos, setPos] = useState(null);        // { modo, left, top, tam }
  const [objetivo, setObjetivo] = useState(null);
  const [frase, setFrase] = useState(null);
  const ocultar = useRef(null);

  const visible = montado && prefs.activa && prefs.guia;

  useEffect(() => {
    if (!visible) return undefined;
    let raf = 0;
    const medir = () => {
      raf = 0;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const tam = vw < 720 ? 48 : 96;
      const lista = Array.from(document.querySelectorAll(selector));
      // El último que ya entró en la franja de lectura (algo menos de media
      // pantalla); al principio de la página, el primero.
      let elegido = null;
      let idx = -1;
      lista.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.height === 0) return;
        if (r.top < vh * 0.42) { elegido = el; idx = i; }
      });
      if (!elegido && lista.length && lista[0].getBoundingClientRect().top >= vh * 0.42) { elegido = lista[0]; idx = 0; }
      if (!elegido) return;
      const r = elegido.getBoundingClientRect();
      const margen = r.left;
      const alto = tam + 70; // la mascota y su bocadillo encima
      // En el margen izquierdo, a la altura de lo que señala, si cabe con su
      // bocadillo y no pisa nada; si no, en una esquina libre de abajo.
      if (margen >= Math.max(tam, ANCHO_BOCADILLO) + 32) {
        const top = Math.min(Math.max(r.top + 12, TOPE_SUPERIOR), vh - tam - 16);
        const ancho = Math.min(220, Math.round(margen - 32));
        const left = Math.round(margen - tam - 16);
        if (cajaLibre(Math.min(left, margen - ancho - 16), top - 70, Math.max(tam, ancho), alto)) {
          setPos({ modo: 'margen', left, top: Math.round(top), tam, ancho, burbuja: true });
          setObjetivo((prev) => (prev?.el === elegido ? prev : { el: elegido, idx }));
          return;
        }
      }
      // Sin hueco en ninguna esquina (el pie de página, una tabla ancha…) se
      // aparta hasta que lo haya.
      // El bocadillo solo sale si también le queda sitio.
      const yMascota = vh - tam - 16;
      const yBocadillo = yMascota - 76;
      let modo = 'fuera';
      let burbuja = false;
      if (cajaLibre(vw - tam - 16, yMascota, tam, tam)) {
        modo = 'esquina';
        burbuja = cajaLibre(vw - 236, yBocadillo, 220, 64);
      } else if (cajaLibre(16, yMascota, tam, tam)) {
        modo = 'esquina-izq';
        burbuja = cajaLibre(16, yBocadillo, 220, 64);
      }
      setPos({ modo, tam, burbuja });
      setObjetivo((prev) => (prev?.el === elegido ? prev : { el: elegido, idx }));
    };
    const pedir = () => { if (!raf) raf = requestAnimationFrame(medir); };
    medir();
    window.addEventListener('scroll', pedir, { passive: true });
    window.addEventListener('resize', pedir);
    // El contenido de las docs llega tras un skeleton: volver a medir cuando cambie.
    const obs = new MutationObserver(pedir);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', pedir);
      window.removeEventListener('resize', pedir);
      obs.disconnect();
    };
  }, [visible, selector]);

  // Cada sección nueva, un comentario que se va solo a los pocos segundos.
  useEffect(() => {
    if (!objetivo) return undefined;
    clearTimeout(ocultar.current);
    const entrar = setTimeout(() => {
      setFrase(clasificar(objetivo.el, objetivo.idx, t));
      ocultar.current = setTimeout(() => setFrase(null), 5200);
    }, 450);
    return () => clearTimeout(entrar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objetivo]);
  useEffect(() => () => clearTimeout(ocultar.current), []);

  if (!montado || !prefs.activa) return null;
  const quien = personajeDe(prefs);
  const nombre = NOMBRES[quien];

  if (!prefs.guia) {
    return (
      <button type="button" className="mascota-volver" onClick={() => fijarMascota({ guia: true })} aria-label={t('show', { name: nombre })} title={t('show', { name: nombre })}>
        <SpriteMascota personaje={quien} estado="idle" tam={48} quieta />
      </button>
    );
  }
  if (!pos || pos.modo === 'fuera') return null;

  const hablando = Boolean(frase) && !dormido && pos.burbuja;
  const estado = dormido ? 'sleep' : hablando ? 'point' : 'idle';
  const enEsquina = pos.modo !== 'margen';
  const estilo = enEsquina ? { '--w': `${pos.tam}px` } : { left: pos.left, top: pos.top, '--w': `${pos.tam}px`, '--ancho': `${pos.ancho}px` };

  return (
    <div className={`mascota-guia mascota-guia--${pos.modo}`} style={estilo}>
      {hablando && <Bocadillo key={frase}>{frase}</Bocadillo>}
      {dormido && <span className="mascota-zzz" aria-hidden="true"><i>z</i><i>z</i><i>Z</i></span>}
      <button
        type="button"
        className="mascota-guia__boton"
        onClick={() => fijarMascota({ guia: false })}
        aria-label={t('hide', { name: nombre })}
        title={t('hideHint')}
      >
        {/* Siempre mira hacia el contenido: en la esquina derecha, a su izquierda. */}
        <SpriteMascota personaje={quien} estado={estado} tam={pos.tam} espejo={pos.modo === 'esquina'} quieta={prefs.reducir} />
      </button>
    </div>
  );
}
