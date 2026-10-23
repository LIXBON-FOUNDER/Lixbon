import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ProjectsSidebar } from './ProjectsSidebar';
import { TASK_PAGE_LIMIT } from './coreQueries';
import { coreModelFromState } from './useCoreModel';
import { formatUtc } from './attemptFormat';
import { CANONICAL, ERRORS, VARIANTS, attemptsPage, taskListPage } from './testFixtures/coreModelFixtures';

// LXO-120 · Sidebar adaptativo: TaskNode con 0/1/N Attempts, en los dos modos de core_model.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const LEGACY = coreModelFromState({ data: VARIANTS.coreModelLegacy, error: null });
const INACTIVE = coreModelFromState({ data: null, error: ERRORS.inactive });
const ZERO = { question: 0, approval: 0, review_ready: 0, conflict: 0, failed: 0, environment_blocked: 0, risk: 0 };
const PROJECT = { id: 'p-1', name: 'App', state: 'active', status: 'active', locations: [], counts: { tasks: 5, active: 1, failed: 0, attention: { total: 0, by_category: ZERO } } };
const OVERVIEW = { v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [PROJECT], unassigned: { tasks: 0, active: 0, failed: 0, attention: { total: 0, by_category: ZERO } } };
const f2Task = (id, status, created) => ({ id, run_id: 'r1', parent_id: null, root_id: id, status, title: `Task ${id}`, provider: 'claude', model: null, branch: null, worktree: null, external: false, created_at: created, updated_at: created });
const F2 = [f2Task('t0', 'starting', 50), f2Task('t1', 'done', 40), f2Task('t3', 'running', 30), f2Task('t7', 'failed', 20), f2Task('t9', 'running', 10)];
const V2 = taskListPage([VARIANTS.zero, VARIANTS.one, VARIANTS.many, VARIANTS.lastFailed, VARIANTS.unknownStatus]);
const READ_ONLY = new Set(['projects_overview', 'tasks_by_project', 'task_list_v2', 'attempts_by_task']);

function mountCore({ v2 = () => V2, attempts = (taskId) => attemptsPage(taskId, taskId === 't3' ? VARIANTS.many.attempt_count && [
  ...[1, 2, 3].map((n) => (n === 3 ? VARIANTS.many.current_attempt : { ...VARIANTS.many.current_attempt, id: `t3-a${n}`, n, status: n === 1 ? 'failed' : 'stopped', provider: 'claude', model: null })),
] : []) } = {}) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => {
    calls.push(payload.query);
    if (payload.query === 'projects_overview') return OVERVIEW;
    if (payload.query === 'tasks_by_project') return { v: 1, project_id: 'p-1', filters: { status: payload.args.status }, limit: TASK_PAGE_LIMIT, tasks: F2, has_more: false, next_cursor: null };
    if (payload.query === 'task_list_v2') return v2(payload.args);
    if (payload.query === 'attempts_by_task') return attempts(payload.args.task_id);
    throw new Error(`query inesperada: ${payload.query}`);
  });
  return calls;
}

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const row = (taskId) => document.querySelector(`[role="treeitem"][aria-level="2"][data-task-id="${taskId}"]`);
afterEach(() => { cleanup(); invoke.mockReset(); localStorage.clear(); });

async function renderSidebar(props = {}) {
  render(<ProjectsSidebar initialExpandedProjectIds={['p-1']} coreModel={V1} {...props} />);
  await screen.findByText('Task t3');
  await flush();
}

