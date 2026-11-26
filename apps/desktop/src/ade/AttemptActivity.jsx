import { ATTEMPT_GROUP_LABELS, COPY, attemptActivityLabel, attemptRunLabel, isKnownAttemptActivity } from './adeLabels';
import { formatDurationMs, formatUtc } from './attemptFormat';
import { groupAttemptActivity } from './attemptTimeline';
import { CoreModelNotice } from './CoreModelNotice';
import { ATTEMPT_ACTIVITY_LIMIT } from './attemptActivityLimit';
import { useCoreQuery } from './useCoreQuery';
import { StatusIcon } from '@lixbon/icons/status';

export { ATTEMPT_ACTIVITY_LIMIT };

/**
 * LXO-121 · Actividad de UN Attempt con `activity_list` filtrado por `target_kind=attempt`.
 * Es parcial a propósito: el Core solo devuelve eventos cuya entidad es el Attempt
 * (`attempt.*`); los de ProviderSession y Worktree llevan el Attempt solo en el payload y no
 * aparecen. Solo se consulta en modo task_attempt_v1; los errores van por código (CoreModelNotice).
 */
const EVENT_ICONS = {
  started: 'working', resumed: 'working', completed: 'done', integrated: 'done',
  failed: 'failed', rejected: 'failed', stopped: 'paused', exited: 'paused',
  waiting: 'question', awaiting_terminal_approval: 'permission', question_requested: 'question',
  approved: 'done', request_answered: 'done', requested: 'review',
};
const ACTOR_LABELS = { person: 'Persona', agent: 'Agente', system: 'Sistema' };

export function AttemptActivity({ attemptId, coreModel, active = true, embedded = false }) {
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
      <h4 className={embedded ? 'sr-only' : 'ssec__label'}>{COPY.attemptActivity}</h4>
      <details className="ade-attempt-activity__scope"><summary>Alcance de la actividad</summary>
        <p className="ade-attempts__hint ade-attempts__state--neutral">{COPY.activityPerAttemptPartial}</p>
        {items && items.length > 0 && <p className="ade-attempts__hint ade-attempts__state--neutral" data-testid="attempt-activity-grouping">{COPY.activityGroupedByRun}</p>}
      </details>
      {items && state.error && <CoreModelNotice error={state.error} onRetry={state.retry} />}
      {items ? (
        items.length === 0 ? (
          <p className="ade-attempts__state ade-attempts__state--neutral">{COPY.noAttemptActivity}</p>
        ) : (
          groupAttemptActivity(items).map((group, index) => (
            <details key={group.id} open={index === 0} className="ade-attempt-activity__group" data-group-kind={group.kind} data-testid="attempt-activity-group">
              <summary className="ade-attempt-activity__group-head">
                <span>{group.kind === 'run' ? attemptRunLabel(group.n) : ATTEMPT_GROUP_LABELS[group.kind]}</span>
                {group.kind === 'run' && (
                  <span className="ade-attempt-activity__group-meta">
                    {group.durationMs !== null ? `${formatDurationMs(group.durationMs)} · ${attemptActivityLabel(group.endKey)}` : group.open ? COPY.runInProgress : null}
                  </span>
                )}
                <span className="ade-attempt-activity__count">{group.items.length} {group.items.length === 1 ? 'evento' : 'eventos'}</span>
              </summary>
              <ol className="ade-attempt-activity__list">
                {group.items.map((item) => {
                  const time = formatUtc(item.ts);
                  const icon = EVENT_ICONS[item.message_key?.replace('activity.attempt.', '')];
                  return (
                    <li key={item.event_id} data-event-id={item.event_id}>
                      <span className="ade-attempt-activity__icon">{icon && <StatusIcon kind={icon} size={16} />}</span>
                      <div className="ade-attempt-activity__event"><span>{attemptActivityLabel(item.message_key)}</span>
                        {ACTOR_LABELS[item.actor?.kind] && <small>{ACTOR_LABELS[item.actor.kind]}</small>}
                        {!isKnownAttemptActivity(item.message_key) && (
                        <details className="ade-status__raw"><summary>{COPY.technicalDetail}</summary><code>{String(item.message_key ?? '')}</code></details>
                        )}
                      </div>
                      {time ? <time dateTime={time.iso} title={time.label} aria-label={time.label}>{time.iso.slice(11, 16)} UTC</time> : <span className="ade-missing">{COPY.notAvailable}</span>}
                    </li>
                  );
                })}
              </ol>
            </details>
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
