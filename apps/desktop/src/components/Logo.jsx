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
