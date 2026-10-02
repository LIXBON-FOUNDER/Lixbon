// Mascota.jsx — piezas visuales de Gael y Leya en el IDE: el sprite animado
// (una tira de cuadros pixel art de 48×48) y el bocadillo de esquinas en
// escalón. La lógica de cuándo hace qué vive en chat/MascotaAgente.jsx.
import { CUADROS } from '../lib/mascota';

export function SpriteMascota({ personaje, estado = 'idle', tam = 96, espejo = false, quieta = false, className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={`mascota-sprite mascota-sprite--${estado} ${espejo ? 'is-espejo' : ''} ${quieta ? 'is-quieta' : ''} ${className}`}
      style={{
        '--w': `${tam}px`,
        '--n': CUADROS[estado] || 1,
        backgroundImage: `url(/mascotas/${personaje}-${estado}.png)`,
      }}
    />
  );
}

export function Bocadillo({ children, className = '' }) {
  return <div className={`mascota-bocadillo ${className}`}>{children}</div>;
}
