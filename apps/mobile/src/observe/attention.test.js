// Pruebas de la bandeja de Attention de Supervisar (LXO-109): `npm test` (node --test).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CATEGORIES,
  EMPTY_FILTERS,
  SEVERITIES,
  ageText,
  attentionA11y,
  attentionTarget,
  categoryOf,
  groupByProject,
  initialList,
  listNotice,
  listReducer,
  projectLabel,
  projectNames,
  queryOf,
  severityOf,
} from './attention.js';
import { RELAY_PROTOCOL, createCoreLink } from './link.js';

const NOW = 50_000_000;
const item = (id, over = {}) => ({ id, category: 'question', severity: 'high', status: 'active', target_kind: 'task', target_id: `t-${id}`, project_id: 'p1', run_id: 'r1', occurrence: 1, created_at: NOW - 5 * 60_000, ...over });
const names = { p1: 'lixbon', p2: 'docs' };

describe('1 · categorías y severidad vienen del Core', () => {
  it('las siete categorías iniciales tienen nombre e icono', () => {
    assert.deepEqual(CATEGORIES, ['question', 'approval', 'review_ready', 'conflict', 'failed', 'environment_blocked', 'risk']);
    for (const k of CATEGORIES) {
      assert.ok(categoryOf(k).label && categoryOf(k).label !== k, k);
      assert.ok(categoryOf(k).icon, k);
    }
  });

  it('una categoría nueva del Core se ve con su código, sin romper', () => {
    assert.deepEqual(categoryOf('budget_exceeded'), { label: 'budget_exceeded', icon: 'bell' });
    assert.equal(severityOf('extreme').label, 'extreme');
  });

  it('solo la severidad crítica usa el tono de fallo', () => {
    assert.deepEqual(SEVERITIES, ['critical', 'high', 'medium', 'low']);
    assert.equal(severityOf('critical').tone, 'error');
    assert.equal(severityOf('high').tone, 'warn');
    assert.equal(severityOf('low').tone, 'muted');
  });
});

describe('2 · destino y navegación', () => {
  it('una Attention de Task abre su detalle por ids durables', () => {
    assert.deepEqual(attentionTarget(item('a')), { navigable: true, label: 'Tarea', route: { name: 'task', taskId: 't-a', projectId: 'p1' } });
    assert.equal(attentionTarget(item('b', { project_id: null })).route.projectId, null);
  });

  it('los demás destinos se describen sin navegar', () => {
    for (const kind of ['project', 'run', 'spawn_request', 'worktree', 'algo_nuevo']) {
      const t = attentionTarget(item('x', { target_kind: kind }));
      assert.equal(t.navigable, false, kind);
      assert.equal(t.route, null);
      assert.ok(t.label);
    }
    assert.equal(attentionTarget(item('y', { target_id: null })).navigable, false, 'sin id no hay adónde ir');
  });

  it('abrir no pide nada al Core: la consulta solo lleva filtros y cursor', () => {
    assert.deepEqual(queryOf(EMPTY_FILTERS), {});
    assert.deepEqual(queryOf({ project_id: 'p1', category: 'failed', severity: null }, 'cur'), { project_id: 'p1', category: 'failed', cursor: 'cur' });
  });
});

describe('3 · agrupación, edad y texto', () => {
  it('agrupa por Project conservando el orden del Core', () => {
    const items = [item('a'), item('b', { project_id: 'p2' }), item('c'), item('d', { project_id: null }), item('e', { project_id: 'p9' })];
    const groups = groupByProject(items, names);
    assert.deepEqual(groups.map((g) => [g.name, g.items.map((i) => i.id)]), [
      ['lixbon', ['a', 'c']],
      ['docs', ['b']],
      ['Sin proyecto', ['d']],
      ['Proyecto p9', ['e']],
    ]);
  });

  it('nombres de Project desde la snapshot', () => {
    assert.deepEqual(projectNames({ projects: { items: [{ id: 'p1', name: 'lixbon' }] } }), { p1: 'lixbon' });
    assert.equal(projectLabel('abcdefghijk', {}), 'Proyecto abcdefgh');
  });

  it('edad en palabras', () => {
    assert.equal(ageText(NOW, NOW), 'ahora');
    assert.equal(ageText(NOW - 5 * 60_000, NOW), 'hace 5 min');
    assert.equal(ageText(NOW - 3 * 3600_000, NOW), 'hace 3 h');
    assert.equal(ageText(NOW - 2 * 86400_000, NOW), 'hace 2 días');
  });

  it('lector de pantalla: categoría, severidad, destino, edad y acción', () => {
    assert.equal(attentionA11y(item('a'), names, NOW), 'Pregunta, severidad alta, Tarea en lixbon, hace 5 min, abre la tarea');
    assert.equal(attentionA11y(item('b', { target_kind: 'run' }), names, NOW), 'Pregunta, severidad alta, Run en lixbon, hace 5 min');
  });
});

