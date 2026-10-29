// Pruebas de los intentos de una Task en Supervisar (LXO-126): `npm test` (node --test).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ATTEMPT_STATUS,
  attemptA11y,
  attemptFilterOptions,
  attemptResult,
  attemptsModel,
  attemptsNotice,
  createAttemptsMemory,
} from './attempts.js';
import { attentionTarget } from './attention.js';
import { RELAY_PROTOCOL, createCoreLink } from './link.js';

const NOW = 1_800_000_000_000;
const attempt = (n, status, over = {}) => ({
  id: `t1-a${n}`, task_id: 't1', n, status, provider: 'codex', model: 'gpt-5', role: null, origin: 'lixbon',
  created_at: NOW - (10 - n) * 60_000, started_at: NOW - (10 - n) * 60_000 + 1000, ended_at: ['done', 'failed', 'stopped', 'exited'].includes(status) ? NOW - (10 - n) * 60_000 + 5000 : null,
  failure_reason: null, integrated: null, has_summary: null, host: null, ...over,
});
const data = (attempts, over = {}) => ({
  task: { id: 't1', title: 'API', state: 'in_progress', attempt_count: attempts.length, current_attempt_id: attempts.at(-1)?.id ?? null, ...over },
  attempts,
  truncated: false,
});
const ids = (m) => m.items.map((i) => i.id);

describe('0 / 1 / N intentos', () => {
  it('sin intentos: la tarea no se ha lanzado', () => {
    const m = attemptsModel({ data: data([], { state: 'open', current_attempt_id: null }) });
    assert.equal(m.empty, true);
    assert.equal(m.count, 0);
    assert.equal(m.taskState, 'Abierta');
    assert.equal(m.relevantId, null);
  });

  it('uno: es el actual y el relevante', () => {
    const m = attemptsModel({ data: data([attempt(1, 'running')]) });
    assert.deepEqual(ids(m), ['t1-a1']);
    assert.equal(m.items[0].current, true);
    assert.equal(m.relevantId, 't1-a1');
    assert.equal(m.items[0].statusMeta.label, 'Trabajando');
  });

  it('N: el actual primero y la historia debajo, del más nuevo al más viejo', () => {
    const m = attemptsModel({ data: data([attempt(1, 'failed'), attempt(2, 'stopped'), attempt(3, 'running')]) });
    assert.deepEqual(ids(m), ['t1-a3', 't1-a2', 't1-a1']);
    assert.deepEqual(m.counts, { all: 3, active: 1, final: 2 });
    assert.equal(m.items.filter((i) => i.current).length, 1, 'un solo actual, el que nombra la Task');
  });

  it('el actual es el que nombra la Task, no el de n más alto', () => {
    const m = attemptsModel({ data: data([attempt(1, 'done'), attempt(2, 'pending_approval')], { current_attempt_id: 't1-a1' }) });
    assert.equal(m.relevantId, 't1-a1');
    assert.deepEqual(ids(m), ['t1-a1', 't1-a2']);
  });

  it('cuenta los de la Task aunque el relé traiga solo los últimos', () => {
    const m = attemptsModel({ data: { ...data([attempt(24, 'running')], { attempt_count: 24 }), truncated: true } });
    assert.equal(m.count, 24);
    assert.equal(m.truncated, true);
  });
});

