// El `remoteReducer` real de web con los dos canales que reemplazan la snapshot del orquestador (LXO-243): comprueba la conexión
// de `remoteOrchReducer.js` en `remote.js`, no solo el reducer puro. La app móvil tiene el mismo cableado en
// `apps/mobile/src/remote.js` (importa `react-native`, así que no se puede ejecutar aquí).
import assert from 'node:assert/strict';
import test from 'node:test';

import { initialRemoteState, remoteReducer } from './remote.js';

const SUCIA = 'https://user:SENTINEL_CREDENTIAL@github.com/o/r/pull/7?token=SENTINEL_QUERY';
const snap = (id, pr) => ({ runs: [{ id: 'r1' }], tasks: [{ id, run: 'r1', status: 'done', pr_url: pr }], messages: [], live: [] });
const aplica = (...eventos) => eventos.reduce(remoteReducer, initialRemoteState);

test('un orch con pr_url sucia llega saneado a la UI', () => {
  const s = aplica({ type: 'orch', seq: 1, ...snap('t1', SUCIA) });
  assert.equal(s.orch.tasks[0].pr_url, 'https://github.com/o/r/pull/7');
  assert.ok(!JSON.stringify(s.orch).includes('SENTINEL_'));
  assert.equal(s.lastSeq, 1);
});

test('un channel_status con pr_url sucia o peligrosa llega saneado, y no mueve lastSeq', () => {
  const s = aplica({ type: 'orch', seq: 3, ...snap('t1', null) }, { type: 'channel_status', seq: 50, host_connected: true, orch: snap('t2', 'javascript:alert(1)') });
  assert.equal(s.lastSeq, 3);
  assert.equal(s.hostConnected, true);
  assert.equal(s.orch.tasks[0].id, 't2');
  assert.equal(s.orch.tasks[0].pr_url, null);
});

test('un orch repetido o anterior no reemplaza la snapshot', () => {
  const s = aplica({ type: 'orch', seq: 5, ...snap('nueva', null) }, { type: 'orch', seq: 5, ...snap('repetida', null) }, { type: 'orch', seq: 2, ...snap('vieja', null) });
  assert.equal(s.orch.tasks[0].id, 'nueva');
  assert.equal(s.lastSeq, 5);
});

test('un seq NaN, Infinity o negativo no envenena el cursor: lo que viene después se sigue aplicando', () => {
  let s = aplica({ type: 'orch', seq: 1, ...snap('a', null) });
  for (const seq of [Number.NaN, Infinity, -1, 1.5, '9']) {
    const despues = remoteReducer(s, { type: 'orch', seq, ...snap('mala', null) });
    assert.strictEqual(despues, s, String(seq));
  }
  s = remoteReducer(s, { type: 'orch', seq: 2, ...snap('b', null) });
  assert.equal(s.orch.tasks[0].id, 'b', 'el cursor sigue sano');
  assert.equal(s.lastSeq, 2);
});

test('un evento numerado que no es orch sigue avanzando el cursor y descartando duplicados (sin regresión)', () => {
  const s = aplica({ type: 'orch_agents', seq: 4, agents: ['claude'] }, { type: 'orch_agents', seq: 4, agents: ['otro'] }, { type: 'orch_agents', seq: 3, agents: ['viejo'] });
  assert.deepEqual(s.orchAgents, ['claude']);
  assert.equal(s.lastSeq, 4);
  assert.equal(remoteReducer(s, { type: 'orch_agents', seq: Infinity, agents: [] }), s, 'un seq inválido tampoco lo pisa');
});
