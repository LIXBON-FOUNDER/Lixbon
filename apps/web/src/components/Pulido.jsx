// Piezas pequeñas del pulido visual (tableros «Pulido visual · chat y Coding»):
// - Rombos: el indicador de espera de los botones (cuatro rombos que se
//   encienden en ola, la forma de la marca en vez del círculo que gira).
// - Aviso: un aviso con el color de su estado (fondo tintado, icono en un
//   cuadro de su color, título y una sola línea, acciones a la derecha).
// - Recorte: texto de una línea que, solo si no cabe, se funde al final y
//   muestra el nombre completo en un globo a su lado tras medio segundo.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icono } from './Icons';

export function Rombos({ className = '' }) {
  return (
    <span className={`rombos ${className}`} aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}

/** tipo: info · warn · mal · ok · marca */
export function Aviso({ tipo = 'info', icono = 'alerta', titulo, texto, acciones = null, className = '', role = 'status' }) {
  return (
    <div className={`aviso aviso--${tipo} ${className}`} role={role}>
      <span className="aviso__ico"><Icono nombre={icono} size={20} /></span>
      <div className="aviso__t">
        {titulo && <strong>{titulo}</strong>}
        {texto && <span>{texto}</span>}
      </div>
      {acciones && <div className="aviso__acc">{acciones}</div>}
    </div>
  );
}

const RETARDO_GLOBO = 500;

/** Mide si el texto no cabe. Devuelve [ref, corta]. */
export function useCorta(dep) {
  const ref = useRef(null);
  const [corta, setCorta] = useState(false);
  const medir = useCallback(() => {
    const el = ref.current;
    if (el) setCorta(el.scrollWidth > el.clientWidth + 1);
  }, []);
  useLayoutEffect(medir, [medir, dep]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [medir]);
  return [ref, corta];
}

export function Recorte({ texto, className = '', as: Tag = 'span' }) {
  const [ref, corta] = useCorta(texto);
  const [globo, setGlobo] = useState(null);
  const timer = useRef(0);
  const entra = () => {
    if (!corta) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      // Fuera de su fila (la fila de la barra lateral, el botón del título…):
      // así no tapa el icono ni los «⋯».
      const el = ref.current;
      const r = (el?.closest('.sb-fila, .chat-header__title-btn, .attach-chip') || el)?.getBoundingClientRect();
      if (!r) return;
      // A su lado (a la derecha de la fila); si no cabe, debajo.
      const derecha = r.right + 16 + 320 < window.innerWidth;
      setGlobo(derecha ? { left: r.right + 16, top: r.top + r.height / 2, lado: true } : { left: r.left, top: r.bottom + 8, lado: false });
    }, RETARDO_GLOBO);
  };
  const sale = () => { clearTimeout(timer.current); setGlobo(null); };
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <>
      <Tag ref={ref} className={`recorte ${corta ? 'is-corta' : ''} ${className}`} onMouseEnter={entra} onMouseLeave={sale}>
        {texto}
      </Tag>
      {globo && createPortal(
        <span className={`globo ${globo.lado ? 'globo--lado' : ''}`} style={{ left: globo.left, top: globo.top }} role="tooltip">{texto}</span>,
        document.body,
      )}
    </>
  );
}
