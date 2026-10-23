import { COPY, errorCopy } from './adeLabels';
import { coreErrorCode } from './coreModelContract';

/**
 * Aviso de una lectura vNext que no dio datos, por código estructurado (adeLabels.js). El texto
 * principal es siempre la copia del producto; el error crudo solo va dentro de «Detalle técnico».
 */
export function CoreModelNotice({ error, onRetry, onBack, className = 'ade-notice' }) {
  const code = coreErrorCode(error);
  const copy = errorCopy(code);
  const raw = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error ?? '');
  return (
    <div className={`${className} ${className}--${copy.tone}`} role={copy.tone === 'error' ? 'alert' : 'status'} data-code={code}>
      <span>{copy.text}</span>
      {copy.back && onBack && <button type="button" className="lk" onClick={onBack}>{COPY.backToProject}</button>}
      {copy.retry && onRetry && <button type="button" className="lk" onClick={onRetry}>{COPY.retry}</button>}
      <details>
        <summary>{COPY.technicalDetail}</summary>
        <code>{raw}</code>
      </details>
    </div>
  );
}

/** Estado como texto (el tono solo acompaña). El valor crudo, si no se reconoce, va al detalle. */
export function StatusText({ info, className = 'ade-status', prefix = '' }) {
  return (
    <span className={`${className} ${className}--${info.tone}`} data-status={info.raw ?? ''} data-known={info.known ? 'true' : 'false'}>
      {prefix}{info.label}
      {!info.known && info.raw !== null && (
        <details className="ade-status__raw"><summary>{COPY.technicalDetail}</summary><code>{String(info.raw)}</code></details>
      )}
    </span>
  );
}
