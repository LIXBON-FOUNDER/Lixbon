import { useId, useState } from 'react';
import { adoptWorktree, describeCommandError } from './attemptCommands';
import { CoreModelNotice } from './CoreModelNotice';
import { useCoreQuery } from './useCoreQuery';
import './ResourcesInventory.css';

/**
 * LXO-157 · Adoptar un worktree externo (`resource_adopt_preview` / `resource_adopt`, docs/core/RESOURCES.md § Adoptar). Un worktree que Lixbon no creó no
 * tiene dueño: adoptarlo lo convierte en el PRIMER intento, ya terminado, de una tarea sin ejecución del mismo proyecto, para revisarlo e
 * integrarlo como cualquier otro. No se inventa historia: Lixbon no lo ejecutó, y el intento lo dice.
 *
 * - El Core exige el worktree LIMPIO (sin cambios sin commit), en una rama propia y distinta de la base; la interfaz solo muestra el veredicto y su
 *   motivo, nunca lo recalcula. Nada se ofrece si el Core no dice que se puede.
 * - La elección de la tarea y la confirmación son de la persona; después se vuelve a leer del Core (y se refresca el inventario).
 */
const BLOCKS = Object.freeze({
  adopt_dirty: 'Tiene cambios sin commit: guárdalos (commit) o descártalos antes de adoptarlo. Solo se adopta trabajo comprometido.',
  adopt_unknown: 'No se pudo comprobar su estado: por seguridad no se adopta a ciegas.',
  adopt_not_a_worktree: 'Esa carpeta ya no es un worktree de este proyecto según git.',
  adopt_main_checkout: 'Es el checkout principal del proyecto, no un worktree adicional.',
  adopt_missing: 'La carpeta del worktree ya no está en disco.',
  adopt_detached: 'No está en una rama (HEAD desacoplado): no hay qué revisar ni integrar.',
  adopt_already_owned: 'Una tarea ya posee este worktree.',
  adopt_branch_taken: 'Otra tarea ya usa esta rama.',
  adopt_no_base: 'No se pudo determinar en qué se diferencia de la rama base: no hay nada que revisar.',
  adopt_no_changes: 'La rama no tiene commits propios respecto a la rama base: no hay trabajo que revisar.',
  adopt_locked: 'El worktree está bloqueado (git worktree lock): quien lo bloqueó lo quiere conservar.',
  adopt_is_base: 'Está en la rama base: no tiene trabajo propio que adoptar.',
  adopt_degraded: 'El Core está en solo lectura: no puede registrar la adopción.',
  adopt_no_task: 'No hay una tarea sin ejecución en este proyecto que lo reciba: crea una primero.',
});

