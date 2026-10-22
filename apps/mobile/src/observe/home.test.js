// Pruebas de Home de Supervisar (LXO-108): `npm test` (node --test).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { activeA11y, homeModel, projectA11y, projectCounts, projectModel, projectStatusOf } from './home.js';

const by = (over = {}) => ({ question: 0, approval: 0, review_ready: 0, conflict: 0, failed: 0, environment_blocked: 0, risk: 0, ...over });
const snap = ({ projects = [], tasks = [], attention = by(), total, truncated = false, tasksTotal, health = 'ok' } = {}) => ({
  snapshot_version: 1,
  core: { version: '2.2.0', health, machine_id: 'm' },
  cursor: { events: 1 },
  projects: { total: total ?? projects.length, truncated, items: projects },
  active_tasks: { total: tasksTotal ?? tasks.length, truncated: (tasksTotal ?? tasks.length) > tasks.length, items: tasks },
  attention: { total: Object.values(attention).reduce((a, b) => a + b, 0), by_category: attention, truncated: false, items: [] },
  unassigned: { active: 0, failed: 0, attention: 0 },
});
const project = (id, over = {}) => ({ id, name: id, status: 'idle', active: 0, failed: 0, attention: 0, ...over });
const task = (id, over = {}) => ({ id, project_id: 'p1', run_id: 'r1', parent_id: null, root_id: id, status: 'running', title: `Tarea ${id}`, provider: 'claude', origin: 'lixbon', updated_at: 1, ...over });

describe('1 · 0 / 1 / N Projects', () => {
  it('sin snapshot no hay Home (el banner explica por qué)', () => assert.equal(homeModel(null), null));

  it('0 Projects', () => {
    const h = homeModel(snap());
    assert.deepEqual([h.projects.length, h.projectsTotal, h.projectsHidden, h.active.length, h.attention.total], [0, 0, 0, 0, 0]);
  });

  it('1 Project en reposo', () => {
    const h = homeModel(snap({ projects: [project('p1')] }));
    assert.equal(h.projects[0].status.label, 'En reposo');
    assert.equal(h.projects[0].counts, '0 activas');
  });

  it('N Projects en el orden del Core y recorte marcado', () => {
    const h = homeModel(snap({ projects: [project('b', { status: 'failed' }), project('a', { status: 'active' })], total: 60, truncated: true }));
    assert.deepEqual(h.projects.map((p) => p.id), ['b', 'a'], 'Home no reordena');
    assert.equal(h.projectsHidden, 58);
  });
});

describe('2 · Project con varias señales', () => {
  it('activas, fallidas y Attention se cuentan aparte', () => {
    const p = project('p1', { status: 'failed', active: 2, failed: 1, attention: 3 });
    assert.equal(projectCounts(p), '2 activas · 1 fallida · 3 piden atención');
    const h = homeModel(snap({ projects: [p] }));
    assert.deepEqual([h.projects[0].active, h.projects[0].failed, h.projects[0].attention], [2, 1, 3], 'nunca se suman');
    assert.equal(h.projects[0].status.tone, 'error');
    assert.equal(projectStatusOf('attention').tone, 'warn');
    assert.equal(projectStatusOf('nuevo').label, 'nuevo');
  });

  it('Attention por categoría, solo las que tienen algo, con su ruta', () => {
    const h = homeModel(snap({ attention: by({ question: 2, failed: 1 }) }));
    assert.equal(h.attention.total, 3);
    assert.deepEqual(h.attention.categories.map((c) => [c.key, c.count]), [['question', 2], ['failed', 1]]);
    assert.deepEqual(h.attention.categories[0].route, { name: 'attention', category: 'question' });
  });

  it('salud del Core', () => {
    assert.equal(homeModel(snap({ health: 'read_only' })).health, 'read_only');
    assert.equal(homeModel(snap()).version, '2.2.0');
  });
});

describe('3 · trabajo activo y navegación por ids durables', () => {
  it('cada fila lleva a su Task o a su Project por id', () => {
    const h = homeModel(snap({ projects: [project('p1', { name: 'lixbon', status: 'active', active: 1 })], tasks: [task('t1'), task('t2', { project_id: null, parent_id: 't1', origin: 'external' })] }));
    assert.deepEqual(h.projects[0].route, { name: 'project', projectId: 'p1' });
    assert.deepEqual(h.active[0].route, { name: 'task', taskId: 't1', projectId: 'p1' });
    assert.deepEqual(h.active[1].route, { name: 'task', taskId: 't2', projectId: null });
    assert.equal(h.active[0].projectName, 'lixbon');
    assert.equal(h.active[1].projectName, 'Sin proyecto');
  });

  it('el origen solo se enseña cuando es relevante (coordinador externo)', () => {
    const h = homeModel(snap({ tasks: [task('a'), task('b', { origin: 'external' })] }));
    assert.deepEqual(h.active.map((t) => t.origin), [null, 'Externo']);
  });

  it('activas recortadas: se dice cuántas faltan', () => {
    const h = homeModel(snap({ tasks: [task('a')], tasksTotal: 80 }));
    assert.equal(h.activeHidden, 79);
  });

  it('pantalla de Project: sus Tasks activas y su Attention', () => {
    const s = snap({ projects: [project('p1', { active: 2, attention: 1 }), project('p2')], tasks: [task('a'), task('b', { project_id: 'p2' }), task('c')] });
    const m = projectModel(s, 'p1');
    assert.deepEqual(m.tasks.map((t) => t.id), ['a', 'c']);
    assert.deepEqual(m.attentionRoute, { name: 'attention', projectId: 'p1' });
    assert.equal(m.partial, false);
    assert.equal(projectModel(s, 'no-existe').project, null, 'un Project que no está se dice, no rompe');
  });
});

describe('4 · accesibilidad', () => {
  it('etiquetas completas para el lector de pantalla', () => {
    const h = homeModel(snap({ projects: [project('p1', { name: 'lixbon', status: 'failed', active: 1, failed: 1 })], tasks: [task('t1', { parent_id: 'x', origin: 'external' })] }));
    assert.equal(projectA11y(h.projects[0]), 'lixbon, Con fallos, 1 activa · 1 fallida');
    assert.equal(activeA11y(h.active[0]), 'Tarea t1, Trabajando, lixbon, Externo, tarea hija, abre la tarea');
  });
});
