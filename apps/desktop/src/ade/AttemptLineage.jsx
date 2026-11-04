import { attemptStatusInfo } from './adeLabels';
import { AttemptFork } from './AttemptFork';
import { StatusText } from './CoreModelNotice';
import { useCoreQuery } from './useCoreQuery';

/**
 * LXO-145/153 · De dónde salió un intento y qué Forks nacieron de él (`attempt_lineage`), más la acción de bifurcar. La procedencia es la
 * que el Core registró al bifurcar: no se deduce de nombres ni de fechas. Si la lectura falla no se pinta nada (no hay procedencia que
 * inventar), pero bifurcar sigue ofreciéndose: el Core es quien comprueba.
 */
const STRATEGY_TEXT = { clean: 'solo con el encargo', context_package: 'con un paquete de contexto' };
const OVERRIDE_TEXT = { provider: 'otro proveedor', model: 'otro modelo', effort: 'otro esfuerzo' };

export function AttemptLineage({ attempt, onOpenAttempt, active = true }) {
  const enabled = Boolean(active && attempt?.id);
  const state = useCoreQuery('attempt_lineage', { attempt_id: attempt?.id }, { enabled });
  const lineage = state.data ?? null;
  const origin = lineage?.forked_from ?? null;
  const forks = lineage?.forks ?? [];
  const open = (taskId, attemptId) => () => onOpenAttempt?.({ taskId, attemptId });

  return (
    <div className="ade-lineage" data-testid="attempt-lineage">
      {origin && (
        <p data-testid="attempt-lineage-origin">
          Bifurcado del intento{' '}
          {onOpenAttempt
            ? <button type="button" className="lk" onClick={open(origin.task_id, origin.attempt_id)} data-testid="attempt-lineage-origin-open"><span className="mono">{origin.attempt_id}</span></button>
            : <span className="mono">{origin.attempt_id}</span>}
          {' '}· {STRATEGY_TEXT[origin.strategy]}
          {origin.overrides.length > 0 && <> · {origin.overrides.map((o) => OVERRIDE_TEXT[o]).join('; ')}</>}
          {origin.package_id && <> · paquete <code className="mono">{origin.package_id.slice(0, 19)}…</code></>}
        </p>
      )}
      {forks.length > 0 && (
        <>
          <h4 className="ssec__label">Bifurcaciones de este intento ({forks.length})</h4>
          <ul className="ade-attempt__artifacts" aria-label="Bifurcaciones" data-testid="attempt-lineage-forks">
            {forks.map((fork) => (
              <li key={fork.attempt_id} data-fork={fork.attempt_id}>
                {onOpenAttempt
                  ? <button type="button" className="lk" onClick={open(fork.task_id, fork.attempt_id)}><span className="mono">{fork.attempt_id}</span></button>
                  : <span className="mono">{fork.attempt_id}</span>}
                {' · '}{[fork.provider, fork.model].filter(Boolean).join(' · ')}
                {' · '}{STRATEGY_TEXT[fork.strategy]}
                {' · '}<StatusText info={attemptStatusInfo(fork.status)} />
              </li>
            ))}
          </ul>
        </>
      )}
      <AttemptFork attempt={attempt} onForked={state.retry} onOpenAttempt={onOpenAttempt} active={active} />
    </div>
  );
}
