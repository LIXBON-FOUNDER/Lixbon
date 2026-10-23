import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ProjectsSidebar } from './ProjectsSidebar';
import { TASK_PAGE_LIMIT } from './coreQueries';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, VARIANTS, taskListPage } from './testFixtures/coreModelFixtures';

// LXO-120: los cursores guardados de la lista de Tasks son de un core_model concreto.
// Al cambiar legacy <-> task_attempt_v1 se descartan y la paginacion vuelve a la cabecera.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const LEGACY = coreModelFromState({ data: VARIANTS.coreModelLegacy, error: null });
const ZERO = { question: 0, approval: 0, review_ready: 0, conflict: 0, failed: 0, environment_blocked: 0, risk: 0 };
const PROJECT = { id: 'p-1', name: 'App', state: 'active', status: 'active', locations: [], counts: { tasks: 3, active: 0, failed: 0, attention: { total: 0, by_category: ZERO } } };
const OVERVIEW = { v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [PROJECT], unassigned: { tasks: 0, active: 0, failed: 0, attention: { total: 0, by_category: ZERO } } };
const task = (id, created) => ({ id, run_id: 'r1', parent_id: null, root_id: id, status: 'running', title: `Task ${id}`, provider: 'claude', model: null, branch: null, worktree: null, external: false, created_at: created, updated_at: created });
const LOAD_MORE = 'Cargar m\u00e1s Tasks de App';

function mountCore() {
  const pageCursors = [];
  invoke.mockImplementation(async (_command, payload) => {
    const { query, args } = payload;
    if (query === 'projects_overview') return OVERVIEW;
    if (query === 'task_list_v2') return taskListPage([]);
    if (query === 'attempts_by_task') return { v: 1, task_id: args.task_id, items: [], has_more: false, next_cursor: null };
    if (query === 'tasks_by_project') {
      const base = { v: 1, project_id: 'p-1', filters: { status: args.status }, limit: TASK_PAGE_LIMIT };
      if (!args.cursor) return { ...base, tasks: [task('head', 50)], has_more: true, next_cursor: 'c-head' };
      pageCursors.push(args.cursor);
      if (args.cursor === 'c-head') return { ...base, tasks: [task('page2', 40)], has_more: true, next_cursor: 'c-page2' };
      return { ...base, tasks: [task('page3', 30)], has_more: false, next_cursor: null };
    }
    throw new Error(`query inesperada: ${query}`);
  });
  return pageCursors;
}

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); localStorage.clear(); });

describe('ProjectsSidebar: cursores guardados por core_model (LXO-120)', () => {
  it.each([
    ['legacy -> task_attempt_v1', LEGACY, V1],
    ['task_attempt_v1 -> legacy', V1, LEGACY],
  ])('%s: descarta las paginas y el cursor guardado y vuelve a empezar desde la cabecera', async (_name, from, to) => {
    const pageCursors = mountCore();
    const view = render(<ProjectsSidebar initialExpandedProjectIds={['p-1']} coreModel={from} />);
    await screen.findByText('Task head');
    await flush();
    fireEvent.click(screen.getByRole('button', { name: LOAD_MORE }));
    await screen.findByText('Task page2');
    expect(pageCursors).toEqual(['c-head']);

    view.rerender(<ProjectsSidebar initialExpandedProjectIds={['p-1']} coreModel={to} />);
    await flush();
    // La pagina 2 y su cursor `c-page2` pertenecian al modelo anterior: ya no se muestran.
    expect(screen.queryByText('Task page2')).toBeNull();
    expect(screen.getByText('Task head')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: LOAD_MORE }));
    await screen.findByText('Task page2');
    // El siguiente "Cargar mas" parte de la cabecera nueva, nunca del cursor guardado del modelo viejo.
    expect(pageCursors).toEqual(['c-head', 'c-head']);
    expect(pageCursors).not.toContain('c-page2');
  });
});