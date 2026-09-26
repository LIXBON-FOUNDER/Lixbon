import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredAbove } from '../lib/useAnchoredPopover';
import { IconCheck } from '../components/Icons';

const LEVELS = {
  auto: { label: 'Auto', desc: 'Claude decide cuánto pensar' },
  low: { label: 'Bajo', desc: 'Respuestas rápidas, poco razonamiento' },
  medium: { label: 'Medio', desc: 'Equilibrio entre velocidad y calidad' },
  high: { label: 'Alto', desc: 'Piensa más antes de actuar' },
  xhigh: { label: 'Muy alto', desc: 'Razonamiento profundo' },
  max: { label: 'Máximo', desc: 'Todo el razonamiento posible; más lento' },
};

function Bars({ level, total }) {
  return (
    <span className="effort__bars" aria-hidden>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={i < level ? 'is-on' : ''} style={{ height: `${35 + (65 * (i + 1)) / total}%` }} />
      ))}
    </span>
  );
}

export function EffortSlider({ levels, value, onChange }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const stops = ['auto', ...levels];
  const current = stops.includes(value) ? value : 'auto';
  const rank = (s) => (s === 'auto' ? 0 : levels.indexOf(s) + 1);
  const pos = useAnchoredAbove(btnRef, open, { align: 'left' });

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const step = (d) => {
    const i = Math.min(stops.length - 1, Math.max(0, stops.indexOf(current) + d));
    if (stops[i] !== current) onChange(stops[i]);
  };

  return (
    <>
      <button
        ref={btnRef}
        className={`effort is-${current} ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); step(1); }
          if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
        }}
        title="Effort: cuánto razona Claude antes de responder"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bars level={rank(current)} total={levels.length} />
        <span className="effort__value">{LEVELS[current]?.label || current}</span>
      </button>

      {open && pos && createPortal(
        <div className="agentmenu effortmenu" ref={popRef} style={pos} role="menu">
          <div className="agentmenu__title"><span>Effort</span></div>
          {stops.map((s) => (
            <button
              key={s}
              role="menuitemradio"
              aria-checked={s === current}
              className={`modeopt effortopt effortopt--${s} ${s === current ? 'is-active' : ''}`}
              onClick={() => { onChange(s); setOpen(false); }}
            >
              <Bars level={rank(s)} total={levels.length} />
              <span className="modeopt__text">
                <span className="modeopt__label">{LEVELS[s]?.label || s}</span>
                <span className="modeopt__desc">{LEVELS[s]?.desc || ''}</span>
              </span>
              {s === current && <IconCheck size={13} />}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
