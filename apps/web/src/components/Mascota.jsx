import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../i18n/useT';
import {
  CUADROS, MS_CUADRO, NOMBRES, VERSION_SPRITES, alAzar, duracion, fijarMascota, personajeDe, sincronizarConCuenta, useMascota,
} from '../lib/mascota';

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
        '--d': `${cuadros * (MS_CUADRO[estado] || 200)}ms`,
        backgroundImage: `url(/mascotas/${personaje}-${estado}.png?v=${VERSION_SPRITES})`,
      }}
    />
  );
}

/** Bocadillo que se abre con rebote y escribe el texto letra a letra. El
    texto completo ocupa su sitio desde el principio (invisible) para que la
    caja no cambie de tamaño mientras se escribe. */
export function Bocadillo({ texto, mostrado, cerrando, children, className = '' }) {
  return (
    <span className={`mascota-bocadillo ${cerrando ? 'is-cerrando' : ''} ${className}`} role="status">
      {texto !== undefined ? (
        <span className="mascota-bocadillo__texto">
          <span className="mascota-bocadillo__molde" aria-hidden="true">{texto}</span>
          <span className="mascota-bocadillo__escrito">{mostrado}</span>
        </span>
      ) : children}
    </span>
  );
}

// La mascota solo existe en el navegador: en el prerender no se pinta, así el
// HTML del servidor y el del primer render coinciden.
function useMontado() {
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);
  return montado;
}

const sinMovimiento = () => typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

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

