// Paisajes.jsx — las ilustraciones de la web pública: cuatro paisajes pintados
// a mano en SVG (sierra al amanecer, costa, valle de olivos y crepúsculo).
// Van por capas: cada <g className="capa"> lleva una profundidad (--d) y se
// desplaza con el scroll según --p, que pone useParallax en el contenedor.
// El grano de papel es un ::after del marco (landing.css), no un filtro SVG,
// para que el navegador lo rasterice una vez y no en cada fotograma.
import { useEffect, useId, useRef } from 'react';

// Una línea de cumbres suave que pasa por `pts` y se cierra hasta `base`.
// Catmull-Rom convertido a Bézier: basta con dar las alturas a mano.
function cresta(pts, base) {
  const r = (n) => Math.round(n * 10) / 10;
  let d = `M${pts[0][0]} ${base}L${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${r(c1[0])} ${r(c1[1])} ${r(c2[0])} ${r(c2[1])} ${p2[0]} ${p2[1]}`;
  }
  return `${d}L${pts[pts.length - 1][0]} ${base}Z`;
}

// Ciprés: una llama alargada. `x, y` es el pie del árbol.
function ciPres(x, y, h) {
  const w = h * 0.17;
  return `M${x} ${y}C${x - w} ${y - h * 0.3} ${x - w * 0.55} ${y - h * 0.86} ${x} ${y - h}C${x + w * 0.55} ${y - h * 0.86} ${x + w} ${y - h * 0.3} ${x} ${y}Z`;
}

function Cipreses({ arboles, fill }) {
  return <path d={arboles.map(([x, y, h]) => ciPres(x, y, h)).join('')} fill={fill} />;
}

// Olivo: copa redonda de tres manchas sobre un tronco corto.
function Olivos({ arboles, fill }) {
  return (
    <g fill={fill}>
      {arboles.map(([x, y, s], i) => (
        <g key={i}>
          <rect x={x - s * 0.08} y={y - s * 0.5} width={s * 0.16} height={s * 0.5} rx={s * 0.05} />
          <ellipse cx={x - s * 0.34} cy={y - s * 0.72} rx={s * 0.5} ry={s * 0.38} />
          <ellipse cx={x + s * 0.34} cy={y - s * 0.78} rx={s * 0.52} ry={s * 0.4} />
          <ellipse cx={x} cy={y - s * 1.06} rx={s * 0.5} ry={s * 0.4} />
        </g>
      ))}
    </g>
  );
}

