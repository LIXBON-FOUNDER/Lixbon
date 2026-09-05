// Logo.jsx — la marca: el isotipo real (el mismo de favicon.svg) junto al
// wordmark LIXBON en Bruno Ace SC.

// Isotipo suelto, para donde no cabe el wordmark (favicon del cajón, avatares
// del sistema, pantalla de carga).
export function LogoMark({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x="0" y="0" width="32" height="32" rx="9" ry="9" fill="#1B1A17" />
      <polygon points="16,3.2 3.2,16 16,16" fill="#DCD6BC" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <polygon points="16,3.2 28.8,16 16,16" fill="#C7BE9F" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <polygon points="3.2,16 16,28.8 16,16" fill="#4B5327" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <polygon points="28.8,16 16,28.8 16,16" fill="#333A1C" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <path
        d="M19.8 16C20.956 18.244 20.956 18.244 23.2 19.4C20.956 20.556 20.956 20.556 19.8 22.8C18.644 20.556 18.644 20.556 16.4 19.4C18.644 18.244 18.644 18.244 19.8 16Z"
        fill="#FCFAEF"
      />
      <circle cx="23.4" cy="22.6" r="1.1" fill="#FCFAEF" />
    </svg>
  );
}

// `mark={false}` deja solo el wordmark (pie de página, correos embebidos).
export function Logo({ size = 15, mark = true }) {
  return (
    <span className="logo">
      {mark && <LogoMark size={Math.round(size * 1.73)} />}
      <span className="brand" style={{ fontSize: size }}>
        LIXBON
      </span>
    </span>
  );
}
