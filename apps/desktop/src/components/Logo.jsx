// Logo.jsx — marca de lixbon: diamante de cuatro facetas y wordmark.

export function LogoMark({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logomark">
      <polygon points="16,2 2,16 16,16" fill="#E6DFC2" />
      <polygon points="16,2 30,16 16,16" fill="#CFC5A2" />
      <polygon points="2,16 16,30 16,16" fill="#7D8A3E" />
      <polygon points="30,16 16,30 16,16" fill="#58622A" />
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
