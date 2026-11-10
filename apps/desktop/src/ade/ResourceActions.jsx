import { useId, useState } from 'react';
import { cleanResource, deleteWorktree, describeCommandError } from './attemptCommands';
import { CoreModelNotice } from './CoreModelNotice';
import { useCoreQuery } from './useCoreQuery';
import './ResourcesInventory.css';

/**
 * LXO-157 · Acciones sobre el worktree de una Task (`resource_inspect` / `resource_clean` / `resource_delete_worktree`), con el estado de git a la
 * vista ANTES de confirmar. Nunca se ofrece lo que el Core no deja: lo bloqueado sale desactivado con su motivo. Un estado desconocido no habilita
 * nada destructivo. Después de actuar se vuelve a leer del Core (y se refresca el inventario): la interfaz no da nada por hecho por su cuenta.
 *
 * - «Limpiar» solo quita un worktree limpio de trabajo integrado y borra su rama con `branch -d`.
 * - «Quitar el worktree» conserva SIEMPRE la rama; los cambios sin commit solo se pierden si se descartan aparte.
 */
const BLOCKS = Object.freeze({
  degraded: 'El Core está en solo lectura: no puede registrar el cambio, así que no se borra nada.',
  running: 'La tarea sigue en marcha o tiene un proceso vivo: páralo antes.',
  unknown: 'No se pudo comprobar su estado: por seguridad no se ofrece borrar.',
  dirty: 'Tiene cambios sin commit.',
  not_merged: 'Su trabajo no consta integrado.',
  nothing_to_do: 'No hay nada que limpiar.',
  no_worktree: 'La tarea no tiene worktree.',
});
const DISK_TEXT = Object.freeze({ present: 'en disco', missing: 'ya no está en disco', none: 'sin worktree', unknown: 'no se pudo comprobar' });
const MERGED_TEXT = Object.freeze({ integrated: 'integrada', not_merged: 'sin integrar', unknown: 'no se sabe si está integrada' });
const DIRTY_TEXT = (dirty) => (dirty === true ? 'con cambios sin commit' : dirty === false ? 'limpio' : 'sin comprobar');

function outcomeText(action, r) {
  if (r.outcome === 'nothing_to_do') return 'No había nada que hacer.';
  if (r.outcome === 'forgotten') return 'El worktree ya no estaba en disco: solo se anotó. No se tocó git.';
  if (action === 'clean') {
    return `Limpio: se quitó el worktree${r.branch_deleted ? ' y se borró su rama integrada' : r.branch_kept ? '; su rama se conserva (git no la ve integrada)' : ''}.`;
  }
  return `Worktree quitado${r.discarded_uncommitted ? ' (se descartaron los cambios sin commit)' : ''}. La rama se conserva con su trabajo.`;
}

