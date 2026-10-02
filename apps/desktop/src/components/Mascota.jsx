// Mascota.jsx — piezas visuales de Gael y Leya en el IDE: el sprite animado
// (una tira de cuadros pixel art de 48×48) y el bocadillo de esquinas en
// escalón. La lógica de cuándo hace qué vive en chat/MascotaAgente.jsx.
import { CUADROS, MS_CUADRO, VERSION_SPRITES } from '../lib/mascota';

export function SpriteMascota({ personaje, estado = 'idle', tam = 96, espejo = false, quieta = false, className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={`mascota-sprite mascota-sprite--${estado} ${espejo ? 'is-espejo' : ''} ${quieta ? 'is-quieta' : ''} ${className}`}
      style={{
        '--w': `${tam}px`,
        '--n': CUADROS[estado] || 1,
        '--d': `${(CUADROS[estado] || 1) * (MS_CUADRO[estado] || 200)}ms`,
        backgroundImage: `url(/mascotas/${personaje}-${estado}.png?v=${VERSION_SPRITES})`,
      }}
    />
  );
}

/** Bocadillo con rebote al abrirse. Con `texto`, el texto completo reserva el
    sitio (invisible) y encima se va escribiendo `mostrado`. */
export function Bocadillo({ texto, mostrado, cerrando, children, pie, className = '' }) {
  return (
    <div className={`mascota-bocadillo ${cerrando ? 'is-cerrando' : ''} ${className}`}>
      {children}
      {texto !== undefined && (
        <span className="mascota-bocadillo__texto">
          <span className="mascota-bocadillo__molde" aria-hidden="true">{texto}</span>
          <span className="mascota-bocadillo__escrito">{mostrado}</span>
        </span>
      )}
      {pie}
    </div>
  );
}
