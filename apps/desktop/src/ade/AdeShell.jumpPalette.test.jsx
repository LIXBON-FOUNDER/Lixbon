import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COPY } from './adeLabels';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AdeShell } from './AdeShell';
import { queryAdeCore } from './coreQueries';
import { useWorkbenchStore } from '../store/workbenchStore';

vi.mock('./coreQueries', async (importOriginal) => ({ ...(await importOriginal()), queryAdeCore: vi.fn() }));

// Estas pruebas de integración montan AdeShell y la paleta con Core simulado. El fixture contiene
// 2 Projects, 2 Tasks y 4 Attention (8 opciones). Las consultas por rol de `option` con filtro `name`
// calculan nombres accesibles dentro de su ámbito; `findByRole` repite la consulta mientras espera.
// El límite de RTL (10 s) es menor que el límite explícito de cada prueba asíncrona (15 s): si una espera
// agota su plazo mientras la prueba aún tiene margen, RTL puede señalar qué consulta no se resolvió. La
// primera prueba es síncrona y conserva el límite por defecto de la suite.
const PALETTE_WAIT_TIMEOUT = 10_000;
const PALETTE_TEST_TIMEOUT = 15_000;
configure({ asyncUtilTimeout: PALETTE_WAIT_TIMEOUT });

// FIXTURES con la forma del contrato de docs/core/QUERIES.md; no son una lectura de Core real ni dogfood.

const PROJECTS = [
  { id: 'prj-1', name: 'Repo Uno', state: 'active', status: 'active', counts: { tasks: 1, active: 1, failed: 0, attention: { total: 0, by_category: {} } }, locations: [] },
  { id: 'prj-2', name: 'Repo Dos', state: 'active', status: 'active', counts: { tasks: 1, active: 1, failed: 0, attention: { total: 0, by_category: {} } }, locations: [] },
];
const TASKS = {
  'prj-1': [{ id: 'task-1', title: 'Tarea Uno', status: 'running', branch: 'feat/uno', created_at: 1, updated_at: 2 }],
  'prj-2': [{ id: 'task-2', title: 'Tarea Dos', status: 'waiting', branch: 'feat/dos', created_at: 1, updated_at: 2 }],
};
const att = (over) => ({
  category: 'question', severity: 'medium', status: 'active', project_id: null, run_id: null, occurrence: 1,
  created_at: 1, resolved_at: null, resolution: null, ...over,
});
const ATTENTION = [
  att({ id: 'att-task', target_kind: 'task', target_id: 'task-2', project_id: 'prj-2' }),
  att({ id: 'att-run', target_kind: 'run', target_id: 'run-7' }),
  att({ id: 'att-spawn', target_kind: 'spawn_request', target_id: 'pend-3' }),
  att({ id: 'att-attempt', target_kind: 'attempt', target_id: 'attempt-5' }),
];

function core() {
  queryAdeCore.mockImplementation(async (query, args) => {
    if (query === 'projects_overview') return { v: 1, filters: { archived: args.archived, machine: null }, total: PROJECTS.length, projects: PROJECTS, unassigned: {} };
    if (query === 'tasks_by_project') return { v: 1, project_id: args.projectId, filters: { status: 'active' }, limit: 50, tasks: TASKS[args.projectId] ?? [], has_more: false, next_cursor: null };
    if (query === 'task_detail') throw new Error('task_detail_unavailable: fixture');
    if (query === 'attention_list') {
      const items = args.targetKind ? ATTENTION.filter((item) => item.target_kind === args.targetKind && item.target_id === args.targetId) : ATTENTION;
      return { v: 1, items, next_cursor: null, has_more: false, limit: 100 };
    }
    throw new Error(`Query no permitida en fixture: ${query}`);
  });
}

const shell = (props = {}) => (
  <>
    <button type="button">Foco previo</button>
    <AdeShell active leftOpen rightOpen drawerOpen={false} operationWorkspace={<div />} {...props} />
  </>
);
const selection = () => useWorkbenchStore.getState().adeSelection;
const input = () => screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
const attentionCalls = () => queryAdeCore.mock.calls.filter(([name, args]) => name === 'attention_list' && args.targetKind);

async function openPalette(props) {
  render(shell(props));
  screen.getByRole('button', { name: 'Foco previo' }).focus();
  act(() => useWorkbenchStore.getState().setJumpPaletteOpen(true));
  await screen.findByRole('option', { name: /Repo Uno/ });
  await waitFor(() => expect(within(screen.getByRole('group', { name: 'Tasks' })).getAllByRole('option')).toHaveLength(2));
}

// La búsqueda por ID del Project también encuentra sus Tasks/Attention (el ID es metadato buscable): se elige por grupo.
async function pick(query, group) {
  fireEvent.change(input(), { target: { value: query } });
  const option = await waitFor(() => within(screen.getByRole('group', { name: group })).getByRole('option'));
  fireEvent.click(option);
}

