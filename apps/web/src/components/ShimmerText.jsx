export function ShimmerText({ text, className = '' }) {
  return <span className={`shimmer ${className}`}>{text}</span>;
}
