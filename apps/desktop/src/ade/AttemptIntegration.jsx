import { useId, useState } from 'react';
import { describeCommandError, integrateAttempt } from './attemptCommands';
import { CoreModelNotice } from './CoreModelNotice';
import { useCoreQuery } from './useCoreQuery';
import './AttemptCompare.css';

/**
 * LXO-156 · Integrar un intento ya revisado: fusionar en el proyecto o publicar un PR (`attempt_integration_preview` / `attempt_integrate`).
 *
 * Se ve ANTES de confirmar: la revisión (el mismo HEAD que se aceptó y que viaja), el destino (rama y HEAD, y si se movió fuera de Lixbon) y qué
 * hace cada acción. Lo que el Core no deja hacer sale desactivado con su motivo. Los resultados son los del efecto —fusionado, conflicto, error,
 * destino movido, PR creado o ya existente—; un conflicto o un error no pierden historia. Aceptar la revisión no es haber integrado, y integrar
 * no limpia el worktree.
 */
const BLOCKS = Object.freeze({
  not_current_attempt: 'Solo se integra el intento actual de la tarea.',
  not_final: 'El intento sigue en marcha: espera a que termine.',
  no_branch: 'El intento no tiene una rama que integrar.',
  review_required: 'Primero acepta la revisión de este HEAD exacto (Proof Pack).',
  already_merged: 'Ya está integrado.',
  already_exists: 'Ya hay un PR.',
  target_branch_mismatch: 'El proyecto no está en la rama base de esta tarea: vuelve a ella.',
  target_unavailable: 'No se puede leer el destino.',
  checkout_dirty: 'El proyecto tiene cambios sin commit: haz commit o stash.',
  no_remote: 'El proyecto no tiene remoto «origin»: no se puede publicar un PR.',
});
const REVIEW_TEXT = Object.freeze({
  accepted: 'aceptada sobre este HEAD',
  none: 'sin revisar',
  stale: 'la aceptación era de otro HEAD',
  rejected: 'rechazada',
});
const short = (commit) => (typeof commit === 'string' ? commit.slice(0, 12) : '');

/** El texto de lo que pasó, tal como lo dice el efecto. `tone`: success · warn · error. */
function describeOutcome(r) {
  const files = Array.isArray(r.conflicts) ? r.conflicts : [];
  switch (r.outcome) {
    case 'merged': return { tone: 'success', text: `Fusionado. Commit resultante ${short(r.result_commit)}. El worktree no se limpia: eso es otra acción.` };
    case 'already_merged': return { tone: 'success', text: 'Ya estaba integrado: no se hizo otra fusión.' };
    case 'conflict': return { tone: 'error', text: 'Conflicto: git abortó la fusión y no se perdió nada. La rama del intento sigue intacta y el proyecto, limpio. Resuélvelo fuera de Lixbon.', files };
    case 'target_moved': return { tone: 'warn', text: `El destino cambió fuera de Lixbon (esperado ${short(r.expected_commit)}, encontrado ${short(r.found_commit)}). No se integró.` };
    case 'target_branch_mismatch': return { tone: 'warn', text: `El proyecto está en «${r.found_branch ?? 'ninguna rama'}» y esta tarea nació de «${r.expected_branch}». No se integró.` };
    case 'head_moved': return { tone: 'warn', text: `La rama se movió desde que la viste (ahora ${short(r.found_commit)}). No se integró nada: revisa el HEAD actual.` };
    case 'review_required': return { tone: 'warn', text: 'Hace falta aceptar la revisión de este HEAD exacto antes de integrar.' };
    case 'created': return { tone: 'success', text: 'PR creado.', url: r.pr_url };
    case 'already_exists': return { tone: 'success', text: 'Ya existía un PR: no se abrió otro.', url: r.pr_url };
    case 'error': return { tone: 'error', text: 'El efecto falló.', detail: r.message };
    default: return { tone: 'warn', text: `Resultado no reconocido: ${String(r.outcome)}.` };
  }
}

