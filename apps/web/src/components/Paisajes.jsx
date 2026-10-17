// Lo "aleatorio" (flores, estrellas, destellos) sale de una semilla fija para
// que el prerender y el navegador pinten lo mismo.
import { createContext, useContext, useEffect, useId, useRef } from 'react';

const r1 = (n) => Math.round(n * 10) / 10;

function azar(semilla) {
  let s = semilla;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

// Una línea de cumbres suave que pasa por `pts` y se cierra hasta `base`.
// Catmull-Rom convertido a Bézier: basta con dar las alturas a mano.
function cresta(pts, base) {
  let d = `M${pts[0][0]} ${base}L${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${r1(c1[0])} ${r1(c1[1])} ${r1(c2[0])} ${r1(c2[1])} ${p2[0]} ${p2[1]}`;
  }
  return `${d}L${pts[pts.length - 1][0]} ${base}Z`;
}

function Vertical({ id, paradas }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      {paradas.map(([o, c, a = 1]) => <stop key={o} offset={o} stopColor={c} stopOpacity={a} />)}
    </linearGradient>
  );
}

function pino(x, y, h) {
  const w = h * 0.5;
  return `M${x} ${r1(y - h)}L${r1(x + w * 0.34)} ${r1(y - h * 0.64)}L${r1(x + w * 0.18)} ${r1(y - h * 0.64)}L${r1(x + w * 0.5)} ${r1(y - h * 0.32)}L${r1(x + w * 0.28)} ${r1(y - h * 0.32)}L${r1(x + w * 0.62)} ${y}L${r1(x - w * 0.62)} ${y}L${r1(x - w * 0.28)} ${r1(y - h * 0.32)}L${r1(x - w * 0.5)} ${r1(y - h * 0.32)}L${r1(x - w * 0.18)} ${r1(y - h * 0.64)}L${r1(x - w * 0.34)} ${r1(y - h * 0.64)}Z`;
}

const Arboles = ({ forma, lista, fill, opacity }) => (
  <path d={lista.map(([x, y, h]) => forma(x, y, h)).join('')} fill={fill} opacity={opacity} />
);

// Cada capa es un <svg> propio: un transform sobre un <g> interno obliga a
// re-rasterizar el SVG entero en cada fotograma; sobre el <svg> solo se compone.
// El transform se escribe en cada capa y no como variable en el marco, que
// invalidaría el estilo de todos los nodos del dibujo.
function useParallax() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const capas = [...el.querySelectorAll('.capa')].map((c) => [c, Number(c.dataset.d)]);
    const quieto = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let visible = false;
    let raf = 0;
    const pintar = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = Math.max(-1, Math.min(1, (r.top + r.height / 2 - vh / 2) / (vh / 2 + r.height / 2)));
      for (const [c, d] of capas) c.style.transform = `translate3d(0, ${(p * d).toFixed(1)}px, 0)`;
    };
    const alMover = () => { if (visible && !quieto && !raf) raf = requestAnimationFrame(pintar); };
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      el.classList.toggle('paisaje--fuera', !visible);
      alMover();
    });
    io.observe(el);
    window.addEventListener('scroll', alMover, { passive: true });
    window.addEventListener('resize', alMover);
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', alMover);
      window.removeEventListener('resize', alMover);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return ref;
}

const MarcoVb = createContext('');

function Marco({ vb, className, children }) {
  const ref = useParallax();
  return (
    <div ref={ref} className={className}>
      <MarcoVb.Provider value={vb}>{children}</MarcoVb.Provider>
    </div>
  );
}

