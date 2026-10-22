import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AdeShell } from './AdeShell';
import { queryAdeCore, readAdeTask } from './coreQueries';
import { useWorkbenchStore } from '../store/workbenchStore';

// Vitest omite CSS por defecto; cargar las fuentes mantiene sus reglas reales en esta prueba.
const sourceRoot = [resolve(process.cwd(), 'src'), resolve(process.cwd(), 'apps/desktop/src')]
  .find((candidate) => existsSync(resolve(candidate, 'ade/AdeShell.css')));
if (!sourceRoot) throw new Error('No se encontró el origen de CSS de ADE desde el directorio actual.');
const adeShellStyles = readFileSync(resolve(sourceRoot, 'ade/AdeShell.css'), 'utf8');
const orchStyles = readFileSync(resolve(sourceRoot, 'styles/orch.css'), 'utf8');

// Solo se sustituye el transporte; los códigos y constantes del contrato son los reales.
// `readAdeTask` delega en el mismo transporte simulado: lee `task_detail` por el par durable, igual que el real.
// Se espía aparte de `queryAdeCore` porque son dos canales distintos: la verificación de Activity
// (`readAdeTask`) y las lecturas del shell (`useCoreQuery` → `queryAdeCore`). Contarlos juntos mezclaría
// una lectura del shell con una verificación de un destino.
// Como ambos canales pasan por el mismo mock de transporte, cada registro de llamada emitido por la
// verificación se conserva por identidad. Así el canal del shell se mide sin contar las verificaciones.
const transport = vi.hoisted(() => ({ verificationQueryCalls: new Set() }));

vi.mock('./coreQueries', async (importOriginal) => {
  const queryAdeCore = vi.fn();
  const readAdeTask = vi.fn((projectId, taskId) => {
    // Marca el registro exacto aunque el transporte lance sincrónicamente.
    const callIndex = queryAdeCore.mock.calls.length;
    try {
      return queryAdeCore('task_detail', { projectId, taskId });
    } finally {
      transport.verificationQueryCalls.add(queryAdeCore.mock.calls[callIndex]);
    }
  });
  return {
    ...(await importOriginal()),
    queryAdeCore,
    readAdeTask,
  };
});

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

// DTO de `resource_inventory` con la FORMA del contrato (docs/core/RESOURCES.md): lo que da el Core,
// tal cual. No es una lectura real de Core ni dogfood.
const INVENTORY = {
  v: 1,
  machine: 'machine-real',
  filters: { project_id: PROJECT.id, probe: true },
  repos: [{ project_id: PROJECT.id, machine: 'machine-real', path: 'C:/repos/repo-real', scan: 'ok' }],
  worktrees: [{
    target: { machine: 'machine-real', project_id: PROJECT.id, repo: 'C:/repos/repo-real', path: 'C:/repos/repo-real.lixbon-wt/wt-1' },
    state: 'tracked', origin: 'task', physical: 'present',
    git: { registered: true, branch: 'lxo/x', detached: false, locked: false, prunable: false },
    owner: { task_id: ITEM.id, run_id: 'run-1', status: 'running' },
    dirty: 'clean', merged: 'unknown', into: 'main', needs_review: false,
  }],
  preserved_branches: [],
  warnings: {
    branches_to_review: 0,
    worktrees_by_state: { tracked: 1, missing_on_disk: 0, not_registered: 0, orphan_candidate: 0, external: 0, unknown: 0 },
  },
};

const projectActivityPage = (items, args = {}) => ({
  v: 1, projection: 'activity.v1', order: 'desc', items, next_cursor: '0', has_more: false, head_seq: '0', limit: args.limit ?? 20,
});
const ACTIVITY_EVENT = {
  seq: '7', event_id: 'evt-project-1', ts: Date.UTC(2026, 9, 21, 15, 0, 0), kind: 'task.created', v: 1, class: 'task',
  message_key: 'no.such.key', args: {}, visual: 'neutral', fallback: false,
  target: { kind: 'task', id: 'task-durable-1' }, project_id: 'project-durable-1',
};

function core(detail, { attention = () => attentionPage([]), inventory = () => INVENTORY, activity = (args) => projectActivityPage([], args) } = {}) {
  queryAdeCore.mockImplementation(async (query, args) => {
    if (query === 'projects_overview') return { v: 1, filters: { archived: args.archived, machine: null }, total: 1, projects: [PROJECT], unassigned: {} };
    if (query === 'tasks_by_project') return {
      v: 1, project_id: PROJECT.id, filters: { status: args.status }, limit: 50,
      tasks: args.status === 'all' ? [ITEM, FINAL_ITEM] : args.status === 'final' ? [FINAL_ITEM] : [ITEM],
      has_more: false, next_cursor: null,
    };
    if (query === 'task_detail') return detail;
    if (query === 'attention_list') return attention(args);
    if (query === 'resource_inventory') return inventory(args);
    if (query === 'activity_list') return activity(args);
    throw new Error(`Query no permitida en fixture: ${query}`);
  });
}

const attentionCalls = () => queryAdeCore.mock.calls.filter(([query]) => query === 'attention_list');
// El Project View consulta Attention acotada al Project (projectId durable); el Attention Inbox global no lleva Project.
const projectAttentionCalls = () => attentionCalls().filter(([, args]) => args.projectId === PROJECT.id);
const inboxAttentionCalls = () => attentionCalls().filter(([, args]) => args.projectId === null);
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const attentionRows = () => within(screen.getByRole('list', { name: 'Attention activa' })).getAllByRole('listitem');
const openAttentionTab = () => fireEvent.click(screen.getByRole('tab', { name: 'Attention' }));

const operation = <div data-testid="operation-canvas"><span data-testid="pty-sentinel" /></div>;
const shell = (props = {}) => (
  <AdeShell active leftOpen rightOpen drawerOpen={false} operationWorkspace={operation} {...props} />
);
let adeShellStyleElement;

const pickTask = async () => {
  fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
  fireEvent.click(await screen.findByRole('treeitem', { name: /Task Real/ }));
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
  readAdeTask.mockClear();
  transport.verificationQueryCalls.clear();
});

