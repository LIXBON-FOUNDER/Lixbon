import { useState } from 'react';
import { describeCommandError, resumeAttempt } from './attemptCommands';
import { useLatestAttempt } from './useLatestAttempt';

/** Se continúa un intento terminado de cualquier manera (también `done`: es un seguimiento). */
export const RESUMABLE_ATTEMPT_STATUSES = Object.freeze(['done', 'failed', 'stopped', 'exited']);
export const MAX_RESUME_CHARS = 20000;

const OUTCOMES = {
  Requested: 'Continuación pedida: el Core reanudará la sesión en un momento.',
  Replayed: 'Esta continuación ya estaba pedida.',
};

/**
 * Continuar la sesión del proveedor del ÚLTIMO intento de la Task con un mensaje nuevo. A diferencia de reintentar, conserva lo que el
 * proveedor guarda de la conversación (y trabaja en el mismo worktree). Solo se ofrece con una sesión que el Core pueda reanudar
 * (`resumable` y en espera); si el Core la rechaza por cualquier otra razón, lo dice. Siempre el mismo proveedor y con los mismos permisos.
 */
export function AttemptResume({ attempt, onResumed }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  const session = attempt?.provider_session;
  const resumable = RESUMABLE_ATTEMPT_STATUSES.includes(attempt?.status) && Boolean(attempt?.task_id)
    && session?.resumable === true && session?.status === 'idle';
  const { known, isLatest } = useLatestAttempt(attempt, resumable);
  if (!resumable) return null;
  if (!outcome && (!known || !isLatest)) return null;

  const message = text.trim();
  const send = async () => {
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await resumeAttempt(attempt.task_id, attempt.id, message);
      setOutcome({ text: OUTCOMES[result?.status] ?? 'Continuación registrada.', attemptId: result?.attempt_id ?? null });
      setOpen(false);
      onResumed?.(result);
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nat-resume" role="group" aria-label="Continuar la sesión del intento" data-testid="attempt-resume">
      {outcome ? (
        <p role="status" data-testid="attempt-resume-outcome">
          {outcome.text}{outcome.attemptId && <> Intento nuevo: <code className="mono">{outcome.attemptId}</code>.</>}
        </p>
      ) : !open ? (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)} data-testid="attempt-resume-open">Continuar la sesión</button>
      ) : (
        <>
          <p className="nat__hint">Continúa la misma sesión del proveedor, con lo que ya recuerda de la conversación, en el mismo worktree y con los mismos permisos.</p>
          <textarea
            className="nat-resume__text"
            aria-label="Mensaje para continuar la sesión"
            rows={3}
            maxLength={MAX_RESUME_CHARS}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            data-testid="attempt-resume-text"
          />
          <div className="nat__actions">
            <button type="button" className="btn btn--primary btn--sm" disabled={busy || !message} onClick={send} data-testid="attempt-resume-send">{busy ? 'Pidiendo…' : 'Continuar'}</button>
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>Cancelar</button>
          </div>
        </>
      )}
      {error && (
        <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-resume-error">
          <span>{error.message}</span>
          {error.detail !== error.message && (
            <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
          )}
        </div>
      )}
    </div>
  );
}