describe('múltiples proveedores y estados', () => {
  it('cada estado del vocabulario tiene su etiqueta y su tono', () => {
    for (const code of ['pending_approval', 'starting', 'running', 'waiting', 'awaiting_terminal_approval', 'done', 'failed', 'stopped', 'exited']) {
      assert.ok(ATTEMPT_STATUS[code]?.label, code);
    }
    const m = attemptsModel({ data: data([attempt(1, 'weird_state')]) });
    assert.equal(m.items[0].statusMeta.label, 'weird_state', 'un estado nuevo se enseña tal cual, sin romper');
  });

  it('el resultado se lee de cada intento', () => {
    assert.equal(attemptResult(attempt(1, 'done', { integrated: true })).text, 'Integrado');
    assert.equal(attemptResult(attempt(1, 'done', { integrated: false, has_summary: true })).text, 'Terminó con resumen; sin integrar');
    assert.equal(attemptResult(attempt(1, 'done')).text, 'Terminó');
    assert.equal(attemptResult(attempt(1, 'failed', { failure_reason: 'agent_idle_timeout' })).text, 'Falló: el agente dejó de dar señales');
    assert.equal(attemptResult(attempt(1, 'failed', { failure_reason: 'otra_cosa' })).text, 'Falló: motivo desconocido');
    assert.equal(attemptResult(attempt(1, 'stopped')).text, 'Se detuvo');
    assert.equal(attemptResult(attempt(1, 'running')), null);
  });

  it('proveedores distintos y uno desconocido', () => {
    const m = attemptsModel({ data: data([attempt(1, 'failed', { provider: 'claude' }), attempt(2, 'done', { provider: 'codex' }), attempt(3, 'running', { provider: null })]) });
    assert.deepEqual(m.items.map((i) => i.provider), ['agente desconocido', 'Codex', 'Claude Code']);
  });

  it('el filtro separa en curso y terminados sin perder el relevante', () => {
    const d = data([attempt(1, 'failed'), attempt(2, 'done'), attempt(3, 'running')]);
    assert.deepEqual(ids(attemptsModel({ data: d, filter: 'active' })), ['t1-a3']);
    assert.deepEqual(ids(attemptsModel({ data: d, filter: 'final' })), ['t1-a2', 't1-a1']);
    assert.deepEqual(attemptFilterOptions({ all: 3, active: 1, final: 2 }).map((o) => o.label), ['Todos · 3', 'En curso · 1', 'Terminados · 2']);
  });
});

describe('Attention sobre un intento concreto', () => {
  const attention = [
    { id: 'att-1', category: 'failed', severity: 'high', target_kind: 'attempt', target_id: 't1-a1', project_id: 'p1' },
    { id: 'att-2', category: 'question', severity: 'medium', target_kind: 'attempt', target_id: 't9-a1', project_id: 'p1' },
    { id: 'att-3', category: 'review_ready', severity: 'low', target_kind: 'task', target_id: 't1', project_id: 'p1' },
  ];

  it('el intento que pide atención va primero, aunque no sea el actual', () => {
    const m = attemptsModel({ data: data([attempt(1, 'failed'), attempt(2, 'running')]), attention });
    assert.equal(m.relevantId, 't1-a1');
    assert.deepEqual(ids(m), ['t1-a1', 't1-a2']);
    assert.deepEqual(m.items[0].attention.map((a) => a.id), ['att-1'], 'solo la suya: ni la de otra tarea ni la de la Task');
    assert.deepEqual(m.items[1].attention, []);
    assert.equal(m.flaggedCount, 1);
  });

  it('con varios, el más grave', () => {
    const more = [...attention, { id: 'att-4', category: 'approval', severity: 'critical', target_kind: 'attempt', target_id: 't1-a2' }];
    assert.equal(attemptsModel({ data: data([attempt(1, 'failed'), attempt(2, 'pending_approval')]), attention: more }).relevantId, 't1-a2');
  });

  it('desde la bandeja, abre ese intento y no «el último» de su tarea', () => {
    assert.deepEqual(attentionTarget(attention[0]).route, { name: 'attempt', attemptId: 't1-a1', projectId: 'p1' });
    assert.equal(attentionTarget(attention[2]).route.name, 'task');
  });
});

