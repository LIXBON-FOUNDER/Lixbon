// Paisajes.jsx — las ilustraciones de la web pública: cuatro paisajes pintados
// a mano en SVG (sierra al amanecer, costa, valle de lavanda y crepúsculo).
//
// Van por capas: cada <g className="capa"> lleva una profundidad (--d) y se
// desplaza con el scroll según --p, que pone useParallax en el contenedor.
// Cada capa lleva su propio degradado vertical (más clara arriba, como la
// luz que la baña) para que la profundidad la haga el aire, no una línea.
// El grano de papel es un ::after del marco (landing.css), no un filtro SVG,
// para que el navegador lo rasterice una vez y no en cada fotograma.
//
// Todo lo "aleatorio" (flores, estrellas, destellos) sale de una semilla fija:
// el servidor y el navegador pintan exactamente lo mismo.
import { useEffect, useId, useRef } from 'react';

// ── Utilidades de dibujo ─────────────────────────────────────────────────

const r1 = (n) => Math.round(n * 10) / 10;

// Generador pseudoaleatorio con semilla (Park–Miller).
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

// Solo el filo de una cresta, abierto: para la espuma que la sigue.
function filo(pts) {
  return cresta(pts, 0).replace(/^M[^L]+L/, 'M').replace(/L[^L]*Z$/, '');
}

// Degradado vertical de dos o más paradas.
function Vertical({ id, paradas }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      {paradas.map(([o, c, a = 1]) => <stop key={o} offset={o} stopColor={c} stopOpacity={a} />)}
    </linearGradient>
  );
}

// Ciprés: una llama alargada. `x, y` es el pie del árbol.
function ciPres(x, y, h) {
  const w = h * 0.17;
  return `M${x} ${y}C${x - w} ${y - h * 0.3} ${x - w * 0.55} ${y - h * 0.86} ${x} ${y - h}C${x + w * 0.55} ${y - h * 0.86} ${x + w} ${y - h * 0.3} ${x} ${y}Z`;
}

// Pino: tres pisos de ramas.
function pino(x, y, h) {
  const w = h * 0.5;
  return `M${x} ${r1(y - h)}L${r1(x + w * 0.34)} ${r1(y - h * 0.64)}L${r1(x + w * 0.18)} ${r1(y - h * 0.64)}L${r1(x + w * 0.5)} ${r1(y - h * 0.32)}L${r1(x + w * 0.28)} ${r1(y - h * 0.32)}L${r1(x + w * 0.62)} ${y}L${r1(x - w * 0.62)} ${y}L${r1(x - w * 0.28)} ${r1(y - h * 0.32)}L${r1(x - w * 0.5)} ${r1(y - h * 0.32)}L${r1(x - w * 0.18)} ${r1(y - h * 0.64)}L${r1(x - w * 0.34)} ${r1(y - h * 0.64)}Z`;
}

const Arboles = ({ forma, lista, fill, opacity }) => (
  <path d={lista.map(([x, y, h]) => forma(x, y, h)).join('')} fill={fill} opacity={opacity} />
);

// Olivo: copa redonda de tres manchas sobre un tronco corto.
function Olivos({ arboles, fill, sombra }) {
  return (
    <g>
      {arboles.map(([x, y, s], i) => (
        <g key={i}>
          <ellipse cx={x + s * 0.3} cy={y + s * 0.06} rx={s * 0.9} ry={s * 0.16} fill={sombra} opacity=".35" />
          <rect x={x - s * 0.08} y={y - s * 0.5} width={s * 0.16} height={s * 0.5} rx={s * 0.05} fill={fill} />
          <g fill={fill}>
            <ellipse cx={x - s * 0.34} cy={y - s * 0.72} rx={s * 0.5} ry={s * 0.38} />
            <ellipse cx={x + s * 0.34} cy={y - s * 0.78} rx={s * 0.52} ry={s * 0.4} />
            <ellipse cx={x} cy={y - s * 1.06} rx={s * 0.5} ry={s * 0.4} />
          </g>
        </g>
      ))}
    </g>
  );
}