function useBocadillo(quieta) {
  const [b, setB] = useState(null);
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
    timers.current.push(setTimeout(() => callar(), ms + texto.length * 26));
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

function useAccion() {
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
function useGestos(activo, hacer) {
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

const VELOCIDAD = 150;
function useCaminata(ref, clave, lado, quieta) {
  const [estilo, setEstilo] = useState(null);
  const [caminando, setCaminando] = useState(false);
  const [haciaIzq, setHaciaIzq] = useState(false);
  const t = useRef(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!clave || !el || quieta || sinMovimiento()) return undefined;
    const r = el.getBoundingClientRect();
    const desde = lado === 'izq' ? -(r.right + 12) : window.innerWidth - r.left + 12;
    const ms = Math.min(3200, Math.max(500, (Math.abs(desde) / VELOCIDAD) * 1000));
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

  const salir = useCallback((fin) => {
    const el = ref.current;
    if (!el || quieta || sinMovimiento()) { fin(); return; }
    const r = el.getBoundingClientRect();
    const izq = r.left + r.width / 2 < window.innerWidth / 2;
    const hasta = izq ? -(r.right + 12) : window.innerWidth - r.left + 12;
    const ms = Math.min(2600, Math.max(400, (Math.abs(hasta) / (VELOCIDAD * 1.4)) * 1000));
    setHaciaIzq(izq);
    setCaminando(true);
    setEstilo({ transform: `translateX(${hasta}px)`, transition: `transform ${ms}ms linear` });
    clearTimeout(t.current);
    t.current = setTimeout(fin, ms);
  }, [ref, quieta]);

  useEffect(() => () => clearTimeout(t.current), []);
  return { estilo, caminando, haciaIzq, salir };
}

function saludoDeLaHora(t) {
  const h = new Date().getHours();
  return alAzar(t(h < 6 ? 'greet.night' : h < 13 ? 'greet.morning' : h < 20 ? 'greet.afternoon' : 'greet.night'));
}

export function MascotaChat({ ocupado, escribiendo }) {
  const prefs = useMascota();
  const montado = useMontado();
  const t = useT('mascota');
  const ref = useRef(null);
  const quieta = prefs.reducir;
  const bocadillo = useBocadillo(quieta);
  const [accion, hacer] = useAccion();
  const dormido = useInactivo(prefs.dormir_min, prefs.activa && prefs.dormir && !ocupado);
  const visible = montado && prefs.activa;
  const { estilo, caminando, haciaIzq } = useCaminata(ref, visible ? 'chat' : null, 'izq', quieta);
  const antes = useRef({ ocupado, dormido });
  const quien = personajeDe(prefs);
  const nombre = NOMBRES[quien];
  const libre = !ocupado && !dormido && !bocadillo.abierto && !accion && !caminando;

  useEffect(() => {
    if (!visible || caminando) return;
    try {
      if (sessionStorage.getItem('lixbon-mascota-saludo')) return;
      sessionStorage.setItem('lixbon-mascota-saludo', '1');
    } catch { /* sin almacenamiento: saluda igual */ }
    hacer('wave', duracion('wave') * 2);
    bocadillo.decir(saludoDeLaHora(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, caminando]);

  useEffect(() => {
    const prev = antes.current;
    antes.current = { ocupado, dormido };
    if (prev.ocupado && !ocupado) {
      hacer('celebrate', duracion('celebrate') * 2);
      setTimeout(() => bocadillo.decir(alAzar(t('chat.done'))), 500);
    } else if (prev.dormido && !dormido) {
      hacer('stretch');
      bocadillo.decir(alAzar(t('chat.wake')));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocupado, dormido]);

  useEffect(() => {
    if (!ocupado || escribiendo) return undefined;
    const tt = setTimeout(() => bocadillo.decir(alAzar(t('chat.thinkingLong')), 3000), 9000);
    return () => clearTimeout(tt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ocupado, escribiendo]);

  useGestos(visible && libre && !quieta, hacer);
  useEffect(() => {
    if (!visible || !libre) return undefined;
    const tt = setTimeout(() => bocadillo.decir(alAzar(t('chat.idle'))), 120_000 + Math.random() * 120_000);
    return () => clearTimeout(tt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, libre]);

  if (!visible) return null;

  let estado = 'idle';
  let rotulo = nombre;
  if (caminando) estado = 'walk';
  else if (ocupado) {
    estado = bocadillo.hablando ? 'talk' : escribiendo ? 'type' : 'think';
    rotulo = t(escribiendo ? 'chat.writing' : 'chat.thinking', { name: nombre });
  } else if (accion) estado = accion;
  else if (bocadillo.hablando) estado = 'talk';
  else if (dormido) {
    estado = 'sleep';
    rotulo = t('chat.sleeping', { name: nombre });
  }

  const pinchar = () => {
    if (ocupado || caminando) return;
    hacer(alAzar(['wave', 'celebrate', 'scratch']));
    bocadillo.decir(alAzar(t('chat.poke')), 2600);
  };
  const saludarAlPasar = () => { if (libre) hacer('wave'); };

  return (
    <div className={`mascota-chat mascota-chat--${estado}`} ref={ref} style={estilo || undefined}>
      {bocadillo.abierto && !caminando && <Bocadillo texto={bocadillo.texto} mostrado={bocadillo.mostrado} cerrando={bocadillo.cerrando} />}
      {estado === 'think' && <span className="mascota-puntos" aria-hidden="true"><i /><i /><i /></span>}
      {estado === 'sleep' && <span className="mascota-zzz" aria-hidden="true"><i>z</i><i>z</i><i>Z</i></span>}
      <button type="button" className="mascota-chat__boton" onClick={pinchar} onMouseEnter={saludarAlPasar} aria-label={rotulo} title={rotulo}>
        <SpriteMascota personaje={quien} estado={estado} tam={96} espejo={caminando && haciaIzq} quieta={quieta} className="mascota-chat__grande" />
        <SpriteMascota personaje={quien} estado={estado} tam={48} espejo={caminando && haciaIzq} quieta={quieta} className="mascota-chat__chica" />
      </button>
    </div>
  );
}

const ANCHO_BOCADILLO = 150;
const TOPE_SUPERIOR = 140;

const CONTENIDO = 'figure, img, svg, video, canvas, p, h1, h2, h3, h4, li, pre, table, a, button, input, textarea, label, .codeblock, .docs__callout, nav, header, footer';

// Por rectángulos y no con elementsFromPoint, que se salta lo que tiene
// pointer-events: none (las ilustraciones, por ejemplo).
function cajaLibre(contenido, x, y, w, h) {
  if (x < 0 || y < 0 || x + w > window.innerWidth || y + h > window.innerHeight) return false;
  for (const el of contenido) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.left < x + w && r.right > x && r.top < y + h && r.bottom > y) return false;
  }
  return true;
}

function moverCaja(el, xy) {
  if (el && xy) el.style.transform = `translate3d(${xy[0]}px, ${xy[1]}px, 0)`;
}

function clasificar(el, i, t) {
  const clave = el.dataset.mascota;
  if (clave) return alAzar(t(`guide.${clave}`));
  if (el.matches('.docs__callout')) return alAzar(t('guide.callout'));
  if (el.matches('pre, .codeblock')) return alAzar(t('guide.code'));
  if (el.matches('table, .docs__table-wrap')) return alAzar(t('guide.table'));
  const frases = t('guide.headings');
  return frases[(i + Math.floor(Math.random() * 3)) % frases.length];
}

export function MascotaGuia({ selector }) {
  const prefs = useMascota();
  const montado = useMontado();
  const t = useT('mascota');
  const ref = useRef(null);
  const caja = useRef(null);
  const coords = useRef(null);
  const modoPintado = useRef(null);
  const quieta = prefs.reducir;
  const bocadillo = useBocadillo(quieta);
  const [accion, hacer] = useAccion();
  const dormido = useInactivo(prefs.dormir_min, prefs.activa && prefs.guia && prefs.dormir);
  // En modo margen la posición exacta va por coords + transform, fuera de React,
  // para no re-renderizar en cada fotograma de scroll.
  const [pos, setPos] = useState(null);
  const [objetivo, setObjetivo] = useState(null);
  const [yendose, setYendose] = useState(false);
  const volvio = useRef(false);

  const visible = montado && prefs.activa && prefs.guia;
  const sitio = pos && pos.modo !== 'fuera' ? pos.modo : null;
  const lado = sitio === 'esquina' ? 'der' : 'izq';
  const { estilo, caminando, haciaIzq, salir } = useCaminata(ref, visible && sitio ? sitio : null, lado, quieta);

  useEffect(() => {
    if (!visible) return undefined;
    let raf = 0;
    let lista = [];
    let contenido = [];
    let sucio = true;
    const recoger = () => {
      sucio = false;
      lista = Array.from(document.querySelectorAll(selector));
      contenido = Array.from(document.querySelectorAll(CONTENIDO)).filter((el) => !el.closest('.mascota-guia, .mascota-volver'));
    };
    const fijar = (sig) => setPos((prev) => (prev && prev.modo === sig.modo && prev.tam === sig.tam && prev.ancho === sig.ancho && prev.burbuja === sig.burbuja ? prev : sig));
    const medir = () => {
      raf = 0;
      if (sucio) recoger();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const tam = vw < 720 ? 48 : 96;
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
      const alto = tam + 70;
      if (margen >= Math.max(tam, ANCHO_BOCADILLO) + 32) {
        const top = Math.min(Math.max(r.top + 12, TOPE_SUPERIOR), vh - tam - 16);
        const ancho = Math.min(220, Math.round(margen - 32));
        const left = Math.round(margen - tam - 16);
        if (cajaLibre(contenido, Math.min(left, margen - ancho - 16), top - 70, Math.max(tam, ancho), alto)) {
          coords.current = [left, Math.round(top)];
          if (modoPintado.current === 'margen') moverCaja(caja.current, coords.current);
          fijar({ modo: 'margen', tam, ancho, burbuja: true });
          setObjetivo((prev) => (prev?.el === elegido ? prev : { el: elegido, idx }));
          return;
        }
      }
      const yMascota = vh - tam - 16;
      const yBocadillo = yMascota - 76;
      let modo = 'fuera';
      let burbuja = false;
      if (cajaLibre(contenido, vw - tam - 16, yMascota, tam, tam)) {
        modo = 'esquina';
        burbuja = cajaLibre(contenido, vw - 236, yBocadillo, 220, 64);
      } else if (cajaLibre(contenido, 16, yMascota, tam, tam)) {
        modo = 'esquina-izq';
        burbuja = cajaLibre(contenido, 16, yBocadillo, 220, 64);
      }
      fijar({ modo, tam, burbuja });
      setObjetivo((prev) => (prev?.el === elegido ? prev : { el: elegido, idx }));
    };
    const pedir = () => { if (!raf) raf = requestAnimationFrame(medir); };
    medir();
    window.addEventListener('scroll', pedir, { passive: true });
    window.addEventListener('resize', pedir);
    // El contenido de las docs llega tras un skeleton: volver a recoger cuando
    // cambie, sin contar los cambios de la propia mascota (el bocadillo escribe).
    const obs = new MutationObserver((cambios) => {
      if (cambios.every((c) => c.target.closest?.('.mascota-guia'))) return;
      sucio = true;
      pedir();
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', pedir);
      window.removeEventListener('resize', pedir);
      obs.disconnect();
    };
  }, [visible, selector]);

  useLayoutEffect(() => {
    const el = caja.current;
    const modo = el ? pos?.modo : null;
    if (modo === modoPintado.current) return;
    modoPintado.current = modo;
    if (!el) return;
    // Al entrar en el margen se coloca sin transición: si no, cruzaría la
    // pantalla desde la esquina superior.
    el.style.transition = 'none';
    if (modo === 'margen') moverCaja(el, coords.current);
    else el.style.transform = '';
    void el.offsetWidth;
    el.style.transition = '';
  });

  useEffect(() => {
    if (!objetivo || caminando || yendose) return undefined;
    const entrar = setTimeout(() => {
      if (volvio.current) { volvio.current = false; bocadillo.decir(alAzar(t('guide.back'))); hacer('wave'); return; }
      bocadillo.decir(clasificar(objetivo.el, objetivo.idx, t), 4200);
    }, 350);
    return () => clearTimeout(entrar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objetivo, caminando]);

  const libre = visible && !caminando && !yendose && !bocadillo.abierto && !accion && !dormido;
  useGestos(libre && !quieta, hacer);
  useEffect(() => {
    if (!libre) return undefined;
    const tt = setTimeout(() => { bocadillo.decir(alAzar(t('guide.idle'))); hacer('look'); }, 40_000 + Math.random() * 30_000);
    return () => clearTimeout(tt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libre]);

  if (!montado || !prefs.activa) return null;
  const quien = personajeDe(prefs);
  const nombre = NOMBRES[quien];

  if (!prefs.guia) {
    return (
      <button type="button" className="mascota-volver" onClick={() => { volvio.current = true; fijarMascota({ guia: true }); }} aria-label={t('show', { name: nombre })} title={t('show', { name: nombre })}>
        <SpriteMascota personaje={quien} estado="idle" tam={48} quieta />
      </button>
    );
  }
  if (!pos || pos.modo === 'fuera') return null;

  const despedirse = () => {
    if (yendose) return;
    setYendose(true);
    bocadillo.decir(alAzar(t('guide.bye')), 900);
    setTimeout(() => {
      bocadillo.callar();
      salir(() => { setYendose(false); fijarMascota({ guia: false }); });
    }, quieta ? 0 : 700);
  };

  const hablando = bocadillo.abierto && pos.burbuja && !dormido;
  let estado = 'idle';
  if (caminando) estado = 'walk';
  else if (yendose) estado = 'wave';
  else if (accion) estado = accion;
  else if (bocadillo.hablando && pos.burbuja) estado = 'talk';
  else if (hablando) estado = 'point';
  else if (dormido) estado = 'sleep';

  const enEsquina = pos.modo !== 'margen';
  const espejo = caminando ? haciaIzq : pos.modo === 'esquina';
  const colocacion = enEsquina ? { '--w': `${pos.tam}px` } : { '--w': `${pos.tam}px`, '--ancho': `${pos.ancho}px` };

  return (
    <div ref={caja} className={`mascota-guia mascota-guia--${pos.modo}`} style={colocacion}>
      <div className="mascota-guia__cuerpo" ref={ref} style={estilo || undefined}>
        {hablando && !caminando && <Bocadillo texto={bocadillo.texto} mostrado={bocadillo.mostrado} cerrando={bocadillo.cerrando} />}
        {estado === 'sleep' && <span className="mascota-zzz" aria-hidden="true"><i>z</i><i>z</i><i>Z</i></span>}
        <button
          type="button"
          className="mascota-guia__boton"
          onClick={despedirse}
          onMouseEnter={() => { if (libre) hacer('wave'); }}
          aria-label={t('hide', { name: nombre })}
          title={t('hideHint')}
        >
          <SpriteMascota personaje={quien} estado={estado} tam={pos.tam} espejo={espejo} quieta={quieta} />
        </button>
      </div>
    </div>
  );
}