export function ResourceActions({ taskId, onChanged }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const state = useCoreQuery('resource_inspect', { task_id: taskId }, { enabled: Boolean(open && taskId) });
  const [confirming, setConfirming] = useState(null);
  const [discard, setDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const view = state.data ?? null;

  const run = async (kind) => {
    setBusy(true);
    setError(null);
    try {
      const r = kind === 'clean' ? await cleanResource(taskId) : await deleteWorktree(taskId, discard);
      setResult(outcomeText(kind, r));
      setConfirming(null);
      setDiscard(false);
      // Refrescar desde el Core: no se parchea la autoridad localmente.
      state.retry();
      onChanged?.(r);
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  if (!taskId) return null;
  if (!open) {
    return <button type="button" className="lk" onClick={() => setOpen(true)} data-testid="resact-open">Gestionar…</button>;
  }
  const block = (a) => (a.ok ? null : BLOCKS[a.reason]);
  const discards = Boolean(view?.actions.delete_worktree.ok && view.actions.delete_worktree.discards_uncommitted);

  return (
    <div className="resact" role="group" aria-labelledby={`${uid}-t`} data-testid="resact">
      <div className="resinv__head">
        <strong id={`${uid}-t`}>Acciones sobre el worktree</strong>
        <button type="button" className="lk" onClick={() => { setOpen(false); setConfirming(null); setResult(null); setError(null); }} data-testid="resact-close">Cerrar</button>
      </div>
      {view ? (
        <>
          <dl className="resinv__fields" data-testid="resact-state">
            <dt>Worktree</dt><dd data-testid="resact-worktree">{DISK_TEXT[view.worktree.state]}{view.worktree.state === 'present' ? ` · ${DIRTY_TEXT(view.worktree.dirty)}` : ''}</dd>
            <dt>Rama</dt><dd data-testid="resact-branch">{view.branch.name ?? 'ninguna'}{view.branch.name && view.branch.merged ? ` · ${MERGED_TEXT[view.branch.merged]}` : ''}</dd>
            <dt>Proceso</dt><dd>{view.process.running ? 'en marcha' : 'parado'}</dd>
          </dl>
          {!view.health.writable && <p className="ade-notice ade-notice--warn" role="alert" data-testid="resact-readonly">{BLOCKS.degraded}</p>}
          {result && <p role="status" data-testid="resact-result">{result}</p>}
          {confirming ? (
            <div className="nat__form" data-testid="resact-confirm">
              {confirming === 'clean' ? (
                <p className="nat__hint">Vas a quitar el worktree (limpio) y a borrar su rama <strong className="mono">{view.branch.name ?? '—'}</strong> con <code>branch -d</code>: su trabajo consta integrado. Esto no se puede deshacer.</p>
              ) : (
                <>
                  <p className="nat__hint">Vas a quitar la carpeta del worktree. La rama <strong className="mono">{view.branch.name ?? '—'}</strong> se conserva con su trabajo.</p>
                  {discards && (
                    <label className="ade-notice ade-notice--warn">
                      <input type="checkbox" checked={discard} onChange={(e) => setDiscard(e.target.checked)} data-testid="resact-discard" />
                      {' '}Tiene cambios sin commit y se perderán. Quiero descartarlos.
                    </label>
                  )}
                </>
              )}
              <div className="nat__actions">
                <button type="button" className="btn btn--primary btn--sm" disabled={busy || (confirming === 'delete' && discards && !discard)} onClick={() => run(confirming)} data-testid="resact-confirm-yes">
                  {busy ? 'Ejecutando…' : confirming === 'clean' ? 'Limpiar' : 'Quitar el worktree'}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setConfirming(null); setDiscard(false); setError(null); }}>Cancelar</button>
              </div>
            </div>
          ) : (
            <div className="nat__actions" role="group" aria-label="Acciones">
              <button type="button" className="btn btn--primary btn--sm" disabled={!view.actions.clean.ok} onClick={() => { setConfirming('clean'); setResult(null); }} data-testid="resact-clean">Limpiar (integrado)</button>
              <button type="button" className="btn btn--ghost btn--sm" disabled={!view.actions.delete_worktree.ok} onClick={() => { setConfirming('delete'); setResult(null); }} data-testid="resact-delete">Quitar el worktree (conserva la rama)</button>
            </div>
          )}
          {!confirming && (block(view.actions.clean) || block(view.actions.delete_worktree)) && (
            <ul className="resinv__note" data-testid="resact-blocks">
              {block(view.actions.clean) && <li data-reason={view.actions.clean.reason}>Limpiar: {block(view.actions.clean)}</li>}
              {block(view.actions.delete_worktree) && <li data-reason={view.actions.delete_worktree.reason}>Quitar el worktree: {block(view.actions.delete_worktree)}</li>}
            </ul>
          )}
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="resact-error">
              <span>{error.message}</span>
              {error.detail !== error.message && <details><summary>Detalle técnico</summary><code>{error.detail}</code></details>}
            </div>
          )}
        </>
      ) : state.error ? (
        <CoreModelNotice error={state.error} onRetry={state.retry} />
      ) : (
        <p role="status">Leyendo el estado del worktree.</p>
      )}
    </div>
  );
}