// Nube de varios lóbulos con la panza en sombra.
function Nube({ x, y, s = 1, luz = '#FBF4E6', sombra = '#E6D8BE', opacity = 0.85 }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} opacity={opacity}>
      <ellipse cx="6" cy="10" rx="150" ry="14" fill={sombra} />
      <g fill={luz}>
        <ellipse cx="0" cy="4" rx="150" ry="14" />
        <circle cx="-60" cy="-6" r="24" />
        <circle cx="-14" cy="-20" r="34" />
        <circle cx="38" cy="-10" r="26" />
        <circle cx="80" cy="-2" r="16" />
      </g>
    </g>
  );
}

function Pajaros({ aves, color, grosor = 2.2 }) {
  return (
    <g fill="none" stroke={color} strokeWidth={grosor} strokeLinecap="round">
      {aves.map(([x, y, s], i) => (
        <path key={i} d={`M${x - s} ${r1(y - s * 0.3)}Q${r1(x - s * 0.45)} ${r1(y - s * 0.7)} ${x} ${y}Q${r1(x + s * 0.45)} ${r1(y - s * 0.7)} ${x + s} ${r1(y - s * 0.3)}`} />
      ))}
    </g>
  );
}

// Casa encalada con tejado de teja: la de la costa y la del valle.
function Casas({ casas, pared = '#F6F0E4', sombra = '#E2D6C0', teja = '#B8664A', ventana = '#6B5B45' }) {
  return (
    <g>
      {casas.map(([x, y, w, h], i) => (
        <g key={i}>
          <rect x={x} y={y - h} width={w} height={h} fill={pared} />
          <rect x={x + w * 0.62} y={y - h} width={w * 0.38} height={h} fill={sombra} />
          <path d={`M${x - w * 0.08} ${y - h}L${x + w / 2} ${r1(y - h - w * 0.36)}L${x + w * 1.08} ${y - h}Z`} fill={teja} />
          <rect x={x + w * 0.2} y={y - h * 0.62} width={w * 0.18} height={h * 0.26} fill={ventana} />
        </g>
      ))}
    </g>
  );
}

// Matas de hierba y flores silvestres del primer plano.
function Pradera({ semilla, x0, x1, y0, y1, n, colores, hierba }) {
  const rnd = azar(semilla);
  const matas = [];
  const flores = [];
  for (let i = 0; i < n; i++) {
    const x = r1(x0 + rnd() * (x1 - x0));
    const y = r1(y0 + rnd() * (y1 - y0));
    const h = 8 + rnd() * 14;
    matas.push(`M${x} ${y}q-2 ${r1(-h * 0.6)} -6 ${r1(-h)}M${x} ${y}q0 ${r1(-h * 0.7)} 1 ${r1(-h * 1.15)}M${x} ${y}q3 ${r1(-h * 0.5)} 7 ${r1(-h * 0.85)}`);
    if (rnd() > 0.45) flores.push([r1(x + (rnd() - 0.5) * 10), r1(y - h * 0.9), colores[Math.floor(rnd() * colores.length)], r1(2 + rnd() * 2.2)]);
  }
  return (
    <g>
      <path d={matas.join('')} fill="none" stroke={hierba} strokeWidth="1.6" strokeLinecap="round" />
      {flores.map(([x, y, c, r], i) => <circle key={i} cx={x} cy={y} r={r} fill={c} />)}
    </g>
  );
}

// Pone --p (de -1 a 1) en el marco según dónde esté respecto al centro de la
// ventana. Solo mientras se ve, y nada si el sistema pide menos movimiento.
export function useParallax() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    let visible = false;
    let raf = 0;
    const pintar = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight;
      const p = (r.top + r.height / 2 - vh / 2) / (vh / 2 + r.height / 2);
      el.style.setProperty('--p', Math.max(-1, Math.min(1, p)).toFixed(3));
    };
    const alMover = () => { if (visible && !raf) raf = requestAnimationFrame(pintar); };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) alMover(); });
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

const capa = (d) => ({ className: 'capa', style: { '--d': d } });

function usarIds() {
  const base = useId().replace(/:/g, '');
  return (n) => `${base}${n}`;
}