beforeEach(() => {
  localStorage.clear(); // los recientes de la paleta viven en localStorage: ninguna prueba hereda los de otra
  useWorkbenchStore.setState({ adeSelection: { projectId: null, taskId: null }, jumpPaletteOpen: false, mode: 'orch', orchView: 'ade' });
  core();
});
afterEach(() => {
  cleanup();
  queryAdeCore.mockReset();
});

describe('AdeShell · Jump Palette (LXO-102)', () => {
  it('no monta la paleta ni lee Core desde ella hasta que se abre', () => {
    render(shell());
    expect(screen.queryByRole('dialog')).toBeNull();
    // Solo la paleta lee con la clave `cursor`; el shell no lo hace.
    expect(queryAdeCore.mock.calls.some(([, args]) => 'cursor' in args)).toBe(false);
  });

  it('selecciona el Project exacto, cierra y devuelve el foco', async () => {
    await openPalette();
    expect(document.activeElement).toBe(input());
    await pick('Repo Dos', 'Projects');

    expect(selection()).toEqual({ projectId: 'prj-2', taskId: null });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useWorkbenchStore.getState().jumpPaletteOpen).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Foco previo' }));
  }, PALETTE_TEST_TIMEOUT);

  it('selecciona el par exacto Project/Task aunque el Project no esté seleccionado, y vuelve a Workspace', async () => {
    const onActivate = vi.fn();
    await openPalette({ onActivate });
    act(() => { fireEvent.click(screen.getByRole('tab', { name: 'Attention' })); });
    await pick('Tarea Dos', 'Tasks');

    expect(selection()).toEqual({ projectId: 'prj-2', taskId: 'task-2' });
    expect(screen.getByRole('tab', { name: 'Workspace' }).getAttribute('aria-selected')).toBe('true');
    expect(onActivate).toHaveBeenCalled();
  }, PALETTE_TEST_TIMEOUT);

  it('abre una Attention de Task por la subvista Attention con el filtro exacto (task + ID)', async () => {
    await openPalette();
    await pick('att-task', 'Attention');

    expect(screen.getByRole('tab', { name: 'Attention' }).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(attentionCalls()).toContainEqual(['attention_list', expect.objectContaining({ targetKind: 'task', targetId: 'task-2' })]));
    expect(screen.getByRole('group', { name: 'Filtro por target' }).textContent).toContain('Task task-2');
    expect(selection()).toEqual({ projectId: null, taskId: null }); // no inventa una selección
  }, PALETTE_TEST_TIMEOUT);

  it.each([
    ['run', 'att-run', 'run-7', 'onOpenRun'],
    ['spawn_request', 'att-spawn', 'pend-3', 'onOpenSpawnRequest'],
  ])('enruta Attention de %s por la ruta existente con el ID exacto', async (_kind, attentionId, targetId, prop) => {
    const open = vi.fn(() => true);
    await openPalette({ [prop]: open });
    await pick(attentionId);

    expect(open.mock.calls).toEqual([[targetId]]);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(attentionCalls()).toHaveLength(0);
  }, PALETTE_TEST_TIMEOUT);

  it('si la ruta de Run ya no existe, mantiene la paleta con un aviso y no cae a otro destino', async () => {
    const onOpenRun = vi.fn(() => false);
    await openPalette({ onOpenRun });
    await pick('att-run', 'Attention');

    expect(onOpenRun).toHaveBeenCalledWith('run-7');
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('El Run run-7 ya no está disponible');
    expect(selection()).toEqual({ projectId: null, taskId: null });
  }, PALETTE_TEST_TIMEOUT);

  it('anuncia un tipo de destino no soportado sin navegar a ningún otro sitio', async () => {
    const onOpenRun = vi.fn(() => true);
    const onOpenSpawnRequest = vi.fn(() => true);
    await openPalette({ onOpenRun, onOpenSpawnRequest });
    await pick('att-attempt', 'Attention');

    // LXO-123: un destino attempt ya se resuelve; attempt-5 no es <task>-a<n> (o el modelo no es vNext): se rechaza con texto, sin navegar.
    expect([COPY.navAttemptNeedsModel, COPY.navAttemptInvalid].some((t) => screen.getByRole('alert').textContent.includes(t))).toBe(true);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(onOpenRun).not.toHaveBeenCalled();
    expect(onOpenSpawnRequest).not.toHaveBeenCalled();
    expect(screen.getByRole('tab', { name: 'Workspace' }).getAttribute('aria-selected')).toBe('true');
    expect(attentionCalls()).toHaveLength(0);
  }, PALETTE_TEST_TIMEOUT);

  it('cede a Quick Open / la paleta de comandos del IDE en vez de apilarse', async () => {
    const { useAppStore } = await import('../store/appStore');
    await openPalette();
    act(() => useAppStore.getState().setQuickOpen(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(useWorkbenchStore.getState().jumpPaletteOpen).toBe(false);
    act(() => useAppStore.getState().setQuickOpen(false));
  }, PALETTE_TEST_TIMEOUT);

  it('cierra con Esc sin navegar y restaura el foco', async () => {
    await openPalette();
    fireEvent.keyDown(input(), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(selection()).toEqual({ projectId: null, taskId: null });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Foco previo' }));
  }, PALETTE_TEST_TIMEOUT);
});
