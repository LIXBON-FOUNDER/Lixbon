import { COPY, attemptStatusInfo } from './adeLabels';
import { AttemptActivity } from './AttemptActivity';
import { attemptDuration, attemptTime } from './attemptFormat';
import { CoreModelNotice, StatusText } from './CoreModelNotice';
import { useCoreQuery } from './useCoreQuery';

/**
 * LXO-121 · Historial de Attempts de una Task (solo lectura). Lee `attempts_by_task` (una página,
 * sin paginar): cada fila usa solo `attempt_brief`, nunca `attempt_detail` por fila. En modo legacy
 * (o Core sin la query) no consulta nada y avisa sin reintento; la Task sigue en la vista F2.
 */
export function AttemptHistory({ taskId, coreModel, selectedAttemptId = null, onSelectAttempt, onBack, active = true }) {
  const enabled = Boolean(active && taskId && coreModel?.vNext);
  const state = useCoreQuery('attempts_by_task', { task_id: taskId }, { enabled });
  const items = Array.isArray(state.data?.items) ? [...state.data.items].sort((a, b) => a.n - b.n) : null;
  return (
    <section className="ade-attempts" aria-label={COPY.attemptHistory} data-testid="attempt-history">
      <h3 className="ssec__label">{COPY.attemptHistory}</h3>
      {!coreModel?.vNext ? (
        coreModel?.mode === 'unknown'
          ? <p className="ade-attempts__state" role="status">Comprobando el modelo del Core.</p>
          : <CoreModelNotice error="core_model_inactive: modo legacy" />
      ) : items ? (
        items.length === 0 ? (
          <p className="ade-attempts__state ade-attempts__state--neutral">{COPY.noAttempts}</p>
        ) : (
          <ol className="ade-attempts__list">
            {items.map((attempt) => {
              const time = attemptTime(attempt);
              const duration = attemptDuration(attempt);
              const selected = attempt.id === selectedAttemptId;
              return (
                <li key={attempt.id} className={`ade-attempts__item${selected ? ' is-selected' : ''}`} data-attempt-id={attempt.id}>
                  <button type="button" className="ade-attempts__open" aria-current={selected ? 'true' : undefined} onClick={() => onSelectAttempt?.(attempt.id)}>
                    <StatusText info={attemptStatusInfo(attempt.status)} prefix={`Intento #${attempt.n} · `} />
                  </button>
                  <span className="ade-attempts__meta">
                    {[attempt.provider, attempt.model].filter(Boolean).join(' · ') || 'Proveedor no informado'}
                    {attempt.role ? ` · ${attempt.role}` : ''}
                    {attempt.external ? ' · externo' : ''}
                  </span>
                  <span className="ade-attempts__meta">
                    {time ? <time dateTime={time.iso}>{time.label}</time> : COPY.notAvailable}
                    {' · '}{duration === COPY.notAvailable ? COPY.durationUnavailable : duration}
                  </span>
                </li>
              );
            })}
          </ol>
        )
      ) : state.error ? (
        <CoreModelNotice error={state.error} onRetry={state.retry} onBack={onBack} />
      ) : (
        <p className="ade-attempts__state" role="status">Cargando intentos.</p>
      )}
      {selectedAttemptId && <AttemptActivity attemptId={selectedAttemptId} coreModel={coreModel} active={active} />}
    </section>
  );
}
