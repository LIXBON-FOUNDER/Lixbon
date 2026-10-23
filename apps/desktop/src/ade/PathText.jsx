import { useEffect, useRef, useState } from 'react';
import { COPY } from './adeLabels';
import { displayPath } from './attemptFormat';

/** Ruta o URI como TEXTO: nombre corto visible, completa en tooltip y en «Copiar ruta». Nunca enlace. */
export function PathText({ path, repoRoot = null }) {
  const shown = displayPath(path, repoRoot);
  // Confirmación breve tras copiar (aria-live polite); si el portapapeles falla, se dice.
  const [feedback, setFeedback] = useState('');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!shown) return <span className="ade-missing">{COPY.notAvailable}</span>;
  const report = (text) => {
    setFeedback(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFeedback(''), 2000);
  };
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('sin portapapeles');
      await navigator.clipboard.writeText(path);
      report(COPY.pathCopied);
    } catch {
      report(COPY.pathCopyFailed);
    }
  };
  return (
    <span className="ade-path">
      <code className="mono" title={path}>{shown}</code>{' '}
      <button type="button" className="lk" onClick={copy} aria-label={`${COPY.copyPath}: ${shown}`}>{COPY.copyPath}</button>
      <span className="ade-path__feedback" aria-live="polite" data-testid="path-copy-feedback">{feedback}</span>
    </span>
  );
}
