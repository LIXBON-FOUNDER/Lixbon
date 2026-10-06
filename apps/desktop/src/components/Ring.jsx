// Ring.jsx — anillo de progreso: girando para "en curso" o fijo para un %.
export function SpinRing({ size = 14, color = 'var(--accent)' }) {
  return (
    <svg className="spinring" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="var(--surface-6)" />
      <circle cx="8" cy="8" r="6" stroke={color} strokeLinecap="round" strokeDasharray="11 27" />
    </svg>
  );
}

export function ProgressRing({ value = 0, size = 18, stroke = 2.4, color }) {
  const r = 10 - stroke;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const tone = color || (v >= 80 ? 'var(--warn)' : 'var(--accent)');
  return (
    <svg className="progring" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r={r} fill="none" stroke="var(--surface-6)" strokeWidth={stroke} />
      <circle
        cx="10" cy="10" r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={`${(v / 100) * c} ${c}`} transform="rotate(-90 10 10)"
      />
    </svg>
  );
}