describe('AdeShell · navegación con listas grandes (LXO-95)', () => {
  // Lista grande: en la suite paralela el render supera los 5 s por defecto; se sube el plazo, no se relajan aserciones.
  it('mantiene Operación en una región propia y alcanzable con muchos Projects y Tasks', { timeout: 20_000 }, async () => {
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
    const tree = await within(projectsRegion).findByRole('tree', { name: 'Projects y Tasks del Core' });
    expect(within(tree).getAllByRole('treeitem', { name: /^Repo / })).toHaveLength(32);
    fireEvent.click(within(tree).getByRole('treeitem', { name: /Repo 0/ }));
    await within(tree).findByRole('treeitem', { name: /Task 49/ });
    expect(within(tree).getAllByRole('treeitem', { name: /^Task / })).toHaveLength(50);

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

describe('AdeShell · ProjectsSidebar (LXO-97)', () => {
  it('renderiza el árbol y navega por Tasks activas, finalizadas y todas', { timeout: 20_000 }, async () => {
    core(detailOf());
    render(shell());

    const tree = await screen.findByRole('tree', { name: 'Projects y Tasks del Core' });
    const projectRow = await within(tree).findByRole('treeitem', { name: /Repo Real/ });
    expect(projectRow.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(projectRow.querySelector('.ps__meta'));
    expect(projectRow.getAttribute('aria-expanded')).toBe('true');
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: null });

    // ProjectView tiene su propio filtro «Activas» (role=radio); el del sidebar se acota a su región.
    const sidebar = within(screen.getByTestId('projects-sidebar'));
    expect(sidebar.getByRole('radiogroup', { name: 'Estado de las Tasks' })).toBeTruthy();
    expect(sidebar.getByRole('radio', { name: 'Activas' }).checked).toBe(true);
    // Ambos grupos de radio conservan su rol y nombre accesible.
    expect(within(screen.getByTestId('project-view')).getByRole('radio', { name: 'Activas' })).toBeTruthy();
    const taskRow = await within(tree).findByRole('treeitem', { name: /Task Real/ });
    expect(taskRow).toBeTruthy();
    fireEvent.click(taskRow);
    expect(taskRow.getAttribute('aria-selected')).toBe('true');
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: ITEM.id });
    expect(within(tree).queryByRole('treeitem', { name: /Task Final/ })).toBeNull();

    fireEvent.click(sidebar.getByRole('radio', { name: 'Finalizadas' }));
    expect(await within(tree).findByRole('treeitem', { name: /Task Final/ })).toBeTruthy();
    expect(within(tree).queryByRole('treeitem', { name: /Task Real/ })).toBeNull();

    fireEvent.click(sidebar.getByRole('radio', { name: 'Todas' }));
    expect(await within(tree).findByRole('treeitem', { name: /Task Real/ })).toBeTruthy();
    expect(within(tree).getByRole('treeitem', { name: /Task Final/ })).toBeTruthy();
    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'tasks_by_project').map(([, args]) => args.status))
      .toEqual(expect.arrayContaining(['active', 'final', 'all']));
  });

  it('mantiene la selección controlada por IDs durables y limpia Task al activar explícitamente su Project', async () => {
    core(detailOf());
    useWorkbenchStore.setState({ adeSelection: { projectId: PROJECT.id, taskId: ITEM.id } });
    render(shell());

    const tree = await screen.findByRole('tree', { name: 'Projects y Tasks del Core' });
    const taskRow = await within(tree).findByRole('treeitem', { name: /Task Real/ });
    expect(taskRow.getAttribute('aria-selected')).toBe('true');
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: ITEM.id });

    fireEvent.click(within(tree).getByRole('treeitem', { name: /Repo Real/ }));
    await flush();
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: null });
    expect(screen.queryByRole('heading', { level: 2, name: 'Task Real' })).toBeNull();
  });

  it('resuelve metadata para una selección externa y no duplica projects_overview en AdeShell', async () => {
    core(detailOf());
    useWorkbenchStore.setState({ adeSelection: { projectId: PROJECT.id, taskId: null } });
    render(shell());

    const projectView = await screen.findByTestId('project-view');
    await within(projectView).findByTestId('location-machine');
    expect(within(projectView).getByTestId('location-machine').textContent).toBe('machine-real');
    expect(within(projectView).getByTestId('location-path').textContent).toBe('C:/repos/repo-real');
    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'projects_overview')).toHaveLength(1);
  });
});

