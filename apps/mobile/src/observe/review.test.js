import assert from 'node:assert/strict';
import test from 'node:test';
import { attentionTarget } from './attention.js';
import { reviewOutcome, reviewReady } from './review.js';

const head = 'a'.repeat(40);
const ready = () => ({ attempt_id: 't1-a1', review_id: 'r1', can_decide: true, policy: 'confirm', diff: { readable: true, files: [] },
  proof: { revision: { head_commit: { value: head, provenance: 'verified' } }, decision: { can_decide: true, head_commit: head } } });
test('Review Ready abre su Task o Attempt exacto solo con la capability del host', () => {
  const item = { id: 'r1', target_kind: 'task', target_id: 't1', category: 'review_ready' };
  assert.equal(attentionTarget(item).route.name, 'task');
  assert.deepEqual(attentionTarget(item, false, false, true).route, { name: 'review', attentionId: 'r1', taskId: 't1', projectId: null });
  assert.equal(attentionTarget({ ...item, target_kind: 'attempt', target_id: 't1-a1' }, false, false, true).route.attemptId, 't1-a1');
});
test('solo una revisión verificada, íntegra, sobre el destino exacto permite decidir', () => {
  assert.equal(reviewReady(ready(), 't1-a1', 'r1'), true);
  for (const change of [
    (d) => { d.proof.revision.head_commit.provenance = 'agent_reported'; },
    (d) => { d.proof.decision.head_commit = 'b'.repeat(40); },
    (d) => { d.diff.readable = false; },
    (d) => { d.proof.changes = { mobile_truncated: true }; },
    (d) => { d.policy = 'elevated'; },
    (d) => { d.attempt_id = 't1-a2'; },
  ]) { const d = ready(); change(d); assert.equal(reviewReady(d, 't1-a1', 'r1'), false); }
});
test('un ACK, una revisión distinta o pérdida de confirmación nunca son éxito', () => {
  const response = (overrides = {}) => ({ ok: true, data: { result: { outcome: 'recorded', attempt_id: 't1-a1', head_commit: head, decision: 'accepted', ...overrides } } });
  assert.equal(reviewOutcome(response(), 't1-a1', head, 'accepted'), 'accepted');
  assert.equal(reviewOutcome(response({ head_commit: 'b'.repeat(40) }), 't1-a1', head, 'accepted'), 'unconfirmed');
  assert.equal(reviewOutcome({ ok: false, code: 'head_moved' }, 't1-a1', head, 'accepted'), 'head_moved');
  assert.equal(reviewOutcome({ ok: true }, 't1-a1', head, 'accepted'), 'unconfirmed');
});
