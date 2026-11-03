import { useEffect, useRef } from 'react';

// Fondo del chat de inicio: el ciclo del día en ASCII según la hora local.
//   mañana     el sol surge por la izquierda, dorado, entre nubes rosadas
//   mediodía   el sol en lo alto, claro
//   tarde      el sol naranja cae hacia la derecha tras la cordillera
//   noche      la luna sube entre estrellas
//   madrugada  la luna en su punto más alto (≈ 02:30) y luego baja
// Técnica del antiguo colibrí: la escena se dibuja en vectores a un búfer de
// una celda por carácter; cada celda opaca se pinta como un bloque de color con
// un glifo encima, y el halo o la bruma solo como glifos. La escena se atenúa
// alrededor del contenido. Sin animación: se repinta cada minuto, al cambiar
// de tamaño y al cambiar de tema. Sin `cielo`, el hueco queda vacío (Remoto).

const SALE_SOL = 6;       // 06:00
const SE_PONE_SOL = 19.5; // 19:30
const CUMBRE_LUNA = 2.5;  // 02:30

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sstep = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const rgbDe = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hexDe = (c) => `#${c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
const mezcla = (a, b, t) => { const x = rgbDe(a), y = rgbDe(b), k = clamp(t, 0, 1); return hexDe(x.map((v, i) => v + (y[i] - v) * k)); };
const conAlfa = (h, a) => { const [r, g, b] = rgbDe(h); return `rgba(${r},${g},${b},${clamp(a, 0, 1)})`; };

// Paletas: núcleo, medio y borde del astro, halo, bruma del horizonte, nubes
// (cara iluminada y sombra) y las tres sierras (lejana → cercana).
const PALETAS = {
  manana: {
    nucleo: '#FFF6DA', medio: '#FFC56B', borde: '#F39A3D', halo: '#FFB45A', bruma: '#F2A35E', brumaA: 0.26,
    nubeLuz: '#F6C79A', nubeSombra: '#7E6A78', sierra: ['#3E3C4C', '#2B2C37', '#1C1D23'],
  },
  mediodia: {
    nucleo: '#FFFBEA', medio: '#FFE9A8', borde: '#FFD06A', halo: '#FFE3A0', bruma: '#A9B8C8', brumaA: 0.08,
    nubeLuz: '#E9E6DE', nubeSombra: '#8F949E', sierra: ['#353D38', '#272E26', '#1B201B'],
  },
  tarde: {
    nucleo: '#FFE2A8', medio: '#F58A3A', borde: '#D9481F', halo: '#F07A34', bruma: '#E8663A', brumaA: 0.34,
    nubeLuz: '#F29B6B', nubeSombra: '#5E3446', sierra: ['#4C3040', '#33202D', '#1F161B'],
  },
  noche: {
    nucleo: '#F6F3E9', medio: '#E4E0D4', borde: '#C9C4B7', halo: '#C9D2E8', bruma: '#3B4A7A', brumaA: 0.14,
    nubeLuz: '#5C6379', nubeSombra: '#262A36', sierra: ['#252A3A', '#1B1F2C', '#14161D'],
  },
};
const CLAVES = ['nucleo', 'medio', 'borde', 'halo', 'bruma', 'nubeLuz', 'nubeSombra'];
function interpola(a, b, t) {
  const p = { brumaA: a.brumaA + (b.brumaA - a.brumaA) * t, sierra: a.sierra.map((c, i) => mezcla(c, b.sierra[i], t)) };
  for (const k of CLAVES) p[k] = mezcla(a[k], b[k], t);
  return p;
}

// Ángulo sobre el arco (0 = horizonte izquierdo, π = derecho), altura, fase.
export function astroDe(h) {
  if (h >= SALE_SOL && h < SE_PONE_SOL) {
    const t = (h - SALE_SOL) / (SE_PONE_SOL - SALE_SOL);
    const alto = Math.sin(Math.PI * t);
    const fase = h < 11 ? 'manana' : h < 15 ? 'mediodia' : 'tarde';
    const k = alto ** 1.6;
    const paleta = t < 0.5 ? interpola(PALETAS.manana, PALETAS.mediodia, k) : interpola(PALETAS.tarde, PALETAS.mediodia, k);
    return { astro: 'sol', fase, theta: Math.PI * t, alto, paleta };
  }
  const desde = (h - SE_PONE_SOL + 24) % 24;
  const subida = (CUMBRE_LUNA - SE_PONE_SOL + 24) % 24; // 7 h
  const total = (SALE_SOL - SE_PONE_SOL + 24) % 24;     // 10,5 h
  const theta = desde <= subida
    ? (Math.PI / 2) * (desde / subida)
    : (Math.PI / 2) * (1 + (desde - subida) / (total - subida));
  const fase = h >= SE_PONE_SOL || h < 0.5 ? 'noche' : 'madrugada';
  return { astro: 'luna', fase, theta, alto: Math.sin(theta), paleta: PALETAS.noche };
}

function horaActual() {
  if (import.meta.env.DEV) {
    const p = new URLSearchParams(window.location.search).get('hora');
    if (p !== null && !Number.isNaN(+p)) return +p;
  }
  const d = new Date();
  return d.getHours() + d.getMinutes() / 60;
}

// Rampas de glifos: bloques oscuros, medios y claros, y bruma.
const RD = '#%#X%#', RM = 'xX+x%x', RL = '+:x:+:', RV = ':..:·.';

// Nubes fijas: centro (fracción del ancho y del alto) y ancho relativo.
const NUBES = [
  { x: 0.16, y: 0.2, w: 0.15 }, { x: 0.74, y: 0.13, w: 0.19 }, { x: 0.9, y: 0.4, w: 0.11 },
  { x: 0.3, y: 0.46, w: 0.09 }, { x: 0.58, y: 0.3, w: 0.08 },
];

// `ap` (0..1): cuánto del dibujo se ha formado. Al cargar la portada las
// celdas aparecen de abajo arriba y salteadas, como píxeles que se encienden.
function pintar(cv, h, centro, ap = 1) {
  const W = cv.clientWidth;
  const H = cv.clientHeight;
  if (!W || !H) return;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  cv.width = Math.round(W * DPR);
  cv.height = Math.round(H * DPR);
  const CELL = W < 520 ? 6 : W < 861 ? 7 : 8;
  const COLS = Math.ceil(W / CELL) + 1;
  const ROWS = Math.ceil(H / CELL) + 1;
  const root = document.documentElement;
  const claro = root.dataset.theme === 'light';
  const MONO = getComputedStyle(root).getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace';
  const a = astroDe(h);
  const noche = a.astro === 'luna';
  // En claro, las sierras y las nubes se aclaran hacia el papel.
  const P = claro ? {
    ...a.paleta,
    sierra: a.paleta.sierra.map((c, i) => mezcla(c, '#F2EEE4', [0.62, 0.5, 0.38][i])),
    nubeSombra: mezcla(a.paleta.nubeSombra, '#F2EEE4', 0.45),
    nubeLuz: mezcla(a.paleta.nubeLuz, '#FFFFFF', 0.2),
  } : a.paleta;

  // Zona del contenido: la escena se atenúa a su alrededor.
  const cr = cv.getBoundingClientRect();
  const rc = centro?.getBoundingClientRect();
  const C = rc ? { l: rc.left - cr.left, t: rc.top - cr.top, r: rc.right - cr.left, b: rc.bottom - cr.top } : null;
  const mask = new Float32Array(COLS * ROWS).fill(1);
  const hash = new Float32Array(COLS * ROWS);
  for (let i = 0; i < hash.length; i += 1) { const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453; hash[i] = x - Math.floor(x); }
  if (C) {
    for (let cy = 0; cy < ROWS; cy += 1) for (let cx = 0; cx < COLS; cx += 1) {
      const px = cx * CELL + CELL / 2, py = cy * CELL + CELL / 2;
      const dx = Math.max(C.l - 10 - px, 0, px - (C.r + 10)), dy = Math.max(C.t - 10 - py, 0, py - (C.b + 10));
      mask[cy * COLS + cx] = 0.18 + 0.82 * sstep(Math.hypot(dx, dy) / 56);
    }
  }

  // Cordillera: tres capas pegadas al borde de abajo.
  const rh = H * 0.26;
  // Picos: senos «crestados» (1 − |sen|) para cumbres afiladas y valles suaves.
  const capas = [
    { h: rh * 1.25, f: [0.0035, 0.009, 0.027], o: [0.4, 2.1, 1.3], pico: 0.55 },
    { h: rh * 0.85, f: [0.0052, 0.014, 0.039], o: [2.6, 0.4, 3.1], pico: 0.4 },
    { h: rh * 0.5, f: [0.007, 0.02, 0.055], o: [1.1, 3.7, 0.6], pico: 0.2 },
  ];
  const cresta = (v) => 1 - Math.abs(Math.sin(v));
  const cima = (l, x) => H - l.h * (0.42
    + 0.3 * ((1 - l.pico) * Math.sin(x * l.f[0] + l.o[0]) + l.pico * (cresta(x * l.f[0] * 1.7 + l.o[0]) * 2 - 1))
    + 0.14 * cresta(x * l.f[1] + l.o[1]) + 0.05 * Math.sin(x * l.f[2] + l.o[2]));
  const horizonte = H - rh * 0.5;

  // Astro: semicírculo alrededor del contenido; en lo alto, sobre el titular.
  const techo = C ? C.t : H * 0.3;
  const Rmax = noche ? 46 : 58;
  const R = clamp(Math.min(Rmax, (techo - 20) / 2.4), 20, Rmax);
  const tope = clamp(techo - R * 1.3, R + 8, R + 28);
  const ax = W / 2 - W * 0.44 * Math.cos(a.theta);
  const ay = horizonte - (horizonte - tope) * Math.sin(a.theta);
  const bajo = 1 - a.alto;

  // ---------- escena en el búfer (una celda = un píxel) ----------
  const buf = document.createElement('canvas');
  buf.width = COLS; buf.height = ROWS;
  const B = buf.getContext('2d', { willReadFrequently: true });
  B.setTransform(1 / CELL, 0, 0, 1 / CELL, 0, 0);

  // Bruma del horizonte (más intensa con el astro bajo).
  const brumaA = P.brumaA * (noche ? 1 : 0.45 + bajo * 0.9);
  const gb = B.createLinearGradient(0, horizonte - H * 0.42, 0, horizonte + rh * 0.2);
  gb.addColorStop(0, conAlfa(P.bruma, 0));
  gb.addColorStop(1, conAlfa(P.bruma, brumaA));
  B.fillStyle = gb; B.fillRect(0, horizonte - H * 0.42, W, H * 0.42 + rh);
  // Resplandor sobre el horizonte, centrado en el sol cuando está bajo.
  if (!noche && bajo > 0.35) {
    const gr = B.createRadialGradient(ax, horizonte, 0, ax, horizonte, W * 0.38);
    gr.addColorStop(0, conAlfa(P.halo, 0.42 * (bajo - 0.35) / 0.65));
    gr.addColorStop(1, conAlfa(P.halo, 0));
    B.fillStyle = gr; B.fillRect(0, 0, W, H);
  }

  // Halo del astro.
  const gh = B.createRadialGradient(ax, ay, R * 0.9, ax, ay, R * (noche ? 2.6 : 3.2));
  gh.addColorStop(0, conAlfa(P.halo, noche ? 0.36 : 0.44));
  gh.addColorStop(1, conAlfa(P.halo, 0));
  B.fillStyle = gh; B.beginPath(); B.arc(ax, ay, R * 3.2, 0, Math.PI * 2); B.fill();

  // Disco: degradado del núcleo al borde (oscurecimiento del limbo).
  const gd = B.createRadialGradient(ax - R * 0.2, ay - R * 0.25, R * 0.1, ax, ay, R);
  gd.addColorStop(0, P.nucleo); gd.addColorStop(0.55, P.medio); gd.addColorStop(1, P.borde);
  B.fillStyle = gd; B.beginPath(); B.arc(ax, ay, R, 0, Math.PI * 2); B.fill();
  if (noche) {
    // Mares y cráteres de la luna.
    B.save(); B.beginPath(); B.arc(ax, ay, R, 0, Math.PI * 2); B.clip();
    const manchas = [[-0.3, -0.25, 0.34, 0.26], [0.22, -0.32, 0.22, 0.18], [0.12, 0.18, 0.3, 0.22], [-0.38, 0.3, 0.16, 0.13], [0.45, 0.32, 0.12, 0.1], [-0.05, 0.55, 0.1, 0.08]];
    for (const [x, y, rx, ry] of manchas) {
      B.fillStyle = conAlfa(claro ? '#9A958A' : '#A9A497', 0.85);
      B.beginPath(); B.ellipse(ax + x * R, ay + y * R, rx * R, ry * R, 0.3, 0, Math.PI * 2); B.fill();
    }
    B.fillStyle = conAlfa('#FFFFFF', 0.35);
    for (const [x, y, r] of [[0.5, -0.05, 0.07], [-0.15, -0.6, 0.06], [-0.55, 0.0, 0.05]]) { B.beginPath(); B.arc(ax + x * R, ay + y * R, r * R, 0, Math.PI * 2); B.fill(); }
    B.restore();
  }

  // Nubes: puñados de elipses, iluminadas desde el lado del astro.
  for (const [i, n] of NUBES.entries()) {
    if (a.fase === 'mediodia' && i > 2) continue;
    const cx = n.x * W, cy = n.y * (horizonte - 40), w = n.w * W, hh = w * 0.22;
    const lado = Math.sign(ax - cx) || 1;
    const gn = B.createLinearGradient(cx - lado * w * 0.5, cy - hh, cx + lado * w * 0.5, cy + hh);
    gn.addColorStop(0, P.nubeSombra); gn.addColorStop(1, P.nubeLuz);
    B.fillStyle = gn;
    B.globalAlpha = noche ? 0.75 : 0.9;
    B.beginPath();
    B.ellipse(cx, cy + hh * 0.35, w * 0.5, hh * 0.55, 0, 0, Math.PI * 2);
    B.ellipse(cx - w * 0.2, cy, w * 0.2, hh * 0.75, 0, 0, Math.PI * 2);
    B.ellipse(cx + w * 0.08, cy - hh * 0.3, w * 0.24, hh, 0, 0, Math.PI * 2);
    B.ellipse(cx + w * 0.3, cy + hh * 0.05, w * 0.16, hh * 0.6, 0, 0, Math.PI * 2);
    B.fill();
    B.globalAlpha = 1;
  }

  // Cordillera, de la lejana a la cercana; tapa al astro bajo.
  capas.forEach((l, i) => {
    B.fillStyle = P.sierra[i];
    B.beginPath(); B.moveTo(0, H + CELL);
    for (let x = 0; x <= W + CELL; x += CELL / 2) B.lineTo(x, cima(l, x));
    B.lineTo(W + CELL, H + CELL); B.closePath(); B.fill();
    // Filo iluminado por el astro.
    B.strokeStyle = conAlfa(P.halo, (noche ? 0.25 : 0.35) * (1 - i * 0.25));
    B.lineWidth = CELL * 0.9;
    B.beginPath();
    for (let x = 0; x <= W + CELL; x += CELL / 2) { const y = cima(l, x); if (x === 0) B.moveTo(x, y); else B.lineTo(x, y); }
    B.stroke();
  });

  // ---------- celdas ----------
  const d = B.getImageData(0, 0, COLS, ROWS).data;
  const g = cv.getContext('2d');
  g.setTransform(DPR, 0, 0, DPR, 0, 0);
  g.clearRect(0, 0, W, H);
  g.font = `500 ${CELL + 0.5}px ${MONO}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const inkL = [241, 234, 216], inkD = [13, 12, 10];
  const half = CELL / 2, TS = CELL - 1.5;
  const filaCordillera = Math.floor((H - rh) / CELL);
  for (let cy = 0; cy < ROWS; cy += 1) {
    for (let cx = 0; cx < COLS; cx += 1) {
      const i = cy * COLS + cx, o = i * 4, A = d[o + 3] / 255, x = cx * CELL, y = cy * CELL, hs = hash[i];
      const f = ap >= 1 ? 1 : Math.min(1, Math.max(0, (ap * 1.45 - (hs * 0.55 + (1 - cy / ROWS) * 0.45)) / 0.45));
      if (f <= 0) continue;
      const m = mask[i] * f;
      if (A < 0.08) {
        // Estrellas de noche (fijas), por encima de la cordillera.
        if (noche && cy < filaCordillera && hs > 0.991) {
          const big = hs > 0.9985;
          g.fillStyle = `rgba(${(claro ? inkD : inkL).join(',')},${((big ? 0.7 : 0.38) * (0.55 + a.alto * 0.45) * m).toFixed(3)})`;
          g.fillText(big ? '+' : '·', x + half, y + half + 0.5);
        }
        continue;
      }
      const r = d[o], gg = d[o + 1], b = d[o + 2], lu = (0.299 * r + 0.587 * gg + 0.114 * b) / 255;
      if (A > 0.45) {
        g.fillStyle = `rgba(${r},${gg},${b},${(0.97 * m * Math.min(1, A * 1.25)).toFixed(3)})`;
        g.fillRect(x + 0.75, y + 0.75, TS, TS);
        const ch = (lu < 0.28 ? RD : lu < 0.5 ? RM : RL)[(hs * 6) | 0];
        const ink = lu < 0.55 ? inkL : inkD;
        g.fillStyle = `rgba(${ink.join(',')},${((lu < 0.55 ? 0.34 : 0.3) * m).toFixed(3)})`;
        g.fillText(ch, x + half, y + half + 0.5);
      } else {
        g.fillStyle = `rgba(${r},${gg},${b},${(Math.min(1, 0.3 + A * 1.4) * m).toFixed(3)})`;
        g.fillText(RV[(hs * 6) | 0], x + half, y + half + 0.5);
      }
    }
  }
}

