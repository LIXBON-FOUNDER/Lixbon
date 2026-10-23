import { COPY } from './adeLabels';
import { displayPath } from './attemptFormat';

/** Ruta o URI como TEXTO: nombre corto visible, completa en tooltip y en «Copiar ruta». Nunca enlace. */
export function PathText({ path, repoRoot = null }) {
  const shown = displayPath(path, repoRoot);
  if (!shown) return <span className="ade-missing">{COPY.notAvailable}</span>;
  const copy = () => {
    try { navigator.clipboard?.writeText(path); } catch { /* sin portapapeles */ }
  };
  return (
    <span className="ade-path">
      <code className="mono" title={path}>{shown}</code>{' '}
      <button type="button" className="lk" onClick={copy} aria-label={`${COPY.copyPath}: ${shown}`}>{COPY.copyPath}</button>
    </span>
  );
}
