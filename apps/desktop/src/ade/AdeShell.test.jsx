import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdeShell } from './AdeShell';
import { queryAdeCore } from './coreQueries';
import { useWorkbenchStore } from '../store/workbenchStore';

// Vitest omite CSS por defecto; cargar las fuentes mantiene sus reglas reales en esta prueba.
// Con `--environment jsdom` el `URL` global no es el de Node y `readFileSync(new URL(...))` falla: se resuelve por ruta.
const here = dirname(fileURLToPath(import.meta.url));
const adeShellStyles = readFileSync(resolve(here, 'AdeShell.css'), 'utf8');
const orchStyles = readFileSync(resolve(here, '../styles/orch.css'), 'utf8');

// Solo se sustituye el transporte; los códigos y constantes del contrato son los reales.
vi.mock('./coreQueries', async (importOriginal) => ({ ...(await importOriginal()), queryAdeCore: vi.fn() }));

// FIXTURES con la forma del contrato de docs/core/QUERIES.md; no son una lectura de Core real ni dogfood.

const PROJECT = {
  id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active',
  counts: { tasks: 2, active: 1, failed: 0, attention: { total: 1, by_category: { question: 1 } } },
  locations: [{ machine: 'machine-real', path: 'C:/repos/repo-real', primary: true, state: 'ok', last_seen: 1760000000000 }],
};
const ITEM = { id: 'task-uuid-1', run_id: 'run-1', parent_id: null, root_id: 'task-uuid-1', status: 'running', title: 'Task Real', provider: 'claude', model: null, created_at: 1, updated_at: 2 };
const FINAL_ITEM = { ...ITEM, id: 'task-uuid-final', status: 'done', title: 'Task Final' };
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
    if (query === 'tasks_by_project') return {
      v: 1, project_id: PROJECT.id, filters: { status: args.status }, limit: 50,
      tasks: args.status === 'all' ? [ITEM, FINAL_ITEM] : [ITEM], has_more: false, next_cursor: null,
    };
    if (query === 'task_detail') return detail;
    if (query === 'attention_list') return attention(args);
    throw new Error(`Query no permitida en fixture: ${query}`);
  });
}

const attentionCalls = () => queryAdeCore.mock.calls.filter(([query]) => query === 'attention_list');
// El Project View consulta Attention acotada al Project (projectId durable); el Attention Inbox global no lleva Project.
const projectAttentionCalls = () => attentionCalls().filter(([, args]) => args.projectId === PROJECT.id);
const inboxAttentionCalls = () => attentionCalls().filter(([, args]) => args.projectId === null);
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const attentionRows = () => within(screen.getByRole('list', { name: 'Attention activa' })).getAllByRole('listitem');
const openAttentionTab = () => fireEvent.click(screen.getByRole('tab', { name: 'Attention' }));

const operation = <div data-testid="operation-canvas"><span data-testid="pty-sentinel" /></div>;
const shell = (props = {}) => (
  <AdeShell active leftOpen rightOpen drawerOpen={false} operationWorkspace={operation} {...props} />
);
let adeShellStyleElement;

const pickTask = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Repo Real' }));
  const taskNav = await screen.findByRole('region', { name: `Tasks del Project ${PROJECT.id}` });
  fireEvent.click(await within(taskNav).findByRole('button', { name: 'Task Real' }));
};

beforeEach(() => {
  adeShellStyleElement = document.createElement('style');
  adeShellStyleElement.textContent = adeShellStyles;
  document.head.appendChild(adeShellStyleElement);
  useWorkbenchStore.setState({ adeSelection: { projectId: null, taskId: null } });
});
afterEach(() => {
  cleanup();
  adeShellStyleElement.remove();
  vi.useRealTimers();
  queryAdeCore.mockReset();
});