function Pajaros({ aves, color }) {
  return (
    <g fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round">
      {aves.map(([x, y, s], i) => (
        <path key={i} d={`M${x - s} ${y - s * 0.3}Q${x - s * 0.45} ${y - s * 0.7} ${x} ${y}Q${x + s * 0.45} ${y - s * 0.7} ${x + s} ${y - s * 0.3}`} />
      ))}
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

// ── Sierra al amanecer (portada) ─────────────────────────────────────────

export function PaisajeAmanecer({ className = '' }) {
  const id = useId().replace(/:/g, '');
  const ref = useParallax();
  return (
    <div ref={ref} className={`paisaje ${className}`}>
      <svg viewBox="0 0 1600 760" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#E3D6BD" />
            <stop offset=".55" stopColor="#F1E4CA" />
            <stop offset="1" stopColor="#F7E9CF" />
          </linearGradient>
          <radialGradient id={`${id}s`} cx="1090" cy="420" r="420" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#F7D59C" stopOpacity=".9" />
            <stop offset=".35" stopColor="#F5DDB0" stopOpacity=".45" />
            <stop offset="1" stopColor="#F5DDB0" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${id}n`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#FBF4E6" stopOpacity="0" />
            <stop offset=".5" stopColor="#FBF4E6" stopOpacity=".75" />
            <stop offset="1" stopColor="#FBF4E6" stopOpacity="0" />
          </linearGradient>
        </defs>

        <rect width="1600" height="760" fill={`url(#${id}c)`} />
        <rect width="1600" height="760" fill={`url(#${id}s)`} />
        <g {...capa(4)}>
          <circle cx="1090" cy="430" r="78" fill="#F3C98A" />
          <g fill="#FBF4E6" opacity=".7">
            <ellipse cx="360" cy="190" rx="190" ry="16" />
            <ellipse cx="470" cy="214" rx="120" ry="10" />
            <ellipse cx="1330" cy="150" rx="150" ry="12" />
            <ellipse cx="1000" cy="300" rx="230" ry="9" opacity=".8" />
          </g>
        </g>

        <g {...capa(10)}>
          <path d={cresta([[-40, 470], [120, 430], [260, 452], [420, 392], [560, 428], [700, 404], [860, 452], [1000, 440], [1180, 396], [1320, 424], [1480, 386], [1640, 420]], 820)} fill="#CBC7AC" />
        </g>
        <rect {...capa(12)} y="440" width="1600" height="120" fill={`url(#${id}n)`} />
        <g {...capa(18)}>
          <path d={cresta([[-40, 520], [140, 488], [300, 512], [470, 470], [640, 506], [820, 480], [980, 522], [1160, 492], [1340, 516], [1500, 480], [1640, 500]], 820)} fill="#ADB08A" />
        </g>
        <g {...capa(12)}>
          <Pajaros color="#6D6A56" aves={[[640, 250, 11], [676, 236, 8], [708, 262, 9], [1210, 300, 7]]} />
        </g>
        <g {...capa(28)}>
          <path d={cresta([[-40, 590], [180, 552], [380, 580], [560, 548], [760, 584], [980, 560], [1200, 590], [1420, 556], [1640, 578]], 820)} fill="#8A935F" />
          <rect y="560" width="1600" height="60" fill={`url(#${id}n)`} opacity=".55" />
        </g>
        <g {...capa(44)}>
          <path d={cresta([[-40, 668], [160, 630], [360, 652], [560, 618], [720, 640], [900, 652], [1120, 616], [1320, 644], [1640, 630]], 840)} fill="#626C36" />
          <Cipreses fill="#434B24" arboles={[[1060, 628, 92], [1088, 632, 70], [1116, 626, 104], [1144, 630, 64], [238, 642, 78], [262, 646, 58]]} />
        </g>
        <g {...capa(64)}>
          <path d={cresta([[-40, 730], [220, 700], [480, 724], [760, 694], [1040, 716], [1320, 690], [1640, 712]], 860)} fill="#3B4220" />
          <Cipreses fill="#2C321A" arboles={[[140, 716, 150], [176, 720, 112], [1430, 704, 170], [1470, 710, 124], [1504, 706, 96]]} />
        </g>
      </svg>
    </div>
  );
}

// ── Costa con faro (privacidad) ──────────────────────────────────────────

export function PaisajeCosta({ className = '' }) {
  const id = useId().replace(/:/g, '');
  const ref = useParallax();
  return (
    <div ref={ref} className={`paisaje ${className}`}>
      <svg viewBox="0 0 1200 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#E4DDD0" />
            <stop offset=".7" stopColor="#F1DCC3" />
            <stop offset="1" stopColor="#F4D3B4" />
          </linearGradient>
          <linearGradient id={`${id}m`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#AFC0B6" />
            <stop offset="1" stopColor="#6E8C86" />
          </linearGradient>
          <linearGradient id={`${id}r`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#F4D8B0" stopOpacity=".9" />
            <stop offset="1" stopColor="#F4D8B0" stopOpacity="0" />
          </linearGradient>
        </defs>
        <rect width="1200" height="900" fill={`url(#${id}c)`} />
        <g {...capa(6)}>
          <circle cx="360" cy="520" r="58" fill="#EFB98A" />
          <g fill="#FBF4E6" opacity=".75">
            <ellipse cx="240" cy="200" rx="160" ry="12" />
            <ellipse cx="820" cy="260" rx="200" ry="10" />
            <ellipse cx="900" cy="284" rx="110" ry="7" />
          </g>
          <Pajaros color="#7A6F5E" aves={[[520, 330, 10], [552, 318, 7], [580, 340, 8]]} />
        </g>
        <g {...capa(12)}>
          <rect y="530" width="1200" height="420" fill={`url(#${id}m)`} />
          <path d="M270 532h180l-40 150h-100z" fill={`url(#${id}r)`} opacity=".7" />
          <g stroke="#E7EEE8" strokeWidth="2" strokeLinecap="round" opacity=".55">
            <path d="M80 590h120M300 612h90M520 598h160M160 660h110M420 690h140M700 640h110M60 740h160M360 770h120" />
          </g>
        </g>
        <g {...capa(24)}>
          <path d="M1240 950V560C1180 540 1120 520 1060 536C1010 548 960 530 900 556C850 578 820 640 800 700C780 780 740 860 700 950Z" fill="#C4A77A" />
          <path d="M1240 950V640C1150 660 1060 700 1000 780C960 840 940 900 930 950Z" fill="#9C8057" />
          <path d="M1240 566C1180 540 1120 520 1060 536C1010 548 960 530 900 556L904 572C962 548 1012 566 1062 554C1122 540 1180 560 1240 586Z" fill="#6F7A3E" />
          <g transform="translate(1030 440)">
            <path d="M-16 100L-11 0h22L16 100z" fill="#F6F0E4" />
            <path d="M-14.5 70h29l-1 14h-27zM-12.6 32h25.2l-.8 13h-23.6z" fill="#C06A4A" />
            <rect x="-15" y="-16" width="30" height="16" rx="3" fill="#3E3A30" />
            <path d="M-19 -16h38l-19 -18z" fill="#C06A4A" />
            <circle cx="0" cy="-8" r="4.5" fill="#F7D59C" />
          </g>
        </g>
        <g {...capa(40)}>
          <path d={cresta([[-40, 820], [80, 760], [200, 790], [320, 812], [440, 860], [520, 950]], 960)} fill="#4F5434" />
          <path d={cresta([[-40, 870], [60, 842], [180, 870], [300, 900], [380, 960]], 980)} fill="#363A24" />
        </g>
      </svg>
    </div>
  );
}

// ── Valle de olivos (los productos) ─────────────────────────────────────

export function PaisajeValle({ className = '' }) {
  const id = useId().replace(/:/g, '');
  const ref = useParallax();
  const fila = (y0, x0, x1, paso, s) => Array.from({ length: Math.floor((x1 - x0) / paso) + 1 }, (_, i) => [x0 + i * paso, y0 + Math.sin(i * 0.7) * 3, s]);
  return (
    <div ref={ref} className={`paisaje ${className}`}>
      <svg viewBox="0 0 1600 640" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#E6E3D3" />
            <stop offset="1" stopColor="#F4EEDD" />
          </linearGradient>
        </defs>
        <rect width="1600" height="640" fill={`url(#${id}c)`} />
        <g {...capa(4)} fill="#FBF6EA" opacity=".85">
          <ellipse cx="300" cy="120" rx="170" ry="14" />
          <ellipse cx="1180" cy="90" rx="220" ry="12" />
          <ellipse cx="1260" cy="112" rx="120" ry="8" />
        </g>
        <g {...capa(8)}>
          <path d={cresta([[-40, 300], [200, 262], [420, 286], [660, 250], [900, 280], [1120, 246], [1360, 276], [1640, 256]], 700)} fill="#C3C2A2" />
        </g>
        <g {...capa(16)}>
          <path d={cresta([[-40, 370], [240, 330], [520, 362], [780, 334], [1060, 368], [1320, 330], [1640, 356]], 700)} fill="#B9B27E" />
          <path d={cresta([[620, 700], [700, 380], [900, 350], [1100, 372], [1300, 342], [1640, 360], [1640, 700]], 700)} fill="#D2C48F" opacity=".75" />
        </g>
        <g {...capa(26)}>
          <path d={cresta([[-40, 440], [260, 404], [560, 432], [860, 400], [1160, 438], [1440, 408], [1640, 424]], 720)} fill="#9CA16A" />
          <Olivos fill="#5E6834" arboles={[...fila(452, 60, 520, 46, 13), ...fila(440, 900, 1500, 46, 13)]} />
          <g transform="translate(700 404)">
            <rect x="0" y="0" width="64" height="38" fill="#F4EEE1" />
            <path d="M-6 2L32 -22L70 2z" fill="#B8664A" />
            <rect x="26" y="16" width="12" height="22" fill="#6B5B45" />
          </g>
          <Cipreses fill="#4A5228" arboles={[[788, 442, 64], [806, 444, 48]]} />
        </g>
        <g {...capa(40)}>
          <path d={cresta([[-40, 540], [300, 500], [640, 528], [980, 494], [1320, 524], [1640, 500]], 740)} fill="#7D8649" />
          <Olivos fill="#48512A" arboles={[...fila(560, 40, 600, 70, 20), ...fila(546, 1000, 1580, 70, 20)]} />
          <path d="M820 740C800 640 760 590 700 540C680 520 720 504 760 500" fill="none" stroke="#E6DABE" strokeWidth="18" strokeLinecap="round" opacity=".9" />
        </g>
        <g {...capa(58)}>
          <path d={cresta([[-40, 630], [360, 596], [760, 620], [1160, 590], [1640, 612]], 760)} fill="#4E5629" />
        </g>
      </svg>
    </div>
  );
}

// ── Crepúsculo sobre el lago (llamada final) ─────────────────────────────

const ESTRELLAS = [[120, 80], [260, 150], [410, 60], [560, 120], [700, 40], [820, 170], [980, 70], [1120, 140], [1260, 50], [1420, 110], [1510, 190], [340, 230], [900, 250], [1380, 260], [60, 210], [640, 210]];

export function PaisajeCrepusculo({ className = '' }) {
  const id = useId().replace(/:/g, '');
  const ref = useParallax();
  return (
    <div ref={ref} className={`paisaje paisaje--noche ${className}`}>
      <svg viewBox="0 0 1600 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}c`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#23262A" />
            <stop offset=".45" stopColor="#4E4A4C" />
            <stop offset=".72" stopColor="#9A6E5A" />
            <stop offset=".86" stopColor="#D69A63" />
          </linearGradient>
          <linearGradient id={`${id}l`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#C58E62" />
            <stop offset=".4" stopColor="#6C5A52" />
            <stop offset="1" stopColor="#2A2B2B" />
          </linearGradient>
        </defs>
        <rect width="1600" height="800" fill={`url(#${id}c)`} />
        <g {...capa(3)} fill="#F6EEDC">
          {ESTRELLAS.map(([x, y], i) => <circle key={i} className="estrella" cx={x} cy={y} r={i % 3 ? 1.6 : 2.4} style={{ animationDelay: `${(i % 5) * 0.7}s` }} />)}
          <path d="M1250 170a52 52 0 1 0 40 86a44 44 0 1 1 -40 -86z" opacity=".95" />
        </g>
        <g {...capa(10)}>
          <path d={cresta([[-40, 500], [160, 452], [340, 486], [520, 420], [700, 470], [880, 436], [1060, 482], [1260, 428], [1440, 468], [1640, 440]], 900)} fill="#4A4043" />
        </g>
        <g {...capa(20)}>
          <path d={cresta([[-40, 560], [220, 516], [460, 548], [700, 506], [960, 546], [1200, 512], [1440, 540], [1640, 520]], 900)} fill="#2F2D2C" />
          <Cipreses fill="#242321" arboles={[[300, 540, 70], [322, 544, 52], [1300, 524, 84], [1326, 528, 60]]} />
        </g>
        <g {...capa(30)}>
          <rect y="580" width="1600" height="300" fill={`url(#${id}l)`} />
          <g stroke="#F2C58F" strokeLinecap="round" opacity=".5">
            <path d="M700 600h200M740 626h120M660 652h280M760 690h80M720 730h160" strokeWidth="2" />
          </g>
          <g stroke="#F6EEDC" strokeLinecap="round" opacity=".18" strokeWidth="1.6">
            <path d="M120 640h140M1300 620h180M240 720h120M1180 700h160" />
          </g>
        </g>
        <g {...capa(46)}>
          <path d={cresta([[-40, 790], [200, 740], [420, 770], [540, 820]], 900)} fill="#1A1B18" />
          <path d={cresta([[1160, 830], [1300, 752], [1460, 736], [1640, 760]], 900)} fill="#1A1B18" />
        </g>
      </svg>
    </div>
  );
}