// ── Sierra al amanecer (portada) ─────────────────────────────────────────

const RAYOS = Array.from({ length: 14 }, (_, i) => i * (360 / 14));

export function PaisajeAmanecer({ className = '' }) {
  const id = usarIds();
  const ref = useParallax();
  const u = (n) => `url(#${id(n)})`;
  return (
    <div ref={ref} className={`paisaje ${className}`}>
      <svg viewBox="0 0 1600 760" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <Vertical id={id('cielo')} paradas={[[0, '#CFCBBC'], [0.4, '#E6D8BD'], [0.72, '#F4E1BF'], [1, '#F8E8CC']]} />
          <radialGradient id={id('sol')} cx="990" cy="360" r="560" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#F9D8A0" stopOpacity=".95" />
            <stop offset=".3" stopColor="#F6DDB2" stopOpacity=".5" />
            <stop offset="1" stopColor="#F5DDB0" stopOpacity="0" />
          </radialGradient>
          <Vertical id={id('niebla')} paradas={[[0, '#FBF4E6', 0], [0.5, '#FBF4E6', 0.8], [1, '#FBF4E6', 0]]} />
          <Vertical id={id('c1')} paradas={[[0, '#D6CFB4'], [1, '#C4C1A4']]} />
          <Vertical id={id('c2')} paradas={[[0, '#BDBE9A'], [1, '#A5AA84']]} />
          <Vertical id={id('c3')} paradas={[[0, '#9CA473'], [1, '#7F8A55']]} />
          <Vertical id={id('c4')} paradas={[[0, '#6E7A3C'], [1, '#535E2A']]} />
          <Vertical id={id('c5')} paradas={[[0, '#434C23'], [1, '#2A3016']]} />
          <Vertical id={id('rio')} paradas={[[0, '#F7E2B8'], [0.5, '#E4D6B2'], [1, '#AEB894']]} />
        </defs>

        <rect width="1600" height="760" fill={u('cielo')} />
        <rect width="1600" height="760" fill={u('sol')} />

        <g {...capa(3)}>
          <g transform="translate(990 362)" fill="#FFF6E2" opacity=".09">
            {RAYOS.map((a) => <path key={a} d="M-9 0L9 0L3 -620L-3 -620Z" transform={`rotate(${a})`} />)}
          </g>
          <circle cx="990" cy="362" r="96" fill="#F4CD90" opacity=".45" />
          <circle cx="990" cy="362" r="70" fill="#EFBA78" />
          <Nube x={330} y={180} s={1.15} />
          <Nube x={1340} y={140} s={0.9} />
          <Nube x={860} y={262} s={0.6} opacity={0.7} />
          <Nube x={120} y={300} s={0.5} opacity={0.6} />
        </g>

        <g {...capa(8)}>
          <path d={cresta([[-40, 468], [90, 420], [180, 438], [300, 356], [380, 398], [470, 376], [560, 428], [700, 404], [820, 448], [960, 416], [1080, 382], [1180, 338], [1260, 386], [1380, 366], [1500, 408], [1640, 386]], 820)} fill={u('c1')} />
          <path d="M300 356l-22 26 14-4 8 10 10-12 12 6z M1180 338l-20 24 12-3 9 9 9-10 13 5z" fill="#F4EEDD" opacity=".7" />
        </g>
        <rect {...capa(10)} y="430" width="1600" height="130" fill={u('niebla')} />

        <g {...capa(16)}>
          <path d={cresta([[-40, 522], [140, 488], [300, 512], [470, 470], [640, 506], [820, 480], [980, 522], [1160, 492], [1340, 516], [1500, 480], [1640, 500]], 820)} fill={u('c2')} />
          <Arboles forma={pino} fill="#8E956C" opacity=".8" lista={[[430, 486, 20], [448, 482, 26], [466, 478, 18], [1470, 490, 22], [1490, 486, 28], [1512, 488, 18], [800, 488, 16], [816, 486, 20]]} />
        </g>

        <g {...capa(10)}>
          <Pajaros color="#6D6A56" aves={[[620, 250, 11], [656, 236, 8], [690, 262, 9], [720, 244, 7], [598, 272, 6], [1210, 300, 7], [1236, 290, 5]]} />
        </g>

        <g {...capa(26)}>
          <path d={cresta([[-40, 592], [180, 552], [380, 580], [560, 546], [760, 584], [980, 560], [1200, 590], [1420, 556], [1640, 578]], 840)} fill={u('c3')} />
          <rect y="560" width="1600" height="56" fill={u('niebla')} opacity=".45" />
          <Casas casas={[[448, 574, 20, 14], [474, 570, 16, 12], [496, 576, 22, 15], [524, 572, 14, 11]]} teja="#B46A4C" />
          <path d="M506 544v-14" stroke="#EFE6D4" strokeWidth="3" strokeLinecap="round" />
          <path d="M504 530h4" stroke="#B46A4C" strokeWidth="3" strokeLinecap="round" />
        </g>

        <g {...capa(34)}>
          <path d="M982 596C966 616 1004 636 988 656C960 688 870 700 884 730C896 756 830 790 760 860L1150 860C1072 800 1062 760 1044 728C1024 700 1092 680 1062 654C1040 634 1000 618 990 596Z" fill={u('rio')} />
          <g stroke="#FFF4DC" strokeLinecap="round" opacity=".75">
            <path d="M980 640h22M968 676h40M944 712h58M920 752h86M900 796h120" strokeWidth="2.2" />
          </g>
        </g>

        <g {...capa(42)}>
          <path d={cresta([[-40, 668], [160, 630], [360, 652], [560, 618], [760, 650], [880, 690], [940, 760]], 880)} fill={u('c4')} />
          <path d={cresta([[1120, 760], [1180, 690], [1260, 640], [1400, 652], [1640, 630]], 880)} fill={u('c4')} />
          <Arboles forma={ciPres} fill="#3F4722" lista={[[1216, 668, 92], [1244, 660, 70], [1272, 652, 106], [1300, 650, 64], [1328, 652, 84]]} />
          <Arboles forma={pino} fill="#46502A" lista={[[220, 640, 54], [250, 642, 40], [120, 646, 46], [640, 628, 48]]} />
          <Olivos fill="#4C5628" sombra="#2E3418" arboles={[[420, 652, 12], [460, 650, 11], [500, 646, 12], [700, 646, 11], [1460, 652, 12], [1500, 650, 11], [1540, 648, 12]]} />
        </g>

        <g {...capa(62)}>
          <path d={cresta([[-40, 730], [220, 700], [480, 724], [720, 744], [860, 800]], 900)} fill={u('c5')} />
          <path d={cresta([[1180, 800], [1300, 712], [1420, 700], [1640, 712]], 900)} fill={u('c5')} />
          <Arboles forma={ciPres} fill="#232812" lista={[[140, 716, 150], [176, 720, 112], [1470, 704, 170], [1508, 710, 124], [1540, 706, 96]]} />
          <Pradera semilla={11} x0={20} x1={680} y0={736} y1={770} n={46} hierba="#56612E" colores={['#E8C77A', '#D98B6A', '#F4EEDD', '#C9A9C9']} />
          <Pradera semilla={29} x0={1260} x1={1600} y0={726} y1={770} n={26} hierba="#56612E" colores={['#E8C77A', '#F4EEDD', '#D98B6A']} />
        </g>
      </svg>
    </div>
  );
}