describe('host y origen', () => {
  it('si no cambian, van una vez en el resumen', () => {
    const m = attemptsModel({ data: data([attempt(1, 'failed', { host: 'torre' }), attempt(2, 'running', { host: 'torre' })]) });
    assert.equal(m.showPlace, false);
    assert.deepEqual(m.sharedPlace, { host: 'torre', origin: 'lixbon' });
  });

  it('si cambian, en cada fila; el desconocido se dice', () => {
    const m = attemptsModel({ data: data([attempt(1, 'failed', { host: 'torre' }), attempt(2, 'running', { host: null, origin: 'external' })]) });
    assert.equal(m.showPlace, true);
    assert.equal(m.sharedPlace, null);
    const a11y = attemptA11y(m.items[0], NOW, true);
    assert.match(a11y, /host desconocido, Coordinador externo/);
    assert.match(attemptA11y(m.items[1], NOW, true), /en torre, Lanzado por Lixbon/);
  });
});

describe('stale / offline', () => {
  it('sin datos, sin conexión: lo dice; con datos viejos: desactualizado con su edad', () => {
    assert.match(attemptsNotice({ data: null, online: false, now: NOW }).text, /hasta que vuelva la conexión/);
    assert.match(attemptsNotice({ data: null, online: true, now: NOW }).text, /Cargando/);
    const n = attemptsNotice({ data: data([]), stale: true, at: NOW - 5 * 60_000, now: NOW, online: false });
    assert.equal(n.tone, 'warn');
    assert.match(n.text, /Desactualizado: son los intentos de hace 5 min/);
    assert.equal(attemptsNotice({ data: data([]), stale: false, now: NOW, online: true }), null);
  });

  it('la memoria guarda lo último por tarea, con tope', () => {
    const mem = createAttemptsMemory(2);
    mem.remember('a', { at: 1 });
    mem.remember('b', { at: 2 });
    mem.remember('c', { at: 3 });
    assert.equal(mem.recall('a'), null, 'el más viejo sale');
    assert.deepEqual(mem.recall('c'), { at: 3 });
  });
});

describe('accesibilidad', () => {
  it('cada fila se lee entera: número, actual, proveedor, estado, edad, resultado y atención', () => {
    const m = attemptsModel({
      data: data([attempt(1, 'failed', { failure_reason: 'launch_failed' }), attempt(2, 'running')]),
      attention: [{ id: 'x', category: 'failed', severity: 'high', target_kind: 'attempt', target_id: 't1-a1' }],
    });
    assert.equal(attemptA11y(m.items[0], NOW, false), 'Intento 1, Codex, Falló, hace 9 min, Falló: no llegó a arrancar, pide atención');
    assert.equal(attemptA11y(m.items[1], NOW, false), 'Intento 2, actual, Codex, Trabajando, hace 8 min');
  });
});

describe('relé: core_attempts y core_attempt', () => {
  const link = (rids) => {
    const sent = [];
    const l = createCoreLink({ send: async (cmd) => (sent.push(cmd), { ok: true }), newRid: () => rids.shift() });
    return { l, sent };
  };

  it('empareja las respuestas por rid', async () => {
    const { l, sent } = link(['r1', 'r2']);
    const list = l.request('core_attempts', { task_id: 't1' });
    const one = l.request('core_attempt', { attempt_id: 't1-a1' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(l.handleEvent({ type: 'orch_core_attempts', rid: 'r1', ok: true, protocol: RELAY_PROTOCOL, task: { id: 't1' }, attempts: [] }), true);
    assert.equal(l.handleEvent({ type: 'orch_core_attempt', rid: 'r2', ok: false, code: 'model_not_found', protocol: RELAY_PROTOCOL }), true);
    assert.equal((await list).ok, true);
    assert.deepEqual(await one, { ok: false, code: 'model_not_found' });
    assert.deepEqual(sent.map((c) => c.action), ['core_attempts', 'core_attempt']);
  });

  it('un IDE anterior responde «no soportada»: la pantalla sigue como antes', async () => {
    const { l } = link(['r3']);
    const list = l.request('core_attempts', { task_id: 't1' });
    await new Promise((r) => setTimeout(r, 0));
    l.handleEvent({ type: 'orch_error', action: 'core_attempts', message: 'Acción no soportada.' });
    assert.deepEqual(await list, { ok: false, code: 'unsupported_action' });
  });
});