describe('4 · estado de la lista', () => {
  const page = (state, ids, extra = {}) => listReducer(state, { type: 'page', gen: state.gen, items: ids.map((i) => item(i)), cursor: null, hasMore: false, at: NOW, ...extra });

  it('cambiar filtros vacía y descarta respuestas de la consulta anterior', () => {
    let s = page(initialList, ['a', 'b']);
    const oldGen = s.gen;
    s = listReducer(s, { type: 'filters', filters: { category: 'failed' } });
    assert.equal(s.items.length, 0);
    assert.equal(s.gen, oldGen + 1);
    const stale = listReducer(s, { type: 'page', gen: oldGen, items: [item('z')], at: NOW });
    assert.equal(stale.items.length, 0, 'la respuesta de los filtros viejos no se mezcla');
    assert.equal(listReducer(s, { type: 'filters', filters: { category: 'failed' } }), s, 'los mismos filtros no recargan');
  });

  it('cargar más añade sin repetir', () => {
    let s = page(initialList, ['a', 'b'], { cursor: 'c1', hasMore: true });
    assert.equal(s.hasMore, true);
    s = listReducer(s, { type: 'page', gen: s.gen, append: true, items: [item('b'), item('c')], cursor: null, hasMore: false, at: NOW });
    assert.deepEqual(s.items.map((i) => i.id), ['a', 'b', 'c']);
    assert.equal(s.hasMore, false);
  });

  it('un fallo conserva lo que se veía y lo marca', () => {
    let s = page(initialList, ['a']);
    s = listReducer(s, { type: 'fail', gen: s.gen, code: 'timeout' });
    assert.equal(s.items.length, 1);
    assert.equal(s.error, 'timeout');
    assert.deepEqual(listNotice(s, { capability: true, online: true }), { tone: 'warn', text: 'No se pudo actualizar la bandeja: ves la última que llegó.' });
    assert.match(listNotice(page(initialList, ['a']), { capability: true, online: false }).text, /Sin conexión/);
  });

  it('sin lista propia: las más urgentes de la snapshot, filtradas y marcadas', () => {
    let s = listReducer(initialList, { type: 'filters', filters: { severity: 'critical' } });
    s = listReducer(s, { type: 'snapshot', items: [item('a', { severity: 'critical' }), item('b')] });
    assert.deepEqual(s.items.map((i) => i.id), ['a']);
    assert.equal(s.source, 'snapshot');
    assert.match(listNotice(s, { capability: false, snapshotTotal: 9 }).text, /solo envía las más urgentes \(1 de 9\): actualízalo/);
    assert.match(listNotice(s, { capability: true, snapshotTotal: 9 }).text, /guardadas en este teléfono/);
    assert.equal(listNotice(s, { capability: true, snapshotTotal: 1 }), null, 'si están todas, no hay nada que avisar');
  });

  it('la snapshot nunca sustituye a una lista ya cargada', () => {
    const s = page(initialList, ['a', 'b']);
    assert.equal(listReducer(s, { type: 'snapshot', items: [item('z')] }), s);
  });
});

describe('5 · relé', () => {
  it('core_attention se empareja por rid y no va al transcript', async () => {
    const sent = [];
    const link = createCoreLink({ send: async (c) => (sent.push(c), { ok: true }), newRid: () => 'a1' });
    const p = link.request('core_attention', { category: 'question' });
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(sent, [{ type: 'orch', action: 'core_attention', args: { category: 'question', rid: 'a1' } }]);
    assert.equal(link.handleEvent({ type: 'orch_core_attention', rid: 'a1', ok: true, protocol: RELAY_PROTOCOL, items: [item('a')], has_more: false }), true);
    const res = await p;
    assert.equal(res.ok, true);
    assert.equal(res.data.items[0].id, 'a');
  });
});
