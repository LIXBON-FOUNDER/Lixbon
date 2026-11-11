import assert from 'node:assert/strict';
import test from 'node:test';

import { hasValidSeq, reduceRemoteOrchEvent } from './remoteOrchReducer.js';

const SUCIA = 'https://user:SENTINEL_CREDENTIAL@github.com/o/r/pull/7?token=SENTINEL_QUERY#SENTINEL_FRAGMENT';

const task = (over = {}) => ({ id: 't1', run: 'run-1', status: 'running', pr_url: null, ...over });
const snapshot = (over = {}) => ({ enabled: true, runs: [{ id: 'run-1' }], tasks: [task()], messages: [], live: [], ...over });
const previous = () => ({
  hostConnected: true, session: 's-1', meta: { source: 'desktop' }, lastSeq: 5,
  orch: snapshot({ tasks: [task({ id: 'previa', pr_url: 'https://github.com/o/r/pull/1' })] }),
});

test('un orch aceptado sanea la pr_url, avanza el cursor y no muta el evento', () => {
  const ev = { type: 'orch', seq: 6, ...snapshot({ tasks: [task({ pr_url: SUCIA })] }) };
  const next = reduceRemoteOrchEvent(previous(), ev);
  assert.equal(next.lastSeq, 6);
  assert.equal(next.orch.tasks[0].pr_url, 'https://github.com/o/r/pull/7');
  assert.equal(ev.tasks[0].pr_url, SUCIA, 'el evento original no se toca');
  assert.ok(!JSON.stringify(next).includes('SENTINEL_'));
});

test('un channel_status también sanea la snapshot que trae, sin mover lastSeq', () => {
  const next = reduceRemoteOrchEvent(previous(), {
    type: 'channel_status', seq: 99, host_connected: false, session: 's-2', meta: { source: 'x' },
    orch: snapshot({ tasks: [task({ pr_url: SUCIA }), task({ id: 't2', pr_url: 'javascript:alert(1)' })] }),
  });
  assert.equal(next.lastSeq, 5, 'channel_status no avanza el cursor: el replay que viene detrás no es un duplicado');
  assert.deepEqual([next.hostConnected, next.session, next.meta], [false, 's-2', { source: 'x' }]);
  assert.equal(next.orch.tasks[0].pr_url, 'https://github.com/o/r/pull/7');
  assert.equal(next.orch.tasks[1].pr_url, null);
  assert.ok(!JSON.stringify(next).includes('SENTINEL_'));
});

test('un orch con seq repetido o anterior no reemplaza la snapshot ni mueve el cursor', () => {
  const prev = previous();
  for (const seq of [5, 4, 0]) {
    const next = reduceRemoteOrchEvent(prev, { type: 'orch', seq, ...snapshot({ enabled: false, tasks: [task({ id: 'vieja' })] }) });
    assert.strictEqual(next, prev, `seq ${seq}`);
  }
  assert.equal(prev.lastSeq, 5);
  assert.equal(prev.orch.tasks[0].id, 'previa');
});

test('un orch sin seq se aplica sin mover el cursor', () => {
  const next = reduceRemoteOrchEvent(previous(), { type: 'orch', ...snapshot({ tasks: [task({ id: 'sin-seq' })] }) });
  assert.equal(next.orch.tasks[0].id, 'sin-seq');
  assert.equal(next.lastSeq, 5);
});

test('un seq inválido no aplica nada ni envenena el cursor', () => {
  const prev = previous();
  for (const seq of [-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '6', null, {}, []]) {
    assert.strictEqual(reduceRemoteOrchEvent(prev, { type: 'orch', seq, ...snapshot({ enabled: false }) }), prev, String(seq));
    assert.strictEqual(reduceRemoteOrchEvent(prev, { type: 'channel_status', seq, host_connected: false, orch: null }), prev, `status ${String(seq)}`);
  }
  assert.equal(prev.lastSeq, 5);
  assert.equal(prev.orch.enabled, true);
});

test('hasValidSeq: sin seq vale; con seq, un entero seguro no negativo', () => {
  assert.equal(hasValidSeq({ type: 'hello' }), true);
  assert.equal(hasValidSeq({ type: 'hello', seq: undefined }), true);
  for (const seq of [0, 1, 7, Number.MAX_SAFE_INTEGER]) assert.equal(hasValidSeq({ seq }), true, String(seq));
  for (const seq of [-1, 1.5, Number.NaN, Infinity, -Infinity, '3', null, true, {}, []]) assert.equal(hasValidSeq({ seq }), false, String(seq));
});

test('una snapshot que no se puede sanear conserva la anterior y el cursor', () => {
  const prev = previous();
  const malas = [
    { tasks: { 0: { id: 'x', pr_url: SUCIA } }, runs: [] },
    { tasks: [], runs: null },
    { tasks: [task(), 'no soy una task'], runs: [] },
  ];
  for (const mala of malas) {
    assert.strictEqual(reduceRemoteOrchEvent(prev, { type: 'orch', seq: 6, ...mala }), prev, 'orch');
    const status = reduceRemoteOrchEvent(prev, { type: 'channel_status', host_connected: false, session: 's-9', orch: mala });
    assert.strictEqual(status.orch, prev.orch, 'channel_status: la snapshot anterior se conserva');
    assert.equal(status.hostConnected, false, 'pero el estado del host sí se actualiza');
    assert.equal(status.session, 's-9');
    assert.equal(status.lastSeq, 5);
  }
});

test('un channel_status con orch null o ausente no limpia la snapshot', () => {
  const prev = previous();
  for (const ev of [{ type: 'channel_status', host_connected: false, orch: null }, { type: 'channel_status', host_connected: false }]) {
    const next = reduceRemoteOrchEvent(prev, ev);
    assert.strictEqual(next.orch, prev.orch);
    assert.equal(next.hostConnected, false);
  }
});

test('un __proto__ propio en un orch se rechaza sin contaminar ningún prototipo', () => {
  const prev = previous();
  const maliciosa = JSON.parse('{"type":"orch","seq":6,"__proto__":{"polluted":"yes"},"runs":[],"tasks":[]}');
  assert.strictEqual(reduceRemoteOrchEvent(prev, maliciosa), prev);
  assert.equal(Object.prototype.polluted, undefined);
});

test('otro tipo de evento no lo toca este reducer', () => {
  const prev = previous();
  assert.strictEqual(reduceRemoteOrchEvent(prev, { type: 'orch_diff', seq: 6, task: 't1' }), prev);
});
