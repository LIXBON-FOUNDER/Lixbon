// Logo.jsx — marca de lixbon: prisma de cuatro caras con destello y wordmark.

const FACES = ['32,4 12,26 27,28', '32,4 27,28 52,26', '12,26 27,28 32,60', '27,28 52,26 32,60'];
// La luz de la refracción recorre las caras en sentido horario.
const CLOCKWISE = [FACES[0], FACES[1], FACES[3], FACES[2]];
const STAR = 'M38 30Q38.9 37.1 42.5 38Q38.9 38.9 38 46Q37.1 38.9 33.5 38Q37.1 37.1 38 30Z';

// Giro: la arista central barre el prisma de izquierda a derecha y cada cara
// se oscurece al pasar al otro lado.
const GIRO = [
  { from: '#E2D9B8', to: '#B3A880', points: ['32,4 12,26 12.5,26.2', '32,4 12,26 32,28', '32,4 12,26 51.5,26.2'] },
  { from: '#B3A880', to: '#8A825D', points: ['32,4 12.5,26.2 52,26', '32,4 32,28 52,26', '32,4 51.5,26.2 52,26'] },
  { from: '#66702F', to: '#3A4120', points: ['12,26 12.5,26.2 32,60', '12,26 32,28 32,60', '12,26 51.5,26.2 32,60'] },
  { from: '#3A4120', to: '#1E2310', points: ['12.5,26.2 52,26 32,60', '32,28 52,26 32,60', '51.5,26.2 52,26 32,60'] },
];

/** Animación del icono según lo que hace el agente: leer y buscar refractan
    la luz, editar y ejecutar tallan las caras, lo demás es pensar. */
export function toolMotion(tool) {
  if (/^(read_file|search|list_files|find_files|outline|web_search|fetch_url|read_output)$/.test(tool || '')) return 'refraccion';
  if (/^(write_file|edit_file|multi_edit|append_file|insert_at_line|delete_file|rename_file|mkdir|run_command)$/.test(tool || '')) return 'talla';
  return 'destello';
}

/** motion: destello (pensando), refraccion (leyendo), talla (editando),
    giro (agentes en segundo plano). Sin motion, el icono quieto. */
export function LogoMark({ size = 18, motion, className = '' }) {
  const cls = `logomark ${motion ? `logomark--${motion}` : ''} ${className}`;
  // El giro es SMIL: el CSS de movimiento reducido no lo para.
  if (motion === 'giro' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    const anim = { dur: '2.8s', repeatCount: 'indefinite' };
    return (
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={cls}>
        <polygon points="32,4 52,26 32,60 12,26" fill="#8A825D" />
        {GIRO.map((f) => (
          <polygon key={f.from} points={f.points[0]} fill={f.from}>
            <animate attributeName="points" {...anim} calcMode="spline" keyTimes="0;0.5;1" keySplines="0.45 0 1 1;0 0 0.55 1" values={f.points.join(';')} />
            <animate attributeName="fill" {...anim} values={`${f.from};${f.to}`} />
          </polygon>
        ))}
        <path className="logomark__star" d={STAR} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={cls}>
      <g strokeWidth="0.35" strokeLinejoin="round">
        {FACES.slice(0, 3).map((p, i) => <polygon key={p} className={`logomark__f${i + 1}`} points={p} />)}
        <g className="logomark__f4g">
          <polygon className="logomark__f4" points={FACES[3]} />
          {motion === 'talla' && <path className="logomark__star" d={STAR} />}
        </g>
      </g>
      {motion === 'refraccion' && CLOCKWISE.map((p, i) => <polygon key={p} className={`logomark__luz logomark__luz--${i + 1}`} points={p} />)}
      {motion !== 'talla' && <path className="logomark__star" d={STAR} />}
    </svg>
  );
}

export function Logo({ size = 30 }) {
  return (
    <span className="brand" style={{ fontSize: size }}>
      lixbon
    </span>
  );
}

// Lixbon Team: el diamante de Lixbon delante de otro en el acento, dos que
// trabajan juntos. El corte entre ambos toma el fondo de donde se pinte.
export function TeamMark({ size = 18, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={`teammark ${className}`}>
      <polygon points="21.5,2.5 31,12 21.5,21.5 12,12" fill="#C6D66E" />
      <polygon points="12.5,9 23,19.5 12.5,30 2,19.5" className="teammark__cut" />
      <g className="teammark__front">
        <polygon points="12.5,9 2,19.5 12.5,19.5" fill="#E6DFC2" />
        <polygon points="12.5,9 23,19.5 12.5,19.5" fill="#CFC5A2" />
        <polygon points="2,19.5 12.5,30 12.5,19.5" fill="#7D8A3E" />
        <polygon points="23,19.5 12.5,30 12.5,19.5" fill="#58622A" />
      </g>
    </svg>
  );
}

export function ClaudeMark({ size = 16, className = '' }) {
  const rays = Array.from({ length: 8 }, (_, i) => i * 22.5 * 2);
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={`claudemark ${className}`}>
      {rays.map((deg) => (
        <rect key={deg} x="14.6" y="3" width="2.8" height="26" rx="1.4" fill="#D97757" transform={`rotate(${deg} 16 16)`} />
      ))}
    </svg>
  );
}
