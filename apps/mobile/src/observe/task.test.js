// Pruebas del Task Detail de Supervisar (LXO-110): `npm test` (node --test).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ACTIVITY_V1_MESSAGE_KEYS } from './activityMessages.js';
import { RELAY_PROTOCOL, createCoreLink } from './link.js';
import { activityLine, activityReducer, initialActivity, isFinal, snapshotTask, statusOf, taskModel, taskNotice } from './task.js';

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = {
  projects: { items: [{ id: 'p1', name: 'lixbon' }] },
  active_tasks: { items: [{ id: 't1', project_id: 'p1', run_id: 'r1', parent_id: null, root_id: 't1', status: 'running', title: 'Raíz', provider: 'claude', origin: 'external', updated_at: 5 }] },
  attention: { items: [] },
};
const detail = (over = {}) => ({
  id: 't2', project_id: 'p1', run_id: 'r1', parent_id: 't1', root_id: 't1', child_ids: [], status: 'running', title: 'Hija', provider: 'codex', model: 'gpt-5',
  branch: 'lxo/t2', worktree: 'C:/r/wt/2', location: 'C:/r/wt/2', created_at: 1, updated_at: 2, phase: { done: false, at: 3 }, pending_questions: 0,
  merged: false, review: null, integration: null, ...over,
});

describe('1 · fixtures root / child / final / failed', () => {
  it('raíz desde la snapshot: lo que no se sabe queda desconocido', () => {
    const m = taskModel({ taskId: 't1', snapItem: snapshotTask(snapshot, 't1'), snapshot });
    assert.equal(m.source, 'snapshot');
    assert.equal(m.isRoot, true);
    assert.equal(m.projectName, 'lixbon');
    assert.equal(m.provider, 'Claude Code');
    assert.equal(m.origin, 'external');
    for (const k of ['model', 'branch', 'location', 'sharedCheckout', 'children', 'host']) assert.equal(m[k], null, `${k} no se inventa`);
  });

  it('hija con worktree desde el detalle', () => {
    const m = taskModel({ taskId: 't2', detail: detail(), snapshot });
    assert.equal(m.source, 'detail');
    assert.equal(m.isRoot, false);
    assert.equal(m.parentId, 't1');
    assert.equal(m.sharedCheckout, false);
    assert.equal(m.location, 'C:/r/wt/2');
    assert.equal(m.model, 'gpt-5');
    assert.equal(m.phase, 'Fase en curso');
    assert.equal(m.host, null, 'el modelo legacy no registra host');
    assert.equal(m.origin, null, 'sin fila de snapshot no se sabe el origen');
    assert.equal(taskModel({ taskId: 't2', detail: detail({ worktree: null, location: 'C:/r/api' }), snapshot }).sharedCheckout, true);
  });

  it('final y fallida', () => {
    const done = taskModel({ taskId: 't2', detail: detail({ status: 'done', merged: true, review: { decision: 'accepted', at: 4 } }), snapshot });
    assert.equal(done.final, true);
    assert.deepEqual(done.flags.map((f) => f.text), ['Revisión aceptada', 'Integrada']);
    const failed = taskModel({ taskId: 't2', detail: detail({ status: 'failed' }), snapshot });
    assert.equal(failed.statusMeta.tone, 'error', 'solo «falló» usa el tono de fallo');
    assert.equal(failed.final, true);
    assert.equal(isFinal('waiting'), false);
    assert.equal(statusOf('waiting').tone, 'warn');
    assert.equal(statusOf('nuevo_estado').label, 'nuevo_estado');
  });

  it('señales de pregunta, revisión e integración', () => {
    const m = taskModel({ taskId: 't2', detail: detail({ pending_questions: 2, review: { decision: 'rejected' }, integration: { outcome: 'conflict' } }), snapshot });
    assert.deepEqual(m.flags.map((f) => f.text), ['Tiene 2 preguntas sin responder', 'Revisión rechazada', 'Integración con conflictos']);
  });
});

