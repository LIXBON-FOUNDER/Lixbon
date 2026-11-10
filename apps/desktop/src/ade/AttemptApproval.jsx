import { useState } from 'react';
import { approveAttempt, describeCommandError, rejectAttempt } from './attemptCommands';

/**
 * LXO-141 · La decisión de la persona sobre la aprobación inicial de un Attempt `pending_approval`. Solo aparece en ese estado.
 * Aprobar NO lo ejecuta por sí mismo: el Core lo despacha después. El plazo es el que fijó el Core; si ya venció, aprobar tarde
 * no aprueba (el intento queda detenido) y aquí se dice tal cual. Tras decidir se pide al detalle que vuelva a leer.
 */
const OUTCOMES = {
  Approved: 'Aprobado: el Core lo lanzará en un momento.',
  Rejected: 'Rechazado: el intento no se ejecutará.',
  Expired: 'La aprobación venció: el intento se detuvo sin ejecutarse.',
};

function outcomeText(result) {
  if (result?.status === 'Replayed') {
    return result.decision === 'rejected' ? 'Ya estaba rechazado.' : 'Ya estaba aprobado.';
  }
  return OUTCOMES[result?.status] ?? 'Decisión registrada.';
}

export function AttemptApproval({ attemptId, onDecided }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);

  const decide = async (command) => {
    setBusy(true);
    setError(null);
    try {
      const result = await command(attemptId);
      setOutcome(outcomeText(result));
      onDecided?.(result);
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nat-approval" role="group" aria-label="Aprobación del intento" data-testid="attempt-approval">
      <p className="nat__hint">Este intento espera tu aprobación para ejecutarse.</p>
      {outcome ? (
        <p role="status" data-testid="attempt-approval-outcome">{outcome}</p>
      ) : (
        <div className="nat__actions">
          <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => decide(approveAttempt)} data-testid="attempt-approve">Aprobar</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => decide(rejectAttempt)} data-testid="attempt-reject">Rechazar</button>
        </div>
      )}
      {error && (
        <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-approval-error">
          <span>{error.message}</span>
          {error.detail !== error.message && (
            <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
          )}
        </div>
      )}
    </div>
  );
}
