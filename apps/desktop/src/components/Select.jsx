// Select.jsx — desplegable propio. El <select> nativo no se puede tematizar:
// en Windows el menú lo pinta el sistema (fondo blanco, fuente del SO), así que
// rompía el tema oscuro del IDE.
//
// El menú se monta en un PORTAL con posición fija: dentro del árbol lo recortaba
// cualquier ancestro con overflow (la barra de pestañas del terminal, el centro
// del shell…), y el desplegable simplemente no se veía.
//
// options: [{ value, label, hint?, disabled? }]
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronDown, IconCheck } from './Icons';

const GAP = 6;

export function Select({
  value,
  onChange,
  options,
  placeholder = 'Elegir…',
  disabled = false,
  up = false,           // abre hacia arriba (controles pegados al borde inferior)
  className = '',
  title,
}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(0);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const hoverByKey = useRef(false);

  const idx = options.findIndex((o) => o.value === value);
  const selected = idx >= 0 ? options[idx] : null;

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return undefined;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      setPos({
        minWidth: r.width,
        right: window.innerWidth - r.right,
        ...(up
          ? { bottom: window.innerHeight - r.top + GAP }
          : { top: r.bottom + GAP }),
      });
    };
    place();
    // El scroll de la propia lista (rueda, o scrollIntoView al pasar el ratón)
    // también llega aquí en captura: antes cerraba el menú al ir a elegir.
    const onScroll = (e) => { if (!listRef.current?.contains(e.target)) place(); };
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, up]);

  useEffect(() => {
    if (!open) return;
    hoverByKey.current = true;
    setHover(idx >= 0 ? idx : 0);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || listRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  // Mantener visible la opción resaltada al navegar con las flechas.
  useEffect(() => {
    if (!open || !listRef.current || !hoverByKey.current) return;
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
      hoverByKey.current = true;
      setHover((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      hoverByKey.current = true;
      setHover((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(hover);
    }
  };

  return (
    <div className={`select ${className} ${open ? 'is-open' : ''}`}>
      <button
        ref={btnRef}
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

      {open && pos && createPortal(
        <ul className="select__menu" role="listbox" ref={listRef} style={pos}>
          {options.map((o, i) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`select__opt ${i === hover ? 'is-hover' : ''} ${o.disabled ? 'is-disabled' : ''}`}
              onPointerEnter={() => { hoverByKey.current = false; setHover(i); }}
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
        </ul>,
        document.body,
      )}
    </div>
  );
}
