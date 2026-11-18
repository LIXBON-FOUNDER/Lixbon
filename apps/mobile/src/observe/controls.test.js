import test from 'node:test';
import assert from 'node:assert/strict';
import { controlReady, controlOutcome, recoverQueue } from './controls.js';

test('controls require exact Attempt, Core capability and non elevated policy', () => {
  const data = { attempt_id: 't1-a1', queue_control: { allowed: true, policy: 'confirm' } };
  assert.equal(controlReady(data, 't1-a1', 'queue'), true);
  assert.equal(controlReady(data, 't1-a2', 'queue'), false);
  for (const policy of ['deny', 'elevated', undefined]) assert.equal(controlReady({ ...data, queue_control: { allowed: true, policy } }, 't1-a1', 'queue'), false);
  assert.equal(controlReady({ ...data, queue_control: { allowed: false, policy: 'allow' } }, 't1-a1', 'queue'), false);
});
test('transport ACK or mismatched target cannot confirm a Queue, cancellation or Stop', () => {
  for (const kind of ['queue', 'cancel', 'stop']) {
    assert.equal(controlOutcome({ ok: true }, 't1-a1', { kind }), 'unconfirmed');
    assert.equal(controlOutcome({ ok: false, code: 'timeout' }, 't1-a1', { kind }), 'timeout');
    assert.equal(controlOutcome({ ok: true, data: { result: { attempt_id: 't1-a2', status: 'Stopped' } } }, 't1-a1', { kind }), 'unconfirmed');
  }
  assert.equal(controlOutcome({ ok: true, data: { result: { attempt_id: 't1-a1', status: 'Replayed', queue_id: 'q1' } } }, 't1-a1', { kind: 'queue' }), 'queued');
  assert.equal(controlOutcome({ ok: true, data: { result: { attempt_id: 't1-a1', status: 'Cancelled', queue_id: 'q2' } } }, 't1-a1', { kind: 'cancel', queue_id: 'q1' }), 'unconfirmed');
  assert.equal(controlOutcome({ ok: true, data: { result: { attempt_id: 't1-a1', status: 'Stopped' } } }, 't1-a1', { kind: 'stop' }), 'stopped');
});
test('lost Queue response is reconciled by the same business request without resending', () => {
  const pending = { request_id: 'business-1', body: 'texto original' };
  assert.equal(recoverQueue({ request_status: { request_id: 'other', queue_id: 'q', status: 'queued' } }, pending), null);
  for (const status of ['queued', 'delivered', 'failed', 'cancelled']) assert.equal(recoverQueue({ request_status: { request_id: 'business-1', queue_id: 'q', status } }, pending), status);
});
