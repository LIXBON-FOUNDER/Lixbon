import { useState } from 'react';
import { describeCommandError, retryAttempt } from './attemptCommands';
import { useCoreQuery } from './useCoreQuery';

/** Estados que se reintentan: los que terminaron mal (`retryable` del Core). Uno que terminó bien es un seguimiento, no un reintento. */
export const RETRYABLE_ATTEMPT_STATUSES = Object.freeze(['failed', 'stopped', 'exited']);

const OUTCOMES = {
  Requested: 'Reintento pedido: el Core lo lanzará en un momento.',
  Replayed: 'Este reintento ya estaba pedido.',
};

/**
 * Reintentar el ÚLTIMO intento de la Task cuando terminó mal. El intento nuevo hereda proveedor, modelo, esfuerzo, rol y perfil, y
 * trabaja en el MISMO worktree: lo que dejó a medias el anterior sigue ahí (se dice antes de confirmar). Pide confirmación.
 * Solo se ofrece sobre el último; si el historial aún no se leyó o falla, el Core vuelve a comprobarlo y lo rechaza si no lo es.
 */
export function AttemptRetry({ attempt, onRetried }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  const retryable = RETRYABLE_ATTEMPT_STATUSES.includes(attempt?.status) && Boolean(attempt?.task_id);
  const history = useCoreQuery('attempts_by_task', { task_id: attempt?.task_id ?? null }, { enabled: retryable });
  if (!retryable) return null;
  const items = Array.isArray(history.data?.items) ? history.data.items : null;
  // Sin el historial (ni su error) todavía no se sabe si es el último: no se muestra para que el botón no aparezca y desaparezca.
  if (!outcome && !items && !history.error) return null;
  const latest = items ? Math.max(attempt.n, ...items.map((item) => Number(item.n) || 0)) : attempt.n;
  if (!outcome && latest > attempt.n) return null;

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await retryAttempt(attempt.task_id, attempt.id);
      setOutcome({ text: OUTCOMES[result?.status] ?? 'Reintento registrado.', attemptId: result?.attempt_id ?? null });
      setConfirming(false);
      onRetried?.(result);
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nat-retry" role="group" aria-label="Reintentar el intento" data-testid="attempt-retry">
      {outcome ? (
        <p role="status" data-testid="attempt-retry-outcome">
          {outcome.text}{outcome.attemptId && <> Intento nuevo: <code className="mono">{outcome.attemptId}</code>.</>}
        </p>
      ) : !confirming ? (
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setConfirming(true)} data-testid="attempt-retry-open">Reintentar</button>
      ) : (
        <>
          <p className="nat__hint">Se lanza un intento nuevo con el mismo agente, modelo y perfil. Trabaja en el mismo worktree: lo que dejó a medias este intento sigue ahí.</p>
          <div className="nat__actions">
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={retry} data-testid="attempt-retry-confirm">{busy ? 'Pidiendo…' : 'Sí, reintentar'}</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setConfirming(false); setError(null); }}>Cancelar</button>
          </div>
        </>
      )}
      {error && (
        <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-retry-error">
          <span>{error.message}</span>
          {error.detail !== error.message && (
            <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
          )}
        </div>
      )}
    </div>
  );
}