describe('ProjectsSidebar · TaskNode (LXO-120)', () => {
  it('0 intentos: «Sin intentos todavía» neutro; 1: plegada con chip; N: expandida', async () => {
    const calls = mountCore();
    await renderSidebar();
    const zero = within(row('t0')).getByTestId('task-no-attempts');
    expect(zero.textContent).toBe('Sin intentos todavía');
    expect(zero.className).toContain('--neutral');
    expect(row('t0').getAttribute('aria-expanded')).toBeNull();
    const t1 = row('t1');
    expect(t1.getAttribute('aria-expanded')).toBeNull();
    expect(within(t1).getByText('Intento #1 · Terminado')).toBeTruthy();
    expect(t1.querySelector('[data-attempt-id]').getAttribute('data-attempt-id')).toBe('t1-a1');
    const t3 = row('t3');
    expect(t3.getAttribute('aria-expanded')).toBe('true');
    const group = await screen.findByRole('group', { name: 'Intentos de Task t3' });
    const items = within(group).getAllByRole('treeitem');
    expect(items.map((item) => item.getAttribute('data-attempt-id'))).toEqual(['t3-a3', 't3-a2', 't3-a1']);
    expect(items.every((item) => item.getAttribute('aria-level') === '3')).toBe(true);
    // El sidebar solo lee `attempt_brief`: nunca `attempt_detail` por Attempt.
    expect(calls).not.toContain('attempt_detail');
    expect(calls.every((query) => READ_ONLY.has(query))).toBe(true);
  });

  it('último intento fallido: «Falló» con su hora y estado de Task distinto del del Attempt', async () => {
    mountCore();
    await renderSidebar();
    const t7 = row('t7');
    const chip = within(t7).getByText('Intento #2 · Falló');
    expect(chip.className).toContain('--failed');
    expect(within(t7).getByText(formatUtc(1792000008000).label).getAttribute('dateTime')).toBe(new Date(1792000008000).toISOString());
    expect(within(t7).getByText('Fallida')).toBeTruthy();
    expect(t7.getAttribute('data-status')).toBe('failed');
  });

  it('estado no reconocido: etiqueta genérica neutra, sin estilo de error y el valor crudo solo en el detalle', async () => {
    mountCore();
    await renderSidebar();
    const status = row('t9').querySelector('.ps__astatus');
    expect(status.textContent).toContain('Intento #1 · Estado no reconocido');
    expect(status.className).toContain('--neutral');
    expect(status.className).not.toContain('--failed');
    expect(status.querySelector('details code').textContent).toBe('paused_by_operator');
  });

  it('teclado: ← pliega la Task, → la expande, → baja al primer intento y Enter lo selecciona', async () => {
    const calls = mountCore();
    const onSelectAttempt = vi.fn();
    const onSelectTask = vi.fn();
    await renderSidebar({ onSelectAttempt, onSelectTask });
    const t3 = row('t3');
    await screen.findByRole('group', { name: 'Intentos de Task t3' });
    t3.focus();
    fireEvent.keyDown(t3, { key: 'ArrowLeft' });
    expect(t3.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(t3, { key: 'ArrowRight' });
    await flush();
    expect(t3.getAttribute('aria-expanded')).toBe('true');
    const items = within(await screen.findByRole('group', { name: 'Intentos de Task t3' })).getAllByRole('treeitem');
    fireEvent.keyDown(t3, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'Enter' });
    expect(onSelectAttempt).toHaveBeenCalledWith({ projectId: 'p-1', taskId: 't3', attemptId: 't3-a2' });
    expect(onSelectTask).not.toHaveBeenCalled();
    fireEvent.keyDown(items[1], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(t3);
    expect(calls.every((query) => READ_ONLY.has(query))).toBe(true);
  });

  it('una selección de Attempt restaurada queda como único aria-selected', async () => {
    mountCore();
    await renderSidebar({ selection: { projectId: 'p-1', taskId: 't3', attemptId: 't3-a1' } });
    await screen.findByRole('group', { name: 'Intentos de Task t3' });
    const selected = document.querySelectorAll('[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('data-attempt-id')).toBe('t3-a1');
  });

  it.each([
    ['legacy declarado', LEGACY],
    ['core_model_inactive', INACTIVE],
  ])('modo %s: filas F2 sin Attempts, aviso informativo sin reintentar y sin pedir vNext', async (_name, model) => {
    const calls = mountCore();
    await renderSidebar({ coreModel: model });
    expect(document.querySelectorAll('[data-testid="task-attempt-summary"]')).toHaveLength(0);
    expect(within(row('t3')).getByText('Proveedor claude')).toBeTruthy();
    const note = screen.getByTestId('core-model-legacy');
    expect(note.textContent).toBe('El modelo de Attempts aún no está activo en este Core');
    expect(note.querySelector('button')).toBeNull();
    expect(calls).not.toContain('task_list_v2');
  });

  it('si task_list_v2 responde core_model_inactive o un Core viejo no la conoce, vuelve a F2 sin error', async () => {
    for (const error of [ERRORS.inactive, ERRORS.unknownCommand]) {
      mountCore({ v2: () => { throw new Error(error); } });
      await renderSidebar();
      expect(document.querySelectorAll('[data-testid="task-attempt-summary"]')).toHaveLength(0);
      expect(document.querySelector('[role="alert"]')).toBeNull();
      cleanup();
    }
  });

  it('errores de attempts_by_task por código: not_found con vuelta al proyecto; unavailable con reintento y detalle técnico', async () => {
    mountCore({ attempts: () => { throw new Error(ERRORS.notFound); } });
    const onSelectProject = vi.fn();
    await renderSidebar({ onSelectProject });
    const notFound = await within(row('t3')).findByRole('alert');
    expect(notFound.firstChild.textContent).toBe('Esta tarea ya no existe o no es de este proyecto');
    fireEvent.click(within(notFound).getByRole('button', { name: 'Volver al proyecto' }));
    expect(onSelectProject).toHaveBeenCalled();
    cleanup();
    mountCore({ attempts: () => { throw new Error(ERRORS.unavailable); } });
    await renderSidebar();
    const unavailable = await within(row('t3')).findByRole('alert');
    expect(unavailable.firstChild.textContent).toBe('El Core no responde');
    expect(within(unavailable).getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    expect(unavailable.querySelector('details code').textContent).toContain('model_unavailable');
    expect(unavailable.firstChild.textContent).not.toContain('model_unavailable');
  });

  it('acepta la fixture canónica de task_list_v2 (1 intento por Task)', async () => {
    invoke.mockImplementation(async (command, payload) => {
      if (payload.query === 'projects_overview') return OVERVIEW;
      if (payload.query === 'tasks_by_project') return { v: 1, project_id: 'p-1', filters: { status: payload.args.status }, limit: TASK_PAGE_LIMIT, tasks: [f2Task('t5', 'done', 5), f2Task('t4', 'failed', 4), f2Task('t3', 'done', 3)], has_more: false, next_cursor: null };
      if (payload.query === 'task_list_v2') return CANONICAL['task_list_v2.json'];
      throw new Error(payload.query);
    });
    await renderSidebar();
    expect(within(row('t5')).getByText('Intento #1 · Terminado')).toBeTruthy();
    expect(within(row('t4')).getByText('Intento #1 · Falló')).toBeTruthy();
  });
});
