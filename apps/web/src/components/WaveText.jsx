export function WaveText({ text, className = '' }) {
  const chars = [...(text.length > 90 ? `${text.slice(0, 89)}…` : text)];
  return (
    <span className={`wave ${className}`} aria-label={text}>
      {chars.map((c, i) => <span key={i} aria-hidden="true" style={{ '--i': i }}>{c}</span>)}
    </span>
  );
}