// Lo que se anima es la capa entera (opacidad o desplazamiento del <svg>), que
// el compositor mueve sin repintar. Animar elementos sueltos dentro del dibujo
// lo repintaba en cada fotograma.
function Capa({ d, clase, children }) {
  const vb = useContext(MarcoVb);
  return (
    <svg className={[d && 'capa', clase].filter(Boolean).join(' ') || undefined} data-d={d} viewBox={vb} preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

function useIds() {
  const base = useId().replace(/:/g, '');
  return (n) => `${base}${n}`;
}

export function PaisajeCrepusculo({ className = '' }) {
  const id = useIds();
  const u = (n) => `url(#${id(n)})`;
  const rnd = azar(42);
  // El cuarto valor (retardo) ya no se usa, pero se sigue sacando para no
  // cambiar la secuencia de la semilla y que el dibujo quede igual.
  const estrellas = Array.from({ length: 90 }, () => [r1(rnd() * 1600), r1(rnd() * 400), r1(0.6 + rnd() * 1.8), r1(rnd() * 4)]);
  const bosque = Array.from({ length: 46 }, (_, i) => [r1(i * 36 + rnd() * 20 - 20), r1(560 + Math.sin(i * 0.5) * 10 + rnd() * 6), r1(26 + rnd() * 34)]);
  const luciernagas = Array.from({ length: 14 }, () => [r1(120 + rnd() * 520), r1(640 + rnd() * 110), r1(rnd() * 3)]);
  return (
    <Marco vb="0 0 1600 800" className={`paisaje paisaje--noche ${className}`}>
        <Capa>
        <defs>
          <Vertical id={id('cielo')} paradas={[[0, '#1B1F2A'], [0.35, '#34344A'], [0.58, '#6E5563'], [0.72, '#B8795C'], [0.8, '#E3A366']]} />
          <radialGradient id={id('via')} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#F6EEDC" stopOpacity=".16" />
            <stop offset="1" stopColor="#F6EEDC" stopOpacity="0" />
          </radialGradient>
          <radialGradient id={id('luna')} cx="1262" cy="210" r="150" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#F6EEDC" stopOpacity=".28" />
            <stop offset="1" stopColor="#F6EEDC" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={id('fugaz')} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#F6EEDC" stopOpacity="0" />
            <stop offset="1" stopColor="#F6EEDC" stopOpacity=".95" />
          </linearGradient>
          <Vertical id={id('m1')} paradas={[[0, '#5E4F59'], [1, '#4A4046']]} />
          <Vertical id={id('bruma')} paradas={[[0, '#E3A366', 0], [0.6, '#E3A366', 0.16], [1, '#E3A366', 0]]} />
          <Vertical id={id('m2')} paradas={[[0, '#393641'], [1, '#2B2A2E']]} />
          <Vertical id={id('lago')} paradas={[[0, '#D69A63'], [0.25, '#8E6A5E'], [0.6, '#3E3A44'], [1, '#1E1F24']]} />
          <radialGradient id={id('ventana')} cx="0.5" cy="0.5" r="0.5">
            <stop offset="0" stopColor="#F5C27A" stopOpacity=".6" />
            <stop offset="1" stopColor="#F5C27A" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="1600" height="800" fill={u('cielo')} />

        </Capa>
        <Capa d={2}>
          <ellipse cx="760" cy="180" rx="720" ry="90" fill={u('via')} transform="rotate(-14 760 180)" />
          <g fill="#F6EEDC">
            {estrellas.filter((_, i) => i % 3).map(([x, y, r], i) => (
              <circle key={i} cx={x} cy={y} r={r} opacity={r > 1.8 ? 1 : 0.7} />
            ))}
          </g>
          <circle cx="1262" cy="210" r="150" fill={u('luna')} />
          <path d="M1250 164a52 52 0 1 0 40 86a44 44 0 1 1 -40 -86z" fill="#F6EEDC" />
        </Capa>
        {/* Una de cada tres estrellas titila: todas juntas, en su propia capa. */}
        <Capa d={2} clase="estrellas">
          <g fill="#F6EEDC">
            {estrellas.filter((_, i) => !(i % 3)).map(([x, y, r], i) => (
              <circle key={i} cx={x} cy={y} r={r} opacity={r > 1.8 ? 1 : 0.7} />
            ))}
          </g>
        </Capa>
        <Capa clase="fugaz">
          <path d="M300 90L480 150" stroke={u('fugaz')} strokeWidth="2.2" strokeLinecap="round" />
        </Capa>

        <Capa d={8}>
          <path d={cresta([[-40, 498], [120, 452], [260, 474], [420, 404], [560, 456], [720, 428], [880, 470], [1040, 420], [1200, 468], [1380, 430], [1520, 466], [1640, 444]], 900)} fill={u('m1')} />
          <rect y="440" width="1600" height="120" fill={u('bruma')} />
        </Capa>
        <Capa d={18}>
          <path d={cresta([[-40, 566], [220, 522], [460, 552], [700, 512], [960, 550], [1200, 516], [1440, 544], [1640, 524]], 900)} fill={u('m2')} />
          <Arboles forma={pino} fill="#222226" lista={bosque} />
        </Capa>

        <Capa d={28}>
          <rect y="584" width="1600" height="320" fill={u('lago')} />
          <g stroke="#F2C58F" strokeLinecap="round" opacity=".55" strokeWidth="2">
            <path d="M700 604h200M740 628h120M660 654h280M760 690h80M720 730h160M780 770h60" />
          </g>
          <g stroke="#F6EEDC" strokeLinecap="round" opacity=".45" strokeWidth="2">
            <path d="M1244 610h36M1236 640h52M1250 676h24M1240 716h44" />
          </g>
          <g stroke="#F6EEDC" strokeLinecap="round" opacity=".14" strokeWidth="1.6">
            <path d="M120 640h140M1300 800h180M240 720h120M1080 700h160M460 780h110" />
          </g>
        </Capa>

        <Capa d={40}>
          <path d={cresta([[-40, 660], [140, 626], [320, 640], [480, 664], [620, 710], [700, 820]], 920)} fill="#1C1D1A" />
          <circle cx="258" cy="612" r="46" fill={u('ventana')} />
          <g transform="translate(222 632)">
            <rect x="0" y="-34" width="70" height="34" fill="#141512" />
            <path d="M-8 -34L35 -62L78 -34Z" fill="#141512" />
            <rect x="44" y="-58" width="8" height="16" fill="#141512" />
            <rect x="14" y="-24" width="14" height="12" fill="#F5C27A" />
            <rect x="38" y="-24" width="12" height="12" fill="#E8A95E" />
          </g>
          <path d="M270 574c-6-14 10-20 2-34s8-22 2-36" fill="none" stroke="#C9BFB6" strokeWidth="3" strokeLinecap="round" opacity=".35" />
          <path d="M240 664h40M246 676h28" stroke="#F5C27A" strokeWidth="2.4" strokeLinecap="round" opacity=".45" />
          <path d={cresta([[1160, 820], [1300, 740], [1460, 724], [1640, 748]], 920)} fill="#1A1B18" />
          <g stroke="#2B2D26" strokeWidth="2.2" strokeLinecap="round" fill="none">
            <path d="M1330 740q-4-40 6-70M1350 738q2-34-6-58M1372 734q-2-30 8-52M1398 732q-6-36 2-62M1420 730q4-28-4-48" />
          </g>
        </Capa>
        <Capa d={40} clase="luciernagas">
          <g fill="#F6D98A">
            {luciernagas.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="2.2" />)}
          </g>
        </Capa>
    </Marco>
  );
}
