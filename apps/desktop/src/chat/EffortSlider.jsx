import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredAbove } from '../lib/useAnchoredPopover';

const LEVELS = {
  auto: { label: 'Auto', short: 'Auto', desc: 'Claude decide cuánto pensar en cada respuesta' },
  low: { label: 'Bajo', short: 'Bajo', desc: 'Respuestas rápidas, poco razonamiento' },
  medium: { label: 'Medio', short: 'Medio', desc: 'Equilibrio entre velocidad y calidad' },
  high: { label: 'Alto', short: 'Alto', desc: 'Piensa más antes de actuar' },
  xhigh: { label: 'Muy alto', short: 'M. alto', desc: 'Razonamiento profundo para problemas difíciles' },
  max: { label: 'Máximo', short: 'Máx', desc: 'Todo el razonamiento posible; más lento y gasta más cupo' },
};

// Intensidad de la animación: velocidad de la onda (s por ciclo) y altura.
const MOTION = {
  auto: { speed: 2.6, amp: 0.3 },
  low: { speed: 2.2, amp: 0.35 },
  medium: { speed: 1.6, amp: 0.55 },
  high: { speed: 1.1, amp: 0.75 },
  xhigh: { speed: 0.8, amp: 0.9 },
  max: { speed: 0.55, amp: 1 },
};

const motionOf = (level, i, n) => MOTION[level] || { speed: 2.4 - (1.8 * i) / Math.max(1, n - 1), amp: 0.3 + (0.7 * i) / Math.max(1, n - 1) };

function Wave({ bars, level, rank, total, className = '' }) {
  const m = motionOf(level, rank, total);
  return (
    <span className={`effwave effwave--${level} ${className}`} style={{ '--speed': `${m.speed}s`, '--amp': m.amp }} aria-hidden>
      {Array.from({ length: bars }, (_, i) => <span key={i} style={{ '--i': i }} />)}
    </span>
  );
}

export function EffortSlider({ levels, value, onChange }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const stops = ['auto', ...levels];
  const current = stops.includes(value) ? value : 'auto';
  const [draft, setDraft] = useState(current);
  const pos = useAnchoredAbove(btnRef, open, { align: 'left' });

  useEffect(() => { if (!open) setDraft(current); }, [current, open]);

  // Cambiar el effort con la sesión abierta manda un `/effort` a Claude Code:
  // se aplica al soltar, no en cada paso del arrastre.
  const commit = (level = draft) => { if (level !== current) onChange(level); };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    if (!open) return undefined;
    const close = () => { commitRef.current(); setOpen(false); };
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || popRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); close(); } };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const idx = stops.indexOf(draft);
  const shown = open ? draft : current;
  const info = LEVELS[shown] || { label: shown, desc: '' };
  const pct = stops.length > 1 ? (idx / (stops.length - 1)) * 100 : 0;

  return (
    <>
      <button
        ref={btnRef}
        className={`effort is-${current} ${open ? 'is-open' : ''}`}
        onClick={() => { if (open) commit(); setOpen((v) => !v); }}
        title="Effort: cuánto razona Claude antes de responder"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Wave bars={4} level={shown} rank={stops.indexOf(shown)} total={stops.length} className="effwave--mini" />
        <span className="effort__value">{info.label}</span>
      </button>

      {open && pos && createPortal(
        <div className={`effpop effpop--${draft}`} ref={popRef} style={pos} role="dialog" aria-label="Effort">
          <div className="effpop__head">
            <span className="effpop__title">Effort</span>
            <span className="effpop__label" key={draft}>{info.label}</span>
          </div>
          <Wave bars={24} level={draft} rank={idx} total={stops.length} className="effwave--big" />
          <p className="effpop__desc">{info.desc}</p>
          <div className="effpop__slider" style={{ '--pct': `${pct}%` }}>
            <div className="effpop__track"><span /></div>
            {stops.map((s, i) => (
              <span key={s} className={`effpop__stop ${i <= idx ? 'is-on' : ''}`} style={{ left: `${(i / (stops.length - 1)) * 100}%` }} />
            ))}
            <input
              type="range"
              min={0}
              max={stops.length - 1}
              step={1}
              value={idx}
              autoFocus
              aria-valuetext={info.label}
              onChange={(e) => setDraft(stops[Number(e.target.value)])}
              onPointerUp={(e) => commit(stops[Number(e.currentTarget.value)])}
              onKeyUp={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') commit(stops[Number(e.currentTarget.value)]); }}
            />
          </div>
          <div className="effpop__ticks">
            {stops.map((s) => (
              <button key={s} className={s === draft ? 'is-active' : ''} onClick={() => { setDraft(s); commit(s); }}>
                {LEVELS[s]?.short || s}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
