export const CONTROLS_ACTION = 'mobile_controls';

export function controlReady(data, attemptId, kind) {
  const control = data?.[`${kind}_control`];
  return data?.attempt_id === attemptId && control?.allowed === true && ['allow', 'confirm'].includes(control.policy);
}

export function controlOutcome(result, attemptId, operation) {
  if (!result.ok) return result.code || 'unconfirmed';
  const ack = result.data?.result;
  if (ack?.attempt_id !== attemptId) return 'unconfirmed';
  if (operation.kind === 'queue') return ['Queued', 'Replayed'].includes(ack.status) && typeof ack.queue_id === 'string' ? 'queued' : 'unconfirmed';
  if (operation.kind === 'cancel') return ['Cancelled', 'AlreadyCancelled'].includes(ack.status) && ack.queue_id === operation.queue_id ? 'cancelled' : 'unconfirmed';
  return ['Stopped', 'Replayed'].includes(ack.status) ? 'stopped' : 'unconfirmed';
}

/** A lost ACK retains the business key and immutable text until a fresh Core read proves its outcome. */
export function recoverQueue(data, pending) {
  const known = data?.request_status;
  return pending && known?.request_id === pending.request_id && typeof known.queue_id === 'string'
    && ['queued', 'delivering', 'delivered', 'cancelled', 'failed'].includes(known.status) ? known.status : null;
}