describe('AdeShell · navegación con listas grandes (LXO-95)', () => {
  it('mantiene Operación en una región propia y alcanzable con muchos Projects y Tasks', async () => {
    adeShellStyleElement.textContent = `${orchStyles}\n${adeShellStyles}`;
    const projects = Array.from({ length: 32 }, (_, index) => ({
      ...PROJECT,
      id: `project-${index}`,
      name: `Repo ${index}`,
    }));
    const tasks = Array.from({ length: 50 }, (_, index) => ({
      ...ITEM,
      id: `task-${index}`,
      title: `Task ${index}`,
    }));
    queryAdeCore.mockImplementation(async (query, args) => {
      if (query === 'projects_overview') return {
        v: 1, filters: { archived: args.archived, machine: null }, total: projects.length, projects, unassigned: {},
      };
      if (query === 'tasks_by_project') return {
        v: 1, project_id: args.project_id, filters: { status: args.status }, limit: 50, tasks, has_more: false, next_cursor: null,
      };
      if (query === 'task_detail') return detailOf();
      if (query === 'attention_list') return attentionPage([]);
      throw new Error(`Query no permitida en fixture: ${query}`);
    });

    render(shell({
      operationNavigation: (
        <section aria-label="Operación">
          <button type="button">Aprobar spawn pendiente</button>
          <button type="button">Run anterior</button>
        </section>
      ),
    }));

    const projectsRegion = await screen.findByRole('region', { name: 'Projects y Tasks' });
    expect(within(projectsRegion).getAllByRole('button', { name: /^Repo / })).toHaveLength(32);
    fireEvent.click(within(projectsRegion).getByRole('button', { name: 'Repo 0' }));
    const tasksRegion = await screen.findByRole('region', { name: 'Tasks del Project project-0' });
    await within(tasksRegion).findByRole('button', { name: 'Task 49' });
    expect(within(tasksRegion).getAllByRole('button', { name: /^Task / })).toHaveLength(50);

    const operationRegion = screen.getByRole('region', { name: 'Navegación de Operación' });
    expect(within(operationRegion).getByRole('button', { name: 'Aprobar spawn pendiente' })).toBeTruthy();
    expect(within(operationRegion).getByRole('button', { name: 'Run anterior' })).toBeTruthy();
    expect(projectsRegion.parentElement).toBe(operationRegion.parentElement);
    expect(projectsRegion.tabIndex).toBe(0);
    expect(operationRegion.tabIndex).toBe(0);

    const navigationContentStyle = getComputedStyle(projectsRegion.parentElement);
    expect(navigationContentStyle.display).toBe('flex');
    expect(navigationContentStyle.flexDirection).toBe('column');
    expect(navigationContentStyle.flexGrow).toBe('1');
    expect(navigationContentStyle.minHeight).toBe('0px');
    expect(navigationContentStyle.maxHeight).toBe('100%');
    expect(navigationContentStyle.overflow).toBe('hidden');
    for (const region of [projectsRegion, operationRegion]) {
      const style = getComputedStyle(region);
      expect(style.overflowX).toBe('hidden');
      expect(style.overflowY).toBe('auto');
      expect(style.minHeight).toBe('0px');
      expect(style.maxHeight).toBe('100%');
    }

    projectsRegion.focus();
    expect(document.activeElement).toBe(projectsRegion);
    operationRegion.focus();
    expect(document.activeElement).toBe(operationRegion);
  });
});

