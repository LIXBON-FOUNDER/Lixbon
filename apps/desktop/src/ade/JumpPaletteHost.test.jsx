import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { JumpPaletteHost } from './JumpPaletteHost';
import { PALETTE_CONCURRENCY } from './jumpPaletteData';
import { queryAdeCore } from './coreQueries';

vi.mock('./coreQueries', async (importOriginal) => ({ ...(await importOriginal()), queryAdeCore: vi.fn() }));

// FIXTURES con la forma del contrato de docs/core/QUERIES.md; no son una lectura de Core real ni dogfood.

const PROJECTS = [
  { id: 'prj-1', name: 'Alpha', status: 'active', locations: [{ machine: 'host-a', path: 'C:/alpha' }] },
  { id: 'prj-2', name: 'Beta', status: 'idle', locations: [] },
  ...Array.from({ length: 4 }, (_, index) => ({ id: `prj-${index + 3}`, name: `Gamma ${index + 3}`, status: 'idle', locations: [] })),
];

const makeTasks = (projectId, count, over = {}) => Array.from({ length: count }, (_, index) => ({
  id: `${projectId}-task-${index + 1}`,
  title: `${projectId} tarea ${index + 1}`,
  status: 'running',
  branch: `rama/${projectId}/${index + 1}`,
  created_at: 1,
  updated_at: 2,
  ...over,
}));

/** Reparte `tasks` en páginas de 50 con cursores opacos `cur:<proyecto>:<n>` (el cliente no los interpreta). */
function paged(projectId, tasks, cursor) {
  const start = cursor ? Number(cursor.split(':')[2]) : 0;
  const slice = tasks.slice(start, start + 50);
  const end = start + 50;
  return { v: 1, project_id: projectId, tasks: slice, has_more: end < tasks.length, next_cursor: end < tasks.length ? `cur:${projectId}:${end}` : null };
}

const att = (over = {}) => ({
  id: 'att-1', category: 'question', severity: 'high', status: 'active', target_kind: 'task', target_id: 'prj-1-task-2',
  project_id: 'prj-1', run_id: null, occurrence: 1, created_at: 1, resolved_at: null, resolution: null, ...over,
});

// La carga real es asíncrona; bajo la suite completa el reloj de jsdom va más lento que el límite por defecto de 1 s.
configure({ asyncUtilTimeout: 5000 });

let taskData;
let attentionItems;
let inFlight;
let maxInFlight;

function core({ fail = {} } = {}) {
  inFlight = 0;
  maxInFlight = 0;
  queryAdeCore.mockImplementation(async (query, args) => {
    if (fail[query] && (fail[query] === true || fail[query](args))) throw new Error(`${query}_read_failed: fixture`);
    if (query === 'projects_overview') return { v: 1, filters: { archived: args.archived }, total: PROJECTS.length, projects: PROJECTS };
    if (query === 'attention_list') {
      const second = args.cursor === 'att-cursor-1';
      const items = second ? attentionItems.slice(1) : attentionItems.slice(0, 1);
      return { v: 1, items, has_more: !second && attentionItems.length > 1, next_cursor: !second && attentionItems.length > 1 ? 'att-cursor-1' : null, limit: 100 };
    }
    if (query === 'tasks_by_project') {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return paged(args.projectId, taskData[args.projectId] ?? [], args.cursor);
    }
    throw new Error(`Query no permitida en fixture: ${query}`);
  });
}

function Harness({ initialOpen = true, onNavigate }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Abrir paleta</button>
      <JumpPaletteHost open={open} onClose={() => setOpen(false)} onNavigate={onNavigate} />
    </>
  );
}

const input = () => screen.getByRole('combobox', { name: 'Buscar Projects, Tasks y Attention' });
const activeOption = () => document.getElementById(input().getAttribute('aria-activedescendant'));
// Carga inicial completa con los datos estándar: 131 Tasks y sin progreso pendiente.
const loaded = () => waitFor(() => {
  expect(within(screen.getByRole('group', { name: 'Tasks' })).getAllByRole('option')).toHaveLength(131);
  expect(screen.getByRole('status').textContent).not.toContain('Cargando Tasks');
});
const calls = (query) => queryAdeCore.mock.calls.filter(([name]) => name === query);

