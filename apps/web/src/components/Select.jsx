// Select.jsx — selector propio en lugar del <select> nativo.
// La lista va en un portal con `position: fixed`: así ni el overflow de las
// tarjetas/tablas ni ningún stacking context del contenedor la recortan.
// El foco se queda en el botón y el teclado se resuelve con aria-activedescendant.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevron } from './Icons';

const MARGEN = 8;
const MAX_ALTO = 280;

export function Select({
  value,
  options,
  onChange,
  className = '',
  placeholder = 'Elegir…',
  disabled = false,
  'aria-label': ariaLabel,
}) {
  const id = useId();
  const [abierto, setAbierto] = useState(false);
  const [pos, setPos] = useState(null);
  const [activo, setActivo] = useState(-1);
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const elegida = options.find((o) => o.value === value);

  const abrir = () => {
    if (disabled) return;
    const i = options.findIndex((o) => o.value === value);
    setActivo(i >= 0 ? i : 0);
    setAbierto(true);
  };
  const cerrar = useCallback(() => setAbierto(false), []);

  const elegir = (opt) => {
    cerrar();
    if (opt && !opt.disabled && opt.value !== value) onChange(opt.value);
  };

  useLayoutEffect(() => {
    if (!abierto) return undefined;
    const colocar = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const alto = Math.min(menuRef.current?.scrollHeight || MAX_ALTO, MAX_ALTO);
      const abajo = window.innerHeight - r.bottom - MARGEN;
      const arriba = abajo < alto && r.top - MARGEN > abajo;
      const ancho = Math.max(r.width, 160);
      setPos({
        left: Math.max(MARGEN, Math.min(r.left, window.innerWidth - ancho - MARGEN)),
        top: arriba ? undefined : r.bottom + 4,
        bottom: arriba ? window.innerHeight - r.top + 4 : undefined,
        minWidth: ancho,
        maxHeight: Math.min(MAX_ALTO, arriba ? r.top - MARGEN : abajo),
      });
    };
    colocar();
    window.addEventListener('resize', colocar);
    window.addEventListener('scroll', colocar, true);
    return () => {
      window.removeEventListener('resize', colocar);
      window.removeEventListener('scroll', colocar, true);
    };
  }, [abierto]);

  useEffect(() => {
    if (!abierto) return undefined;
    const fuera = (e) => {
      if (!btnRef.current?.contains(e.target) && !menuRef.current?.contains(e.target)) cerrar();
    };
    document.addEventListener('pointerdown', fuera, true);
    return () => document.removeEventListener('pointerdown', fuera, true);
  }, [abierto, cerrar]);

  useEffect(() => {
    if (!abierto || activo < 0) return;
    menuRef.current?.children[activo]?.scrollIntoView({ block: 'nearest' });
  }, [abierto, activo]);

  const mover = (paso) => {
    if (!options.length) return;
    let i = activo;
    for (let n = 0; n < options.length; n += 1) {
      i = (i + paso + options.length) % options.length;
      if (!options[i].disabled) break;
    }
    setActivo(i);
  };

  const alTeclear = (e) => {
    if (!abierto) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        abrir();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); mover(1); break;
      case 'ArrowUp': e.preventDefault(); mover(-1); break;
      case 'Home': e.preventDefault(); setActivo(0); break;
      case 'End': e.preventDefault(); setActivo(options.length - 1); break;
      case 'Enter':
      case ' ': e.preventDefault(); elegir(options[activo]); break;
      case 'Escape':
      case 'Tab': cerrar(); break;
      default:
    }
  };

  const idOpcion = (i) => `${id}-opt-${i}`;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`select__btn ${className} ${abierto ? 'is-open' : ''}`}
        disabled={disabled}
        onClick={() => (abierto ? cerrar() : abrir())}
        onKeyDown={alTeclear}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={abierto}
        aria-controls={abierto ? `${id}-list` : undefined}
        aria-activedescendant={abierto && activo >= 0 ? idOpcion(activo) : undefined}
        aria-label={ariaLabel}
      >
        <span className={`select__label ${elegida ? '' : 'is-placeholder'}`}>
          {elegida ? elegida.label : placeholder}
        </span>
        <IconChevron size={14} open={abierto} className="select__chevron" />
      </button>

      {abierto && createPortal(
        <div
          ref={menuRef}
          id={`${id}-list`}
          className="select-menu"
          role="listbox"
          aria-label={ariaLabel}
          style={pos || { visibility: 'hidden' }}
        >
          {options.map((o, i) => (
            <div
              key={o.value}
              id={idOpcion(i)}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={[
                'select-menu__opt',
                i === activo ? 'is-active' : '',
                o.value === value ? 'is-selected' : '',
                o.disabled ? 'is-disabled' : '',
              ].join(' ')}
              onPointerMove={() => { if (i !== activo) setActivo(i); }}
              onClick={() => elegir(o)}
            >
              <span className="select-menu__txt">{o.label}</span>
              {o.value === value && <IconCheck size={14} />}
            </div>
          ))}
          {options.length === 0 && <div className="select-menu__vacio">Sin opciones</div>}
        </div>,
        document.body,
      )}
    </>
  );
}