describe('AdeShell · Project View (LXO-204)', () => {
  it('abre por el ID durable y muestra metadata real del overview, Tasks all y slices pendientes', async () => {
    core(detailOf(), { attention: () => attentionPage([att({ id: 'att-project-1' })]) });
    render(shell());

    fireEvent.click(await screen.findByRole('button', { name: 'Repo Real' }));
    const projectView = await screen.findByTestId('project-view');
    await within(projectView).findByTestId('location-machine');
    await within(projectView).findByTestId('attention-att-project-1');

    expect(within(projectView).getByRole('heading', { level: 2, name: 'Repo Real' })).toBeTruthy();
    expect(within(projectView).getByTestId('project-id').textContent).toBe(PROJECT.id);
    expect(within(projectView).getByTestId('location-machine').textContent).toBe('machine-real');
    expect(within(projectView).getByTestId('location-path').textContent).toBe('C:/repos/repo-real');
    expect(within(projectView).getByTestId('location-state').dataset.state).toBe('ok');
    expect(within(projectView).getByTestId('location-last-seen').querySelector('time').dateTime)
      .toBe(new Date(PROJECT.locations[0].last_seen).toISOString());
    expect(within(projectView).getByTestId('count-tasks').querySelector('dd').textContent).toBe('2');
    expect(within(projectView).getByTestId('count-attention').querySelector('dd').textContent).toBe('1');
    for (const name of ['attempts', 'resources']) {
      const count = within(projectView).getByTestId(`count-${name}`).querySelector('dd');
      expect(count.textContent).toBe('—');
      expect(count.getAttribute('aria-label')).toBe('No informado por Core');
    }
    expect(within(projectView).getByTestId('attention-kind').textContent).toBe('question');
    expect(within(projectView).getByText('Core no suministró texto para esta Attention.')).toBeTruthy();
    expect(within(projectView).getByRole('region', { name: /Activity/ }).querySelector('[data-testid="slice-notice"]').textContent)
      .toContain('Backlog (LXO-92)');
    expect(within(projectView).getByRole('region', { name: 'Resources' }).querySelector('[data-testid="slice-notice"]').textContent)
      .toContain('Backlog (LXO-93)');

    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'tasks_by_project'))
      .toContainEqual(['tasks_by_project', { projectId: PROJECT.id, status: 'all' }]);
    expect(attentionCalls().some(([, args]) => args.projectId === PROJECT.id)).toBe(true);

    fireEvent.click(within(projectView).getByTestId('filter-all'));
    expect(within(projectView).getByTestId(`task-${FINAL_ITEM.id}`)).toBeTruthy();
    fireEvent.click(within(projectView).getByTestId(`open-task-${FINAL_ITEM.id}`));
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: FINAL_ITEM.id });
  });

  it('consulta Tasks all solo mientras está abierto el Project View y conserva la query activa del navegador', async () => {
    vi.useFakeTimers();
    core(detailOf());
    render(shell());
    await flush();
    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'tasks_by_project')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Repo Real' }));
    await flush();
    const taskCalls = () => queryAdeCore.mock.calls.filter(([query]) => query === 'tasks_by_project');
    const allReads = () => taskCalls().filter(([, args]) => args.status === 'all');
    const activeReads = () => taskCalls().filter(([, args]) => args.status === 'active');
    expect(allReads()).toHaveLength(1);
    expect(activeReads()).toHaveLength(1);

    fireEvent.click(within(screen.getByRole('region', { name: `Tasks del Project ${PROJECT.id}` })).getByRole('button', { name: 'Task Real' }));
    await flush();
    const allReadsAfterTaskSelection = allReads().length;
    const activeReadsAfterTaskSelection = activeReads().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

    expect(allReads()).toHaveLength(allReadsAfterTaskSelection);
    expect(activeReads().length).toBeGreaterThan(activeReadsAfterTaskSelection);
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: ITEM.id });
  });

  it('abre Attention desde su DTO con el par exacto (kind, target_id)', async () => {
    const row = att({ id: 'att-project-route', target_kind: 'task', target_id: ITEM.id });
    core(detailOf(), { attention: () => attentionPage([row]) });
    render(shell());

    fireEvent.click(await screen.findByRole('button', { name: 'Repo Real' }));
    fireEvent.click(await screen.findByTestId('open-attention-att-project-route'));
    await flush();

    expect(screen.getByRole('tab', { name: 'Attention' }).getAttribute('aria-selected')).toBe('true');
    expect(attentionCalls().at(-1)[1]).toEqual({
      projectId: null, targetKind: 'task', targetId: ITEM.id, category: null, severity: null,
    });
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: null });
    expect(screen.queryByRole('button', { name: /Abrir Attempt/ })).toBeNull();
  });

  it('no convierte un error de tasks_by_project en una lista vacía exitosa', async () => {
    queryAdeCore.mockImplementation(async (query, args) => {
      if (query === 'projects_overview') return { v: 1, filters: { archived: args.archived, machine: null }, total: 1, projects: [PROJECT], unassigned: {} };
      if (query === 'tasks_by_project' && args.status === 'all') throw new Error('tasks_by_project_read_failed');
      if (query === 'tasks_by_project') return { v: 1, project_id: PROJECT.id, filters: { status: args.status }, limit: 50, tasks: [ITEM], has_more: false, next_cursor: null };
      if (query === 'attention_list') return attentionPage([]);
      if (query === 'task_detail') return detailOf();
      throw new Error(`Query no permitida en fixture: ${query}`);
    });
    render(shell());

    fireEvent.click(await screen.findByRole('button', { name: 'Repo Real' }));
    const projectView = await screen.findByTestId('project-view');
    const tasksRegion = within(projectView).getByRole('region', { name: /^Tasks/ });
    expect((await within(tasksRegion).findByRole('alert')).textContent).toContain('tasks_by_project_read_failed');
    expect(within(tasksRegion).queryByTestId('tasks-empty')).toBeNull();
    expect(within(tasksRegion).queryByTestId('tasks-filtered-empty')).toBeNull();
  });
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

  it('Activity y Attention se sirven en el shell y no usan la AttentionList legacy', async () => {
    core(detailOf());
    render(shell());
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });

    const lists = screen.getAllByRole('list', { name: 'Contexto de la Task' });
    expect(lists).toHaveLength(2);
    for (const list of lists) {
      for (const key of ['activity', 'attention']) {
        const entry = list.querySelector(`[data-context="${key}"]`);
        expect(entry.getAttribute('data-available')).toBe('true');
        expect(entry.textContent).not.toContain('No disponible');
      }
      expect(within(list).getAllByRole('button')).toHaveLength(2);
    }
    expect(screen.queryByRole('region', { name: /Attention/i })).toBeNull();
  });

  it('navegar a una Task hija del mismo Project confirma la aceptación, selecciona el ID exacto y mueve el foco al encabezado', async () => {
    const CHILD = { ...ITEM, id: 'task-uuid-child', parent_id: ITEM.id, title: 'Hija Real' };
    queryAdeCore.mockImplementation(async (query, args) => {
      if (query === 'projects_overview') return { v: 1, filters: { archived: args.archived, machine: null }, total: 1, projects: [PROJECT], unassigned: {} };
      if (query === 'tasks_by_project') return { v: 1, project_id: PROJECT.id, filters: { status: args.status }, limit: 50, tasks: args.status === 'all' ? [ITEM, FINAL_ITEM] : [ITEM], has_more: false, next_cursor: null };
      if (query === 'task_detail') {
        return args.taskId === CHILD.id
          ? detailOf({ ...CHILD, root_id: ITEM.id, child_ids: [] })
          : detailOf({ child_ids: [CHILD.id] });
      }
      if (query === 'attention_list') return attentionPage([]);
      throw new Error(`Query no permitida en fixture: ${query}`);
    });
    render(shell());
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });

    fireEvent.click(screen.getAllByRole('button', { name: `Abrir Task hija ${CHILD.id}` })[0]);

    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: CHILD.id });
    const headings = await screen.findAllByRole('heading', { level: 2, name: 'Hija Real' });
    expect(headings).toHaveLength(2);
    expect(headings).toContain(document.activeElement);
  });

  it('rechaza la navegación a la misma Task seleccionada y conserva el foco en el enlace', async () => {
    core(detailOf({ child_ids: [ITEM.id] }));
    const onActivate = vi.fn();
    render(shell({ onActivate }));
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });

    const sameTask = screen.getAllByRole('button', { name: `Abrir Task hija ${ITEM.id}` })[0];
    onActivate.mockClear();
    sameTask.focus();
    fireEvent.click(sameTask);

    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: ITEM.id });
    expect(onActivate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(sameTask);
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
    const activityTab = within(tablist).getByRole('tab', { name: 'Activity' });
    fireEvent.keyDown(workspaceTab, { key: 'End' });
    expect(activityTab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(activityTab);
    fireEvent.keyDown(activityTab, { key: 'ArrowRight' });
    expect(workspaceTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(workspaceTab, { key: 'ArrowLeft' });
    expect(activityTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(activityTab, { key: 'ArrowLeft' });
    expect(attentionTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(attentionTab, { key: 'Home' });
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

    // Subvista Workspace con un Project abierto: solo sondea la Attention del Project; el Inbox global ni se consulta.
    const projectOnOpen = projectAttentionCalls().length;
    expect(projectOnOpen).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(inboxAttentionCalls()).toHaveLength(0);
    expect(projectAttentionCalls().length).toBeGreaterThan(projectOnOpen);
    expect(attentionCalls()).toHaveLength(projectAttentionCalls().length);
    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'projects_overview').every(([, args]) => args.archived === 'exclude')).toBe(true);

    // Subvista Attention: el Inbox global consulta y sondea; la consulta del Project se detiene.
    openAttentionTab();
    await flush();
    expect(inboxAttentionCalls()).toHaveLength(1);
    expect(inboxAttentionCalls()[0][1]).toEqual({ projectId: null, targetKind: null, targetId: null, category: null, severity: null });
    // Los contadores del inbox usan su propia clave (`include`), distinta de la del navegador (`exclude`).
    expect(queryAdeCore.mock.calls.filter(([query, args]) => query === 'projects_overview' && args.archived === 'include')).toHaveLength(1);
    const projectInAttention = projectAttentionCalls().length;

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(inboxAttentionCalls()).toHaveLength(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(projectAttentionCalls()).toHaveLength(projectInAttention);

    // De vuelta a Workspace, el Inbox se detiene y el Project retoma su sondeo.
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    await flush();
    const inboxAfterWorkspace = inboxAttentionCalls().length;
    const projectAfterWorkspace = projectAttentionCalls().length;
    expect(projectAfterWorkspace).toBeGreaterThan(projectInAttention);
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(inboxAttentionCalls()).toHaveLength(inboxAfterWorkspace);
    expect(projectAttentionCalls().length).toBeGreaterThan(projectAfterWorkspace);

    // Con el ADE inactivo (vista Runs) se detiene el Project View; al reactivarlo se reanuda.
    rerender(shell({ active: false }));
    await flush();
    const projectWhenInactive = projectAttentionCalls().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(projectAttentionCalls()).toHaveLength(projectWhenInactive);
    expect(inboxAttentionCalls()).toHaveLength(inboxAfterWorkspace);
    rerender(shell());
    await flush();
    expect(projectAttentionCalls().length).toBeGreaterThan(projectWhenInactive);

    // Lo mismo para el Inbox: se reanuda en la subvista Attention y se detiene con el ADE inactivo.
    openAttentionTab();
    await flush();
    const inboxAfterReopen = inboxAttentionCalls().length;
    expect(inboxAfterReopen).toBeGreaterThan(inboxAfterWorkspace);
    rerender(shell({ active: false }));
    await flush();
    const inboxWhenInactive = inboxAttentionCalls().length;
    const projectEnd = projectAttentionCalls().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(inboxAttentionCalls()).toHaveLength(inboxWhenInactive);
    expect(projectAttentionCalls()).toHaveLength(projectEnd);
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
    fireEvent.click(within(screen.getByRole('region', { name: `Tasks del Project ${PROJECT.id}` })).getByRole('button', { name: 'Task Real' }));
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

// Activity (LXO-99): la subvista monta ActivityPanel con alcance derivado de los IDs durables seleccionados.
const activityItem = (seq, over = {}) => ({
  seq: String(seq), event_id: `event-${seq}`, ts: 1_800_000_000_000, kind: 'task.created', v: 1, class: 'state',
  message_key: 'activity.task.created', args: { title: `Tarea ${seq}`, agent: 'codex', depth: 0, external: false },
  visual: 'info', fallback: false, target: { kind: 'task', id: ITEM.id }, project_id: PROJECT.id, run_id: 'run-1',
  actor: { kind: 'system', id: null }, provenance: { channel: 'core', client_id: 'core-system' }, correlation_id: null, ...over,
});
const activityPage = (items) => ({
  v: 1, projection: 1, order: 'desc', items, next_cursor: items.at(-1)?.seq ?? '0', has_more: false, head_seq: items[0]?.seq ?? '0', limit: 100,
});
function coreWithActivity(items = [activityItem(3)]) {
  core(detailOf());
  const base = queryAdeCore.getMockImplementation();
  queryAdeCore.mockImplementation(async (query, args) => (query === 'activity_list' ? activityPage(items) : base(query, args)));
}
const activityCalls = () => queryAdeCore.mock.calls.filter(([query]) => query === 'activity_list').map(([, args]) => args);
const openActivityTab = () => fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
const scopeButton = (name) => within(screen.getByRole('group', { name: 'Alcance de Activity' })).getByRole('button', { name });

describe('AdeShell · subvista Activity (LXO-99)', () => {
  it('monta ActivityPanel solo al abrir la subvista y consulta el alcance global sin selección', async () => {
    coreWithActivity([activityItem('9007199254740993')]);
    render(shell());
    await flush();
    expect(activityCalls()).toEqual([]);

    openActivityTab();
    await flush();

    expect(await screen.findByTestId('activity-list')).toBeTruthy();
    expect(activityCalls()).toEqual([{ cursor: '0', limit: 100, order: 'desc', projectId: null, runId: null, targetKind: null, targetId: null }]);
    expect(screen.getByTestId('activity-event-9007199254740993').getAttribute('data-seq')).toBe('9007199254740993');
    expect(scopeButton('Global').getAttribute('aria-pressed')).toBe('true');
    expect(scopeButton('Project').disabled).toBe(true);
    expect(scopeButton('Task').disabled).toBe(true);
    expect(document.getElementById(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-controls')).hidden).toBe(false);
  });

  it('usa el Project seleccionado y permite pasar a Global sin perder la selección', async () => {
    coreWithActivity();
    render(shell());
    fireEvent.click(await screen.findByRole('button', { name: 'Repo Real' }));
    openActivityTab();
    await flush();
    await screen.findByTestId('activity-list');

    expect(scopeButton('Project').getAttribute('aria-pressed')).toBe('true');
    expect(activityCalls().at(-1)).toMatchObject({ projectId: PROJECT.id, targetKind: null, targetId: null });
    expect(scopeButton('Task').disabled).toBe(true);
    expect(screen.getByTestId('activity-scope-id').textContent).toBe(PROJECT.id);

    fireEvent.click(scopeButton('Global'));
    await flush();
    expect(activityCalls().at(-1)).toMatchObject({ projectId: null, targetKind: null, targetId: null });
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: null });
  });

  it('el enlace Activity de la Task abre la subvista con alcance Task y llama al callback con los IDs exactos', async () => {
    coreWithActivity();
    const onOpenTaskActivity = vi.fn();
    render(shell({ onOpenTaskActivity }));
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });
    const pty = screen.getByTestId('pty-sentinel');

    fireEvent.click(screen.getAllByRole('button', { name: `Abrir Activity de la Task ${ITEM.id}` })[0]);
    await flush();

    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
    expect(scopeButton('Task').getAttribute('aria-pressed')).toBe('true');
    expect(activityCalls().at(-1)).toMatchObject({ projectId: null, targetKind: 'task', targetId: ITEM.id });
    expect(onOpenTaskActivity.mock.calls).toEqual([[{ projectId: PROJECT.id, taskId: ITEM.id }]]);
    expect(screen.getByTestId('pty-sentinel')).toBe(pty);
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: ITEM.id });
  });

  it('mueve el foco a la pestaña Activity tras la acción de la Task y no lo roba en la selección ordinaria', async () => {
    coreWithActivity();
    render(shell());
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });
    const activityTab = screen.getByRole('tab', { name: 'Activity' });
    expect(document.activeElement).not.toBe(activityTab);

    const action = screen.getAllByRole('button', { name: `Abrir Activity de la Task ${ITEM.id}` })[0];
    action.focus();
    expect(document.activeElement).toBe(action);
    fireEvent.click(action);
    await flush();

    expect(activityTab.getAttribute('aria-selected')).toBe('true');
    expect(activityTab.tabIndex).toBe(0);
    expect(document.activeElement).toBe(activityTab);

    // Actualizaciones de fondo y cambios de alcance no vuelven a mover el foco.
    const globalScope = scopeButton('Global');
    globalScope.focus();
    await flush();
    expect(document.activeElement).toBe(globalScope);
    fireEvent.click(globalScope);
    await flush();
    expect(document.activeElement).toBe(globalScope);
  });

  it('no sondea Activity al salir de la subvista ni con el ADE inactivo y conserva el canvas operativo', async () => {
    vi.useFakeTimers();
    coreWithActivity();
    const { rerender } = render(shell());
    openActivityTab();
    await flush();
    const pty = screen.getByTestId('pty-sentinel');
    const initial = activityCalls().length;
    expect(initial).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(activityCalls()).toHaveLength(initial);

    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    await flush();
    rerender(shell({ active: false }));
    await flush();
    const afterInactive = activityCalls().length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(activityCalls()).toHaveLength(afterInactive);
    expect(screen.getByTestId('pty-sentinel')).toBe(pty);
  });

  it('abre un Project desde un destino de Activity solo si existe en el overview, por su ID exacto', async () => {
    coreWithActivity([activityItem(5, {
      target: { kind: 'project', id: PROJECT.id },
      kind: 'project.registered',
      message_key: 'activity.project.registered',
      args: { name: 'Repo Real', origin: 'auto' },
    })]);
    const onActivate = vi.fn();
    render(shell({ onActivate }));
    await flush();
    openActivityTab();
    await flush();

    fireEvent.click(await screen.findByTestId('activity-target-event-5'));

    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: null });
    expect(screen.getByRole('tab', { name: 'Workspace' }).getAttribute('aria-selected')).toBe('true');
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('no adivina el Project de una Task ajena: avisa y conserva la selección', async () => {
    coreWithActivity([activityItem(5, { target: { kind: 'task', id: 'task-otra' } })]);
    render(shell());
    await flush();
    openActivityTab();
    await flush();

    fireEvent.click(await screen.findByTestId('activity-target-event-5'));

    expect(screen.getByText('La Task task-otra no se puede abrir desde Activity: el evento no identifica su Project.')).toBeTruthy();
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
  });

  it('muestra el texto seguro de un evento desconocido que Core marca fallback=true', async () => {
    coreWithActivity([activityItem(9, {
      kind: 'task.teleported',
      message_key: 'activity.unknown',
      fallback: true,
      args: { reason: 'unknown_kind', kind: 'task.teleported', event_version: 1 },
    })]);
    render(shell());
    await flush();
    openActivityTab();
    await flush();

    expect((await screen.findByTestId('activity-message-event-9')).textContent)
      .toBe('No se reconoce el evento «task.teleported» (versión 1, motivo: unknown_kind).');
  });
});
