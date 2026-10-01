// Menu.jsx — el desplegable de Team: un botón y una lista que se cierra al
// pinchar fuera o con Escape. Lo usan los filtros y las propiedades de una issue.
import { useEffect, useRef, useState } from 'react';
import { IconCheck } from '../../components/Icons';
import { plano } from '../lib/issues';

export function Desplegable({ boton, children, className = '', alinear = 'izquierda', ancho = 240 }) {
  const [abierto, setAbierto] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => { if (!ref.current?.contains(e.target)) setAbierto(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setAbierto(false); } };
    window.addEventListener('pointerdown', fuera);
    window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('pointerdown', fuera); window.removeEventListener('keydown', esc, true); };
  }, [abierto]);
  const cerrar = () => setAbierto(false);
  return (
    <div className={`tdesp ${className}`} ref={ref}>
      {boton({ abierto, alternar: () => setAbierto((v) => !v) })}
      {abierto && (
        <div className={`tmenu tdesp__pop is-${alinear}`} style={{ width: ancho }}>
          {typeof children === 'function' ? children(cerrar) : children}
        </div>
      )}
    </div>
  );
}

/** Lista de opciones con búsqueda. `multiple`: marca varias y no se cierra. */
export function Opciones({ opciones, valor, onElegir, cerrar, multiple = false, buscar = false, vacio = 'Nada que elegir.' }) {
  const [q, setQ] = useState('');
  const lista = q ? opciones.filter((o) => plano(o.nombre).includes(plano(q))) : opciones;
  const marcada = (o) => (multiple ? (valor || []).includes(o.valor) : valor === o.valor);
  return (
    <>
      {buscar && (
        <input className="tdesp__buscar" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" aria-label="Buscar" />
      )}
      <div className="tdesp__lista" role="listbox" aria-multiselectable={multiple || undefined}>
        {lista.map((o) => (
          <button
            key={String(o.valor)}
            type="button"
            role="option"
            aria-selected={marcada(o)}
            className={`tmenu__item ${marcada(o) ? 'is-on' : ''}`}
            onClick={() => { onElegir(o.valor); if (!multiple) cerrar?.(); }}
          >
            {o.icono}
            <span className="tmenu__txt"><span>{o.nombre}</span>{o.ayuda && <span className="tmenu__ayuda">{o.ayuda}</span>}</span>
            {marcada(o) && <IconCheck size={13} />}
          </button>
        ))}
        {!lista.length && <p className="tdesp__vacio">{vacio}</p>}
      </div>
    </>
  );
}
