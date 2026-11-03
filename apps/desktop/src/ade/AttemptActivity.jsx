import { ATTEMPT_GROUP_LABELS, COPY, attemptActivityLabel, attemptRunLabel, isKnownAttemptActivity } from './adeLabels';
import { formatDurationMs, formatUtc } from './attemptFormat';
import { groupAttemptActivity } from './attemptTimeline';
import { CoreModelNotice } from './CoreModelNotice';
import { ATTEMPT_ACTIVITY_LIMIT } from './attemptActivityLimit';
import { useCoreQuery } from './useCoreQuery';

export { ATTEMPT_ACTIVITY_LIMIT };

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
      {items && items.length > 0 && <p className="ade-attempts__hint ade-attempts__state--neutral" data-testid="attempt-activity-grouping">{COPY.activityGroupedByRun}</p>}
      {items ? (
        items.length === 0 ? (
          <p className="ade-attempts__state ade-attempts__state--neutral">{COPY.noAttemptActivity}</p>
        ) : (
          groupAttemptActivity(items).map((group) => (
            <section key={group.id} className="ade-attempt-activity__group" data-group-kind={group.kind} data-testid="attempt-activity-group">
              <h5 className="ade-attempt-activity__group-head">
                <span>{group.kind === 'run' ? attemptRunLabel(group.n) : ATTEMPT_GROUP_LABELS[group.kind]}</span>
                {group.kind === 'run' && (
                  <span className="ade-attempt-activity__group-meta">
                    {group.durationMs !== null ? `${formatDurationMs(group.durationMs)} · ${attemptActivityLabel(group.endKey)}` : group.open ? COPY.runInProgress : null}
                  </span>
                )}
              </h5>
              <ol className="ade-attempt-activity__list">
                {group.items.map((item) => {
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
            </section>
          ))
        )
      ) : state.error ? (
        <CoreModelNotice error={state.error} onRetry={state.retry} />
      ) : (
        <p className="ade-attempts__state" role="status">{COPY.loadingAttemptActivity}</p>
      )}
      {items && items.length > 0 && state.data?.has_more === true ? (
        <p className="ade-attempts__hint ade-attempts__state--neutral" data-testid="attempt-activity-truncated">{COPY.attemptActivityTruncated(ATTEMPT_ACTIVITY_LIMIT)}</p>
      ) : null}
    </div>
  );
}