// ── Costa con faro (privacidad) ──────────────────────────────────────────

export function PaisajeCosta({ className = '' }) {
  const id = usarIds();
  const ref = useParallax();
  const u = (n) => `url(#${id(n)})`;
  const rnd = azar(7);
  const destellos = Array.from({ length: 34 }, (_, i) => {
    const y = 540 + i * 11 + rnd() * 6;
    const ancho = 8 + (y - 530) * 0.18 + rnd() * 16;
    const x = 360 + (rnd() - 0.5) * (30 + (y - 530) * 0.55);
    return `M${r1(x - ancho / 2)} ${r1(y)}h${r1(ancho)}`;
  }).join('');
  const olas = Array.from({ length: 22 }, () => {
    const y = 560 + rnd() * 330;
    const x = rnd() * 1000;
    return `M${r1(x)} ${r1(y)}h${r1(40 + rnd() * 110)}`;
  }).join('');
  return (
    <div ref={ref} className={`paisaje ${className}`}>
      <svg viewBox="0 0 1200 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <Vertical id={id('cielo')} paradas={[[0, '#D9D8D0'], [0.45, '#E9DDCB'], [0.8, '#F2D4B6'], [1, '#F4C9A6']]} />
          <radialGradient id={id('sol')} cx="360" cy="520" r="360" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#F8CFA0" stopOpacity=".9" />
            <stop offset="1" stopColor="#F8CFA0" stopOpacity="0" />
          </radialGradient>
          <Vertical id={id('mar')} paradas={[[0, '#B9C9BF'], [0.35, '#8FA9A1'], [1, '#56766F']]} />
          <Vertical id={id('acant')} paradas={[[0, '#D6BA8C'], [1, '#A98C5F']]} />
          <Vertical id={id('sombra')} paradas={[[0, '#9C8157'], [1, '#6F5A3C']]} />
          <Vertical id={id('roca')} paradas={[[0, '#5A5E3E'], [1, '#2F3222']]} />
        </defs>
        <rect width="1200" height="900" fill={u('cielo')} />
        <rect width="1200" height="900" fill={u('sol')} />

        <g {...capa(5)}>
          <circle cx="360" cy="522" r="70" fill="#F4C79A" opacity=".5" />
          <circle cx="360" cy="522" r="50" fill="#EDA774" />
          <Nube x={240} y={200} s={0.9} luz="#FBF1E6" sombra="#EAD6C4" />
          <Nube x={860} y={250} s={0.75} luz="#FBF1E6" sombra="#EAD6C4" />
          <Nube x={560} y={130} s={0.45} luz="#FBF1E6" sombra="#EAD6C4" opacity={0.6} />
          <Pajaros color="#7A6F5E" aves={[[520, 330, 10], [552, 318, 7], [580, 340, 8], [700, 300, 6]]} />
        </g>

        <g {...capa(9)}>
          <path d="M-20 532C40 506 110 500 170 514C200 520 226 528 250 532Z" fill="#A9B4AB" opacity=".85" />
          <path d="M-20 532C30 518 80 516 120 524L140 532Z" fill="#94A29A" opacity=".8" />
        </g>

        <g {...capa(12)}>
          <rect y="530" width="1200" height="420" fill={u('mar')} />
          <path d={olas} stroke="#E4ECE7" strokeWidth="2" strokeLinecap="round" opacity=".4" />
          <path d={destellos} stroke="#FCE6C4" strokeWidth="2.6" strokeLinecap="round" opacity=".85" />
          <g transform="translate(640 574)">
            <path d="M-26 0h52l-8 9h-36z" fill="#4A4436" />
            <path d="M0 -2V-62L30 -4Z" fill="#FBF6EC" />
            <path d="M-3 -2V-44L-24 -4Z" fill="#EFE6D6" />
            <path d="M-20 13h40" stroke="#4A4436" strokeWidth="2" opacity=".25" strokeLinecap="round" />
          </g>
        </g>

        <g {...capa(24)}>
          <path d="M1240 950V560C1180 540 1120 520 1060 536C1010 548 960 530 900 556C850 578 820 640 800 700C780 780 740 860 700 950Z" fill={u('acant')} />
          <path d="M1240 950V640C1150 660 1060 700 1000 780C960 840 940 900 930 950Z" fill={u('sombra')} />
          <g stroke="#7E6644" strokeWidth="2" fill="none" opacity=".35" strokeLinecap="round">
            <path d="M860 640c40-6 80 4 130-8M836 700c60-4 110 10 170-6M816 770c70 0 120 12 180-2M1010 600c50-8 110 2 180-10" />
          </g>
          <path d="M1240 566C1180 540 1120 520 1060 536C1010 548 960 530 900 556L904 574C962 550 1012 568 1062 556C1122 542 1180 562 1240 588Z" fill="#6F7A3E" />
          <g fill="#5E6834">
            <circle cx="914" cy="560" r="9" /><circle cx="928" cy="554" r="7" /><circle cx="1180" cy="552" r="10" /><circle cx="1196" cy="556" r="8" />
          </g>
          <Casas casas={[[944, 552, 24, 18], [972, 548, 20, 16], [1110, 540, 26, 20], [1140, 546, 18, 14]]} />
          <g transform="translate(1040 440)">
            <path d="M-16 100L-11 0h22L16 100z" fill="#F6F0E4" />
            <path d="M3 100L5 0h6l5 100z" fill="#E2D6C0" />
            <path d="M-14.5 70h29l-1 14h-27zM-12.6 32h25.2l-.8 13h-23.6z" fill="#C06A4A" />
            <rect x="-15" y="-16" width="30" height="16" rx="3" fill="#3E3A30" />
            <path d="M-19 -16h38l-19 -18z" fill="#C06A4A" />
            <circle cx="0" cy="-8" r="4.5" fill="#F7D59C" />
            <path d="M0 -8L-150 -30L-150 14Z" fill="#FBE8C2" opacity=".18" />
          </g>
        </g>

        <g {...capa(40)}>
          <path d={filo([[-40, 820], [80, 760], [200, 790], [320, 812], [440, 860], [520, 960]])} transform="translate(6 -7)" stroke="#F6F3EC" strokeWidth="4" fill="none" strokeLinecap="round" opacity=".5" />
          <path d={cresta([[-40, 820], [80, 760], [200, 790], [320, 812], [440, 860], [520, 960]], 980)} fill={u('roca')} />
          <path d={cresta([[-40, 870], [60, 842], [180, 870], [300, 900], [380, 980]], 1000)} fill="#26291B" />
          <Pajaros color="#F6F3EC" grosor={2} aves={[[240, 700, 12], [280, 684, 9]]} />
        </g>
      </svg>
    </div>
  );
}