let formado = false;

function Cielo() {
  const ref = useRef(null);
  useEffect(() => {
    const cv = ref.current;
    const centro = () => cv.parentElement?.querySelector('.colibri__centro');
    let animando = false;
    const dibujar = () => { if (!animando) pintar(cv, horaActual(), centro()); };
    // Solo la primera vez que se carga la página: el dibujo se forma en ~1,4 s.
    // Al volver a la portada (o con «menos movimiento») sale entero.
    let marco = 0;
    if (!formado && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      animando = true;
      let t0 = null;
      const paso = (t) => {
        t0 ??= t;
        const p = Math.min(1, (t - t0) / 1400);
        pintar(cv, horaActual(), centro(), 1 - (1 - p) ** 2);
        if (p < 1) marco = requestAnimationFrame(paso);
        else { animando = false; formado = true; }
      };
      marco = requestAnimationFrame(paso);
    } else {
      formado = true;
      dibujar();
    }
    const reloj = setInterval(dibujar, 60_000);
    const tam = new ResizeObserver(dibujar);
    tam.observe(cv);
    const tema = new MutationObserver(dibujar);
    tema.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    document.fonts?.ready.then(dibujar).catch(() => {});
    return () => { cancelAnimationFrame(marco); clearInterval(reloj); tam.disconnect(); tema.disconnect(); };
  }, []);
  return <canvas className="cielo" ref={ref} aria-hidden="true" />;
}

// `children` va en el centro (saludo, titular, cuadro de mensaje).
export function HeroInicio({ children, cielo = false }) {
  return (
    <div className="chat-hero colibri">
      {cielo && <Cielo />}
      <div className="colibri__centro">{children}</div>
    </div>
  );
}
