import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { PR_URL_MAX_LEN, sanitizeOrchSnapshot, sanitizePrUrl } from './remotePrUrl.js';

// Los vectores son los del Core y los de lxo: una sola fuente (LXO-243).
const vectors = JSON.parse(readFileSync(new URL('../../../../docs/core/fixtures/pr_url_allowlist.v1.json', import.meta.url), 'utf8'));

test('la allowlist del cliente es la del Core: conserva y limpia lo que el fixture dice', () => {
  assert.equal(PR_URL_MAX_LEN, vectors.max_len);
  assert.ok(vectors.keep.length >= 8);
  for (const { raw, clean } of vectors.keep) assert.equal(sanitizePrUrl(raw), clean, JSON.stringify(raw));
});

test('la allowlist del cliente es la del Core: rechaza lo que el fixture dice', () => {
  assert.ok(vectors.reject.length >= 25);
  for (const raw of vectors.reject) assert.equal(sanitizePrUrl(raw), null, JSON.stringify(raw));
  for (const g of vectors.reject_generated) assert.equal(sanitizePrUrl(g.prefix + g.fill.repeat(g.count)), null, g.why);
});

test('los casos de la aceptación de LXO-243, uno a uno', () => {
  assert.equal(sanitizePrUrl('javascript:alert(1)'), null, 'javascript:');
  assert.equal(sanitizePrUrl('javascript://github.com/o/r/pull/1'), null, 'javascript:// con host');
  assert.equal(sanitizePrUrl('https://bot:SENTINEL@github.com/o/r/pull/1'), 'https://github.com/o/r/pull/1', 'credenciales fuera');
  assert.equal(sanitizePrUrl('https://github.com/o/../pull/1'), null, '..');
  assert.equal(sanitizePrUrl('https://github.com:99999999/o/r/pull/1'), null, 'puerto inválido');
  assert.equal(sanitizePrUrl(`https://github.com/${'a'.repeat(300)}`), null, 'más de 300');
  assert.equal(sanitizePrUrl(`https://github.com/${'a'.repeat(PR_URL_MAX_LEN - 'https://github.com/'.length)}`)?.length, PR_URL_MAX_LEN, 'justo 300 sí');
});

test('lo que no es un texto se descarta', () => {
  for (const raw of [null, undefined, 7, {}, [], true]) assert.equal(sanitizePrUrl(raw), null);
});

test('sanitizeOrchSnapshot sanea la pr_url de cada Task, sin mutar y sin tocar lo demás', () => {
  const sucia = 'https://bot:SENTINEL@github.com/o/r/pull/1?token=SENTINEL';
  const entrada = {
    type: 'orch', seq: 4, runs: [{ id: 'r1' }],
    tasks: [
      { id: 't1', pr_url: sucia, status: 'done' },
      { id: 't2', pr_url: 'javascript:alert(1)' },
      { id: 't3', pr_url: null },
      { id: 't4' },
    ],
  };
  const copia = JSON.parse(JSON.stringify(entrada));
  const salida = sanitizeOrchSnapshot(entrada);
  assert.deepEqual(entrada, copia, 'no muta la entrada');
  assert.equal(salida.tasks[0].pr_url, 'https://github.com/o/r/pull/1');
  assert.equal(salida.tasks[1].pr_url, null);
  assert.equal(salida.tasks[2].pr_url, null);
  assert.equal(Object.prototype.hasOwnProperty.call(salida.tasks[3], 'pr_url'), false, 'una Task sin pr_url no gana el campo');
  assert.deepEqual({ type: salida.type, seq: salida.seq, runs: salida.runs, status: salida.tasks[0].status }, { type: 'orch', seq: 4, runs: [{ id: 'r1' }], status: 'done' });
  assert.ok(!JSON.stringify(salida).includes('SENTINEL'));
});

test('una snapshot sin la forma que se puede sanear no se acepta a medias', () => {
  const sucia = 'https://bot:SENTINEL@github.com/o/r/pull/1?token=SENTINEL';
  for (const x of [null, undefined, 'x', 3, []]) assert.equal(sanitizeOrchSnapshot(x), null, 'ni es un objeto');
  assert.equal(sanitizeOrchSnapshot({ runs: [] }), null, 'sin tasks');
  assert.equal(sanitizeOrchSnapshot({ tasks: [] }), null, 'sin runs');
  assert.equal(sanitizeOrchSnapshot({ runs: null, tasks: [] }), null, 'runs null');
  assert.equal(sanitizeOrchSnapshot({ runs: [], tasks: { 0: { id: 'x', pr_url: sucia } } }), null, 'tasks como objeto: su pr_url no se recorrería');
  assert.equal(sanitizeOrchSnapshot({ runs: [], tasks: [{ id: 'ok' }, 'no soy una task'] }), null, 'una Task que no es objeto');
  assert.deepEqual(sanitizeOrchSnapshot({ runs: [], tasks: [] }), { runs: [], tasks: [] }, 'la vacía y bien formada sí');
});

test('un __proto__ propio no se acepta ni contamina ningún prototipo', () => {
  const maliciosa = JSON.parse('{"runs":[],"__proto__":{"polluted":"yes"},"tasks":[]}');
  assert.equal(Object.prototype.hasOwnProperty.call(maliciosa, '__proto__'), true);
  assert.equal(sanitizeOrchSnapshot(maliciosa), null);
  const taskMaliciosa = JSON.parse('{"runs":[],"tasks":[{"id":"bad","__proto__":{"polluted":"yes"}}]}');
  assert.equal(sanitizeOrchSnapshot(taskMaliciosa), null);
  assert.equal(Object.prototype.polluted, undefined);
});