beforeEach(() => {
  localStorage.clear(); // los recientes viven en localStorage: ninguna prueba hereda los de otra
  taskData = { 'prj-1': makeTasks('prj-1', 120), 'prj-2': makeTasks('prj-2', 5), 'prj-3': makeTasks('prj-3', 3), 'prj-4': [], 'prj-5': makeTasks('prj-5', 1), 'prj-6': makeTasks('prj-6', 2) };
  attentionItems = [att(), att({ id: 'att-2', target_kind: 'run', target_id: 'run-9', project_id: null })];
  core();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  queryAdeCore.mockReset();
});

describe('JumpPaletteHost · lecturas', () => {
  it('no lee Core mientras está cerrada y solo usa las queries read-only permitidas al abrir', async () => {
    render(<Harness initialOpen={false} onNavigate={vi.fn()} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(queryAdeCore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir paleta' }));
    await screen.findByRole('option', { name: /Alpha/ });
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toContain('Cargando Tasks'));

    expect(new Set(queryAdeCore.mock.calls.map(([name]) => name))).toEqual(new Set(['projects_overview', 'tasks_by_project', 'attention_list']));
    expect(calls('projects_overview')).toEqual([['projects_overview', { archived: 'exclude' }]]);
  });

  it('sigue los cursores opacos exactos, con concurrencia acotada, y muestra 100+ Tasks', async () => {
    render(<Harness onNavigate={vi.fn()} />);
    await screen.findByRole('option', { name: /prj-1 tarea 120/ });
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Tasks' })).getAllByRole('option')).toHaveLength(131));

    const project1 = calls('tasks_by_project').filter(([, args]) => args.projectId === 'prj-1').map(([, args]) => args);
    expect(project1).toEqual([
      { projectId: 'prj-1', status: 'all', cursor: null },
      { projectId: 'prj-1', status: 'all', cursor: 'cur:prj-1:50' },
      { projectId: 'prj-1', status: 'all', cursor: 'cur:prj-1:100' },
    ]);
    expect(calls('attention_list').map(([, args]) => args)).toEqual([{ cursor: null }, { cursor: 'att-cursor-1' }]);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(PALETTE_CONCURRENCY);
  });

  it('busca por título/nombre y ID durable, y deja la rama como metadato secundario', async () => {
    taskData['prj-2'][0] = { ...taskData['prj-2'][0], title: 'Migración', branch: 'feat/login' };
    taskData['prj-2'][1] = { ...taskData['prj-2'][1], title: 'Login con feat/login' };
    render(<Harness onNavigate={vi.fn()} />);
    await screen.findByRole('option', { name: /prj-1 tarea 120/ });
    await loaded();

    fireEvent.change(input(), { target: { value: 'Beta' } });
    expect(screen.getByRole('option', { name: /Beta/ })).toBeTruthy();
    fireEvent.change(input(), { target: { value: 'prj-1-task-77' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.change(input(), { target: { value: 'login' } });
    const options = screen.getAllByRole('option');
    expect(options[0].textContent).toContain('Login con feat/login'); // el título gana a la rama
    expect(options[1].textContent).toContain('Migración');
    fireEvent.change(input(), { target: { value: 'rama/prj-3/2' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('muestra Estado y Host/origen solo si Core los devuelve; lo desconocido queda explícito', async () => {
    taskData['prj-3'][0] = { ...taskData['prj-3'][0], host: 'maquina-7', origin: 'cli' };
    render(<Harness onNavigate={vi.fn()} />);
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();

    const alpha = screen.getByRole('option', { name: /Alpha/ });
    expect(alpha.textContent).toContain('Estado active');
    expect(alpha.textContent).toContain('Host host-a');
    expect(screen.getByRole('option', { name: /Beta/ }).textContent).toContain('Host/origen no informado');
    fireEvent.change(input(), { target: { value: 'prj-3-task-1' } });
    expect(screen.getByRole('option').textContent).toContain('Host/origen maquina-7 / cli');
    fireEvent.change(input(), { target: { value: 'prj-3-task-2' } });
    expect(screen.getByRole('option').textContent).toContain('Estado running');
    expect(screen.getByRole('option').textContent).toContain('Host/origen no informado');
  });

  it('etiqueta Attention con el título de su Task por ID exacto y la busca por IDs durables', async () => {
    render(<Harness onNavigate={vi.fn()} />);
    await screen.findByRole('option', { name: /Alpha/ });
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'Attention' })).getByRole('option', { name: /prj-1 tarea 2/ })).toBeTruthy());

    const group = screen.getByRole('group', { name: 'Attention' });
    expect(within(group).getAllByRole('option')).toHaveLength(2);
    expect(within(group).getByRole('option', { name: /prj-1 tarea 2/ }).textContent).toContain('Destino task');
    fireEvent.change(input(), { target: { value: 'run-9' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option').textContent).toContain('Sin Project');
    fireEvent.change(input(), { target: { value: 'att-1' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('declara parcial una lectura fallida sin ocultar el resto', async () => {
    core({ fail: { tasks_by_project: (args) => args.projectId === 'prj-2' } });
    render(<Harness onNavigate={vi.fn()} />);
    await screen.findByRole('option', { name: /prj-1 tarea 120/ });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No se pudieron leer las Tasks de 1 Project.'));
    expect(screen.queryByText('prj-2 tarea 1')).toBeNull();
    expect(screen.getByText('prj-3 tarea 1')).toBeTruthy();
  });

  it('muestra un error recuperable cuando Core no responde y reintenta', async () => {
    core({ fail: { projects_overview: true, attention_list: true } });
    render(<Harness onNavigate={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No se pudieron leer los resultados de Core');

    core();
    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('option', { name: /Alpha/ });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('JumpPaletteHost · navegación y foco', () => {
  it('entrega IDs exactos de Project, Task y Attention y restaura el foco al cerrar', async () => {
    const onNavigate = vi.fn(() => ({ ok: true }));
    render(<Harness initialOpen={false} onNavigate={onNavigate} />);
    const trigger = screen.getByRole('button', { name: 'Abrir paleta' });
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByRole('option', { name: /Alpha/ });
    expect(document.activeElement).toBe(input());

    fireEvent.change(input(), { target: { value: 'prj-2' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'project', projectId: 'prj-2' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    await screen.findByRole('option', { name: /Alpha/ });
    expect(input().value).toBe(''); // la consulta no sobrevive al cierre
    fireEvent.change(input(), { target: { value: 'prj-3-task-2' } });
    fireEvent.click(await screen.findByRole('option', { name: /prj-3 tarea 2/ }));
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'task', projectId: 'prj-3', taskId: 'prj-3-task-2' });

    fireEvent.click(trigger);
    await screen.findByRole('option', { name: /Alpha/ });
    await waitFor(() => expect(screen.getByRole('group', { name: 'Attention' })).toBeTruthy());
    fireEvent.change(input(), { target: { value: 'att-2' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onNavigate).toHaveBeenLastCalledWith({ kind: 'attention', attentionId: 'att-2', targetKind: 'run', targetId: 'run-9', projectId: null });
    expect(onNavigate).toHaveBeenCalledTimes(3);
  });

  it('mantiene abierta la paleta y anuncia el aviso cuando la navegación declara un destino no soportado', async () => {
    const onNavigate = vi.fn(() => ({ ok: false, message: 'Esta vista aún no abre destinos de tipo thread (t-1).' }));
    render(<Harness onNavigate={onNavigate} />);
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();
    fireEvent.change(input(), { target: { value: 'prj-5-task-1' } });
    expect(await screen.findByRole('option')).toBeTruthy();
    fireEvent.keyDown(input(), { key: 'Enter' });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('aún no abre destinos de tipo thread');
    fireEvent.change(input(), { target: { value: 'prj' } });
    expect(screen.queryByRole('alert')).toBeNull(); // el aviso caduca al cambiar la búsqueda
  });

  it('un refresco en segundo plano ni roba el foco ni cambia la opción activa', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render(<Harness onNavigate={vi.fn()} />);
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();
    await act(async () => { await Promise.resolve(); });
    fireEvent.keyDown(input(), { key: 'ArrowDown' });
    const active = activeOption();
    const label = active.textContent;
    const before = calls('projects_overview').length;

    taskData['prj-6'].push(...makeTasks('prj-6', 1, { id: 'prj-6-nueva', title: 'Tarea nueva' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    await waitFor(() => expect(screen.getByRole('option', { name: /Tarea nueva/ })).toBeTruthy());

    expect(calls('projects_overview').length).toBe(before + 1);
    expect(document.activeElement).toBe(input());
    expect(activeOption().textContent).toBe(label);
  });

  it('deja de leer Core al cerrar', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render(<Harness onNavigate={vi.fn()} />);
    await screen.findByRole('option', { name: /Alpha/ });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    const count = queryAdeCore.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(queryAdeCore.mock.calls.length).toBe(count);
  });
});
