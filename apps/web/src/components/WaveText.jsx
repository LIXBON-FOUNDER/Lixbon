// WaveText.jsx — texto de una acción en curso con una ola de color que recorre
// las letras («Revisando el diff», «Pensando…»). Estilos en chat.css (.wave).
export function WaveText({ text, className = '' }) {
  const chars = [...(text.length > 90 ? `${text.slice(0, 89)}…` : text)];
  return (
    <span className={`wave ${className}`} aria-label={text}>
      {chars.map((c, i) => <span key={i} aria-hidden="true" style={{ '--i': i }}>{c}</span>)}
    </span>
  );
}
