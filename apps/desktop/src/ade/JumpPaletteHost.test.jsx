import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { JumpPaletteHost } from './JumpPaletteHost';
import { PALETTE_CONCURRENCY } from './jumpPaletteData';
import { queryAdeCore } from './coreQueries';

vi.mock('./coreQueries', async (importOriginal) => ({ ...(await importOriginal()), queryAdeCore: vi.fn() }));

// Fixtures que respetan los DTO documentados de projects_overview y tasks_by_project.
const attentionCounts = { total: 0, by_category: { question: 0, approval: 0, review_ready: 0, conflict: 0, failed: 0, environment_blocked: 0, risk: 0 } };
const projectDto = (id, name, status, locations = []) => ({
  id,
  name,
  state: 'active',
  status,
  counts: { tasks: 1, active: 1, failed: 0, attention: attentionCounts },
  locations,
});

const PROJECTS = [
  projectDto('prj-1', 'Alpha', 'active', [{ machine: 'host-a', path: 'C:/alpha', primary: true, state: 'ok', last_seen: 1 }]),
  projectDto('prj-2', 'Beta', 'idle'),
  projectDto('prj-3', 'Gamma 3', 'idle', [{ machine: 'maquina-7', path: 'C:/gamma-3', primary: true, state: 'ok', last_seen: 1 }]),
  ...Array.from({ length: 3 }, (_, index) => projectDto(`prj-${index + 4}`, `Gamma ${index + 4}`, 'idle')),
];

const makeTasks = (projectId, count, over = {}) => Array.from({ length: count }, (_, index) => ({
  id: `${projectId}-task-${index + 1}`,
  run_id: `${projectId}-run-${index + 1}`,
  parent_id: null,
  root_id: `${projectId}-task-${index + 1}`,
  title: `${projectId} tarea ${index + 1}`,
  status: 'running',
  provider: null,
  model: null,
  branch: `rama/${projectId}/${index + 1}`,
  worktree: null,
  created_at: 1,
  updated_at: 2,
  ...over,
}));

/** Reparte `tasks` en páginas de 50 con cursores opacos `cur:<proyecto>:<n>` (el cliente no los interpreta). */
function paged(projectId, tasks, cursor, status) {
  const start = cursor ? Number(cursor.split(':')[2]) : 0;
  const slice = tasks.slice(start, start + 50);
  const end = start + 50;
  return { v: 1, project_id: projectId, filters: { status }, limit: 50, tasks: slice, has_more: end < tasks.length, next_cursor: end < tasks.length ? `cur:${projectId}:${end}` : null };
}

const att = (over = {}) => ({
  id: 'att-1', category: 'question', severity: 'high', status: 'active', target_kind: 'task', target_id: 'prj-1-task-2',
  project_id: 'prj-1', run_id: null, occurrence: 1, created_at: 1, resolved_at: null, resolution: null, ...over,
});

// Estas pruebas son de integración: montan la paleta con las 139 opciones del fixture (131 Tasks) y
// esperan a un Core simulado cuya carga es asíncrona. El coste está en el filtro `name` de las consultas
// por rol: RTL recalcula el nombre accesible de TODAS las opciones en cada sondeo de `waitFor`/`findBy*`
// (~55 ms por sondeo en solitario, medido en la investigación de LXO-102), así que la espera necesita
// varios sondeos.
// Medido en la investigación de LXO-102 (corrida con los 15 archivos de src/ade en paralelo): «no lee Core
// mientras está cerrada…» tardó 0,3 s en solitario y 6,6 s en paralelo, y «busca por título/nombre y ID
// durable…» llegó a 7,8 s: por encima del presupuesto por defecto de la prueba (5 s). Una de ellas agotó
// además los 5 s de presupuesto de espera. Al repetir esa misma corrida con menos carga en la máquina
// bajaron a 1,1-2,1 s: el factor depende de la carga, así que no se escribe un multiplicador fijo; lo que
// se fija son los presupuestos.
// Los archivos hermanos JumpPaletteHost.recents (7 opciones) y JumpPaletteHost.stale (paleta simulada, sin
// consultas por rol) no pagan ese coste: en la misma corrida se midieron por debajo de 1,5 s y de 0,8 s, así
// que no llevan presupuesto propio.
// El presupuesto de espera de RTL (10 s) queda POR DEBAJO del presupuesto de la prueba (15 s): si fueran el
// mismo, un `wait` que no se cumple se reportaría como "Test timed out in 5000ms" —sin causa— en vez de
// decir qué elemento no apareció. Los 10 s cubren el caso medido en que una espera agotó los 5 s de espera
// anteriores, y los 15 s cubren la duración más larga medida (7,8 s) con las varias esperas seguidas que
// encadenan estas pruebas.
const PALETTE_WAIT_TIMEOUT = 10_000;
const PALETTE_TEST_TIMEOUT = 15_000;
configure({ asyncUtilTimeout: PALETTE_WAIT_TIMEOUT });

