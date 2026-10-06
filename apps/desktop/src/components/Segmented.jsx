// Segmented.jsx — selector con indicador que se desliza entre opciones.
// `tone` por opción ('danger') tiñe el indicador cuando está elegida.
export function Segmented({ options, value, onChange, width = 86, size = 'md', className = '' }) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const tone = options[idx]?.tone;
  return (
    <div className={`seg seg--${size} ${className}`} role="radiogroup">
      <span
        className={`seg__thumb ${tone ? `seg__thumb--${tone}` : ''}`}
        style={{ width, transform: `translateX(${idx * width}px)` }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          className={`seg__opt ${o.value === value ? 'is-active' : ''} ${o.tone ? `seg__opt--${o.tone}` : ''}`}
          style={{ width }}
          onClick={() => onChange(o.value)}
          title={o.title}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
