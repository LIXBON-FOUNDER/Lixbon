import { useEffect, useRef, useState } from 'react';

const LABELS = { auto: 'Auto', low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo' };

export function EffortSlider({ levels, value, onChange }) {
  const stops = ['auto', ...levels];
  const idx = Math.max(0, stops.indexOf(value));
  const pct = stops.length > 1 ? idx / (stops.length - 1) : 0;
  // Alterna entre dos animaciones idénticas para que el "pop" se repita en
  // cada cambio sin desmontar el pulgar (eso cortaría su transición).
  const [pop, setPop] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setPop((n) => n + 1);
  }, [value]);

  const label = LABELS[stops[idx]] || stops[idx];
  return (
    <div
      className={`effort ${stops[idx] === 'max' ? 'is-max' : ''}`}
      style={{ '--pos': pct }}
      title="Cuánto razona Claude antes de responder"
    >
      <span className="effort__name">Effort</span>
      <span className="effort__track">
        <span className="effort__fill" />
        {stops.map((s, i) => (
          <span key={s} className={`effort__stop ${i <= idx ? 'is-on' : ''}`} style={{ left: `${(i / (stops.length - 1)) * 100}%` }} />
        ))}
        <span className={`effort__thumb ${pop ? (pop % 2 ? 'pop-a' : 'pop-b') : ''}`} />
        <input
          type="range"
          className="effort__input"
          min={0}
          max={stops.length - 1}
          step={1}
          value={idx}
          onChange={(e) => onChange(stops[Number(e.target.value)])}
          aria-label="Effort de Claude"
          aria-valuetext={label}
        />
      </span>
      <span className="effort__value">{label}</span>
    </div>
  );
}
