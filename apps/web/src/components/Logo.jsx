import { useEffect, useId } from 'react';
import { cargarFuente } from './LogoFounder';

// Isotipo: rombo de esquinas suaves con la chispa de 4 puntas calada abajo a la
// derecha. Una sola tinta (currentColor) y sin fondo.
const ROMBO = 'M15 3Q16 2 17 3L29 15Q30 16 29 17L17 29Q16 30 15 29L3 17Q2 16 3 15Z';
const CHISPA = 'M19.5 15.2Q20.25 18.75 23.8 19.5Q20.25 20.25 19.5 23.8Q18.75 20.25 15.2 19.5Q18.75 18.75 19.5 15.2Z';

export function LogoMark({ size = 26, className = '' }) {
  return (
    <svg className={`logo__mark ${className}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path className="logo__rombo" fill="currentColor" fillRule="evenodd" d={`${ROMBO}${CHISPA}`} />
    </svg>
  );
}

// El isotipo mientras el agente trabaja: quieto, y una ola de color suave lo
// recorre en diagonal (verde de marca → verde agua → ámbar pálido). La chispa
// sigue calada, así sirve sobre cualquier fondo. Con «reducir movimiento» la
// ola no se monta (SMIL no atiende a la media query de CSS).
const quieto = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function LogoTrabajando({ size = 18 }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className="logo-trabajo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse" spreadMethod="repeat">
          <stop offset="0" stopColor="#B4C64E" />
          <stop offset="0.35" stopColor="#86C9A0" />
          <stop offset="0.65" stopColor="#DCCF86" />
          <stop offset="1" stopColor="#B4C64E" />
          {!quieto() && (
            <animateTransform attributeName="gradientTransform" type="translate"
              from="0 0" to="32 32" dur="2.6s" repeatCount="indefinite" />
          )}
        </linearGradient>
      </defs>
      <path d={`${ROMBO}${CHISPA}`} fillRule="evenodd" fill={`url(#${id}g)`} />
    </svg>
  );
}

// Wordmark de founder: Fraunces cursiva, con la «l» en tinta plena y el resto
// en tinta media. `size={null}` deja el cuerpo al CSS.
export function Logo({ size = 15, mark = true, animado = false, className = '' }) {
  return (
    <span className={`logo ${animado ? 'logo--animado' : ''} ${className}`}>
      {mark && <LogoMark size={Math.round((size || 15) * 1.5)} />}
      <span className="brand" style={size ? { fontSize: Math.round(size * 1.9) } : undefined}>
        {[...'lixbon'].map((l, i) => (
          <span key={i} className={`logo__letra ${i === 0 ? 'logo__letra--clave' : ''}`} style={animado ? { '--i': i } : undefined}>{l}</span>
        ))}
      </span>
    </span>
  );
}

export function LogoLixbon({ size = 20 }) {
  useEffect(() => { cargarFuente().catch(() => {}); }, []);
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-lixbon">lixbon</span>
    </span>
  );
}
