// Select.jsx — desplegable propio. El <select> nativo no se puede tematizar:
// en Windows el menú lo pinta el sistema (fondo blanco, fuente del SO), así que
// rompía el tema oscuro del IDE. Este usa un botón + lista flotante con teclado.
//
// options: [{ value, label, hint?, disabled? }]
import { useEffect, useRef, useState } from 'react';
import { IconChevronDown, IconCheck } from './Icons';

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Elegir…',
  disabled = false,
  up = false,           // abre hacia arriba (para controles pegados al borde inferior)
  className = '',
  title,
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(0);
  const rootRef = useRef(null);
  const listRef = useRef(null);

  const idx = options.findIndex((o) => o.value === value);
  const selected = idx >= 0 ? options[idx] : null;

  useEffect(() => {
    if (!open) return;
    setHover(idx >= 0 ? idx : 0);
    const onDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open, idx]);

  // Mantener visible la opción resaltada al navegar con las flechas.
  useEffect(() => {
    if (!open || !listRef.current) return;
    listRef.current.children[hover]?.scrollIntoView({ block: 'nearest' });
  }, [open, hover]);

  const pick = (i) => {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // no cerrar también la ventana que lo contiene
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHover((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHover((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(hover);
    }
  };

  return (
    <div className={`select ${className} ${open ? 'is-open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="select__btn"
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        title={title || (selected ? selected.label : placeholder)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="select__value">{selected ? selected.label : placeholder}</span>
        <IconChevronDown size={13} />
      </button>

      {open && (
        <ul className={`select__menu ${up ? 'select__menu--up' : ''}`} role="listbox" ref={listRef}>
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`select__opt ${i === hover ? 'is-hover' : ''} ${o.disabled ? 'is-disabled' : ''}`}
              onPointerEnter={() => setHover(i)}
              onClick={() => pick(i)}
            >
              <span className="select__opt-check">
                {o.value === value && <IconCheck size={13} />}
              </span>
              <span className="select__opt-label">
                {o.label}
                {o.hint && <span className="select__opt-hint">{o.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
