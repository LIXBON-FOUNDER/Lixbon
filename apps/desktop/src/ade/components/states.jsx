// states.jsx — estados vacío / cargando / error y el envoltorio que decide cuál mostrar.
// Una pantalla nunca decide esto a mano: usa <QueryBoundary query={…}>.
import { errorText } from '../state/AdeProvider';

export function EmptyState({ title, children, action, compact = false }) {
  return (
    <div className={`ade-empty ${compact ? 'is-compact' : ''}`} data-ade-state="empty" role="status">
      <div className="ade-empty__title">{title}</div>
      {children && <div className="ade-empty__body">{children}</div>}
      {action}
    </div>
  );
}

export function LoadingState({ label = 'Cargando…', rows = 3 }) {
  return (
    <div className="ade-loading" data-ade-state="loading" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => <div key={i} className="ade-skeleton" style={{ width: `${92 - i * 14}%` }} />)}
      <span className="ade-sr">{label}</span>
    </div>
  );
}

export function ErrorState({ error, onRetry, title = 'No se pudo cargar' }) {
  return (
    <div className="ade-error" data-ade-state="error" role="alert">
      <div className="ade-error__title">{title}</div>
      <div className="ade-error__msg">{errorText(error)}</div>
      {error?.code && <code className="ade-error__code mono">{error.code}</code>}
      {onRetry && <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>Reintentar</button>}
    </div>
  );
}

/**
 * @param {{query: {status: string, data: any, error: any, reload: () => void}, isEmpty?: (data:any)=>boolean,
 *          empty?: import('react').ReactNode, loadingLabel?: string, errorTitle?: string,
 *          children: (data: any) => import('react').ReactNode}} props
 */
export function QueryBoundary({ query, isEmpty = (d) => Array.isArray(d) && d.length === 0, empty, loadingLabel, errorTitle, rows, children }) {
  const { status, data, error, reload } = query;
  if (data === null || data === undefined) {
    if (status === 'error') return <ErrorState error={error} onRetry={reload} title={errorTitle} />;
    return <LoadingState label={loadingLabel} rows={rows} />;
  }
  if (isEmpty(data)) return empty || null;
  return (
    <>
      {status === 'error' && <ErrorState error={error} onRetry={reload} title="No se pudo actualizar (se muestran los últimos datos)" />}
      {children(data)}
    </>
  );
}