// ── Valle de lavanda y olivos (los productos) ────────────────────────────

export function PaisajeValle({ className = '' }) {
  const id = usarIds();
  const ref = useParallax();
  const u = (n) => `url(#${id(n)})`;
  const fila = (y0, x0, x1, paso, s) => Array.from({ length: Math.floor((x1 - x0) / paso) + 1 }, (_, i) => [x0 + i * paso, r1(y0 + Math.sin(i * 0.7) * 3), s]);
  // Surcos de lavanda que convergen hacia un punto de fuga detrás de la colina.
  const surcos = Array.from({ length: 30 }, (_, i) => `M${800 + (i - 15) * 10} 470L${-400 + i * 88} 700`).join('');
  const lavanda = cresta([[-40, 500], [200, 476], [420, 492], [640, 470], [820, 480], [1000, 470]], 700);
  return (
    <div ref={ref} className={`paisaje ${className}`}>
      <svg viewBox="0 0 1600 640" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <Vertical id={id('cielo')} paradas={[[0, '#DCDFD6'], [0.6, '#EFEADA'], [1, '#F6EEDB']]} />
          <radialGradient id={id('sol')} cx="1320" cy="120" r="600" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#F9E6BE" stopOpacity=".9" />
            <stop offset="1" stopColor="#F9E6BE" stopOpacity="0" />
          </radialGradient>
          <Vertical id={id('m')} paradas={[[0, '#C9CDC3'], [1, '#BFC2B0']]} />
          <Vertical id={id('c1')} paradas={[[0, '#C8C39A'], [1, '#B7B083']]} />
          <Vertical id={id('c2')} paradas={[[0, '#A9AC72'], [1, '#8E955C']]} />
          <Vertical id={id('c3')} paradas={[[0, '#7F8849'], [1, '#626B34']]} />
          <Vertical id={id('lav')} paradas={[[0, '#B9AACB'], [1, '#8E7EAA']]} />
          <clipPath id={id('recorte')}><path d={lavanda} /></clipPath>
        </defs>
        <rect width="1600" height="640" fill={u('cielo')} />
        <rect width="1600" height="640" fill={u('sol')} />
        <g {...capa(3)}>
          <circle cx="1320" cy="120" r="44" fill="#F7DCA6" />
          <Nube x={300} y={120} s={1} luz="#FBF7EC" sombra="#E8E1CC" />
          <Nube x={900} y={80} s={0.7} luz="#FBF7EC" sombra="#E8E1CC" opacity={0.75} />
        </g>
        <g {...capa(6)}>
          <path d={cresta([[-40, 290], [140, 240], [300, 262], [460, 218], [620, 256], [780, 232], [940, 268], [1120, 226], [1300, 252], [1460, 230], [1640, 250]], 700)} fill={u('m')} />
        </g>
        <g {...capa(12)}>
          <path d={cresta([[-40, 344], [200, 312], [420, 336], [660, 304], [900, 334], [1120, 300], [1360, 330], [1640, 310]], 700)} fill={u('c1')} />
          <Arboles forma={ciPres} fill="#7E8450" opacity=".85" lista={[[520, 330, 30], [534, 330, 22], [1180, 316, 34], [1194, 318, 24]]} />
        </g>
        <g {...capa(20)}>
          <path d={cresta([[-40, 410], [240, 376], [520, 400], [780, 372], [1060, 404], [1320, 374], [1640, 396]], 720)} fill={u('c2')} />
          <g stroke="#B8B37A" strokeWidth="6" opacity=".45" strokeLinecap="round">
            <path d="M880 420C980 404 1080 412 1180 400M900 440C1010 424 1120 432 1240 420M930 462C1050 448 1170 456 1300 444" />
          </g>
          <Casas casas={[[640, 400, 60, 34], [706, 402, 36, 24]]} />
          <g fill="#D8B870">
            <path d="M1010 452a18 14 0 0 1 36 0z" /><path d="M1060 456a16 12 0 0 1 32 0z" /><path d="M1110 450a18 14 0 0 1 36 0z" />
          </g>
          <Arboles forma={ciPres} fill="#4A5228" lista={[[616, 404, 56], [760, 404, 64], [778, 406, 48]]} />
        </g>
        <g {...capa(30)}>
          <path d={lavanda} fill={u('lav')} />
          <g clipPath={u('recorte')}>
            <path d={surcos} stroke="#6E5E8C" strokeWidth="7" opacity=".45" />
            <path d={surcos} stroke="#CFC4DE" strokeWidth="2" opacity=".5" transform="translate(5 0)" />
          </g>
          <path d={cresta([[560, 720], [700, 580], [840, 490], [1000, 458], [1200, 478], [1400, 452], [1640, 470]], 720)} fill={u('c2')} />
          <Olivos fill="#56602F" sombra="#3A4120" arboles={fila(488, 900, 1560, 52, 13)} />
          <path d="M760 720C790 640 830 580 900 540C960 506 1040 492 1120 486" fill="none" stroke="#E9DEC4" strokeWidth="16" strokeLinecap="round" />
          <Arboles forma={ciPres} fill="#3F4722" lista={[[900, 528, 70], [960, 510, 56], [1020, 500, 46], [1070, 494, 38], [1112, 490, 30]]} />
        </g>
        <g {...capa(46)}>
          <path d={cresta([[-40, 580], [300, 546], [640, 572], [980, 540], [1320, 566], [1640, 544]], 760)} fill={u('c3')} />
          <Olivos fill="#3F4722" sombra="#262B14" arboles={[...fila(596, 40, 520, 76, 21), ...fila(584, 1080, 1580, 76, 21)]} />
          <Pradera semilla={5} x0={560} x1={1040} y0={600} y1={636} n={34} hierba="#4A5327" colores={['#B8A6D0', '#F4EEDD', '#E8C77A']} />
        </g>
      </svg>
    </div>
  );
}

