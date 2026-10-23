import { ATTEMPT_ACTIVITY_LIMIT } from '../AttemptActivity';

// Formas tomadas de activity_tests.rs (attempt.* con target ('attempt', id)).
export function attemptEvent(seq, attemptId, kind, args, visual = 'info', ts = 1792000000000 + seq * 1000) {
  return {
    seq: String(seq), event_id: `ev-${seq}`, ts, kind, v: 1, class: 'state',
    message_key: `activity.${kind}`, args, visual, fallback: false,
    target: { kind: 'attempt', id: attemptId }, project_id: 'p1', run_id: 'r1',
    actor: { kind: 'system', id: null }, provenance: { channel: 'core', client_id: null }, correlation_id: null,
  };
}
export function attemptActivityPage(items) {
  return { v: 1, projection: 1, order: 'desc', items, next_cursor: items.length ? items[items.length - 1].seq : '0', has_more: false, head_seq: items[0]?.seq ?? '0', limit: ATTEMPT_ACTIVITY_LIMIT };
}
