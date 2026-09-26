// Panel.jsx — los paneles y separadores de Team, con la misma física que los
// del IDE (wbpanel/gutter): el que tiene el foco sube un peldaño.
import { useRef } from 'react';
import { useTeamStore } from '../store/teamStore';
import { Avatar } from '../../components/Avatar';
import { estadoDef } from '../lib/presencia';
import { servidorActual } from '../lib/sesion';

export function TPanel({ id, className = '', style, children, as: Tag = 'section', ...rest }) {
  const focused = useTeamStore((s) => s.foco === id);
  return (
    <Tag
      className={`wbpanel ${focused ? 'is-focused' : ''} ${className}`}
      style={style}
      onPointerDownCapture={() => useTeamStore.getState().enfocar(id)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

/** `lado="izquierda"`: el panel crece hacia la izquierda (hilo, detalle). */
export function TGutter({ clave, min, max, lado = 'derecha' }) {
  const frame = useRef(0);
  const start = (e) => {
    e.preventDefault();
    const { anchos, setAncho } = useTeamStore.getState();
    const origen = e.clientX;
    const inicial = anchos[clave];
    document.body.classList.add('is-resizing-x');
    const move = (ev) => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const delta = ev.clientX - origen;
        setAncho(clave, Math.min(max, Math.max(min, inicial + (lado === 'izquierda' ? -delta : delta))));
      });
    };
    const up = () => {
      document.body.classList.remove('is-resizing-x');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return <div className="gutter gutter--x" onPointerDown={start} role="separator" aria-orientation="vertical" />;
}

export const nombreDe = (u) => u?.first_name || u?.username || 'Alguien';

export function Cara({ usuario, estado, size = 20, className = '' }) {
  const def = estado ? estadoDef(estado) : null;
  return (
    <span className={`tcara ${className}`} style={{ width: size, height: size }}>
      <Avatar user={usuario} serverUrl={servidorActual()} size={size} />
      {def && <span className={`tcara__punto ${def.hueco ? 'is-hueco' : ''}`} style={{ '--punto': def.color }} />}
    </span>
  );
}

// Un color estable por persona: el nombre en el canalón se reconoce de un vistazo,
// igual que el color de una palabra clave en el editor.
const TINTAS = ['#D9C7A3', '#A8C3E0', '#C9B6E4', '#B9D5A0', '#E6B8A2', '#9FD3C7', '#D8D08E', '#B7B0E8', '#E3A6B8'];
export function tintaDe(usuarioId, propio) {
  if (propio) return 'var(--ink)';
  const n = Number(usuarioId) || String(usuarioId || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return TINTAS[Math.abs(n) % TINTAS.length];
}
