import { COPY, attemptActivityLabel, isKnownAttemptActivity } from './adeLabels';
import { formatUtc } from './attemptFormat';
import { CoreModelNotice } from './CoreModelNotice';
import { useCoreQuery } from './useCoreQuery';

/** Tamaño de la única página que se pide: el filtro por Attempt devuelve pocos eventos. */
export const ATTEMPT_ACTIVITY_LIMIT = 50;

/**
 * LXO-121 · Actividad de UN Attempt con `activity_list` filtrado por `target_kind=attempt`.
 * Es parcial a propósito: el Core solo devuelve eventos cuya entidad es el Attempt
 * (`attempt.*`); los de ProviderSession y Worktree llevan el Attempt solo en el payload y no
 * aparecen. Solo se consulta en modo task_attempt_v1; los errores van por código (CoreModelNotice).
 */
export function AttemptActivity({ attemptId, coreModel, active = true }) {
  const enabled = Boolean(active && attemptId && coreModel?.vNext);
  const state = useCoreQuery(
    'activity_list',
    { cursor: '0', limit: ATTEMPT_ACTIVITY_LIMIT, order: 'desc', target_kind: 'attempt', target_id: attemptId },
    { enabled },
  );
  if (!enabled) return null;
  const items = Array.isArray(state.data?.items) ? state.data.items : null;
  return (
    <div className="ade-attempt-activity" data-testid="attempt-activity">
      <h4 className="ssec__label">{COPY.attemptActivity}</h4>
      <p className="ade-attempts__hint ade-attempts__state--neutral">{COPY.activityPerAttemptPartial}</p>
      {items ? (
        items.length === 0 ? (
          <p className="ade-attempts__state ade-attempts__state--neutral">{COPY.noAttemptActivity}</p>
        ) : (
          <ol className="ade-attempt-activity__list">
            {items.map((item) => {
              const time = formatUtc(item.ts);
              return (
                <li key={item.event_id} data-event-id={item.event_id}>
                  {time ? <time dateTime={time.iso}>{time.label}</time> : <span className="ade-missing">{COPY.notAvailable}</span>}
                  {' · '}{attemptActivityLabel(item.message_key)}
                  {!isKnownAttemptActivity(item.message_key) && (
                    <details className="ade-status__raw"><summary>{COPY.technicalDetail}</summary><code>{String(item.message_key ?? '')}</code></details>
                  )}
                </li>
              );
            })}
          </ol>
        )
      ) : state.error ? (
        <CoreModelNotice error={state.error} onRetry={state.retry} />
      ) : (
        <p className="ade-attempts__state" role="status">{COPY.loadingAttemptActivity}</p>
      )}
      {items && items.length > 0 && state.data?.next_cursor && state.data?.has_more ? (
        <p className="ade-attempts__hint ade-attempts__state--neutral" data-testid="attempt-activity-truncated">{COPY.attemptActivityTruncated}</p>
      ) : null}
    </div>
  );
}
