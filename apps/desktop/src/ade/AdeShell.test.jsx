import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AdeShell } from './AdeShell';
import { queryAdeCore } from './coreQueries';
import { useWorkbenchStore } from '../store/workbenchStore';

// Solo se sustituye el transporte; los códigos y constantes del contrato son los reales.
vi.mock('./coreQueries', async (importOriginal) => ({ ...(await importOriginal()), queryAdeCore: vi.fn() }));

// FIXTURES con la forma del contrato de docs/core/QUERIES.md; no son una lectura de Core real ni dogfood.

const PROJECT = { id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active', counts: { tasks: 1, active: 1, failed: 0, attention: { total: 0, by_category: {} } }, locations: [] };
const ITEM = { id: 'task-uuid-1', run_id: 'run-1', parent_id: null, root_id: 'task-uuid-1', status: 'running', title: 'Task Real', provider: 'claude', model: null, created_at: 1, updated_at: 2 };
const detailOf = (over = {}) => ({
  v: 1,
  task: { ...ITEM, project_id: PROJECT.id, child_ids: [], phase: null, messages: [], cwd: 'C:/wt', branch: 'lxo/x', worktree: 'C:/wt', merged: false, review: null, integration: null, ...over },
});

const att = (over = {}) => ({
  id: 'att_1', category: 'question', severity: 'medium', status: 'active', target_kind: 'task', target_id: ITEM.id,
  project_id: PROJECT.id, run_id: null, occurrence: 1, created_at: 1, resolved_at: null, resolution: null, ...over,
});
const attentionPage = (items, hasMore = false) => ({ v: 1, items, next_cursor: hasMore ? 'cursor-1' : null, has_more: hasMore, limit: 100 });

function core(detail, { attention = () => attentionPage([]) } = {}) {
  queryAdeCore.mockImplementation(async (query, args) => {
    if (query === 'projects_overview') return { v: 1, filters: { archived: args.archived, machine: null }, total: 1, projects: [PROJECT], unassigned: {} };
    if (query === 'tasks_by_project') return { v: 1, project_id: PROJECT.id, filters: { status: 'active' }, limit: 50, tasks: [ITEM], has_more: false, next_cursor: null };
    if (query === 'task_detail') return detail;
    if (query === 'attention_list') return attention(args);
    throw new Error(`Query no permitida en fixture: ${query}`);
  });
}

const attentionCalls = () => queryAdeCore.mock.calls.filter(([query]) => query === 'attention_list');
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const attentionRows = () => within(screen.getByRole('list', { name: 'Attention activa' })).getAllByRole('listitem');
const openAttentionTab = () => fireEvent.click(screen.getByRole('tab', { name: 'Attention' }));

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
  vi.useRealTimers();
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

  it('Activity queda no disponible sin callback; Attention se sirve en el shell y no usa la AttentionList legacy', async () => {
    core(detailOf());
    render(shell());
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });

    const lists = screen.getAllByRole('list', { name: 'Contexto de la Task' });
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      const activity = list.querySelector('[data-context="activity"]');
      expect(activity.getAttribute('data-available')).toBe('false');
      expect(activity.textContent).toContain('No disponible: esta superficie todavía no está conectada');
      expect(list.querySelector('[data-context="attention"]').getAttribute('data-available')).toBe('true');
      expect(within(list).getAllByRole('button')).toHaveLength(1);
    }
    expect(screen.queryByRole('region', { name: /Attention/i })).toBeNull();
  });

  it('entrega a Activity exactamente los IDs seleccionados', async () => {
    core(detailOf());
    const onOpenTaskActivity = vi.fn();
    render(shell({ onOpenTaskActivity }));
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });

    fireEvent.click(screen.getAllByRole('button', { name: `Abrir Activity de la Task ${ITEM.id}` })[0]);

    expect(onOpenTaskActivity.mock.calls).toEqual([[{ projectId: PROJECT.id, taskId: ITEM.id }]]);
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

