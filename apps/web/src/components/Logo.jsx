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

// El isotipo mientras el agente trabaja: la chispa gira dentro del rombo. La
// chispa recorta con una máscara, así sirve sobre cualquier fondo.
export function LogoTrabajando({ size = 18 }) {
  const id = useId();
  return (
    <svg className="logo-trabajo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <mask id={id}>
        <path d={ROMBO} fill="#fff" />
        <path className="logo-trabajo__chispa" d={CHISPA} fill="#000" />
      </mask>
      <path d={ROMBO} fill="currentColor" mask={`url(#${id})`} />
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
