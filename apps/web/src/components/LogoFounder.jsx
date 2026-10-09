import { useEffect, useRef, useState } from 'react';

const UMBRAL = 48;
const FUENTE = 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@1,9..144,300..680&text=lixbonfuder&display=swap';

// k = orden en que se recogen las letras de tono.
const LETRAS = [
  { ch: 'l', clave: true, l: true },
  { ch: 'i', k: 4 }, { ch: 'x', k: 3 }, { ch: 'b', k: 2 }, { ch: 'o', k: 1 }, { ch: 'n', k: 0 },
  { ch: ' ', k: 5 },
  { ch: 'f', clave: true, f: true },
  { ch: 'o', k: 5 }, { ch: 'u', k: 4 }, { ch: 'n', k: 3 }, { ch: 'd', k: 2 }, { ch: 'e', k: 1 }, { ch: 'r', k: 0 },
];

const claseLetra = (le) => `logo-founder__l ${le.clave ? 'logo-founder__l--clave' : 'logo-founder__l--tono'}${le.l ? ' logo-founder__l--l' : ''}${le.f ? ' logo-founder__l--f' : ''}`;

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

// La animación es CSS (transiciones al cambiar is-cerrado): animar por scroll
// desde React recalculaba tamaño y peso de cada letra en cada cuadro.
// `width` necesita un valor fijo para poder transicionar; se mide en una copia
// oculta porque las letras visibles pueden estar ya recogidas.
export function LogoFounder({ cerrado = false, className = '' }) {
  const medida = useRef(null);
  const [anchos, setAnchos] = useState(null);

  useEffect(() => {
    let vivo = true;
    const medir = () => {
      const nodo = medida.current;
      if (!vivo || !nodo) return;
      const base = parseFloat(getComputedStyle(nodo).fontSize);
      setAnchos([...nodo.children].map((c) => Math.round((c.getBoundingClientRect().width / base) * 1000) / 1000));
    };
    cargarFuente().then(medir, medir);
    return () => { vivo = false; };
  }, []);

  return (
    <span className={`logo-founder ${cerrado ? 'is-cerrado' : ''} ${className}`} role="img" aria-label="Lixbon Founder">
      {LETRAS.map((le, i) => (
        <span
          key={i}
          className={claseLetra(le)}
          aria-hidden="true"
          style={{ '--i': i, '--k': le.k, '--a': anchos?.[i] }}
        >{le.ch}</span>
      ))}
      <span className="logo-founder__medida" ref={medida} aria-hidden="true">
        {LETRAS.map((le, i) => <span key={i}>{le.ch}</span>)}
      </span>
    </span>
  );
}

function useCerradoScroll() {
  const [cerrado, setCerrado] = useState(false);
  useEffect(() => {
    const alMover = () => setCerrado(window.scrollY > UMBRAL);
    alMover();
    window.addEventListener('scroll', alMover, { passive: true });
    return () => window.removeEventListener('scroll', alMover);
  }, []);
  return cerrado;
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
  const solape = 46 * 0.13;
  const ancho = anchoL - solape + c.measureText('f').width;
  const x = (lado - ancho) / 2;
  const base = 44;
  c.fillText('l', x, base);
  c.fillText('f', x + anchoL - solape, base);
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
  useFaviconFounder();
  return <LogoFounder cerrado={useCerradoScroll()} />;
}