export function AttemptIntegration({ attempt, onDone, active = true }) {
  const uid = useId();
  const final = ['done', 'failed', 'stopped', 'exited'].includes(attempt?.status);
  const enabled = Boolean(active && attempt?.id && final);
  const state = useCoreQuery('attempt_integration_preview', { attempt_id: attempt?.id }, { enabled });
  const [confirming, setConfirming] = useState(null);
  const [squash, setSquash] = useState(false);
  const [acceptMoved, setAcceptMoved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  if (!enabled) return null;
  const view = state.data ?? null;
  const target = view?.target;
  const head = view?.revision.head_commit;

  const run = async (action) => {
    setBusy(true);
    setError(null);
    try {
      // Se manda el HEAD que se mostró, no uno releído ahora.
      const out = await integrateAttempt({
        attemptId: attempt.id, action, headCommit: head, squash, acceptMovedTarget: action === 'merge' && acceptMoved ? target.head : undefined,
      });
      setResult({ action, ...describeOutcome(out) });
      setConfirming(null);
      setAcceptMoved(false);
      onDone?.(out);
      state.retry();
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  const open = (action) => { setConfirming(action); setResult(null); setError(null); setAcceptMoved(false); };
  const block = (a) => (a.ok ? null : BLOCKS[a.reason]);

  return (
    <section className="cmp pp" aria-labelledby={`${uid}-title`} data-testid="attempt-integration">
      <div className="cmp__head">
        <h4 id={`${uid}-title`} className="ssec__label">Integración</h4>
        <button type="button" className="lk" onClick={state.retry} data-testid="integration-reload">Recargar</button>
      </div>
      {view ? (
        <>
          <dl className="pp__list">
            <dt>Revisión</dt>
            <dd data-testid="integration-revision"><span className="mono">{head ? short(head) : 'sin rama'}</span> · {REVIEW_TEXT[view.review.state]}</dd>
            <dt>Destino</dt>
            <dd data-testid="integration-target">
              {view.target.kind === 'project_checkout' ? 'proyecto' : 'tarea padre'} · rama <span className="mono">{view.target.branch ?? 'desconocida'}</span>
              {view.target.head && <> · HEAD <span className="mono">{short(view.target.head)}</span></>}
              {view.target.moved === true && <span className="cmp-note"> · se movió fuera de Lixbon (esperado {short(view.target.expected_head)})</span>}
              {view.target.clean === false && <span className="cmp-note"> · con cambios sin commit</span>}
            </dd>
            <dt>Estado</dt>
            <dd data-testid="integration-state">
              {view.merge.merged ? `Integrado${view.merge.result_commit ? ` (${short(view.merge.result_commit)})` : ''}` : 'Sin integrar'}
              {view.pr.url && <> · PR <code className="mono" data-testid="integration-pr">{view.pr.url}</code></>}
            </dd>
          </dl>

          {result && (
            <div className={`ade-notice ade-notice--${result.tone === 'success' ? 'info' : result.tone}`} role={result.tone === 'error' ? 'alert' : 'status'} data-testid="integration-result" data-tone={result.tone}>
              <span>{result.text}</span>
              {result.url && <> <code className="mono">{result.url}</code></>}
              {result.files?.length > 0 && <ul className="cmp-files" aria-label="Archivos en conflicto">{result.files.map((f) => <li key={f}><code className="mono">{f}</code></li>)}</ul>}
              {result.detail && <details><summary>Detalle técnico</summary><code>{result.detail}</code></details>}
            </div>
          )}

          {confirming ? (
            <div className="nat__form" data-testid="integration-confirm">
              {confirming === 'merge' ? (
                <>
                  <p className="nat__hint">
                    Vas a fusionar la revisión <span className="mono">{short(head)}</span> en la rama <strong className="mono">{target.branch}</strong> del proyecto (HEAD <span className="mono">{short(target.head)}</span>).
                    Esto cambia el checkout del proyecto. No se limpia el worktree.
                  </p>
                  <label><input type="checkbox" checked={squash} onChange={(e) => setSquash(e.target.checked)} data-testid="integration-squash" /> Un solo commit (squash)</label>
                  {target.moved === true && (
                    <label className="ade-notice ade-notice--warn" data-testid="integration-moved">
                      <input type="checkbox" checked={acceptMoved} onChange={(e) => setAcceptMoved(e.target.checked)} data-testid="integration-accept-moved" />
                      {' '}El destino cambió fuera de Lixbon. Acepto integrar sobre el commit <span className="mono">{short(target.head)}</span> tal como está.
                    </label>
                  )}
                </>
              ) : (
                <p className="nat__hint">Vas a empujar la rama a «origin» y abrir un PR con la revisión <span className="mono">{short(head)}</span>. Esto publica fuera de tu equipo.</p>
              )}
              <div className="nat__actions">
                <button type="button" className="btn btn--primary btn--sm" disabled={busy || (confirming === 'merge' && target.moved === true && !acceptMoved)} onClick={() => run(confirming)} data-testid="integration-confirm-yes">
                  {busy ? 'Ejecutando…' : confirming === 'merge' ? 'Fusionar' : 'Publicar PR'}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setConfirming(null); setError(null); }}>Cancelar</button>
              </div>
            </div>
          ) : (
            <div className="nat__actions" role="group" aria-label="Integrar el intento">
              <button type="button" className="btn btn--primary btn--sm" disabled={!view.can_merge.ok} onClick={() => open('merge')} data-testid="integration-merge">
                Fusionar en {target.branch ?? 'el proyecto'}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={!view.can_publish_pr.ok} onClick={() => open('publish_pr')} data-testid="integration-pr-open">Publicar PR</button>
            </div>
          )}
          {!confirming && (block(view.can_merge) || block(view.can_publish_pr)) && (
            <ul className="cmp-note" data-testid="integration-blocks">
              {block(view.can_merge) && <li data-reason={view.can_merge.reason}>Fusionar: {block(view.can_merge)}</li>}
              {block(view.can_publish_pr) && <li data-reason={view.can_publish_pr.reason}>Publicar PR: {block(view.can_publish_pr)}</li>}
            </ul>
          )}
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="integration-error">
              <span>{error.message}</span>
              {error.detail !== error.message && <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>}
            </div>
          )}
        </>
      ) : state.error ? (
        <CoreModelNotice error={state.error} onRetry={state.retry} />
      ) : (
        <p role="status">Leyendo el estado de la integración.</p>
      )}
    </section>
  );
}
