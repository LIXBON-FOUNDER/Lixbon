import { useState } from 'react';
import { describeCommandError, listShareCandidates, shareWorktree } from './attemptCommands';

/**
 * LXO-248 · Compartir el worktree de OTRO intento antes de aprobar éste. Solo aparece mientras el intento espera su aprobación y aún no tiene
 * worktree. Lo decide la persona: el Core comprueba que sea del mismo Project, que ningún otro intento vivo lo use (en serie) y que siga activo.
 * El intento que comparte no es dueño de la carpeta: nada de lo que haga la borra, y se revisa e integra desde el intento dueño. Aprobar sigue
 * siendo lo que lo ejecuta. Los candidatos los da el Core (`attempt_share_candidates`); los que otro intento vivo está usando salen deshabilitados.
 */
const OUTCOMES = {
  Shared: 'Compartido: este intento trabajará en la carpeta de ese worktree al aprobarlo. Hasta que termine o se rechace, nadie más la usa.',
  AlreadyShared: 'Ya compartía ese worktree.',
};

function describe(candidate) {
  const title = candidate.owner_task_title || candidate.owner_task_id;
  const branch = candidate.branch ? ` · ${candidate.branch}` : '';
  const busy = candidate.busy_by ? ` (en uso por ${candidate.busy_by}: espera a que termine)` : '';
  return `${title}${branch} · ${candidate.from_attempt_id}${busy}`;
}

export function AttemptShareWorktree({ attempt, onShared }) {
  const [candidates, setCandidates] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  if (!attempt || attempt.status !== 'pending_approval' || attempt.worktree) return null;

  // Los candidatos se piden al abrir (no antes): es una consulta al Core que casi nadie necesita.
  const load = async () => {
    setLoadError(null);
    try {
      const result = await listShareCandidates(attempt.id);
      setCandidates(Array.isArray(result?.candidates) ? result.candidates : []);
    } catch (failure) {
      setCandidates([]);
      setLoadError(describeCommandError(failure));
    }
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await shareWorktree(attempt.id, source);
      setOutcome(OUTCOMES[result?.status] ?? 'Worktree compartido.');
      onShared?.(result);
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="nat-share" data-testid="attempt-share" onToggle={(event) => { if (event.currentTarget.open && candidates === null) load(); }}>
      <summary>Compartir el worktree de otro intento</summary>
      <div className="nat-share__body" role="group" aria-label="Compartir el worktree de otro intento">
        <p className="nat__hint">
          Este intento trabajará en la misma carpeta que el elegido (del mismo proyecto), en serie: nunca dos intentos vivos a la vez. No será dueño
          de la carpeta: nada de lo que haga la borra y se revisa e integra desde el intento dueño.
        </p>
        {loadError && (
          <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-share-load-error">
            <span>{loadError.message}</span>
          </div>
        )}
        {outcome ? (
          <p role="status" data-testid="attempt-share-outcome">{outcome}</p>
        ) : candidates === null ? (
          <p role="status">Buscando worktrees que se puedan compartir.</p>
        ) : candidates.length === 0 ? (
          <p className="ade-missing" data-testid="attempt-share-empty">No hay otro worktree activo en este proyecto que se pueda compartir.</p>
        ) : (
          <>
            <label className="nat-share__label">
              Worktree a compartir
              <select
                className="nat-share__input"
                value={source}
                disabled={busy}
                onChange={(event) => setSource(event.target.value)}
                data-testid="attempt-share-source"
              >
                <option value="">Elige un worktree…</option>
                {candidates.map((candidate) => (
                  <option key={candidate.worktree_id} value={candidate.from_attempt_id} disabled={Boolean(candidate.busy_by)}>
                    {describe(candidate)}
                  </option>
                ))}
              </select>
            </label>
            <div className="nat__actions">
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy || !source} onClick={send} data-testid="attempt-share-send">
                {busy ? 'Compartiendo…' : 'Compartir'}
              </button>
            </div>
          </>
        )}
        {error && (
          <div className="ade-notice ade-notice--error" role="alert" data-testid="attempt-share-error">
            <span>{error.message}</span>
            {error.detail !== error.message && (
              <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
