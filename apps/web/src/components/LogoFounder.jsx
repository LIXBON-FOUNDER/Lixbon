import { useEffect, useId, useState } from 'react';

const GROSOR = 17;
const H = GROSOR / 2;
const ANCHO = { L: 56, I: GROSOR, X: 66, B: 64, O: 76, N: 68, F: 56, U: 72, D: 72, E: 56, R: 66 };
const ESPACIO = 14;
const ENTRE_PALABRAS = 36;
const F_FINAL = 48;
const RADIO_UNION = 16;
const TONO = 0.42;
const RECORRIDO = 420;

const r = (n) => Math.round(n * 100) / 100;
const acota = (n) => Math.min(1, Math.max(0, n));
const suave = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const seno = (t) => (1 - Math.cos(Math.PI * t)) / 2;

const ru = (50 - H) / 2;
const ojo = (w) => `H${r(w - 2 - H - ru)}A${r(ru)} ${r(ru)} 0 0 1 ${r(w - 2 - H - ru)} 50H${r(H)}`;
const redondo = (w) => {
  const a = (w - 2 * H) / 2;
  const arco = `A${r(a)} ${r(a)} 0 0 1`;
  return `M${w / 2} ${H}${arco} ${w - H} ${r(H + a)}V${r(100 - H - a)}${arco} ${w / 2} ${100 - H}${arco} ${H} ${r(100 - H - a)}V${r(H + a)}${arco} ${w / 2} ${H}Z`;
};
const ene = (w) => {
  const d = (w - 2 * H) * 0.1;
  return `M${H} 100V0M${r(H - d)} -10L${r(w - H + d)} 110M${w - H} 100V0`;
};
const uA = (ANCHO.U - 2 * H) / 2;
const dA = (100 - 2 * H) / 2;
const FORMA = {
  I: `M${H} 0V100`,
  X: `M${r(H * 0.7)} -10L${r(66 - H * 0.7)} 110M${r(66 - H * 0.7)} -10L${r(H * 0.7)} 110`,
  B: `M${H} 0V100M${H} ${H}${ojo(64)}M${H} 50H${r(64 - H - ru)}A${r(ru)} ${r(ru)} 0 0 1 ${r(64 - H - ru)} ${100 - H}H${H}`,
  O: redondo(ANCHO.O),
  N: ene(ANCHO.N),
  U: `M${H} 0V${r(100 - H - uA)}A${r(uA)} ${r(uA)} 0 0 0 ${ANCHO.U - H} ${r(100 - H - uA)}V0`,
  D: `M${H} 0V100M${H} ${H}H${r(72 - H - dA)}A${r(dA)} ${r(dA)} 0 0 1 ${r(72 - H - dA)} ${100 - H}H${H}`,
  E: `M56 ${H}H${H}V${100 - H}H56M${H} 50H50`,
  R: `M${H} 100V${H}${ojo(66)}M28 50L${66 - H} 108`,
};

const IXBON = [['i', 'I'], ['x', 'X'], ['b', 'B'], ['o', 'O'], ['n', 'N']];
const OUNDER = [['o2', 'O'], ['u', 'U'], ['n2', 'N'], ['d', 'D'], ['e', 'E'], ['r', 'R']];

const POS = (() => {
  const pos = {};
  let x = ANCHO.L;
  IXBON.forEach(([k, g]) => { x += ESPACIO; pos[k] = x; x += ANCHO[g]; });
  pos.f = x + ENTRE_PALABRAS;
  x = pos.f + ANCHO.F;
  OUNDER.forEach(([k, g]) => { x += ESPACIO; pos[k] = x; x += ANCHO[g]; });
  pos.cola = x - pos.f;
  return pos;
})();

function geometria(p) {
  const desliza = suave(acota(p / 0.85));
  const guarda = seno(acota(p / 0.8));
  const une = seno(acota((p - 0.72) / 0.28));
  const fX = POS.f + (F_FINAL - POS.f) * desliza;
  const radio = RADIO_UNION * une;
  const finPie = ANCHO.L + (F_FINAL + H - radio + 0.5 - ANCHO.L) * une;
  return {
    fX,
    ancho: fX + Math.max(ANCHO.F, POS.cola * (1 - guarda)),
    ounderX: (k) => fX + POS[k] - POS.f - POS.cola * guarda,
    l: `M${H} 0V${100 - H}H${r(finPie)}`,
    f: `M${r(H - radio)} ${r(100 - H * une)}A${r(radio)} ${r(radio)} 0 0 0 ${H} ${r(100 - H - radio)}V${H}H56M${H} 50H${r(50 - 6 * une)}`,
  };
}

export function LogoFounder({ progreso = 0, alto = 22, className = '' }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const g = geometria(acota(progreso));
  const w = g.ancho + 4;
  return (
    <svg
      className={`logo-founder ${className}`}
      width={r((w * alto) / 100)}
      height={alto}
      viewBox={`-2 0 ${r(w)} 100`}
      role="img"
      aria-label="Lixbon Founder"
      fill="none"
      stroke="currentColor"
      strokeWidth={GROSOR}
    >
      <defs>
        <clipPath id={`${id}i`}><rect x="-4" y="-20" width={r(Math.max(0, g.fX + 4))} height="140" /></clipPath>
        <clipPath id={`${id}d`}><rect x={r(g.fX + ANCHO.F)} y="-20" width="2000" height="140" /></clipPath>
      </defs>
      <g clipPath={`url(#${id}i)`} opacity={TONO}>
        {IXBON.map(([k, l]) => <path key={k} d={FORMA[l]} transform={`translate(${POS[k]} 0)`} />)}
      </g>
      <g clipPath={`url(#${id}d)`} opacity={TONO}>
        {OUNDER.map(([k, l]) => <path key={k} d={FORMA[l]} transform={`translate(${r(g.ounderX(k))} 0)`} />)}
      </g>
      <path d={g.f} transform={`translate(${r(g.fX)} 0)`} />
      <path d={g.l} />
    </svg>
  );
}

function useProgresoScroll(recorrido = RECORRIDO) {
  const [progreso, setProgreso] = useState(0);
  useEffect(() => {
    const reducido = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let cuadro = 0;
    const medir = () => {
      cuadro = 0;
      const p = acota(window.scrollY / recorrido);
      setProgreso(reducido ? (p < 0.5 ? 0 : 1) : p);
    };
    const alMover = () => { if (!cuadro) cuadro = requestAnimationFrame(medir); };
    medir();
    window.addEventListener('scroll', alMover, { passive: true });
    return () => {
      window.removeEventListener('scroll', alMover);
      cancelAnimationFrame(cuadro);
    };
  }, [recorrido]);
  return progreso;
}

function useFaviconFounder() {
  useEffect(() => {
    const enlaces = [...document.querySelectorAll('link[rel="icon"]')];
    const antes = enlaces.map((e) => [e.getAttribute('href'), e.getAttribute('type')]);
    enlaces.forEach((e) => { e.setAttribute('href', '/founder.svg'); e.setAttribute('type', 'image/svg+xml'); });
    return () => enlaces.forEach((e, i) => {
      e.setAttribute('href', antes[i][0]);
      if (antes[i][1]) e.setAttribute('type', antes[i][1]);
      else e.removeAttribute('type');
    });
  }, []);
}

export function LogoFounderScroll({ alto = 22 }) {
  useFaviconFounder();
  return <LogoFounder progreso={useProgresoScroll()} alto={alto} />;
}