describe('AdeShell · subvista Attention (LXO-100)', () => {
  it('ofrece un switch Workspace/Attention accesible por teclado y conserva Runs y AgentPanel montados', async () => {
    core(detailOf());
    const { rerender } = render(shell());
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });
    const pty = screen.getByTestId('pty-sentinel');

    const tablist = screen.getByRole('tablist', { name: 'Vista del ADE' });
    const workspaceTab = within(tablist).getByRole('tab', { name: 'Workspace' });
    const attentionTab = within(tablist).getByRole('tab', { name: 'Attention' });
    expect(workspaceTab.getAttribute('aria-selected')).toBe('true');
    expect(attentionTab.getAttribute('aria-selected')).toBe('false');
    expect(workspaceTab.tabIndex).toBe(0);
    expect(attentionTab.tabIndex).toBe(-1);
    expect(document.getElementById(workspaceTab.getAttribute('aria-controls')).getAttribute('role')).toBe('tabpanel');
    expect(document.getElementById(attentionTab.getAttribute('aria-controls')).hidden).toBe(true);

    workspaceTab.focus();
    fireEvent.keyDown(workspaceTab, { key: 'ArrowRight' });
    await flush();
    expect(attentionTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(attentionTab);
    expect(document.getElementById(attentionTab.getAttribute('aria-controls')).hidden).toBe(false);
    expect(document.getElementById(workspaceTab.getAttribute('aria-controls')).hidden).toBe(true);
    expect(screen.getByRole('region', { name: 'Attention' })).toBeTruthy();

    fireEvent.keyDown(attentionTab, { key: 'Home' });
    expect(workspaceTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(workspaceTab);
    fireEvent.keyDown(workspaceTab, { key: 'End' });
    expect(attentionTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(attentionTab, { key: 'ArrowLeft' });
    expect(workspaceTab.getAttribute('aria-selected')).toBe('true');

    // El canvas operativo (PTY/AgentPanel) no se remonta ni se oculta por cambiar de subvista.
    expect(screen.getByTestId('pty-sentinel')).toBe(pty);
    rerender(shell({ active: false }));
    expect(screen.getByTestId('pty-sentinel')).toBe(pty);
    expect(screen.getByTestId('execution-composition').getAttribute('aria-hidden')).toBe('false');
  });

  it('separa las claves de consulta y no sondea Attention mientras la subvista, o el ADE, no están activos', async () => {
    vi.useFakeTimers();
    core(detailOf(), { attention: () => attentionPage([att()]) });
    const { rerender } = render(shell());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Repo Real' }));
    await flush();

    // Subvista Workspace: ni consulta ni sondeo de Attention; sus consultas siguen siendo las de siempre.
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(attentionCalls()).toHaveLength(0);
    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'projects_overview').every(([, args]) => args.archived === 'exclude')).toBe(true);

    openAttentionTab();
    await flush();
    expect(attentionCalls()).toHaveLength(1);
    expect(attentionCalls()[0][1]).toEqual({ projectId: null, targetKind: null, targetId: null, category: null, severity: null });
    // Los contadores del inbox usan su propia clave (`include`), distinta de la del navegador (`exclude`).
    expect(queryAdeCore.mock.calls.filter(([query, args]) => query === 'projects_overview' && args.archived === 'include')).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(attentionCalls()).toHaveLength(2);

    // De vuelta a Workspace, o con el ADE inactivo (vista Runs), el sondeo se detiene.
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    const afterWorkspace = attentionCalls().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(attentionCalls()).toHaveLength(afterWorkspace);

    openAttentionTab();
    await flush();
    const afterReopen = attentionCalls().length;
    expect(afterReopen).toBeGreaterThan(afterWorkspace);
    rerender(shell({ active: false }));
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(attentionCalls()).toHaveLength(afterReopen);
  });

  it('el enlace Attention de la Task abre la vista filtrada por target en el Core, sin filtrar localmente', async () => {
    const other = att({ id: 'att_otra', target_id: 'task-ajena' });
    core(detailOf(), {
      // El Core (fixture) aplica el filtro; la UI muestra tal cual lo que devuelve.
      attention: (args) => attentionPage(args.targetId ? [att({ id: 'att_propia' })] : [att({ id: 'att_propia' }), other]),
    });
    const onActivate = vi.fn();
    render(shell({ onActivate }));
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });
    onActivate.mockClear();

    fireEvent.click(screen.getAllByRole('button', { name: `Abrir Attention de la Task ${ITEM.id}` })[1]);
    await flush();

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tab', { name: 'Attention' }).getAttribute('aria-selected')).toBe('true');
    expect(attentionCalls().at(-1)[1]).toEqual({ projectId: null, targetKind: 'task', targetId: ITEM.id, category: null, severity: null });
    const filter = screen.getByRole('group', { name: 'Filtro por target' });
    expect(filter.textContent).toContain(`Task ${ITEM.id}`);
    expect(attentionRows().map((row) => row.querySelector('[data-attention-id]').dataset.attentionId)).toEqual(['att_propia']);
    expect(screen.getByTestId('attention-total').textContent).toBe('1');

    fireEvent.click(within(filter).getByRole('button', { name: `Quitar el filtro por Task ${ITEM.id}` }));
    await flush();
    expect(screen.queryByRole('group', { name: 'Filtro por target' })).toBeNull();
    expect(attentionCalls().at(-1)[1].targetId).toBeNull();
    expect(attentionRows()).toHaveLength(2);
  });

  it('conserva target y filtros durante stale/reconexión y no los pierde al recuperar', async () => {
    vi.useFakeTimers();
    let failing = false;
    core(detailOf(), {
      attention: () => {
        if (failing) throw new Error('ade_query_timeout: Core no respondió a tiempo');
        return attentionPage([att({ id: 'att_propia', category: 'approval' })]);
      },
    });
    render(shell());
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Repo Real' }));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Task Real' }));
    await flush();
    fireEvent.click(screen.getAllByRole('button', { name: `Abrir Attention de la Task ${ITEM.id}` })[0]);
    await flush();
    fireEvent.change(screen.getByLabelText('Categoría'), { target: { value: 'approval' } });
    await flush();
    expect(attentionCalls().at(-1)[1]).toMatchObject({ targetKind: 'task', targetId: ITEM.id, category: 'approval' });

    failing = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByText(/Attention desactualizada: Core desconectado/)).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Filtro por target' }).textContent).toContain(ITEM.id);
    expect(screen.getByLabelText('Categoría').value).toBe('approval');
    expect(attentionRows()).toHaveLength(1);

    failing = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.queryByText(/Attention desactualizada/)).toBeNull();
    expect(screen.getByRole('group', { name: 'Filtro por target' })).toBeTruthy();
    expect(attentionCalls().at(-1)[1]).toMatchObject({ targetKind: 'task', targetId: ITEM.id, category: 'approval' });
  });

  it('enruta cada fila solo por su par (kind, id) durable y verifica el tipo exacto', async () => {
    const rows = [
      att({ id: 'att_project', target_kind: 'project', target_id: 'project-otro', project_id: 'project-otro', created_at: 1 }),
      att({ id: 'att_task', target_kind: 'task', target_id: 'task-otra', project_id: 'project-otro', created_at: 2 }),
      att({ id: 'att_sin_project', target_kind: 'task', target_id: 'task-huerfana', project_id: null, created_at: 3 }),
      att({ id: 'att_run', target_kind: 'run', target_id: 'run-7', created_at: 4 }),
      att({ id: 'att_spawn', target_kind: 'spawn_request', target_id: 'pend-9', category: 'approval', created_at: 5 }),
      att({ id: 'att_worktree', target_kind: 'worktree', target_id: 'wt-1', created_at: 6 }),
    ];
    core(detailOf(), { attention: () => attentionPage(rows) });
    const onActivate = vi.fn();
    const onOpenRun = vi.fn(() => true);
    const onOpenSpawnRequest = vi.fn(() => false);
    render(shell({ onActivate, onOpenRun, onOpenSpawnRequest }));
    await flush();
    openAttentionTab();
    await flush();
    const row = (id) => document.querySelector(`[data-attention-id="${id}"]`);

    fireEvent.click(row('att_run'));
    expect(onOpenRun.mock.calls).toEqual([['run-7']]);
    expect(onOpenSpawnRequest).not.toHaveBeenCalled();
    expect(screen.queryByText(/ya no está disponible/)).toBeNull();

    // `spawn_request` solo por su callback; si el pendiente ya no existe, se dice y no se navega a otro.
    fireEvent.click(row('att_spawn'));
    expect(onOpenSpawnRequest.mock.calls).toEqual([['pend-9']]);
    expect(onOpenRun).toHaveBeenCalledTimes(1);
    expect(screen.getByText('La solicitud de lanzamiento pend-9 ya no está disponible en esta superficie.')).toBeTruthy();

    fireEvent.click(row('att_worktree'));
    expect(screen.getByText(/aún no abre destinos de tipo worktree \(wt-1\)/)).toBeTruthy();
    fireEvent.click(row('att_sin_project'));
    expect(screen.getByText(/no trae Project/)).toBeTruthy();
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.click(row('att_task'));
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: 'project-otro', taskId: 'task-otra' });
    expect(screen.getByRole('tab', { name: 'Workspace' }).getAttribute('aria-selected')).toBe('true');
    expect(onActivate).toHaveBeenCalledTimes(1);

    openAttentionTab();
    await flush();
    fireEvent.click(row('att_project'));
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: 'project-otro', taskId: null });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it('sin callbacks de Operación, run y spawn_request se declaran no disponibles en vez de navegar', async () => {
    core(detailOf(), { attention: () => attentionPage([att({ id: 'att_run', target_kind: 'run', target_id: 'run-7' })]) });
    render(shell());
    await flush();
    openAttentionTab();
    await flush();

    fireEvent.click(document.querySelector('[data-attention-id="att_run"]'));
    expect(screen.getByText('El Run run-7 ya no está disponible en esta superficie.')).toBeTruthy();
  });
});