export function ResourceAdopt({ projectId, path, onChanged }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const state = useCoreQuery('resource_adopt_preview', { project_id: projectId, path }, { enabled: Boolean(open && projectId && path) });
  const [taskId, setTaskId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const view = state.data ?? null;

  if (!projectId || !path) return null;
  if (!open) {
    return <button type="button" className="lk" onClick={() => setOpen(true)} data-testid="resadopt-open">Adoptar…</button>;
  }

  const tasks = view?.tasks ?? [];
  // Una sola candidata se elige sola; con varias, la persona decide (nunca se adivina).
  const chosen = tasks.some((t) => t.task_id === taskId) ? taskId : tasks.length === 1 ? tasks[0].task_id : '';
  const chosenTask = tasks.find((t) => t.task_id === chosen) ?? null;
  const adoptable = Boolean(view?.adopt.ok);

  const close = () => { setOpen(false); setConfirming(false); setResult(null); setError(null); setTaskId(''); };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await adoptWorktree({ projectId, path, taskId: chosen });
      setResult(r.status === 'AlreadyAdopted'
        ? `Ya estaba adoptado como el intento 1 de la tarea ${r.task_id}.`
        : `Adoptado como el intento 1 de la tarea ${r.task_id}. Ya se puede revisar e integrar.`);
      setConfirming(false);
      // Refrescar desde el Core: no se parchea la autoridad localmente.
      state.retry();
      onChanged?.(r);
    } catch (failure) {
      setError(describeCommandError(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="resact" role="group" aria-labelledby={`${uid}-t`} data-testid="resadopt">
      <div className="resinv__head">
        <strong id={`${uid}-t`}>Adoptar este worktree</strong>
        <button type="button" className="lk" onClick={close} data-testid="resadopt-close">Cerrar</button>
      </div>
      {view ? (
        <>
          <dl className="resinv__fields" data-testid="resadopt-state">
            <dt>Rama</dt><dd data-testid="resadopt-branch">{view.branch ?? 'ninguna'}</dd>
            <dt>Base</dt><dd data-testid="resadopt-base">{view.base ?? '—'}</dd>
          </dl>
          <p className="nat__hint">Pasa a ser el primer intento, ya terminado, de una tarea sin ejecución. Lixbon no lo ejecutó, así que no hay historial de ejecución. Debe estar limpio: sin cambios sin commit.</p>
          {!view.health.writable && <p className="ade-notice ade-notice--warn" role="alert" data-testid="resadopt-readonly">{BLOCKS.adopt_degraded}</p>}
          {result && <p role="status" data-testid="resadopt-result">{result}</p>}
          {!view.adopt.ok && !result && (
            <p className="ade-notice ade-notice--warn" role="status" data-testid="resadopt-block" data-reason={view.adopt.code}>{BLOCKS[view.adopt.code]}</p>
          )}
          {adoptable && !result && !confirming && (
            <div className="nat__form">
              {tasks.length > 1 ? (
                <fieldset>
                  <legend>¿En qué tarea?</legend>
                  {tasks.map((t) => (
                    <label key={t.task_id} className="nat__hint">
                      <input type="radio" name={`${uid}-task`} value={t.task_id} checked={chosen === t.task_id} onChange={() => setTaskId(t.task_id)} data-testid={`resadopt-task-${t.task_id}`} />
                      {' '}{t.title} <span className="mono">({t.task_id})</span>
                    </label>
                  ))}
                </fieldset>
              ) : (
                <p className="nat__hint" data-testid="resadopt-single">Se adoptará en la tarea <strong>{tasks[0].title}</strong> <span className="mono">({tasks[0].task_id})</span>.</p>
              )}
              <div className="nat__actions">
                <button type="button" className="btn btn--primary btn--sm" disabled={!chosen} onClick={() => { setConfirming(true); setError(null); }} data-testid="resadopt-go">Adoptar</button>
              </div>
            </div>
          )}
          {adoptable && confirming && !chosenTask && (
            <div className="nat__form" data-testid="resadopt-gone">
              <p className="ade-notice ade-notice--warn" role="alert">La tarea elegida ya no está disponible. Elige otra.</p>
              <div className="nat__actions"><button type="button" className="btn btn--ghost btn--sm" onClick={() => { setConfirming(false); setTaskId(''); }}>Volver</button></div>
            </div>
          )}
          {adoptable && confirming && chosenTask && (
            <div className="nat__form" data-testid="resadopt-confirm">
              <p className="nat__hint">Vas a adoptar la rama <strong className="mono">{view.branch}</strong> como el intento 1 de <strong>{chosenTask.title}</strong>. Adoptar no toca git ni la carpeta; solo queda registrado en Lixbon. Pero desde ese momento es una tarea de Lixbon: si luego la liberas (<span className="mono">release</span>), Lixbon quitará esta carpeta, con sus archivos ignorados, y borrará la rama solo si ya está fusionada. Cerrar la ejecución no la toca.</p>
              <div className="nat__actions">
                <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={run} data-testid="resadopt-confirm-yes">{busy ? 'Adoptando…' : 'Confirmar adopción'}</button>
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setConfirming(false); setError(null); }}>Cancelar</button>
              </div>
            </div>
          )}
          {error && (
            <div className="ade-notice ade-notice--error" role="alert" data-testid="resadopt-error">
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