let taskData;
let attentionItems;
let inFlight;
let maxInFlight;

function core({ fail = {} } = {}) {
  inFlight = 0;
  maxInFlight = 0;
  queryAdeCore.mockImplementation(async (query, args) => {
    if (fail[query] && (fail[query] === true || fail[query](args))) throw new Error(`${query}_read_failed: fixture`);
    if (query === 'projects_overview') return {
      v: 1,
      filters: { archived: args.archived, machine: null },
      total: PROJECTS.length,
      projects: PROJECTS,
      unassigned: { tasks: 0, active: 0, failed: 0, attention: attentionCounts },
    };
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
      return paged(args.projectId, taskData[args.projectId] ?? [], args.cursor, args.status);
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
  }, PALETTE_TEST_TIMEOUT);

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
  }, PALETTE_TEST_TIMEOUT);

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
  }, PALETTE_TEST_TIMEOUT);

  it('muestra Estado y ubicación del Project desde metadata autoritativa', async () => {
    render(<Harness onNavigate={vi.fn()} />);
    await screen.findByRole('option', { name: /Alpha/ });
    await loaded();

    const alpha = screen.getByRole('option', { name: /Alpha/ });
    expect(alpha.textContent).toContain('Estado active');
    expect(alpha.textContent).toContain('Host host-a');
    expect(screen.getByRole('option', { name: /Beta/ }).textContent).toContain('Ubicación/host del Project no informado');
    fireEvent.change(input(), { target: { value: 'prj-3-task-1' } });
    expect(screen.getByRole('option').textContent).toContain('Ubicación/host del Project maquina-7');
    fireEvent.change(input(), { target: { value: 'prj-3-task-2' } });
    expect(screen.getByRole('option').textContent).toContain('Estado running');
    expect(screen.getByRole('option').textContent).toContain('Ubicación/host del Project maquina-7');
    fireEvent.change(input(), { target: { value: 'prj-2-task-1' } });
    expect(screen.getByRole('option').textContent).toContain('Ubicación/host del Project no informado');
  }, PALETTE_TEST_TIMEOUT);

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
  }, PALETTE_TEST_TIMEOUT);

  it('declara parcial una lectura fallida sin ocultar el resto', async () => {
    core({ fail: { tasks_by_project: (args) => args.projectId === 'prj-2' } });
    render(<Harness onNavigate={vi.fn()} />);
    await screen.findByRole('option', { name: /prj-1 tarea 120/ });
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No se pudieron leer las Tasks de 1 Project.'));
    expect(screen.queryByText('prj-2 tarea 1')).toBeNull();
    expect(screen.getByText('prj-3 tarea 1')).toBeTruthy();
  }, PALETTE_TEST_TIMEOUT);

  it('muestra un error recuperable cuando Core no responde y reintenta', async () => {
    core({ fail: { projects_overview: true, attention_list: true } });
    render(<Harness onNavigate={vi.fn()} />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('No se pudieron leer los resultados de Core');

    core();
    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    await screen.findByRole('option', { name: /Alpha/ });
    expect(screen.queryByRole('alert')).toBeNull();
  }, PALETTE_TEST_TIMEOUT);
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
  }, PALETTE_TEST_TIMEOUT);

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
  }, PALETTE_TEST_TIMEOUT);

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
  }, PALETTE_TEST_TIMEOUT);

  it('deja de leer Core al cerrar', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    render(<Harness onNavigate={vi.fn()} />);
    await screen.findByRole('option', { name: /Alpha/ });
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    const count = queryAdeCore.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(queryAdeCore.mock.calls.length).toBe(count);
  }, PALETTE_TEST_TIMEOUT);
});
