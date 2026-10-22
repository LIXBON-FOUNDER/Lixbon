import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { AppShell } from './AppShell';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useMcpStore } from '../store/mcpStore';
import { useProblemsStore } from '../store/problemsStore';
import { useOrchStore } from '../store/orchStore';
import { useWorkbenchStore } from '../store/workbenchStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock('../orch/AgentTerminal', () => ({ AgentTerminal: () => <div data-testid="agent-terminal" /> }));
vi.mock('../commands/builtin', () => ({ registerBuiltinCommands: () => {} }));
vi.mock('../lib/keymap', () => ({ dispatchKeydown: () => {} }));
vi.mock('../chat/avisoFlotante', () => ({ useAvisoFlotante: () => {} }));
vi.mock('../hooks/useVersion', () => ({
  useVersion: () => ({ updateInfo: null, installUpdate: () => {}, isDownloading: false, downloadProgress: 0, dismissed: false, dismissUpdate: () => {}, error: null }),
}));
vi.mock('./StatusBar', () => ({ StatusBar: () => null }));
vi.mock('../modes/EditorMode', () => ({ EditorMode: ({ active }) => <div data-testid="editor-mode" data-active={String(active)} /> }));
vi.mock('../modes/AgentMode', () => ({ AgentMode: () => <div data-testid="agent-mode" /> }));
vi.mock('../modes/DesignMode', () => ({ DesignMode: () => <div data-testid="design-mode" /> }));
vi.mock('../modes/GitMode', () => ({ GitMode: () => <div data-testid="git-mode" /> }));
vi.mock('../modes/Welcome', () => ({ Welcome: () => null }));
vi.mock('../modes/SettingsPage', () => ({ SettingsPage: () => null }));
vi.mock('../components/QuickOpen', () => ({ QuickOpen: () => null }));
vi.mock('../components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('../components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('../components/Toasts', () => ({ Toasts: () => null }));
vi.mock('../components/RemoteModal', () => ({ RemoteModal: () => null }));

const project = {
  id: 'project-uuid-1', name: 'Repo Real', state: 'active', status: 'active',
  counts: { tasks: 1, active: 1, failed: 0, attention: { total: 0, by_category: {} } }, locations: [],
};
const item = {
  id: 'task-uuid-1', run_id: 'run-1', parent_id: null, root_id: 'task-uuid-1', status: 'running',
  title: 'Task Real', provider: 'claude', model: null, created_at: 1, updated_at: 2,
};
const extraItem = {
  ...item, id: 'task-uuid-2', root_id: 'task-uuid-2', title: 'Task Extra', created_at: 0,
};
const snap = {
  settings: { enabled: true }, lxo_exists: true, live: [], messages: [], runs: {}, tasks: {},
};
const coreQuery = async (query, args) => {
  if (query === 'projects_overview') return { v: 1, filters: { archived: 'exclude', machine: null }, total: 1, projects: [project], unassigned: {} };
  // La cabecera anuncia otra página (has_more) y el cursor devuelve la extra: el sidebar real puede paginar.
  if (query === 'tasks_by_project') {
    return args?.cursor
      ? { v: 1, project_id: project.id, filters: { status: 'active' }, limit: 50, tasks: [extraItem], has_more: false, next_cursor: null }
      : { v: 1, project_id: project.id, filters: { status: 'active' }, limit: 50, tasks: [item], has_more: true, next_cursor: 'cursor-1' };
  }
  if (query === 'attention_list') return { v: 1, items: [], next_cursor: null, has_more: false, limit: 100 };
  if (query === 'task_detail') return { v: 1, task: { ...item, project_id: project.id, child_ids: [], phase: null, messages: [], cwd: '', branch: null, worktree: null, merged: false, review: null, integration: null } };
  throw new Error(`Query no permitida en fixture: ${query}`);
};
const coreCalls = () => invoke.mock.calls.filter(([command]) => command === 'orch_query').length;
const orchHost = () => document.querySelector('[data-retained-mode="orch"]');

const treeitem = (region, attribute, id) => within(region).findByRole('treeitem', { name: (_, el) => el.getAttribute(attribute) === id && (attribute === 'data-task-id' || !el.hasAttribute('data-task-id')) });

function mountShell(mode) {
  invoke.mockImplementation(async (cmd, args) => {
    if (cmd === 'orch_pending_spawns' || cmd === 'orch_list_pending_spawns') return [];
    if (cmd === 'orch_snapshot') return snap;
    if (cmd === 'orch_query') return coreQuery(args.query, args.args);
    return snap;
  });
  useAppStore.setState({ workspaceRoot: 'C:/repo', workspaceReady: true, restoreWorkspace: vi.fn() });
  useGitStore.setState({ startAutoFetch: vi.fn() });
  useMcpStore.setState({ load: vi.fn(() => Promise.resolve()) });
  useProblemsStore.setState({ detect: vi.fn(), scheduleAfterSave: vi.fn() });
  useWorkbenchStore.setState((state) => ({
    mode, page: null, orchView: 'executions', focus: 'ade-nav', drawer: false, adeDrawer: false,
    adeSelection: { projectId: null, taskId: null },
    modePanels: { ...state.modePanels, orch: { left: true, right: true, adeRight: true } },
  }));
  useOrchStore.setState({ snap, snapshotError: null, snapshotRefreshing: false, selected: null, init: () => {} });
  return render(<AppShell />);
}

const setMode = (mode) => act(async () => { useWorkbenchStore.getState().setMode(mode); });

beforeEach(() => invoke.mockReset());
afterEach(() => { cleanup(); localStorage.removeItem('lx_orch_view'); });

describe('AppShell · modo Orquestador (ADE) al cambiar de modo', () => {
  it('no monta el Orquestador hasta la primera visita y luego lo retiene', async () => {
    mountShell('editor');
    expect(orchHost()).toBeNull();

    await setMode('orch');
    expect(orchHost().getAttribute('data-retained-state')).toBe('active');
    expect(await screen.findByRole('region', { name: 'Projects y Tasks' })).toBeTruthy();

    await setMode('git');
    expect(orchHost()).toBeTruthy();
    expect(screen.getByTestId('git-mode')).toBeTruthy();
  });

  it('oculta el árbol inactivo (inert, aria-hidden, sin foco) y deja de consultar Core', async () => {
    mountShell('orch');
    const sidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    await treeitem(sidebar, 'data-project-id', project.id);

    await setMode('editor');
    const host = orchHost();
    expect(host.getAttribute('data-retained-state')).toBe('hidden');
    expect(host.hasAttribute('inert')).toBe(true);
    expect(host.getAttribute('aria-hidden')).toBe('true');
    expect(host.style.visibility).toBe('hidden');
    expect(host.querySelector('section.ps').classList.contains('is-hidden')).toBe(true);

    // Oculto no hay lectura viva: ni el refresco por visibilidad ni nada propio llega a Core.
    await act(async () => { await Promise.resolve(); });
    const before = coreCalls();
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); await Promise.resolve(); });
    expect(coreCalls()).toBe(before);

    await setMode('orch');
    expect(orchHost().getAttribute('data-retained-state')).toBe('active');
    expect(orchHost().hasAttribute('inert')).toBe(false);
    await waitFor(() => expect(coreCalls()).toBeGreaterThan(before));
  });

  it('conserva selección durable, vista, scroll y foco al ir a Editor y volver al ADE', { timeout: 20_000 }, async () => {
    mountShell('orch');
    const sidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    fireEvent.click(await treeitem(sidebar, 'data-project-id', project.id));
    const taskRow = await treeitem(sidebar, 'data-task-id', item.id);
    fireEvent.click(taskRow);
    fireEvent.click(screen.getByRole('tab', { name: 'Attention' }));
    expect(screen.getByRole('tab', { name: 'Attention' }).getAttribute('aria-selected')).toBe('true');
    taskRow.focus();
    expect(document.activeElement).toBe(taskRow);
    // Segunda página del Project: el cursor y las filas extra deben sobrevivir al cambio de modo.
    fireEvent.click(within(sidebar).getByRole('button', { name: 'Cargar más Tasks de Repo Real' }));
    await treeitem(sidebar, 'data-task-id', extraItem.id);
    // El scroller real del sidebar es el árbol (`.ps__tree`), no el contenedor de navegación.
    const scroller = sidebar.querySelector('.ps__tree');
    scroller.scrollTop = 37;
    fireEvent.scroll(scroller);

    await setMode('editor');
    const hiddenCalls = coreCalls();
    // Lo que haría el navegador al ocultar: el foco queda vacante y `display: none` pierde el scroll.
    taskRow.blur();
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Oculto, el árbol y las páginas cargadas siguen montados y Core no se consulta.
    expect(scroller.isConnected).toBe(true);
    expect(orchHost().querySelectorAll('li[data-task-id]')).toHaveLength(2);
    expect(coreCalls()).toBe(hiddenCalls);
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: project.id, taskId: item.id });

    await setMode('orch');
    expect(useWorkbenchStore.getState().adeSelection).toEqual({ projectId: project.id, taskId: item.id });
    expect(screen.getByRole('tab', { name: 'Attention' }).getAttribute('aria-selected')).toBe('true');
    const returned = await screen.findByRole('region', { name: 'Projects y Tasks' });
    const returnedRow = await treeitem(returned, 'data-task-id', item.id);
    expect(returnedRow.getAttribute('aria-selected')).toBe('true');
    expect(returned.querySelector('.ps__tree')).toBe(scroller);
    expect(await treeitem(returned, 'data-task-id', extraItem.id)).toBeTruthy();
    await waitFor(() => expect(scroller.scrollTop).toBe(37));
    // La autoridad llega de Core: las páginas se releen y dejan de estar marcadas como previas.
    await waitFor(() => expect(coreCalls()).toBeGreaterThan(hiddenCalls));
    await waitFor(() => expect(returned.querySelector('[data-testid="stale-task-pages-project-uuid-1"]')).toBeNull());
    expect(returned.querySelector('li[data-task-id="task-uuid-2"]')).toBeTruthy();
    expect(returned.querySelector('.ps__tree')).toBe(scroller);
    expect(scroller.scrollTop).toBe(37);
    await waitFor(() => expect(document.activeElement?.getAttribute('data-task-id')).toBe(item.id));
  });

  it('no roba el foco si la persona ya lo movió a otro sitio', { timeout: 20_000 }, async () => {
    mountShell('orch');
    const sidebar = await screen.findByRole('region', { name: 'Projects y Tasks' });
    const projectRow = await treeitem(sidebar, 'data-project-id', project.id);
    projectRow.focus();
    expect(document.activeElement).toBe(projectRow);

    await setMode('editor');
    projectRow.blur();
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();

    await setMode('orch');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)); });
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
