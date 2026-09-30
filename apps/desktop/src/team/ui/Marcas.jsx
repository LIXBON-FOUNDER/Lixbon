// Marcas.jsx — la iconografía propia de las issues de Lixbon: prioridad con
// rombos, estado con casillas cuadradas y avance con barras. A propósito, nada
// de barras de señal, círculos que se rellenan ni anillos de progreso.
import { prioridadDe, ROLES_AGENTE } from '../lib/issues';
import { IconAgente } from './icons';

// Tres rombos separados, de izquierda a derecha: cuantos más encendidos, más
// prioridad; los tres en rojo es urgente.
const PUNTAS = ['3.2,4.4 6.4,8 3.2,11.6 0,8', '10,4.4 13.2,8 10,11.6 6.8,8', '16.8,4.4 20,8 16.8,11.6 13.6,8'];

export function Rombos({ prioridad = 0, size = 16 }) {
  const p = prioridadDe(prioridad);
  const on = prioridad === 4 ? 'var(--danger)' : 'var(--ink-body)';
  return (
    <svg role="img" aria-label={`Prioridad ${p.nombre.toLowerCase()}`} width={size * 1.25} height={size} viewBox="0 0 20 16" className="rombos">
      {PUNTAS.map((pts, i) => <polygon key={pts} points={pts} fill={i < p.rombos ? on : 'var(--surface-6)'} />)}
    </svg>
  );
}

/** Casilla de estado: vacía (sin empezar), con un cuadro dentro (empezado),
 *  llena con marca (hecho) o tachada (cancelado). El color es el del estado. */
export function Casilla({ estado, size = 16 }) {
  const tipo = estado?.tipo || 'pendiente';
  const color = estado?.color || 'var(--ink-35)';
  const nombre = estado?.nombre || '';
  if (tipo === 'hecho') {
    return (
      <svg role="img" aria-label={nombre} width={size} height={size} viewBox="0 0 16 16" className="casilla">
        <rect x="1" y="1" width="14" height="14" rx="4" fill={color} />
        <path d="M4.6 8.2l2.3 2.3 4.6-4.6" fill="none" stroke="var(--surface-1)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (tipo === 'cancelado') {
    return (
      <svg role="img" aria-label={nombre} width={size} height={size} viewBox="0 0 16 16" className="casilla">
        <rect x="1" y="1" width="14" height="14" rx="4" fill={color} opacity="0.85" />
        <path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="var(--surface-1)" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  const dentro = tipo === 'en_curso' ? 6 : tipo === 'revision' ? 8 : 0;
  return (
    <svg role="img" aria-label={nombre} width={size} height={size} viewBox="0 0 16 16" className="casilla">
      <rect x="1.7" y="1.7" width="12.6" height="12.6" rx="3.6" fill="none" stroke={color} strokeWidth="1.4" strokeDasharray={tipo === 'backlog' ? '2.4 2' : undefined} />
      {dentro > 0 && <rect x={8 - dentro / 2} y={8 - dentro / 2} width={dentro} height={dentro} rx="1.6" fill={color} />}
    </svg>
  );
}

export function Barra({ pct = 0, color = 'var(--accent)', ancho = 28, alto = 4 }) {
  return (
    <span className="tbarra" style={{ width: ancho, height: alto }} role="img" aria-label={`${pct}%`}>
      <span style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} />
    </span>
  );
}

export function Etiqueta({ etiqueta, onQuitar }) {
  if (!etiqueta) return null;
  return (
    <span className="tetq" style={{ '--c': etiqueta.color }}>
      {etiqueta.nombre}
      {onQuitar && <button type="button" onClick={onQuitar} aria-label={`Quitar ${etiqueta.nombre}`}>×</button>}
    </span>
  );
}

export function Agente({ rol, corto = false }) {
  const r = ROLES_AGENTE[rol];
  if (!r) return null;
  return (
    <span className="tagente" title={`Agente ${r.nombre.toLowerCase()} · ${r.modelo}`}>
      <IconAgente size={12} />
      {corto ? r.modelo : `${r.nombre} · ${r.modelo}`}
    </span>
  );
}

export function PuntoCuadrado({ color, size = 8 }) {
  return <span className="tcuadro" style={{ width: size, height: size, background: color }} />;
}
