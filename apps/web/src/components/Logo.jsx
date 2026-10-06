// Logo.jsx — la marca: el isotipo real (el mismo de favicon.svg) junto al
// wordmark LIXBON en Bruno Ace SC.

// Isotipo suelto, para donde no cabe el wordmark (favicon del cajón, avatares
// del sistema, pantalla de carga).
// Las piezas llevan clase para que la versión animada (landing.css) pueda
// montarlas una a una; sin `.logo--animado` no hacen nada.
export function LogoMark({ size = 26 }) {
  return (
    <svg className="logo__mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect className="logo__fondo" x="0" y="0" width="32" height="32" rx="9" ry="9" fill="#1B1A17" />
      <polygon className="logo__p logo__p--1" points="16,3.2 3.2,16 16,16" fill="#DCD6BC" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <polygon className="logo__p logo__p--2" points="16,3.2 28.8,16 16,16" fill="#C7BE9F" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <polygon className="logo__p logo__p--3" points="3.2,16 16,28.8 16,16" fill="#4B5327" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <polygon className="logo__p logo__p--4" points="28.8,16 16,28.8 16,16" fill="#333A1C" stroke="#1B1A17" strokeWidth="0.9" strokeLinejoin="round" />
      <g className="logo__chispa">
        <path
          d="M19.8 16C20.956 18.244 20.956 18.244 23.2 19.4C20.956 20.556 20.956 20.556 19.8 22.8C18.644 20.556 18.644 20.556 16.4 19.4C18.644 18.244 18.644 18.244 19.8 16Z"
          fill="#FCFAEF"
        />
        <circle cx="23.4" cy="22.6" r="1.1" fill="#FCFAEF" />
      </g>
    </svg>
  );
}

// `mark={false}` deja solo el wordmark (pie de página, correos embebidos).
// Bruno Ace SC es una versalita angosta: a igual `size` que el isotipo se ve
// más chica, así que el wordmark usa un tamaño mayor para que ambos pesen
// lo mismo en la barra.
// `animado` monta el isotipo pieza a pieza y levanta las letras en cascada
// (landing.css). Corre al montarse; dentro de un contenedor de useRevelar
// espera a que el wordmark entre en vista (así lo usa el pie).
// `size={null}` deja el cuerpo del wordmark al CSS (el pie lo hace enorme).
export function Logo({ size = 15, mark = true, animado = false, className = '' }) {
  return (
    <span className={`logo ${animado ? 'logo--animado' : ''} ${className}`}>
      {mark && <LogoMark size={Math.round((size || 15) * 1.73)} />}
      <span className="brand" style={size ? { fontSize: Math.round(size * 1.3) } : undefined}>
        {animado
          ? [...'LIXBON'].map((l, i) => <span key={i} className="logo__letra" style={{ '--i': i }}>{l}</span>)
          : 'LIXBON'}
      </span>
    </span>
  );
}
