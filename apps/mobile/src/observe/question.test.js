import assert from 'node:assert/strict';
import test from 'node:test';

import { attentionTarget } from './attention.js';
import { questionLoad, questionReply } from './question.js';

test('abre la pregunta del intento elegido cuando el host anuncia la capacidad', () => {
  const item = { id: 'att1', category: 'question', target_kind: 'attempt', target_id: 't1-a2', project_id: 'p1' };
  assert.deepEqual(attentionTarget(item, true).route, {
    name: 'question', attentionId: 'att1', attemptId: 't1-a2', projectId: 'p1',
  });
  assert.equal(attentionTarget(item).route.name, 'attempt');
  assert.equal(attentionTarget({ ...item, category: 'approval' }, true).route.name, 'attempt');
});

test('solo usa preguntas del intento exacto y distingue una carga perdida', () => {
  const request = { kind: 'question', request_id: 'q1', asked_at: 23, subject: '¿Sigo?' };
  const result = { ok: true, data: { result: { attempt_id: 't1-a2', task_id: 't1', questions: [
    request, { ...request, kind: 'permission' },
  ] } } };
  assert.deepEqual(questionLoad(result, 't1-a2').data.questions, [request]);
  assert.equal(questionLoad(result, 't1-a1').code, 'stale_question');
  assert.equal(questionLoad({ ok: false, transport: 'offline' }, 't1-a2').code, 'offline');
});

test('un acuse del gateway, un timeout o una respuesta a otro destino no se tratan como éxito', () => {
  const reply = (attempt_id, request_id) => ({ ok: true, data: { result: { status: 'Answered', attempt_id, request_id } } });
  assert.equal(questionReply(reply('t1-a2', 'q1'), 't1-a2', 'q1'), 'answered');
  assert.equal(questionReply(reply('t1-a1', 'q1'), 't1-a2', 'q1'), 'unconfirmed');
  assert.equal(questionReply({ ok: true }, 't1-a2', 'q1'), 'unconfirmed');
  assert.equal(questionReply({ ok: false, transport: 'timeout' }, 't1-a2', 'q1'), 'unconfirmed');
  assert.equal(questionReply({ ok: false, code: 'already_answered' }, 't1-a2', 'q1'), 'already_answered');
});