describe('AdeShell · Project View (LXO-204)', () => {
  it('muestra loading mientras espera y distingue un overview completo que omite el Project', async () => {
    const pendingOverview = deferred();
    useWorkbenchStore.setState({ adeSelection: { projectId: 'missing-project', taskId: null } });
    queryAdeCore.mockImplementation(async (query, args) => {
      if (query === 'projects_overview') return pendingOverview.promise;
      if (query === 'tasks_by_project') return {
        v: 1, project_id: args.projectId, filters: { status: args.status }, limit: 50, tasks: [], has_more: false, next_cursor: null,
      };
      if (query === 'attention_list') return attentionPage([]);
      throw new Error(`Query no permitida en fixture: ${query}`);
    });
    render(shell());

    const projectView = await screen.findByTestId('project-view');
    const summary = within(projectView).getByRole('region', { name: 'Resumen de Core' });
    expect(summary.querySelector('[data-testid="slice-notice"]').className).toContain('pv__notice--loading');
    expect(summary.querySelector('[data-testid="slice-notice"]').textContent).toContain('Cargando…');

    pendingOverview.resolve({
      v: 1,
      filters: { archived: 'exclude', machine: null },
      total: 1,
      projects: [PROJECT],
      unassigned: {},
    });
    // El mismo aviso autoritativo aparece en Resumen y en Ubicaciones: se acota al Resumen.
    await waitFor(() => {
      expect(summary.querySelector('[data-testid="slice-notice"]').className).toContain('pv__notice--unavailable');
    });
    const settledNotice = summary.querySelector('[data-testid="slice-notice"]');
    expect(settledNotice.textContent).toContain('El Project seleccionado no aparece en el overview activo de Core');
    expect(settledNotice.textContent).not.toContain('Core no confirmó metadata autoritativa');
    expect(settledNotice.textContent).not.toContain('Cargando…');
    expect(settledNotice.getAttribute('aria-busy')).toBeNull();
    // Sin metadata fabricada: ni nombre, ni contadores, ni ubicaciones del Project omitido.
    expect(within(projectView).queryByText(PROJECT.name)).toBeNull();
    expect(within(projectView).queryByTestId('location-machine')).toBeNull();
    expect(within(projectView).queryByTestId('count-tasks')).toBeNull();
  });

  it('muestra refreshing durante un polling sano sin marcar el Project como stale', async () => {
    vi.useFakeTimers();
    const pendingRefresh = deferred();
    let reads = 0;
    useWorkbenchStore.setState({ adeSelection: { projectId: PROJECT.id, taskId: null } });
    queryAdeCore.mockImplementation(async (query, args) => {
      if (query === 'projects_overview') {
        reads += 1;
        return reads === 1
          ? { v: 1, filters: { archived: args.archived, machine: null }, total: 1, projects: [PROJECT], unassigned: {} }
          : pendingRefresh.promise;
      }
      if (query === 'tasks_by_project') return {
        v: 1, project_id: args.projectId, filters: { status: args.status }, limit: 50,
        tasks: [], has_more: false, next_cursor: null,
      };
      if (query === 'attention_list') return attentionPage([]);
      throw new Error(`Query no permitida en fixture: ${query}`);
    });
    render(shell());
    await flush();

    const projectView = screen.getByTestId('project-view');
    const summary = within(projectView).getByRole('region', { name: 'Resumen de Core' });
    expect(summary.querySelector('[data-testid="slice-notice"]')).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await flush();
    const refreshingNotice = summary.querySelector('[data-testid="slice-notice"]');
    expect(refreshingNotice.className).toContain('pv__notice--loading');
    expect(refreshingNotice.textContent).toBe('Actualizando desde Core.');
    expect(refreshingNotice.textContent).not.toContain('Cargando…');
    expect(refreshingNotice.textContent).not.toContain('Datos desactualizados');
    expect(refreshingNotice.getAttribute('aria-busy')).toBe('true');

    pendingRefresh.resolve({
      v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [PROJECT], unassigned: {},
    });
    await flush();
    expect(summary.querySelector('[data-testid="slice-notice"]')).toBeNull();
  });

  it('abre por el ID durable y muestra metadata real del overview, Tasks all y slices pendientes', async () => {
    core(detailOf(), {
      attention: () => attentionPage([att({ id: 'att-project-1' })]),
      activity: (args) => projectActivityPage([{ ...ACTIVITY_EVENT, project_id: PROJECT.id, target: { kind: 'task', id: ITEM.id } }], args),
    });
    render(shell());

    fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
    const projectView = await screen.findByTestId('project-view');
    await within(projectView).findByTestId('location-machine');
    await within(projectView).findByTestId('activity-evt-project-1');
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
    // Activity del Project (LXO-204): la proyección real de Events acotada al Project durable.
    const activityRegion = within(projectView).getByRole('region', { name: /Activity/ });
    expect(activityRegion.querySelector('[data-testid="slice-notice"]')).toBeNull();
    expect(within(activityRegion).getByTestId('activity-no-text').textContent).toContain('task.created');
    expect(within(activityRegion).getByTestId('activity-evt-project-1').querySelector('time').dateTime)
      .toBe(new Date(ACTIVITY_EVENT.ts).toISOString());
    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'activity_list'))
      .toContainEqual(['activity_list', { cursor: '0', limit: 20, order: 'desc', projectId: PROJECT.id, runId: null, targetKind: null, targetId: null }]);
    // El slice legacy de Resources no lo da ninguna query de Core: se declara no disponible (no vacío)
    // y su foto real es el inventario de solo lectura, que ya está montado debajo.
    expect(within(projectView).getByRole('region', { name: 'Resources' }).querySelector('[data-testid="slice-notice"]').textContent)
      .toContain('Core no da un listado de Resources');
    expect(within(projectView).getByRole('region', { name: 'Resources' }).textContent).not.toMatch(/Backlog \(LXO-93\)/);

    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'tasks_by_project'))
      .toContainEqual(['tasks_by_project', { projectId: PROJECT.id, status: 'all' }]);
    expect(attentionCalls().some(([, args]) => args.projectId === PROJECT.id)).toBe(true);

    fireEvent.click(within(projectView).getByTestId('filter-all'));
    expect(within(projectView).getByTestId(`task-${FINAL_ITEM.id}`)).toBeTruthy();
    fireEvent.click(within(projectView).getByTestId(`open-task-${FINAL_ITEM.id}`));
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: FINAL_ITEM.id });
  });

  it('consulta el inventario del Project durable y monta la foto del Core en Resources tal cual', async () => {
    core(detailOf());
    render(shell());

    fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
    const projectView = await screen.findByTestId('project-view');

    // El DTO llega tal cual: repo y worktree, sin inventar filas ni contadores.
    const inventory = await within(projectView).findByTestId('resinv');

    // La petición lleva solo los dos parámetros del contrato: el ID duradero del Project y el sondeo.
    const inventoryCalls = queryAdeCore.mock.calls.filter(([query]) => query === 'resource_inventory');
    expect(inventoryCalls).toHaveLength(1);
    expect(inventoryCalls[0][1]).toEqual({ projectId: PROJECT.id, probe: true });

    expect(within(inventory).getAllByTestId('resinv-row')).toHaveLength(2);
    expect(within(inventory).getAllByTestId('resinv-target').map((el) => el.textContent))
      .toEqual(['C:/repos/repo-real', 'C:/repos/repo-real.lixbon-wt/wt-1']);
    expect(within(inventory).getByTestId('resinv-readonly').textContent).toBe('Solo lectura');
  });

  it('conserva y muestra el estado del inventario: error con reintento y foto real después', async () => {
    let fail = true;
    core(detailOf(), {
      inventory: () => {
        if (fail) throw new Error('resource_inventory_read_failed: git no respondió');
        return INVENTORY;
      },
    });
    render(shell());

    fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
    const projectView = await screen.findByTestId('project-view');
    const status = await within(projectView).findByTestId('resinv-status');
    expect(status.dataset.state).toBe('error');
    expect(within(status).getByTestId('resinv-status-text').getAttribute('role')).toBe('alert');
    expect(within(status).getByTestId('resinv-status-text').textContent).not.toContain('resource_inventory_read_failed');
    expect(within(status).getByTestId('resinv-status-detail').textContent).toContain('resource_inventory_read_failed');
    expect(within(projectView).getByTestId('resinv-unavailable-inventory')).toBeTruthy();

    // El reintento vuelve a preguntar al Core y la foto real sustituye al error.
    fail = false;
    fireEvent.click(within(projectView).getByTestId('resinv-retry'));
    await within(projectView).findAllByTestId('resinv-row');
    expect(within(projectView).queryByTestId('resinv-status')).toBeNull();
    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'resource_inventory').length).toBeGreaterThanOrEqual(2);
  });

  it('no consulta el inventario mientras no hay un Project durable seleccionado', async () => {
    core(detailOf());
    render(shell());
    await flush();
    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'resource_inventory')).toHaveLength(0);
  });

  it('consulta Tasks all solo mientras está abierto el Project View y conserva la query activa del navegador', async () => {
    vi.useFakeTimers();
    core(detailOf());
    render(shell());
    await flush();
    expect(queryAdeCore.mock.calls.filter(([query]) => query === 'tasks_by_project')).toHaveLength(0);

    fireEvent.click(screen.getByRole('treeitem', { name: /Repo Real/ }));
    await flush();
    const taskCalls = () => queryAdeCore.mock.calls.filter(([query]) => query === 'tasks_by_project');
    const allReads = () => taskCalls().filter(([, args]) => args.status === 'all');
    const activeReads = () => taskCalls().filter(([, args]) => args.status === 'active');
    expect(allReads()).toHaveLength(1);
    expect(activeReads()).toHaveLength(1);

    fireEvent.click(screen.getByRole('treeitem', { name: /Task Real/ }));
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

    fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
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

    fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
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
      const activity = list.querySelector('[data-context="activity"]');
      expect(activity.getAttribute('data-available')).toBe('true');
      expect(list.querySelector('[data-context="attention"]').getAttribute('data-available')).toBe('true');
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
  it('ofrece un switch Workspace/Attention/Activity accesible por teclado y conserva Runs y AgentPanel montados', async () => {
    core(detailOf());
    const { rerender } = render(shell());
    await pickTask();
    await screen.findAllByRole('region', { name: 'Identidad' });
    const pty = screen.getByTestId('pty-sentinel');

    const tablist = screen.getByRole('tablist', { name: 'Vista del ADE' });
    const workspaceTab = within(tablist).getByRole('tab', { name: 'Workspace' });
    const attentionTab = within(tablist).getByRole('tab', { name: 'Attention' });
    const activityTab = within(tablist).getByRole('tab', { name: 'Activity' });
    expect(workspaceTab.getAttribute('aria-selected')).toBe('true');
    expect(attentionTab.getAttribute('aria-selected')).toBe('false');
    expect(activityTab.getAttribute('aria-selected')).toBe('false');
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
    expect(activityTab.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(activityTab, { key: 'ArrowLeft' });
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
    fireEvent.click(screen.getByRole('treeitem', { name: /Repo Real/ }));
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
    fireEvent.click(screen.getByRole('treeitem', { name: /Repo Real/ }));
    await flush();
    fireEvent.click(screen.getByRole('treeitem', { name: /Task Real/ }));
    await flush();
    fireEvent.click(screen.getAllByRole('button', { name: `Abrir Attention de la Task ${ITEM.id}` })[0]);
    await flush();
    fireEvent.change(screen.getByLabelText('Categoría'), { target: { value: 'approval' } });
    await flush();
    expect(attentionCalls().at(-1)[1]).toMatchObject({ targetKind: 'task', targetId: ITEM.id, category: 'approval' });

    failing = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    // Un plazo agotado no es una desconexión: el Core puede estar escaneando (LXO-101).
    expect(screen.getByText(/Attention desactualizada: Core sin respuesta a tiempo/)).toBeTruthy();
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
    fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
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

  it('abre un Project desde un destino de Activity por su ID durable exacto', async () => {
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

  it('abre una Task de Activity por el par durable aunque no aparezca en la página de Tasks seleccionada', async () => {
    const targetTaskId = 'task-activity-target';
    coreWithActivity([activityItem(6, { target: { kind: 'task', id: targetTaskId } })]);
    const base = queryAdeCore.getMockImplementation();
    queryAdeCore.mockImplementation(async (query, args) => {
      if (query === 'task_detail' && args.projectId === PROJECT.id && args.taskId === targetTaskId) {
        return detailOf({ ...ITEM, id: targetTaskId, title: 'Task abierta desde Activity', project_id: PROJECT.id });
      }
      return base(query, args);
    });
    render(shell());
    fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
    await screen.findByRole('treeitem', { name: /Task Real/ });
    expect(screen.queryByText('Task abierta desde Activity')).toBeNull();
    expect(document.querySelector(`[data-task-id="${targetTaskId}"]`)).toBeNull();

    await flush();
    openActivityTab();
    await flush();

    fireEvent.click(await screen.findByTestId('activity-target-event-6'));
    const identityRegions = await screen.findAllByRole('region', { name: 'Identidad' });

    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: targetTaskId });
    expect(identityRegions.some((region) => region.textContent.includes(targetTaskId)
      && region.textContent.includes('Task abierta desde Activity'))).toBe(true);
    expect(queryAdeCore).toHaveBeenCalledWith('task_detail', { projectId: PROJECT.id, taskId: targetTaskId });
    expect(screen.queryByText(/no se pudo verificar|no aparece en el overview/i)).toBeNull();
  });

  it('no selecciona un destino de Activity cuyo Project ya no aparece en el overview', async () => {
    coreWithActivity([activityItem(7, {
      target: { kind: 'task', id: 'task-of-deleted-project' },
      project_id: 'deleted-project',
    })]);
    render(shell());
    await flush();
    openActivityTab();
    await flush();

    fireEvent.click(await screen.findByTestId('activity-target-event-7'));

    expect(await screen.findByText('El Project deleted-project no aparece en el overview activo de Core.')).toBeTruthy();
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });
    expect(queryAdeCore.mock.calls.some(([query, args]) => query === 'task_detail' && args.taskId === 'task-of-deleted-project')).toBe(false);
  });

  it('no selecciona un Project de Activity ausente del overview', async () => {
    coreWithActivity([activityItem(8, {
      target: { kind: 'project', id: 'deleted-project' },
      project_id: 'deleted-project',
      kind: 'project.registered',
      message_key: 'activity.project.registered',
    })]);
    render(shell());
    await flush();
    openActivityTab();
    await flush();

    fireEvent.click(await screen.findByTestId('activity-target-event-8'));

    expect(await screen.findByText('El Project deleted-project no aparece en el overview activo de Core.')).toBeTruthy();
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });
  });

  it('mantiene la selección cuando Core confirma que la Task de Activity ya no existe', async () => {
    const targetTaskId = 'deleted-task';
    coreWithActivity([activityItem(9, { target: { kind: 'task', id: targetTaskId } })]);
    const base = queryAdeCore.getMockImplementation();
    queryAdeCore.mockImplementation(async (query, args) => {
      if (query === 'task_detail' && args.projectId === PROJECT.id && args.taskId === targetTaskId) {
        throw new Error('task_not_found: Task no encontrada');
      }
      return base(query, args);
    });
    render(shell());
    fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
    await screen.findByRole('treeitem', { name: /Task Real/ });
    openActivityTab();
    await flush();

    fireEvent.click(await screen.findByTestId('activity-target-event-9'));

    expect(await screen.findByText(`La Task ${targetTaskId} ya no está disponible en el Project ${PROJECT.id}.`)).toBeTruthy();
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: null });
  });

  it('no abre una Task sin Project durable en el evento y conserva la selección', async () => {
    coreWithActivity([activityItem(10, {
      target: { kind: 'task', id: 'task-without-project' },
      project_id: null,
    })]);
    render(shell());
    await flush();
    openActivityTab();
    await flush();

    fireEvent.click(await screen.findByTestId('activity-target-event-10'));

    expect(await screen.findByText('La Task task-without-project no se puede abrir desde Activity: el evento no identifica su Project.')).toBeTruthy();
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });
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

  describe('navegación por destinos (remediación de revisión)', () => {
    const projectTargetItem = () => activityItem(11, {
      target: { kind: 'project', id: PROJECT.id },
      kind: 'project.registered',
      message_key: 'activity.project.registered',
      args: { name: 'Repo Real', origin: 'auto' },
    });
    // Dos canales distintos de `task_detail`: la verificación de Activity (`readAdeTask`) y la lectura del
    // shell (`useCoreQuery` → `queryAdeCore`). Una lectura del shell NO es una verificación: no se cuentan juntas.
    const verificationCalls = () => readAdeTask.mock.calls.map(([projectId, taskId]) => ({ projectId, taskId }));
    const verificationCallsFor = (projectId, taskId) => verificationCalls()
      .filter((call) => call.projectId === projectId && call.taskId === taskId);
    const verificationCallsForTask = (taskId) => verificationCalls().filter((call) => call.taskId === taskId);
    const verificationQueryCallsFor = (projectId, taskId) => [...transport.verificationQueryCalls]
      .filter(([query, args]) => query === 'task_detail'
        && args.projectId === projectId && args.taskId === taskId);
    // Lecturas del shell: `task_detail` emitidas por `useCoreQuery` → `queryAdeCore`, SIN contar las que
    // emite la verificación de Activity (`readAdeTask`), que comparte el mismo mock de transporte. Sin esta
    // separación, una lectura del shell y una verificación serían la misma llamada y el conteo del shell
    // sería tautológico (siempre ≥ 1 si hubo una verificación).
    const shellTaskDetailCallsFor = (projectId, taskId) => queryAdeCore.mock.calls
      .filter(([query, args]) => query === 'task_detail'
        && args.projectId === projectId && args.taskId === taskId)
      .filter((call) => !transport.verificationQueryCalls.has(call));
    // Resuelve las lecturas encadenadas (render -> efecto -> promesa) sin depender de los temporizadores reales.
    const settle = async () => { for (let i = 0; i < 6; i += 1) await flush(); };
    // Toda lectura de `task_detail` del destino queda pendiente hasta que la prueba la resuelva.
    function withPendingTarget(targetTaskId, pending) {
      const base = queryAdeCore.getMockImplementation();
      queryAdeCore.mockImplementation((query, args) => (
        query === 'task_detail' && args.projectId === PROJECT.id && args.taskId === targetTaskId
          ? pending.promise
          : base(query, args)
      ));
    }

    it('un overview en refreshing (última lectura sana) valida el Project; uno stale no', async () => {
      vi.useFakeTimers();
      coreWithActivity([projectTargetItem()]);
      const base = queryAdeCore.getMockImplementation();
      const refresh = deferred();
      let overviewReads = 0;
      let overviewMode = 'hold';
      queryAdeCore.mockImplementation((query, args) => {
        if (query === 'projects_overview') {
          overviewReads += 1;
          if (overviewReads > 1 && overviewMode === 'hold') return refresh.promise;
          if (overviewReads > 1 && overviewMode === 'fail') return Promise.reject(new Error('ade_query_timeout: Core no respondió a tiempo'));
        }
        return base(query, args);
      });
      render(shell());
      await settle();
      openActivityTab();
      await settle();

      // El segundo overview queda en vuelo: el sidebar conserva los IDs sanos y publica `refreshing`.
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await settle();
      expect(overviewReads).toBeGreaterThan(1);
      fireEvent.click(screen.getByTestId('activity-target-event-11'));
      await settle();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: null });
      expect(screen.queryByText(/No se pudo verificar el Project/)).toBeNull();

      // Con una lectura posterior fallida el snapshot pasa a stale: ya no valida.
      useWorkbenchStore.setState({ adeSelection: { projectId: null, taskId: null } });
      overviewMode = 'fail';
      refresh.resolve({ v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [PROJECT], unassigned: {} });
      await settle();
      openActivityTab();
      await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
      await settle();
      fireEvent.click(screen.getByTestId('activity-target-event-11'));
      await settle();
      expect(screen.getByText(`No se pudo verificar el Project ${PROJECT.id} en el overview de Core; no se cambió la selección.`)).toBeTruthy();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });
    });

    it('conserva el foco del teclado al pasar del destino de Activity al Workspace', async () => {
      coreWithActivity([projectTargetItem()]);
      render(shell());
      await flush();
      openActivityTab();
      await flush();

      const target = await screen.findByTestId('activity-target-event-11');
      target.focus();
      expect(document.activeElement).toBe(target);
      fireEvent.click(target);
      await settle();

      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: null });
      expect(document.getElementById(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-controls')).hidden).toBe(true);
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Workspace' }));
    });

    it('también mueve el foco tras verificar una Task, pero no lo roba si el usuario ya lo movió', async () => {
      const targetTaskId = 'task-activity-focus';
      coreWithActivity([activityItem(12, { target: { kind: 'task', id: targetTaskId } })]);
      const pending = deferred();
      withPendingTarget(targetTaskId, pending);
      render(shell());
      fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
      await screen.findByRole('treeitem', { name: /Task Real/ });
      openActivityTab();
      await settle();

      const target = await screen.findByTestId('activity-target-event-12');
      target.focus();
      fireEvent.click(target);
      await settle();
      pending.resolve(detailOf({ id: targetTaskId, title: 'Task con foco' }));
      await settle();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: targetTaskId });
      expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Workspace' }));

      // Segundo intento: el foco sale del panel Activity mientras se verifica; la navegación no lo roba.
      useWorkbenchStore.setState({ adeSelection: { projectId: PROJECT.id, taskId: null } });
      const second = deferred();
      withPendingTarget(targetTaskId, second);
      openActivityTab();
      await settle();
      fireEvent.click(await screen.findByTestId('activity-target-event-12'));
      await settle();
      const elsewhere = screen.getByRole('treeitem', { name: /Task Real/ });
      elsewhere.focus();
      expect(document.activeElement).toBe(elsewhere);
      second.resolve(detailOf({ id: targetTaskId, title: 'Task con foco' }));
      await settle();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: targetTaskId });
      expect(document.activeElement).toBe(elsewhere);
    });

    it('retira solo el «Verificando…» de la petición invalidada por un cambio de selección', async () => {
      const targetTaskId = 'task-activity-slow';
      coreWithActivity([
        activityItem(13, { target: { kind: 'task', id: targetTaskId } }),
        activityItem(14, { target: { kind: 'task', id: 'task-of-deleted-project' }, project_id: 'deleted-project' }),
      ]);
      const pending = deferred();
      withPendingTarget(targetTaskId, pending);
      render(shell());
      fireEvent.click(await screen.findByRole('treeitem', { name: /Repo Real/ }));
      await screen.findByRole('treeitem', { name: /Task Real/ });
      openActivityTab();
      await settle();

      fireEvent.click(await screen.findByTestId('activity-target-event-13'));
      await settle();
      expect(screen.getByText(`Verificando la Task ${targetTaskId} en el Project ${PROJECT.id}…`)).toBeTruthy();

      // El usuario elige otra Task desde el navegador: la petición queda invalidada y su aviso desaparece.
      fireEvent.click(screen.getByRole('treeitem', { name: /Task Real/ }));
      openActivityTab();
      await settle();
      expect(screen.queryByText(/Verificando la Task/)).toBeNull();
      pending.resolve(detailOf({ id: targetTaskId, title: 'Task lenta' }));
      await settle();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: ITEM.id });

      // Un aviso que no es de una verificación no se retira por cambiar la selección.
      fireEvent.click(await screen.findByTestId('activity-target-event-14'));
      await settle();
      const notice = 'El Project deleted-project no aparece en el overview activo de Core.';
      expect(screen.getByText(notice)).toBeTruthy();
      fireEvent.click(screen.getByRole('treeitem', { name: /Repo Real/ }));
      openActivityTab();
      await settle();
      expect(screen.getByText(notice)).toBeTruthy();
    });

    it('una verificación que sigue en vuelo no pisa el aviso de la petición siguiente', async () => {
      const slowTaskId = 'task-activity-slow';
      coreWithActivity([
        activityItem(13, { target: { kind: 'task', id: slowTaskId } }),
        activityItem(14, { target: { kind: 'task', id: 'task-of-deleted-project' }, project_id: 'deleted-project' }),
      ]);
      const pending = deferred();
      withPendingTarget(slowTaskId, pending);
      render(shell());
      await settle();
      openActivityTab();
      await settle();

      fireEvent.click(await screen.findByTestId('activity-target-event-13'));
      await settle();
      fireEvent.click(await screen.findByTestId('activity-target-event-14'));
      await settle();
      pending.resolve(detailOf({ id: slowTaskId }));
      await settle();

      expect(screen.getByText('El Project deleted-project no aparece en el overview activo de Core.')).toBeTruthy();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });
    });

    it('acota la verificación de task_detail a 10 s y conserva la selección', async () => {
      vi.useFakeTimers();
      const targetTaskId = 'task-activity-hung';
      coreWithActivity([activityItem(15, { target: { kind: 'task', id: targetTaskId } })]);
      withPendingTarget(targetTaskId, deferred());
      render(shell());
      await settle();
      openActivityTab();
      await settle();

      fireEvent.click(screen.getByTestId('activity-target-event-15'));
      await settle();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
      expect(screen.getByText(`Verificando la Task ${targetTaskId} en el Project ${PROJECT.id}…`)).toBeTruthy();
      expect(screen.queryByText(/Core no respondió a tiempo/)).toBeNull();

      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      await settle();
      expect(screen.queryByText(/Verificando la Task/)).toBeNull();
      expect(screen.getByText(`Core no respondió a tiempo al verificar la Task ${targetTaskId} del Project ${PROJECT.id}; no se cambió la selección.`)).toBeTruthy();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });
      // Vencido el plazo, la lectura subyacente sigue viva: el timeout no genera otra lectura ni suelta la ranura.
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);
    });

    it('no repite task_detail para la Task ya seleccionada y sana, y reutiliza la lectura en vuelo del mismo destino', async () => {
      const targetTaskId = 'task-activity-twice';
      coreWithActivity([
        activityItem(16),
        activityItem(17, { target: { kind: 'task', id: targetTaskId } }),
      ]);
      const pending = deferred();
      withPendingTarget(targetTaskId, pending);
      render(shell());
      await pickTask();
      await screen.findAllByRole('region', { name: 'Identidad' });
      openActivityTab();
      await settle();

      // Task ya seleccionada con su detalle sano en el shell: se abre sin otra lectura (ni del shell ni de verificación).
      const shellReadsBefore = shellTaskDetailCallsFor(PROJECT.id, ITEM.id).length;
      fireEvent.click(await screen.findByTestId('activity-target-event-16'));
      await settle();
      expect(verificationCallsForTask(ITEM.id)).toHaveLength(0);
      expect(shellTaskDetailCallsFor(PROJECT.id, ITEM.id)).toHaveLength(shellReadsBefore);
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: ITEM.id });

      // Dos clics sobre el mismo destino comparten una única verificación.
      openActivityTab();
      await settle();
      fireEvent.click(await screen.findByTestId('activity-target-event-17'));
      await settle();
      fireEvent.click(await screen.findByTestId('activity-target-event-17'));
      await settle();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);

      pending.resolve(detailOf({ id: targetTaskId, title: 'Task única' }));
      await settle();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: targetTaskId });
    });

    it('comparte la lectura en vuelo de A al navegar A/B/A por el mismo ID en Projects distintos', async () => {
      const targetTaskId = 'task-activity-pair-dedup';
      const secondProject = { ...PROJECT, id: 'project-uuid-2', name: 'Otro Repo' };
      coreWithActivity([
        activityItem(18, { target: { kind: 'task', id: targetTaskId }, project_id: PROJECT.id }),
        activityItem(19, { target: { kind: 'task', id: targetTaskId }, project_id: secondProject.id }),
      ]);
      const pendingA = deferred();
      const pendingB = deferred();
      const base = queryAdeCore.getMockImplementation();
      queryAdeCore.mockImplementation((query, args) => {
        if (query === 'projects_overview') return {
          v: 1, filters: { archived: args.archived, machine: null }, total: 2, projects: [PROJECT, secondProject], unassigned: {},
        };
        if (query === 'task_detail' && args.taskId === targetTaskId) {
          if (args.projectId === PROJECT.id) return pendingA.promise;
          if (args.projectId === secondProject.id) return pendingB.promise;
        }
        return base(query, args);
      });
      render(shell());
      await settle();
      openActivityTab();
      await settle();

      fireEvent.click(await screen.findByTestId('activity-target-event-18'));
      await settle();
      fireEvent.click(await screen.findByTestId('activity-target-event-19'));
      await settle();
      fireEvent.click(await screen.findByTestId('activity-target-event-18'));
      await settle();

      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);
      expect(verificationCallsFor(secondProject.id, targetTaskId)).toHaveLength(1);
      expect(screen.getByText(`Verificando la Task ${targetTaskId} en el Project ${PROJECT.id}…`)).toBeTruthy();

      // La respuesta de B ya no es dueña de la navegación; A reutilizada sí lo es.
      pendingB.resolve(detailOf({ ...ITEM, id: targetTaskId, project_id: secondProject.id, title: 'Task B' }));
      await settle();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });
      expect(screen.getByText(`Verificando la Task ${targetTaskId} en el Project ${PROJECT.id}…`)).toBeTruthy();
      pendingA.resolve(detailOf({ ...ITEM, id: targetTaskId, project_id: PROJECT.id, title: 'Task A' }));
      await settle();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: targetTaskId });
    });

    it('reintenta tras timeout reutilizando task_detail pendiente y acepta la respuesta del intento vigente', async () => {
      vi.useFakeTimers();
      const targetTaskId = 'task-activity-timeout-retry';
      coreWithActivity([activityItem(20, { target: { kind: 'task', id: targetTaskId } })]);
      const pending = deferred();
      withPendingTarget(targetTaskId, pending);
      useWorkbenchStore.setState({ adeSelection: { projectId: PROJECT.id, taskId: null } });
      render(shell());
      await settle();
      openActivityTab();
      await settle();

      fireEvent.click(screen.getByTestId('activity-target-event-20'));
      await settle();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      await settle();
      expect(screen.getByText(`Core no respondió a tiempo al verificar la Task ${targetTaskId} del Project ${PROJECT.id}; no se cambió la selección.`)).toBeTruthy();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: null });
      // El timeout de la UI no libera la ranura de deduplicación: la lectura subyacente sigue en vuelo.
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);

      fireEvent.click(screen.getByTestId('activity-target-event-20'));
      await settle();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);
      expect(screen.getByText(`Verificando la Task ${targetTaskId} en el Project ${PROJECT.id}…`)).toBeTruthy();

      pending.resolve(detailOf({ ...ITEM, id: targetTaskId, title: 'Task tras reintento' }));
      await settle();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: targetTaskId });
      expect(screen.queryByText(/Core no respondió a tiempo al verificar la Task/)).toBeNull();

      // La ranura se liberó al asentarse la consulta subyacente (no al vencer el timeout): sin Task seleccionada
      // en el shell, el mismo destino vuelve a verificarse con una lectura nueva.
      useWorkbenchStore.setState({ adeSelection: { projectId: null, taskId: null } });
      await settle();
      openActivityTab();
      await settle();
      fireEvent.click(screen.getByTestId('activity-target-event-20'));
      await settle();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(2);
    });

    it('conserva la selección y avisa si task_detail devuelve otro task.id', async () => {
      const targetTaskId = 'task-activity-id-mismatch';
      coreWithActivity([activityItem(21, { target: { kind: 'task', id: targetTaskId } })]);
      const base = queryAdeCore.getMockImplementation();
      queryAdeCore.mockImplementation(async (query, args) => {
        if (query === 'task_detail' && args.projectId === PROJECT.id && args.taskId === targetTaskId) {
          return detailOf({ ...ITEM, id: 'task-activity-different-id' });
        }
        return base(query, args);
      });
      const selection = { projectId: PROJECT.id, taskId: null };
      useWorkbenchStore.setState({ adeSelection: selection });
      render(shell());
      await settle();
      openActivityTab();
      await settle();

      fireEvent.click(await screen.findByTestId('activity-target-event-21'));

      expect(await screen.findByText(`Core no confirmó la Task ${targetTaskId} del Project ${PROJECT.id}; no se cambió la selección.`)).toBeTruthy();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);
      expect(useWorkbenchStore.getState().adeSelection).toEqual(selection);
    });

    it('conserva la selección y avisa si task_detail devuelve el task.id esperado con otro project_id', async () => {
      const targetTaskId = 'task-activity-project-mismatch';
      coreWithActivity([activityItem(22, { target: { kind: 'task', id: targetTaskId } })]);
      const base = queryAdeCore.getMockImplementation();
      queryAdeCore.mockImplementation(async (query, args) => {
        if (query === 'task_detail' && args.projectId === PROJECT.id && args.taskId === targetTaskId) {
          return detailOf({ ...ITEM, id: targetTaskId, project_id: 'project-activity-different' });
        }
        return base(query, args);
      });
      const selection = { projectId: PROJECT.id, taskId: null };
      useWorkbenchStore.setState({ adeSelection: selection });
      render(shell());
      await settle();
      openActivityTab();
      await settle();

      fireEvent.click(await screen.findByTestId('activity-target-event-22'));

      expect(await screen.findByText(`Core no confirmó la Task ${targetTaskId} del Project ${PROJECT.id}; no se cambió la selección.`)).toBeTruthy();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);
      expect(useWorkbenchStore.getState().adeSelection).toEqual(selection);
    });

    it('no deduplica dos Tasks distintas del mismo Project: la clave incluye el taskId', async () => {
      const taskA = 'task-activity-mismo-project-a';
      const taskB = 'task-activity-mismo-project-b';
      coreWithActivity([
        activityItem(23, { target: { kind: 'task', id: taskA }, project_id: PROJECT.id }),
        activityItem(24, { target: { kind: 'task', id: taskB }, project_id: PROJECT.id }),
      ]);
      const pendingA = deferred();
      const pendingB = deferred();
      const base = queryAdeCore.getMockImplementation();
      queryAdeCore.mockImplementation((query, args) => {
        if (query === 'task_detail' && args.projectId === PROJECT.id) {
          if (args.taskId === taskA) return pendingA.promise;
          if (args.taskId === taskB) return pendingB.promise;
        }
        return base(query, args);
      });
      render(shell());
      await settle();
      openActivityTab();
      await settle();

      fireEvent.click(await screen.findByTestId('activity-target-event-23'));
      await settle();
      fireEvent.click(await screen.findByTestId('activity-target-event-24'));
      await settle();

      // Mismo Project, Tasks distintas: dos lecturas en vuelo independientes (la ranura es el par completo).
      expect(verificationCallsFor(PROJECT.id, taskA)).toHaveLength(1);
      expect(verificationCallsFor(PROJECT.id, taskB)).toHaveLength(1);
      expect(verificationCalls()).toHaveLength(2);
      expect(screen.getByText(`Verificando la Task ${taskB} en el Project ${PROJECT.id}…`)).toBeTruthy();

      // La respuesta de A no satisface la petición vigente de B: no hay cruce entre destinos del mismo Project.
      pendingA.resolve(detailOf({ ...ITEM, id: taskA, project_id: PROJECT.id, title: 'Task A' }));
      await settle();
      expect(screen.getByText(`Verificando la Task ${taskB} en el Project ${PROJECT.id}…`)).toBeTruthy();
      expect(screen.queryByText(/Core no confirmó la Task/)).toBeNull();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });

      // B sí es la petición vigente: su propia respuesta abre su Task.
      pendingB.resolve(detailOf({ ...ITEM, id: taskB, project_id: PROJECT.id, title: 'Task B' }));
      await settle();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: taskB });
      expect(screen.queryByText(/Verificando la Task/)).toBeNull();
      // La verificación y el shell pueden compartir el transporte, pero no el registro de llamada.
      expect(verificationCallsFor(PROJECT.id, taskB)).toHaveLength(1);
      const taskBVerificationReads = verificationQueryCallsFor(PROJECT.id, taskB);
      const taskBShellReads = shellTaskDetailCallsFor(PROJECT.id, taskB);
      expect(taskBVerificationReads).toHaveLength(1);
      expect(queryAdeCore.mock.calls).toContain(taskBVerificationReads[0]);
      expect(taskBShellReads.length).toBeGreaterThan(0);
      expect(taskBShellReads).not.toContain(taskBVerificationReads[0]);
    });

    it('libera la ranura de deduplicación cuando la consulta subyacente se asienta', async () => {
      const targetTaskId = 'task-activity-slot-release';
      coreWithActivity([activityItem(25, { target: { kind: 'task', id: targetTaskId } })]);
      const base = queryAdeCore.getMockImplementation();
      queryAdeCore.mockImplementation(async (query, args) => {
        // La lectura se asienta, pero con otro task.id: la verificación no prospera y la selección no cambia.
        if (query === 'task_detail' && args.projectId === PROJECT.id && args.taskId === targetTaskId) {
          return detailOf({ ...ITEM, id: 'task-activity-otra-id' });
        }
        return base(query, args);
      });
      render(shell());
      await settle();
      openActivityTab();
      await settle();

      fireEvent.click(await screen.findByTestId('activity-target-event-25'));
      await settle();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);
      expect(screen.getByText(`Core no confirmó la Task ${targetTaskId} del Project ${PROJECT.id}; no se cambió la selección.`)).toBeTruthy();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: null, taskId: null });

      // La consulta ya se asentó: la ranura quedó libre y el mismo destino se verifica con una lectura nueva.
      fireEvent.click(await screen.findByTestId('activity-target-event-25'));
      await settle();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(2);
    });

    it('libera la ranura tras una verificación correcta cuando el shell ya no tiene la Task seleccionada', async () => {
      const targetTaskId = 'task-activity-slot-release-ok';
      coreWithActivity([activityItem(26, { target: { kind: 'task', id: targetTaskId } })]);
      const pending = deferred();
      withPendingTarget(targetTaskId, pending);
      render(shell());
      await settle();
      openActivityTab();
      await settle();

      fireEvent.click(await screen.findByTestId('activity-target-event-26'));
      await settle();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(1);

      pending.resolve(detailOf({ ...ITEM, id: targetTaskId, title: 'Task verificada' }));
      await settle();
      expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: PROJECT.id, taskId: targetTaskId });

      // Sin la Task seleccionada, el shell no tiene un detalle sano que reutilizar: se verifica de nuevo.
      useWorkbenchStore.setState({ adeSelection: { projectId: null, taskId: null } });
      await settle();
      openActivityTab();
      await settle();
      fireEvent.click(await screen.findByTestId('activity-target-event-26'));
      await settle();
      expect(verificationCallsFor(PROJECT.id, targetTaskId)).toHaveLength(2);
    });
  });
});
