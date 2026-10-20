import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AdeShell } from './AdeShell';
import { queryAdeCore } from './coreQueries';
import { useWorkbenchStore } from '../store/workbenchStore';

vi.mock('./coreQueries', () => ({ queryAdeCore: vi.fn() }));

// FIXTURES con la forma del contrato de docs/core/QUERIES.md; no son una lectura de Core real ni dogfood.

const PROJECT = { id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active', counts: { tasks: 1, active: 1, failed: 0, attention: { total: 0, by_category: {} } }, locations: [] };
const ITEM = { id: 'task-uuid-1', run_id: 'run-1', parent_id: null, root_id: 'task-uuid-1', status: 'running', title: 'Task Real', provider: 'claude', model: null, created_at: 1, updated_at: 2 };
const detailOf = (over = {}) => ({
  v: 1,
  task: { ...ITEM, project_id: PROJECT.id, child_ids: [], phase: null, messages: [], cwd: 'C:/wt', branch: 'lxo/x', worktree: 'C:/wt', merged: false, review: null, integration: null, ...over },
});

function core(detail) {
  queryAdeCore.mockImplementation(async (query) => {
    if (query === 'projects_overview') return { v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [PROJECT], unassigned: {} };
    if (query === 'tasks_by_project') return { v: 1, project_id: PROJECT.id, filters: { status: 'active' }, limit: 50, tasks: [ITEM], has_more: false, next_cursor: null };
    if (query === 'task_detail') return detail;
    throw new Error(`Query no permitida en fixture: ${query}`);
  });
}

const operation = <div data-testid="operation-canvas"><span data-testid="pty-sentinel" /></div>;
const shell = (props = {}) => (
  <AdeShell active leftOpen rightOpen drawerOpen={false} operationWorkspace={operation} {...props} />
);

const pickTask = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Repo Real' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Task Real' }));
};

beforeEach(() => {
  useWorkbenchStore.setState({ adeSelection: { projectId: null, taskId: null } });
});
afterEach(() => {
  cleanup();
  queryAdeCore.mockReset();
});

describe('AdeShell · Task Workspace como canvas e Inspector', () => {
  it('consume el task_detail del shell en canvas e Inspector con una sola consulta', async () => {
    core(detailOf());
    render(shell());
    await pickTask();

    const identities = await screen.findAllByRole('region', { name: 'Identidad' });
    expect(identities).toHaveLength(2); // canvas + Inspector
    expect(screen.getAllByRole('heading', { level: 2, name: 'Task Real' })).toHaveLength(2);
    expect(document.querySelector('.twk--workspace')).toBeTruthy();
    expect(document.querySelector('.ade__inspector .twk--inspector')).toBeTruthy();

    const detailCalls = queryAdeCore.mock.calls.filter(([query]) => query === 'task_detail');
    expect(detailCalls).toEqual([['task_detail', { projectId: PROJECT.id, taskId: ITEM.id }]]);
    for (const region of identities) {
      expect(within(region).getByText('Project', { selector: 'dt' }).nextElementSibling.textContent).toBe('Repo Real');
      expect(within(region).getByText('Task ID', { selector: 'dt' }).nextElementSibling.textContent).toBe(ITEM.id);
    }
    for (const region of screen.getAllByRole('region', { name: 'Ubicación' })) {
      expect(within(region).getByText('Host / origen', { selector: 'dt' }).nextElementSibling.textContent).toBe('No informado');
    }
  });

  it('Activity y Attention quedan no disponibles sin callbacks y no usan la AttentionList legacy', async () => {
    core(detailOf());
    render(shell());
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });

    const lists = screen.getAllByRole('list', { name: 'Contexto de la Task' });
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      expect(list.textContent).toContain('No disponible: esta superficie todavía no está conectada');
      expect(within(list).queryByRole('button')).toBeNull();
    }
    expect(screen.queryByRole('region', { name: /Attention/i })).toBeNull();
  });

  it('con callbacks conectados entrega exactamente los IDs seleccionados', async () => {
    core(detailOf());
    const onOpenTaskActivity = vi.fn();
    const onOpenTaskAttention = vi.fn();
    render(shell({ onOpenTaskActivity, onOpenTaskAttention }));
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });

    fireEvent.click(screen.getAllByRole('button', { name: `Abrir Activity de la Task ${ITEM.id}` })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: `Abrir Attention de la Task ${ITEM.id}` })[1]);

    expect(onOpenTaskActivity.mock.calls).toEqual([[{ projectId: PROJECT.id, taskId: ITEM.id }]]);
    expect(onOpenTaskAttention.mock.calls).toEqual([[{ projectId: PROJECT.id, taskId: ITEM.id }]]);
  });

  it('regresión: una respuesta obsoleta con IDs distintos a la selección no renderiza detalles ni acciones', async () => {
    core(detailOf({ id: 'task-vieja', project_id: 'project-vieja', title: 'Título obsoleto', cwd: 'C:/obsoleta' }));
    const onOpenTaskActivity = vi.fn();
    render(shell({ onOpenTaskActivity, onOpenTaskAttention: vi.fn() }));
    await pickTask();

    const alerts = await screen.findAllByRole('alert');
    for (const alert of alerts) expect(alert.textContent).toContain('Respuesta no verificada');
    expect(document.body.textContent).not.toContain('Título obsoleto');
    expect(document.body.textContent).not.toContain('C:/obsoleta');
    expect(screen.queryByRole('region', { name: 'Identidad' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Contexto de la Task' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Abrir (Activity|Attention)/ })).toBeNull();
    expect(onOpenTaskActivity).not.toHaveBeenCalled();
  });

  it('conserva el canvas operativo montado y la selección durable al pasar a inactivo', async () => {
    core(detailOf());
    const { rerender } = render(shell());
    await pickTask();
    const pty = screen.getByTestId('pty-sentinel');

    rerender(shell({ active: false }));

    expect(screen.getByTestId('pty-sentinel')).toBe(pty);
    expect(screen.getByTestId('execution-composition').getAttribute('aria-hidden')).toBe('false');
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: ITEM.id });
  });
});