describe('2 · stale, offline y no encontrada', () => {
  it('Task desaparecida: no encontrada, sin romper', () => {
    const m = taskModel({ taskId: 'x', snapshot, missing: true });
    assert.equal(m.source, 'none');
    assert.match(taskNotice(m, { online: true }).text, /ya no está en el Core/);
  });

  it('sin datos y sin conexión se dice', () => {
    const m = taskModel({ taskId: 'x', snapshot });
    assert.match(taskNotice(m, { online: false }).text, /hasta que vuelva la conexión/);
    assert.match(taskNotice(m, { online: true }).text, /Cargando/);
  });

  it('solo la fila de la snapshot: resumen marcado', () => {
    const m = taskModel({ taskId: 't1', snapItem: snapshotTask(snapshot, 't1'), snapshot });
    assert.match(taskNotice(m, { online: false }).text, /resumen guardado/);
    const loose = taskModel({ taskId: 'u', snapItem: { id: 'u', project_id: null, status: 'running', title: 'Suelta' }, snapshot });
    assert.match(taskNotice(loose, { online: true }).text, /no tiene proyecto/);
  });

  it('detalle viejo tras un fallo: aviso', () => {
    const m = taskModel({ taskId: 't2', detail: detail(), snapshot });
    assert.equal(taskNotice(m, { online: true, error: null }), null);
    assert.match(taskNotice(m, { online: true, error: 'timeout' }).text, /último detalle/);
  });
});

describe('3 · Activity paginable', () => {
  const item = (seq, key = 'activity.task.running', args = { from: 'starting', to: 'running' }) => ({ seq, ts: seq * 1000, message_key: key, args, visual: 'info' });

  it('lo último primero, más páginas sin repetir y cursor al seq más bajo', () => {
    let s = activityReducer(initialActivity, { type: 'page', items: [item(9), item(8)], cursor: 8, hasMore: true });
    assert.deepEqual(s.items.map((i) => i.seq), [9, 8]);
    assert.equal(s.cursor, 8);
    s = activityReducer(s, { type: 'page', append: true, items: [item(8), item(7), item(6)], cursor: 6, hasMore: false });
    assert.deepEqual(s.items.map((i) => i.seq), [9, 8, 7, 6]);
    assert.equal(s.hasMore, false);
    const failed = activityReducer(s, { type: 'fail', code: 'timeout' });
    assert.equal(failed.items.length, 4, 'un fallo conserva lo visto');
  });

  it('cada línea se traduce con el vocabulario de Activity', () => {
    const line = activityLine(item(1, 'activity.task.failed', { from: 'running', to: 'failed', cause: 'agent_idle_timeout' }));
    assert.equal(line.known, true);
    assert.ok(line.text.length > 0);
    const odd = activityLine({ seq: 2, message_key: 'activity.del.futuro', args: {}, visual: 'raro' });
    assert.equal(odd.known, false);
    assert.equal(odd.visual, 'info');
    assert.match(odd.text, /no sabe describirlo/);
  });

  it('la copia del traductor es idéntica a la de Desktop', () => {
    const desktop = readFileSync(join(here, '../../../desktop/src/ade/activityMessages.js'), 'utf8').replace(/\r\n/g, '\n');
    const mobile = readFileSync(join(here, 'activityMessages.js'), 'utf8').replace(/\r\n/g, '\n');
    const body = mobile.split('\n').slice(5).join('\n');
    assert.equal(body, desktop, 'al cambiar apps/desktop/src/ade/activityMessages.js, copiarlo aquí en el mismo PR');
    assert.ok(ACTIVITY_V1_MESSAGE_KEYS.includes('activity.task.failed'));
  });
});

describe('4 · relé', () => {
  for (const [action, type, payload] of [
    ['core_task', 'orch_core_task', { task: detail() }],
    ['core_activity', 'orch_core_activity', { items: [], next_cursor: 0, has_more: false }],
  ]) {
    it(`${action} se empareja por rid`, async () => {
      const link = createCoreLink({ send: async () => ({ ok: true }), newRid: () => 'k1' });
      const p = link.request(action, { task_id: 't2' });
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(link.handleEvent({ type, rid: 'k1', ok: true, protocol: RELAY_PROTOCOL, ...payload }), true);
      assert.equal((await p).ok, true);
    });
  }
});