// ── Crepúsculo sobre el lago (llamada final) ─────────────────────────────

export function PaisajeCrepusculo({ className = '' }) {
  const id = usarIds();
  const ref = useParallax();
  const u = (n) => `url(#${id(n)})`;
  const rnd = azar(42);
  const estrellas = Array.from({ length: 90 }, () => [r1(rnd() * 1600), r1(rnd() * 400), r1(0.6 + rnd() * 1.8), r1(rnd() * 4)]);
  const bosque = Array.from({ length: 46 }, (_, i) => [r1(i * 36 + rnd() * 20 - 20), r1(560 + Math.sin(i * 0.5) * 10 + rnd() * 6), r1(26 + rnd() * 34)]);
  const luciernagas = Array.from({ length: 14 }, () => [r1(120 + rnd() * 520), r1(640 + rnd() * 110), r1(rnd() * 3)]);
  return (
    <div ref={ref} className={`paisaje paisaje--noche ${className}`}>
      <svg viewBox="0 0 1600 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
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

        <g {...capa(2)}>
          <ellipse cx="760" cy="180" rx="720" ry="90" fill={u('via')} transform="rotate(-14 760 180)" />
          <g fill="#F6EEDC">
            {estrellas.map(([x, y, r, dl], i) => (
              <circle key={i} className={i % 3 ? undefined : 'estrella'} cx={x} cy={y} r={r} opacity={r > 1.8 ? 1 : 0.7} style={i % 3 ? undefined : { animationDelay: `${dl}s` }} />
            ))}
          </g>
          <path className="fugaz" d="M300 90L480 150" stroke={u('fugaz')} strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="1262" cy="210" r="150" fill={u('luna')} />
          <path d="M1250 164a52 52 0 1 0 40 86a44 44 0 1 1 -40 -86z" fill="#F6EEDC" />
        </g>

        <g {...capa(8)}>
          <path d={cresta([[-40, 498], [120, 452], [260, 474], [420, 404], [560, 456], [720, 428], [880, 470], [1040, 420], [1200, 468], [1380, 430], [1520, 466], [1640, 444]], 900)} fill={u('m1')} />
          <rect y="440" width="1600" height="120" fill={u('bruma')} />
        </g>
        <g {...capa(18)}>
          <path d={cresta([[-40, 566], [220, 522], [460, 552], [700, 512], [960, 550], [1200, 516], [1440, 544], [1640, 524]], 900)} fill={u('m2')} />
          <Arboles forma={pino} fill="#222226" lista={bosque} />
        </g>

        <g {...capa(28)}>
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
        </g>

        <g {...capa(40)}>
          <path d={cresta([[-40, 660], [140, 626], [320, 640], [480, 664], [620, 710], [700, 820]], 920)} fill="#1C1D1A" />
          <circle cx="258" cy="612" r="46" fill={u('ventana')} />
          <g transform="translate(222 632)">
            <rect x="0" y="-34" width="70" height="34" fill="#141512" />
            <path d="M-8 -34L35 -62L78 -34Z" fill="#141512" />
            <rect x="44" y="-58" width="8" height="16" fill="#141512" />
            <rect x="14" y="-24" width="14" height="12" fill="#F5C27A" />
            <rect x="38" y="-24" width="12" height="12" fill="#E8A95E" />
          </g>
          <path className="humo" d="M270 574c-6-14 10-20 2-34s8-22 2-36" fill="none" stroke="#C9BFB6" strokeWidth="3" strokeLinecap="round" opacity=".35" />
          <path d="M240 664h40M246 676h28" stroke="#F5C27A" strokeWidth="2.4" strokeLinecap="round" opacity=".45" />
          <path d={cresta([[1160, 820], [1300, 740], [1460, 724], [1640, 748]], 920)} fill="#1A1B18" />
          <g stroke="#2B2D26" strokeWidth="2.2" strokeLinecap="round" fill="none">
            <path d="M1330 740q-4-40 6-70M1350 738q2-34-6-58M1372 734q-2-30 8-52M1398 732q-6-36 2-62M1420 730q4-28-4-48" />
          </g>
          <g fill="#F6D98A">
            {luciernagas.map(([x, y, dl], i) => <circle key={i} className="luciernaga" cx={x} cy={y} r="2.2" style={{ animationDelay: `${dl}s` }} />)}
          </g>
        </g>
      </svg>
    </div>
  );
}
