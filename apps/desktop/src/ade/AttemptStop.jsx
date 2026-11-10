import { useState } from 'react';
import { describeCommandError, stopTask } from './attemptCommands';

/** Estados en los que hay una ejecución que detener (`pending_approval` se rechaza, no se detiene). */
export const STOPPABLE_ATTEMPT_STATUSES = Object.freeze(['starting', 'running', 'waiting', 'awaiting_terminal_approval']);

/**
 * Detener el Attempt en marcha. Pide confirmación porque corta el proceso del proveedor; lo ya escrito se conserva en su
 * worktree. El Core no declara detenido a un Attempt cuyo proceso no pudo matar: en ese caso dice por qué y sigue en marcha.
 */
export function AttemptStop({ taskId, status, onStopped }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!taskId || !STOPPABLE_ATTEMPT_STATUSES.includes(status)) return null;

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      await stopTask(taskId);
      setConfirming(false);
      onStopped?.();
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nat-stop" role="group" aria-label="Detener el intento" data-testid="attempt-stop">
      {!confirming ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setConfirming(true)} data-testid="attempt-stop-open">Detener</button>
      ) : (
        <>
          <p className="nat__hint">Se corta el proceso del proveedor. Lo ya escrito se conserva en su worktree.</p>
          <div className="nat__actions">
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={stop} data-testid="attempt-stop-confirm">{busy ? 'Deteniendo…' : 'Sí, detener'}</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setConfirming(false); setError(null); }}>Cancelar</button>
          </div>
        </>
      )}
      {error && (
        <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-stop-error">
          <span>{error.message}</span>
          {error.detail !== error.message && (
            <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
          )}
        </div>
      )}
    </div>
  );
}
