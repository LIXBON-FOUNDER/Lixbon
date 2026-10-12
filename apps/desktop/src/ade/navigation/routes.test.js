import { describe, it, expect } from 'vitest';
import { SCREENS, routes, formatRoute, parseRoute, sameRoute, navSectionOf, routeForAttention, routeForEntity, breadcrumbTrail, NAV_ITEMS } from './routes';

describe('rutas', () => {
  it('formatear y parsear son inversas para todas las pantallas', () => {
    const todas = [
      routes.home(), routes.projects(), routes.project('prj_a'), routes.task('tsk_a'), routes.attempt('att_a'), routes.thread('th_a'),
      routes.review('att_a'), routes.integration('att_a'), routes.activity(), routes.agents(), routes.settings(),
    ];
    expect(todas.map((r) => r.screen).sort()).toEqual([...SCREENS].sort());
    for (const r of todas) expect(parseRoute(formatRoute(r)), formatRoute(r)).toEqual(r);
  });

  it('una ruta se escribe como hash legible y enlazable', () => {
    expect(formatRoute(routes.attempt('att_pago_1'))).toBe('#/attempt/att_pago_1');
    expect(formatRoute(routes.home())).toBe('#/');
    expect(formatRoute(routes.attempt('a b'))).toBe('#/attempt/a%20b');
  });

  it('un hash desconocido, vacío o sin id cae en Inicio', () => {
    for (const h of ['', '#', '#/', '#/nada', '#/attempt', '#/attempt/']) expect(parseRoute(h), h).toEqual(routes.home());
  });

  it('compara rutas por su forma serializada', () => {
    expect(sameRoute(routes.task('a'), { screen: 'task', taskId: 'a' })).toBe(true);
    expect(sameRoute(routes.task('a'), routes.task('b'))).toBe(false);
  });

  it('la navegación principal tiene cinco secciones y los detalles pertenecen a Proyectos', () => {
    expect(NAV_ITEMS.map((i) => i.screen)).toEqual(['home', 'projects', 'activity', 'agents', 'settings']);
    for (const s of ['project', 'task', 'attempt', 'thread', 'review', 'integration']) expect(navSectionOf({ screen: s })).toBe('projects');
    expect(navSectionOf(routes.activity())).toBe('activity');
  });
});

describe('cadena Attention → … y migas', () => {
  it('cada kind lleva directo al nivel útil', () => {
    const it = (kind) => ({ kind, projectId: 'p', taskId: 't', attemptId: 'a' });
    expect(routeForAttention(it('review'))).toEqual(routes.review('a'));
    expect(routeForAttention(it('integrate'))).toEqual(routes.integration('a'));
    for (const k of ['approve_in_terminal', 'failed', 'pending_spawn', 'unanswered_question']) expect(routeForAttention(it(k)), k).toEqual(routes.attempt('a'));
    expect(routeForAttention({ kind: 'failed', projectId: 'p', taskId: 't', attemptId: null })).toEqual(routes.task('t'));
    expect(routeForAttention({ kind: 'failed', projectId: 'p' })).toEqual(routes.project('p'));
  });

  it('la ruta de una entidad de la actividad', () => {
    const ids = { attemptId: 'a', taskId: 't' };
    expect(routeForEntity({ kind: 'attempt', id: 'a' }, ids)).toEqual(routes.attempt('a'));
    expect(routeForEntity({ kind: 'review', id: 'a' }, ids)).toEqual(routes.review('a'));
    expect(routeForEntity({ kind: 'integration', id: 'a' }, ids)).toEqual(routes.integration('a'));
    expect(routeForEntity({ kind: 'project', id: 'p' }, ids)).toEqual(routes.project('p'));
    expect(routeForEntity({ kind: 'worktree', id: 'w' }, { taskId: 't' })).toEqual(routes.task('t'));
    expect(routeForEntity({ kind: 'worktree', id: 'w' }, {})).toBeNull();
  });

  it('las migas recorren Inicio › Proyecto › Task › Intento › Revisión', () => {
    const e = { project: { id: 'p', name: 'Orbita' }, task: { id: 't', title: 'Pago' }, attempt: { id: 'a', ordinal: 2 } };
    expect(breadcrumbTrail(routes.review('a'), e).map((c) => c.label)).toEqual(['Inicio', 'Orbita', 'Pago', 'Intento 2', 'Revisión']);
    expect(breadcrumbTrail(routes.attempt('a'), e).at(-1).route).toEqual(routes.attempt('a'));
    expect(breadcrumbTrail(routes.task('t'), e).map((c) => c.label)).toEqual(['Inicio', 'Orbita', 'Pago']);
    expect(breadcrumbTrail(routes.thread('h'), { ...e, thread: { title: 'Hilo X' } }).at(-1).label).toBe('Hilo X');
    expect(breadcrumbTrail(routes.home(), {}).map((c) => c.label)).toEqual(['Inicio']);
  });

  it('con entidades sin resolver las migas siguen siendo navegables', () => {
    const t = breadcrumbTrail(routes.attempt('a'), {});
    expect(t.map((c) => c.label)).toEqual(['Inicio', 'Proyecto', 'Tarea', 'Intento']);
  });
});
