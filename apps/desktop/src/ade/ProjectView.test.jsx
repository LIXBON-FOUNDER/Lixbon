import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { ProjectView, taskMatchesFilter, ACTIVE_TASK_STATUSES, FINAL_TASK_STATUSES } from './ProjectView';

afterEach(cleanup);

// Todos los datos son SINTÉTICOS: ni IDs, ni hosts, ni rutas, ni textos vienen de Core real.
const PID = 'synthetic-project-1';
// Forma del DTO de solo lectura de LXO-90: sin location_id ni disponibilidad.
const LOC_A = { machine: 'synthetic-machine-a', path: '/synthetic/a/repo', primary: true, state: 'ok', last_seen: '2026-01-02T03:04:05Z' };
const LOC_B = { machine: 'synthetic-machine-b', path: '/synthetic/b/repo', primary: false, state: 'ok', last_seen: '2026-01-01T00:00:00Z' };
const LOC_MISSING = { machine: 'synthetic-machine-c', path: '/synthetic/c/repo', primary: false, state: 'missing', last_seen: '2025-12-31T23:59:59Z' };

const ready = (items = [], extra = {}) => ({ state: 'ready', items, ...extra });
const task = (id, status, extra = {}) => ({ task_id: id, title: `Task ${id}`, status, ...extra });

const T_RUNNING = task('t-live', 'running');
const T_STARTING = task('t-start', 'starting');
const T_WAIT = task('t-wait', 'awaiting_terminal_approval');
const T_WAITING = task('t-waiting', 'waiting');
const T_DONE = task('t-done', 'done');
const T_FAILED = task('t-fail', 'failed');
const T_EXITED = task('t-exit', 'exited');
const T_STOPPED = task('t-stop', 'stopped');
const T_UNKNOWN = task('t-weird', 'paused_by_synthetic');
const ALL_TASKS = [T_RUNNING, T_STARTING, T_WAIT, T_WAITING, T_DONE, T_FAILED, T_EXITED, T_STOPPED, T_UNKNOWN];

const baseProps = () => ({
  projectId: PID,
  projectName: 'Project sintético',
  locations: ready([LOC_A, LOC_B]),
  summary: { state: 'ready', counts: { tasks: 9, attempts: 3, attention: 2, resources: 1 } },
  tasks: ready(ALL_TASKS),
  attention: ready([
    { attention_id: 'attn-review', kind: 'review', text: 'Texto sintético de revisión', task_id: 't-done' },
    { attention_id: 'attn-failed', kind: 'failed', text: 'Texto sintético de fallo', task_id: 't-fail', attempt_id: 'att-1' },
  ]),
  activity: ready([
    { activity_id: 'act-1', kind: 'synthetic.kind', text: 'Texto de Activity puesto por Core sintético', occurred_at: '2026-01-01T00:00:00Z', task_id: 't-live' },
  ]),
  resources: ready([{ resource_id: 'res-1', kind: 'worktree', label: 'Recurso sintético', availability: 'available' }]),
});

const view = (over = {}, cbs = {}) => render(<ProjectView {...baseProps()} {...over} {...cbs} />);
const section = (name) => screen.getByRole('region', { name });
const visibleTaskIds = () => within(section(/^Tasks/)).queryAllByTestId(/^task-(?!status$)/).map((el) => el.getAttribute('data-testid').replace('task-', ''));

describe('ProjectView · vacío y estados básicos', () => {
  it('todo en ready y vacío: mensajes de vacío explícitos, sin contadores inventados', () => {
    view({
      summary: { state: 'ready', counts: {} },
      locations: ready([]), tasks: ready([]), attention: ready([]), activity: ready([]), resources: ready([]),
    });
    expect(screen.getByTestId('tasks-empty')).toBeTruthy();
    expect(screen.getByTestId('attention-empty')).toBeTruthy();
    expect(screen.getByTestId('activity-empty')).toBeTruthy();
    expect(screen.getByTestId('resources-empty')).toBeTruthy();
    for (const k of ['tasks', 'attempts', 'attention', 'resources']) {
      expect(screen.getByTestId(`count-${k}`).querySelector('dd').textContent).toBe('—');
    }
  });

  it('sin props: todo explícitamente no disponible, nada de «vacío» ni de ceros', () => {
    const { container } = render(<ProjectView />);
    expect(screen.getByTestId('project-id-missing')).toBeTruthy();
    expect(screen.queryByTestId('tasks-empty')).toBeNull();
    expect(screen.queryByTestId('attention-empty')).toBeNull();
    expect(screen.getAllByTestId('slice-notice').length).toBeGreaterThanOrEqual(5);
    expect(container.textContent).toContain('No disponible');
    expect(container.textContent).not.toMatch(/\b0\b/);
  });
});

describe('ProjectView · Task status, Attention y Activity son ejes distintos', () => {
  it('una Task done con Attention review: estado en Tasks, Attention en su sección, sin mezclar', () => {
    view();
    const tasks = section(/^Tasks/);
    const attention = section(/^Attention/);
    const activity = section(/^Activity/);
    fireEvent.click(within(tasks).getByTestId('filter-all'));
    expect(within(tasks).getByTestId('task-t-done').querySelector('[data-testid="task-status"]').getAttribute('data-status')).toBe('done');
    expect(within(attention).getByTestId('attention-attn-review').querySelector('[data-testid="attention-kind"]').textContent).toBe('review');
    expect(within(attention).queryByTestId('task-status')).toBeNull();
    expect(within(tasks).queryByTestId('attention-kind')).toBeNull();
    expect(within(activity).queryByTestId('task-status')).toBeNull();
    expect(within(activity).queryByTestId('attention-kind')).toBeNull();
  });

  it('una Task failed y una Task active se distinguen por texto, no solo por color', () => {
    view();
    fireEvent.click(screen.getByTestId('filter-all'));
    expect(within(screen.getByTestId('task-t-fail')).getByTestId('task-status').textContent).toBe('Falló');
    expect(within(screen.getByTestId('task-t-live')).getByTestId('task-status').textContent).toBe('En curso');
    expect(within(screen.getByTestId('task-t-wait')).getByTestId('task-status').textContent).toBe('Espera aprobación en terminal');
    expect(within(screen.getByTestId('task-t-waiting')).getByTestId('task-status').textContent).toBe('Esperando respuesta');
  });

  it('la Attention no se infiere del estado de la Task: failed sin entrada de Attention no crea ninguna', () => {
    view({ attention: ready([]) });
    fireEvent.click(screen.getByTestId('filter-all'));
    expect(within(screen.getByTestId('task-t-fail')).getByTestId('task-status').textContent).toBe('Falló');
    expect(screen.getByTestId('attention-empty')).toBeTruthy();
  });

  it('Activity: pinta el texto de Core; sin texto no lo inventa a partir del tipo de evento', () => {
    view({
      activity: ready([
        { activity_id: 'a-text', kind: 'task.failed', text: 'Texto humano de Core sintético', occurred_at: '2026-01-01T00:00:00Z' },
        { activity_id: 'a-bare', kind: 'task.failed' },
      ]),
    });
    expect(within(screen.getByTestId('activity-a-text')).getByTestId('activity-text').textContent).toBe('Texto humano de Core sintético');
    const bare = screen.getByTestId('activity-a-bare');
    expect(within(bare).queryByTestId('activity-text')).toBeNull();
    const msg = within(bare).getByTestId('activity-no-text');
    expect(msg.textContent).toContain('Core no suministró texto');
    expect(msg.textContent).toContain('Tipo sin interpretar');
    expect(bare.textContent).not.toMatch(/falló|fallo|failed task|ha fallado/i);
    expect(bare.textContent).toContain('Hora desconocida');
  });

  it('Attention sin texto: lo dice, y el tipo se muestra tal cual', () => {
    view({ attention: ready([{ attention_id: 'attn-x', kind: 'synthetic_kind' }]) });
    const row = screen.getByTestId('attention-attn-x');
    expect(row.textContent).toContain('Core no suministró texto');
    expect(within(row).getByTestId('attention-kind').textContent).toBe('synthetic_kind');
  });
});

describe('ProjectView · filtros active/final/all', () => {
  it('semántica de taskMatchesFilter: los desconocidos solo entran en all', () => {
    for (const s of ACTIVE_TASK_STATUSES) {
      expect(taskMatchesFilter(s, 'active')).toBe(true);
      expect(taskMatchesFilter(s, 'final')).toBe(false);
    }
    for (const s of FINAL_TASK_STATUSES) {
      expect(taskMatchesFilter(s, 'final')).toBe(true);
      expect(taskMatchesFilter(s, 'active')).toBe(false);
    }
    for (const s of ['paused_by_synthetic', undefined, null, '']) {
      expect(taskMatchesFilter(s, 'active')).toBe(false);
      expect(taskMatchesFilter(s, 'final')).toBe(false);
      expect(taskMatchesFilter(s, 'all')).toBe(true);
    }
    expect(taskMatchesFilter('running', 'otro')).toBe(false);
  });

  it('por defecto muestra solo activas y avisa de que hay desconocidas fuera', () => {
    view();
    expect(visibleTaskIds().sort()).toEqual(['t-live', 't-start', 't-wait', 't-waiting']);
    expect(screen.getByTestId('unknown-status-hidden')).toBeTruthy();
  });

  it('waiting no es final: entra en Activas, no en Finales, y no se marca como desconocido', () => {
    expect(ACTIVE_TASK_STATUSES).toContain('waiting');
    expect(FINAL_TASK_STATUSES).not.toContain('waiting');
    expect(taskMatchesFilter('waiting', 'active')).toBe(true);
    expect(taskMatchesFilter('waiting', 'final')).toBe(false);
    view({ tasks: ready([T_WAITING, T_DONE]) });
    expect(visibleTaskIds()).toEqual(['t-waiting']);
    expect(screen.queryByTestId('unknown-status-hidden')).toBeNull();
    expect(screen.getByTestId('task-status').getAttribute('data-status')).toBe('waiting');
    fireEvent.click(screen.getByTestId('filter-final'));
    expect(visibleTaskIds()).toEqual(['t-done']);
  });

  it('un estado no reconocido sigue siendo desconocido y fuera de Activas aunque waiting sea activo', () => {
    view({ tasks: ready([T_WAITING, T_UNKNOWN]) });
    expect(visibleTaskIds()).toEqual(['t-waiting']);
    expect(screen.getByTestId('unknown-status-hidden')).toBeTruthy();
    for (const st of ['Waiting', 'wait', 'paused']) expect(taskMatchesFilter(st, 'active')).toBe(false);
  });

  it('finales: done, failed, exited, stopped', () => {
    view();
    fireEvent.click(screen.getByTestId('filter-final'));
    expect(visibleTaskIds().sort()).toEqual(['t-done', 't-exit', 't-fail', 't-stop']);
  });

  it('todas: incluye el estado desconocido, marcado como tal, y sin aviso de ocultas', () => {
    view();
    fireEvent.click(screen.getByTestId('filter-all'));
    expect(visibleTaskIds()).toHaveLength(ALL_TASKS.length);
    const weird = screen.getByTestId('task-t-weird');
    expect(within(weird).getByTestId('task-status').getAttribute('data-status')).toBe('unknown');
    expect(within(weird).getByTestId('task-status').textContent).toContain('Estado desconocido');
    expect(within(weird).getByTestId('task-status').textContent).toContain('paused_by_synthetic');
    expect(screen.queryByTestId('unknown-status-hidden')).toBeNull();
  });

  it('filtro vacío ≠ sin Tasks: mensaje distinto', () => {
    view({ tasks: ready([T_DONE]) });
    expect(screen.getByTestId('tasks-filtered-empty').textContent).toContain('Activas');
    expect(screen.queryByTestId('tasks-empty')).toBeNull();
    cleanup();
    view({ tasks: ready([]) });
    expect(screen.getByTestId('tasks-empty')).toBeTruthy();
    expect(screen.queryByTestId('tasks-filtered-empty')).toBeNull();
  });

  it('el filtro controlado manda y notifica; el no controlado también notifica', () => {
    const onFilterChange = vi.fn();
    const { rerender } = render(<ProjectView {...baseProps()} filter="final" onFilterChange={onFilterChange} />);
    expect(screen.getByTestId('filter-final').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('filter-active'));
    expect(onFilterChange).toHaveBeenCalledWith('active');
    expect(screen.getByTestId('filter-final').getAttribute('aria-checked')).toBe('true');
    rerender(<ProjectView {...baseProps()} filter="active" onFilterChange={onFilterChange} />);
    expect(screen.getByTestId('filter-active').getAttribute('aria-checked')).toBe('true');
  });

  it('filtro no válido cae en activas', () => {
    view({ filter: 'bogus' });
    expect(screen.getByTestId('filter-active').getAttribute('aria-checked')).toBe('true');
  });
});

describe('ProjectView · contadores solo de Core', () => {
  it('muestra los números de Core aunque no coincidan con las filas visibles', () => {
    view({ summary: { state: 'ready', counts: { tasks: 41, attempts: 7, attention: 5, resources: 9 } } });
    expect(screen.getByTestId('count-tasks').querySelector('dd').textContent).toBe('41');
    expect(screen.getByTestId('count-attempts').querySelector('dd').textContent).toBe('7');
    expect(screen.getByTestId('count-attention').querySelector('dd').textContent).toBe('5');
    expect(screen.getByTestId('count-resources').querySelector('dd').textContent).toBe('9');
    expect(visibleTaskIds()).toHaveLength(4);
  });

  it('sin contadores de Core no sustituye nada contando filas', () => {
    view({ summary: { state: 'ready' } });
    for (const k of ['tasks', 'attempts', 'attention', 'resources']) {
      expect(screen.getByTestId(`count-${k}`).querySelector('dd').textContent).toBe('—');
    }
    // ni encabezados ni filtros llevan números calculados
    for (const h of screen.getAllByRole('heading')) expect(h.textContent).not.toMatch(/\d/);
    for (const f of screen.getAllByRole('radio')) expect(f.textContent).not.toMatch(/\d/);
  });

  it('valores no válidos (negativos, decimales, texto, NaN) se tratan como no informados', () => {
    view({ summary: { state: 'ready', counts: { tasks: -1, attempts: 1.5, attention: '3', resources: NaN } } });
    for (const k of ['tasks', 'attempts', 'attention', 'resources']) {
      expect(screen.getByTestId(`count-${k}`).querySelector('dd').textContent).toBe('—');
    }
  });

  it('un 0 de Core se muestra como 0 (distinto de no informado)', () => {
    view({ summary: { state: 'ready', counts: { tasks: 0, attempts: 0, attention: 0, resources: 0 } } });
    expect(screen.getByTestId('count-tasks').querySelector('dd').textContent).toBe('0');
  });

  it('resumen en error o no disponible: no se pintan contadores', () => {
    view({ summary: { state: 'error', counts: { tasks: 9 }, message: 'fallo sintético' } });
    expect(screen.queryByTestId('count-tasks')).toBeNull();
    expect(screen.getAllByRole('alert')[0].textContent).toContain('fallo sintético');
    cleanup();
    view({ summary: undefined });
    expect(screen.queryByTestId('count-tasks')).toBeNull();
  });

  it('resumen parcial/degradado: pinta lo que hay con aviso', () => {
    view({ summary: { state: 'partial', counts: { tasks: 4 } } });
    expect(screen.getByTestId('count-tasks').querySelector('dd').textContent).toBe('4');
    expect(screen.getByTestId('count-attempts').querySelector('dd').textContent).toBe('—');
    expect(within(section(/Resumen/)).getByTestId('slice-notice').textContent).toContain('parciales');
  });
});

describe('ProjectView · ubicaciones, hosts e identidad del Project', () => {
  const rows = () => within(section('Ubicaciones')).getAllByTestId('location');

  it('pinta machine, path, primary, state y last_seen del DTO de LXO-90', () => {
    view();
    const [a, b] = rows();
    expect(within(a).getByTestId('location-machine').textContent).toBe('synthetic-machine-a');
    expect(within(a).getByTestId('location-path').textContent).toBe('/synthetic/a/repo');
    expect(within(a).getByTestId('location-primary').textContent).toBe('Principal');
    expect(within(a).getByTestId('location-state').getAttribute('data-state')).toBe('ok');
    expect(within(a).getByTestId('location-state').textContent).toBe('Presente');
    expect(within(a).getByText('2026-01-02T03:04:05Z').getAttribute('datetime')).toBe('2026-01-02T03:04:05Z');
    expect(within(b).getByTestId('location-machine').textContent).toBe('synthetic-machine-b');
    expect(within(b).queryByTestId('location-primary')).toBeNull();
  });

  it('state missing se dice explícitamente; ausente o raro es desconocido; no se inventa disponibilidad', () => {
    view({ locations: ready([LOC_MISSING, { machine: 'synthetic-machine-x', state: 'rarísimo' }, {}]) });
    const [missing, weird, empty] = rows();
    expect(within(missing).getByTestId('location-state').getAttribute('data-state')).toBe('missing');
    expect(within(missing).getByTestId('location-state').textContent).toBe('Ruta no encontrada');
    expect(within(weird).getByTestId('location-state').getAttribute('data-state')).toBe('unknown');
    expect(within(weird).getByTestId('location-path').textContent).toBe('Ruta desconocida');
    expect(within(weird).getByTestId('location-last-seen').textContent).toContain('desconocido');
    expect(within(empty).getByTestId('location-machine').textContent).toBe('Máquina desconocida');
    expect(section('Ubicaciones').textContent).not.toMatch(/Disponible|Disponibilidad/);
  });

  it('primary solo se marca con true estricto', () => {
    view({ locations: ready([{ ...LOC_B, primary: 'true' }, { ...LOC_B, primary: 1 }]) });
    expect(within(section('Ubicaciones')).queryByTestId('location-primary')).toBeNull();
  });

  it('las ubicaciones no tienen identidad propia: sin location_id, sin acción, sin selección', () => {
    const cb = { onOpenTask: vi.fn(), onOpenAttempt: vi.fn(), onOpenAttention: vi.fn(), onOpenResource: vi.fn(), onSelectLocation: vi.fn() };
    view({}, cb);
    const loc = section('Ubicaciones');
    expect(within(loc).queryAllByRole('button')).toHaveLength(0);
    for (const row of rows()) fireEvent.click(row);
    fireEvent.click(within(loc).getByText('/synthetic/a/repo'));
    expect(Object.values(cb).every((f) => f.mock.calls.length === 0)).toBe(true);
    expect(loc.querySelector('[aria-current], code')).toBeNull();
    expect(screen.queryByTestId('current-location')).toBeNull();
  });

  it('la ruta nunca es la identidad del Project: project_id sale solo de la prop y sobrevive a cambiar de ubicaciones', () => {
    const { rerender } = render(<ProjectView {...baseProps()} />);
    expect(screen.getByTestId('project-id').textContent).toBe(PID);
    rerender(<ProjectView {...baseProps()} locations={ready([LOC_B])} />);
    expect(screen.getByTestId('project-id').textContent).toBe(PID);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Project sintético');
    cleanup();
    render(<ProjectView {...baseProps()} projectId={undefined} projectName={undefined} />);
    expect(screen.getByTestId('project-id-missing')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Project sin identificar');
    expect(screen.getByRole('heading', { level: 2 }).textContent).not.toContain('/synthetic');
    expect(screen.getByTestId('project-view').textContent).toContain('/synthetic/a/repo');
  });

  it('las filas de Task, Activity y Resource no inventan ubicación a partir de location_id', () => {
    view({
      tasks: ready([task('t-loc', 'running', { location_id: 'synthetic-loc-x' })]),
      activity: ready([{ activity_id: 'a-loc', text: 'x', location_id: 'synthetic-loc-x' }]),
      resources: ready([{ resource_id: 'r-loc', label: 'r', location_id: 'synthetic-loc-x' }]),
    });
    expect(screen.getByTestId('project-view').textContent).not.toContain('synthetic-loc-x');
    expect(screen.queryByTestId('location-chip')).toBeNull();
  });

  it('sin project_id duradero lo dice y las filas no se vuelven navegables por otra vía', () => {
    const onOpenTask = vi.fn();
    render(<ProjectView {...baseProps()} projectId={undefined} projectName={undefined} onOpenTask={onOpenTask} />);
    expect(screen.getByTestId('project-id-missing')).toBeTruthy();
    expect(screen.queryByTestId('project-id')).toBeNull();
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Project sin identificar');
  });

  it('descarta filas que Core marca como de otro Project y lo avisa sin contar', () => {
    view({
      tasks: ready([T_RUNNING, task('t-foreign', 'running', { project_id: 'synthetic-project-2' }), task('t-own', 'running', { project_id: PID })]),
      attention: ready([{ attention_id: 'attn-foreign', kind: 'review', project_id: 'synthetic-project-2' }]),
      activity: ready([{ activity_id: 'act-foreign', text: 'ajena', project_id: 'synthetic-project-2' }]),
      resources: ready([{ resource_id: 'res-foreign', project_id: 'synthetic-project-2' }]),
    });
    expect(visibleTaskIds().sort()).toEqual(['t-live', 't-own']);
    expect(screen.queryByTestId('attention-attn-foreign')).toBeNull();
    expect(screen.queryByTestId('activity-act-foreign')).toBeNull();
    expect(screen.queryByTestId('resource-res-foreign')).toBeNull();
    expect(screen.getAllByTestId('foreign-omitted')).toHaveLength(4);
    // todo lo de otro Project desapareció de Attention: no queda en «vacío» ready engañoso
    expect(screen.getByTestId('attention-empty')).toBeTruthy();
  });
});

describe('ProjectView · navegación solo por IDs duraderos', () => {
  const callbacks = () => ({ onOpenTask: vi.fn(), onOpenAttempt: vi.fn(), onOpenAttention: vi.fn(), onOpenResource: vi.fn() });

  it('cada destino llama a su callback con un único argumento: el ID', () => {
    const cb = callbacks();
    view({}, cb);
    fireEvent.click(screen.getByTestId('open-task-t-live'));
    fireEvent.click(screen.getByTestId('attention-open-task-t-fail'));
    fireEvent.click(screen.getByTestId('attention-open-attempt-att-1'));
    fireEvent.click(screen.getByTestId('open-attention-attn-review'));
    fireEvent.click(screen.getByTestId('activity-open-task-t-live'));
    fireEvent.click(screen.getByTestId('open-resource-res-1'));
    expect(cb.onOpenTask.mock.calls).toEqual([['t-live'], ['t-fail'], ['t-live']]);
    expect(cb.onOpenAttempt.mock.calls).toEqual([['att-1']]);
    expect(cb.onOpenAttention.mock.calls).toEqual([['attn-review']]);
    expect(cb.onOpenResource.mock.calls).toEqual([['res-1']]);
  });

  it('no navega por título, ruta ni nombre: items sin ID no tienen acción', () => {
    const cb = callbacks();
    view({
      tasks: ready([{ title: 'Task sin id', status: 'running' }]),
      attention: ready([{ kind: 'review', text: 'sin id' }]),
      resources: ready([{ label: 'Recurso sin id' }]),
    }, cb);
    expect(screen.getByTestId('task-sin-id').textContent).toContain('Task sin id');
    expect(within(screen.getByTestId('task-sin-id')).queryByRole('button')).toBeNull();
    expect(within(screen.getByTestId('attention-sin-id')).queryByRole('button')).toBeNull();
    expect(within(screen.getByTestId('resource-sin-id')).queryByRole('button')).toBeNull();
    expect(Object.values(cb).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('sin callbacks no hay botones de navegación (solo el filtro)', () => {
    view();
    const buttons = screen.queryAllByRole('button', { hidden: true });
    expect(buttons.length).toBe(0);
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('el texto del título nunca sustituye al ID en el callback', () => {
    const cb = callbacks();
    view({ tasks: ready([task('t-id-1', 'running', { title: 'Un título muy distinto' })]) }, cb);
    fireEvent.click(screen.getByRole('button', { name: 'Un título muy distinto' }));
    expect(cb.onOpenTask).toHaveBeenCalledWith('t-id-1');
  });
});

describe('ProjectView · loading, error, partial, degraded y desconocido', () => {
  const noItemsExpected = (testIdFragment) => expect(screen.queryAllByTestId(new RegExp(`^${testIdFragment}-`))).toHaveLength(0);

  it('loading sin items: aviso con aria-busy y ni vacío ni filas', () => {
    view({ tasks: { state: 'loading', items: [] }, attention: { state: 'loading' }, activity: { state: 'loading' }, resources: { state: 'loading' } });
    const notice = within(section(/^Tasks/)).getByTestId('slice-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('tasks-empty')).toBeNull();
    expect(screen.queryByTestId('attention-empty')).toBeNull();
    expect(screen.queryByTestId('activity-empty')).toBeNull();
    expect(screen.queryByTestId('resources-empty')).toBeNull();
  });

  it('loading con refreshing: dice «Actualizando desde Core.» sin «Cargando…», conserva items y aria-busy', () => {
    view({
      tasks: { state: 'loading', refreshing: true, items: [T_RUNNING] },
      summary: { state: 'loading', refreshing: true, counts: { tasks: 1 } },
    });
    const taskNotice = within(section(/^Tasks/)).getByTestId('slice-notice');
    expect(taskNotice.textContent).toBe('Actualizando desde Core.');
    expect(taskNotice.getAttribute('aria-busy')).toBe('true');
    expect(taskNotice.className).toContain('pv__notice--loading');
    expect(visibleTaskIds()).toContain(T_RUNNING.task_id);
    const summaryNotice = within(section('Resumen de Core')).getByTestId('slice-notice');
    expect(summaryNotice.textContent).toBe('Actualizando desde Core.');
    expect(summaryNotice.textContent).not.toContain('Datos desactualizados');
    // Sin el flag, loading sigue siendo una primera carga.
    cleanup();
    view({ tasks: { state: 'loading', items: [] } });
    expect(within(section(/^Tasks/)).getByTestId('slice-notice').textContent).toBe('Cargando…');
  });

  it('error: role=alert con mensaje de Core, sin items (no son fiables) ni vacío', () => {
    view({ tasks: { state: 'error', items: [T_RUNNING], message: 'Error sintético de Core' }, activity: { state: 'error', items: [{ activity_id: 'x', text: 'stale' }] } });
    const alert = within(section(/^Tasks/)).getByRole('alert');
    expect(alert.textContent).toContain('Error sintético de Core');
    expect(visibleTaskIds()).toHaveLength(0);
    expect(screen.queryByTestId('tasks-empty')).toBeNull();
    expect(screen.queryByTestId('tasks-filtered-empty')).toBeNull();
    noItemsExpected('activity');
    expect(screen.queryByText('stale')).toBeNull();
  });

  it('partial y degraded: aviso explícito y se siguen pintando los items', () => {
    view({ tasks: { state: 'partial', items: [T_RUNNING] }, attention: { state: 'degraded', items: [{ attention_id: 'a1', kind: 'review', text: 'visible' }], message: 'Motivo sintético.' } });
    expect(within(section(/^Tasks/)).getByTestId('slice-notice').textContent).toContain('parciales');
    expect(visibleTaskIds()).toEqual(['t-live']);
    const att = within(section(/^Attention/));
    expect(att.getByTestId('slice-notice').textContent).toContain('degradados');
    expect(att.getByTestId('slice-notice').textContent).toContain('Motivo sintético.');
    expect(att.getByTestId('attention-a1')).toBeTruthy();
    // un listado parcial vacío no se declara «sin nada»
    cleanup();
    view({ attention: { state: 'partial', items: [] } });
    expect(screen.queryByTestId('attention-empty')).toBeNull();
  });

  it('unavailable y estado desconocido: se nombran y no se pintan items', () => {
    view({ resources: { state: 'unavailable', items: [{ resource_id: 'r1', label: 'no debe verse' }] }, activity: { state: 'mystery', items: [{ activity_id: 'a1', text: 'no debe verse' }] } });
    expect(within(section('Resources')).getByTestId('slice-notice').textContent).toContain('Core todavía no ofrece');
    const act = within(section(/^Activity/)).getByTestId('slice-notice');
    expect(act.textContent).toContain('Estado desconocido («mystery»)');
    expect(screen.queryByText('no debe verse')).toBeNull();
  });

  it('slice sin campo state o con state no string: desconocido, no listo', () => {
    view({ tasks: { items: [T_RUNNING] }, attention: { state: 42, items: [] } });
    expect(within(section(/^Tasks/)).getByTestId('slice-notice').textContent).toContain('Estado desconocido');
    expect(visibleTaskIds()).toHaveLength(0);
    expect(screen.queryByTestId('attention-empty')).toBeNull();
  });

  it('ubicaciones en error o cargando: no se declara «sin ubicaciones»', () => {
    view({ locations: { state: 'error', message: 'host inalcanzable sintético' } });
    expect(within(section('Ubicaciones')).getByRole('alert').textContent).toContain('host inalcanzable sintético');
    expect(screen.queryByText(/no conoce ubicaciones/)).toBeNull();
    cleanup();
    view({ locations: { state: 'loading' } });
    expect(screen.queryByText(/no conoce ubicaciones/)).toBeNull();
  });

  it('items malformados (null, sin campos) no rompen la vista', () => {
    expect(() => view({ tasks: ready([null, {}, { task_id: 't-ok', status: 'running' }]), attention: ready([null]), activity: ready([{}]), resources: ready([null, {}]), locations: ready([null, {}]) })).not.toThrow();
    expect(screen.getByTestId('task-t-ok')).toBeTruthy();
  });
});

describe('ProjectView · teclado y ARIA', () => {
  it('estructura: article con nombre, secciones con encabezado y listas etiquetadas', () => {
    view();
    expect(screen.getByRole('article', { name: 'Project sintético' })).toBeTruthy();
    for (const name of [/Resumen de Core/, 'Ubicaciones', /^Attention/, /^Tasks/, /^Activity/, 'Resources']) {
      expect(section(name)).toBeTruthy();
    }
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(6);
    for (const list of screen.getAllByRole('list')) expect(list.getAttribute('aria-labelledby')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Filtro' }).getAttribute('aria-describedby')).toBeTruthy();
  });

  it('filtro como radiogroup con tabindex móvil: solo el seleccionado entra en el orden de tab', () => {
    view();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    expect(radios.map((r) => r.textContent)).toEqual(['Activas', 'Finales', 'Todas']);
  });

  it('flechas, Home y End mueven foco y selección con vuelta circular', () => {
    const onFilterChange = vi.fn();
    view({}, { onFilterChange });
    const radio = (n) => screen.getByRole('radio', { name: n });
    radio('Activas').focus();
    fireEvent.keyDown(radio('Activas'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radio('Finales'));
    expect(radio('Finales').getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(radio('Finales'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(radio('Todas'));
    fireEvent.keyDown(radio('Todas'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(radio('Activas'));
    fireEvent.keyDown(radio('Activas'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(radio('Todas'));
    fireEvent.keyDown(radio('Todas'), { key: 'Home' });
    expect(document.activeElement).toBe(radio('Activas'));
    fireEvent.keyDown(radio('Activas'), { key: 'End' });
    expect(document.activeElement).toBe(radio('Todas'));
    fireEvent.keyDown(radio('Todas'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(radio('Finales'));
    expect(onFilterChange.mock.calls.map((c) => c[0])).toEqual(['final', 'all', 'active', 'all', 'active', 'all', 'final']);
  });

  it('otras teclas no cambian el filtro', () => {
    const onFilterChange = vi.fn();
    view({}, { onFilterChange });
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Activas' }), { key: 'a' });
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Activas' }), { key: 'Tab' });
    expect(onFilterChange).not.toHaveBeenCalled();
  });

  it('los destinos navegables son <button type="button"> nativos con nombre accesible', () => {
    view({}, { onOpenTask: vi.fn(), onOpenAttention: vi.fn(), onOpenResource: vi.fn(), onOpenAttempt: vi.fn() });
    for (const b of screen.getAllByRole('button')) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('type')).toBe('button');
      expect(b.textContent.trim().length).toBeGreaterThan(0);
    }
    expect(screen.getByRole('button', { name: 'Abrir Task t-fail' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abrir Attempt att-1' })).toBeTruthy();
  });

  it('avisos: error = alert, el resto = status; Activity usa lista ordenada con <time>', () => {
    view({ tasks: { state: 'error' }, attention: { state: 'loading' }, resources: { state: 'degraded', items: [] } });
    expect(within(section(/^Tasks/)).getByRole('alert')).toBeTruthy();
    expect(within(section(/^Attention/)).getAllByRole('status').length).toBeGreaterThan(0);
    const act = within(section(/^Activity/));
    expect(act.getByRole('list').tagName).toBe('OL');
    expect(act.getByText('2026-01-01T00:00:00Z').tagName).toBe('TIME');
    expect(act.getByText('2026-01-01T00:00:00Z').getAttribute('datetime')).toBe('2026-01-01T00:00:00Z');
  });
});

describe('ProjectView · solo lectura', () => {
  // `\b` real (límite de palabra), no el carácter U+0008: «run» no debe saltar con «Runtime», sí con «Run».
  const MUTATION = /\b(crear|nueva|nuevo|lanzar|ejecutar|iniciar|reintentar|reanudar|cancelar|detener|eliminar|borrar|limpiar|cleanup|adoptar|adopt|importar|integrar|aprobar|rechazar|guardar|enviar|create|launch|spawn|run|retry|delete|remove|clean|merge|approve|reject|save|submit)\b/i;
  const CONTROLS = 'button, [role="button"], a, input, select, textarea, form';
  const mutationControls = (root) => [...root.querySelectorAll(CONTROLS)]
    .map((el) => el.getAttribute('aria-label') || el.textContent)
    .filter((name) => MUTATION.test(name));

  it('el regex no contiene caracteres de control (U+0008) y trae límites de palabra reales', () => {
    // eslint-disable-next-line no-control-regex
    expect(MUTATION.source).not.toMatch(/[\u0000-\u001f]/);
    expect(MUTATION.source.startsWith('\\b(')).toBe(true);
    expect(MUTATION.source.endsWith(')\\b')).toBe(true);
  });

  it('el detector caza controles de mutación (control positivo) y respeta los límites de palabra', () => {
    for (const label of ['Crear Task', 'Reintentar', 'Aprobar', 'Merge', 'Delete', 'Run', 'run now', 'Guardar cambios', 'Limpiar worktree', 'cleanup']) {
      expect(MUTATION.test(label), label).toBe(true);
    }
    for (const label of ['Runtime', 'Abrir Task t-fail', 'Principal', 'Activas', 'Ruta no encontrada', 'Merged']) {
      expect(MUTATION.test(label), label).toBe(false);
    }
    const host = document.createElement('div');
    host.innerHTML = '<button type="button">Crear Task</button><button type="button" aria-label="Reintentar Attempt">Abrir</button><a href="#">Eliminar</a><button type="button">Abrir Task t-1</button>';
    expect(mutationControls(host)).toEqual(['Crear Task', 'Reintentar Attempt', 'Eliminar']);
  });

  it('mutación simulada: un control inyectado en la vista renderizada sí se detecta', () => {
    const { container } = view({}, { onOpenTask: vi.fn() });
    expect(mutationControls(container)).toEqual([]);
    const injected = document.createElement('button');
    injected.textContent = 'Lanzar Task';
    container.querySelector('.pv').appendChild(injected);
    expect(mutationControls(container)).toEqual(['Lanzar Task']);
  });

  it('sin controles de mutación aunque se pasen todos los callbacks', () => {
    const { container } = view({}, { onOpenTask: vi.fn(), onOpenAttempt: vi.fn(), onOpenAttention: vi.fn(), onOpenResource: vi.fn(), onFilterChange: vi.fn() });
    fireEvent.click(screen.getByTestId('filter-all'));
    expect(container.querySelectorAll(CONTROLS).length).toBeGreaterThan(0);
    expect(mutationControls(container)).toEqual([]);
    expect(container.querySelector('form, input, select, textarea, a[href]')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('con todos los textos sintéticos limpios, ningún texto fijo de la vista invita a mutar', () => {
    const { container } = view({
      summary: { state: 'ready', counts: {} }, locations: ready([]), tasks: ready([]), attention: ready([]), activity: ready([]), resources: ready([]),
    });
    expect(container.textContent).not.toMatch(MUTATION);
  });

  it('los únicos controles interactivos sin callbacks son los tres radios del filtro', () => {
    const { container } = view();
    const interactive = container.querySelectorAll('button, [tabindex]');
    expect([...interactive].every((el) => el.getAttribute('role') === 'radio')).toBe(true);
    expect(interactive).toHaveLength(3);
  });

  it('el filtro es estado de vista: no llama a ningún callback de dominio', () => {
    const cb = { onOpenTask: vi.fn(), onOpenAttempt: vi.fn(), onOpenAttention: vi.fn(), onOpenResource: vi.fn() };
    view({}, cb);
    fireEvent.click(screen.getByTestId('filter-final'));
    fireEvent.click(screen.getByTestId('filter-all'));
    expect(Object.values(cb).every((f) => f.mock.calls.length === 0)).toBe(true);
  });
});

describe('ProjectView · inventario de recursos (LXO-101, DTO de Core)', () => {
  // DTO de `resource_inventory` (docs/core/RESOURCES.md) con la FORMA del contrato: repos,
  // worktrees, ramas conservadas y avisos. Los datos son sintéticos; los campos y los
  // vocabularios son los que devuelve el Core.
  const INV = {
    v: 1,
    machine: 'synthetic-machine-1',
    filters: { project_id: null, probe: true },
    repos: [
      { project_id: PID, machine: 'synthetic-machine-1', path: '/synthetic/app', scan: 'ok' },
      { project_id: 'synthetic-project-2', machine: 'otro-equipo', path: '/srv/remoto', scan: 'other_machine', reason: 'other_machine' },
    ],
    worktrees: [
      {
        target: { machine: 'synthetic-machine-1', project_id: PID, repo: '/synthetic/app', path: '/synthetic/app.lixbon-wt/wt-c' },
        state: 'tracked', origin: 'task', physical: 'present',
        git: { registered: true, branch: 'lx/r/c', detached: false, locked: false, prunable: false },
        owner: { task_id: 't-9', run_id: 'r-1', status: 'done' },
        dirty: 'clean', merged: 'unmerged', into: 'main', needs_review: true,
      },
      {
        target: { machine: 'synthetic-machine-1', project_id: PID, repo: '/synthetic/app', path: '/synthetic/app.lixbon-wt/wt-ext' },
        state: 'external', origin: 'external', physical: 'present',
        git: { registered: true, branch: 'otra/rama', detached: false, locked: false, prunable: false },
        owner: null, dirty: 'clean', merged: 'unknown', into: 'main', needs_review: false,
      },
      {
        target: { machine: 'synthetic-machine-1', project_id: PID, repo: '/synthetic/app', path: '/synthetic/app.lixbon-wt/wt-falta' },
        state: 'missing_on_disk', origin: 'task', physical: 'missing',
        git: { registered: null, branch: 'lx/r/f', detached: false, locked: false, prunable: true },
        owner: { task_id: 't-10', run_id: 'r-2', status: 'done' },
        dirty: 'skipped', merged: 'skipped', into: 'main', needs_review: false,
      },
    ],
    preserved_branches: [
      {
        target: { machine: 'synthetic-machine-1', project_id: PID, repo: '/synthetic/app', branch: 'lx/r/g' },
        branch_exists: true, owner: { task_id: 't-4', run_id: 'r-1', status: 'stopped' },
        merged: 'unmerged', into: 'main', needs_review: true,
      },
    ],
    warnings: {
      branches_to_review: 2,
      worktrees_by_state: { tracked: 1, missing_on_disk: 1, not_registered: 0, orphan_candidate: 0, external: 1, unknown: 0 },
    },
  };
  const resourcesSection = () => section('Resources');
  const invRows = () => within(resourcesSection()).getAllByTestId('resinv-row');
  const invTargets = () => invRows().map((el) => within(el).getByTestId('resinv-target').textContent);

  it('sin DTO el inventario está montado en Resources con estado explícito «no disponible» y sin filas', () => {
    view();
    const inside = within(resourcesSection());
    expect(inside.getByTestId('resinv')).toBeTruthy();
    const notice = inside.getByTestId('resinv-unavailable-inventory');
    expect(notice.textContent).toContain('no disponible');
    // No dice que el contrato de Core esté pendiente ni en Backlog.
    expect(notice.textContent).not.toMatch(/LXO-93|Backlog|pendiente/i);
    expect(resourcesSection().textContent).not.toMatch(/LXO-93|Backlog/i);
    expect(inside.queryAllByTestId('resinv-row')).toHaveLength(0);
    expect(inside.queryByRole('combobox')).toBeNull();
    expect(inside.queryByTestId('resinv-warning-count')).toBeNull();
    // Solo está en Resources.
    expect(screen.getAllByTestId('resinv')).toHaveLength(1);
  });

  it('los items del slice legacy de Resources no se convierten en filas del inventario', () => {
    view({ resources: ready([{ resource_id: 'res-legacy', kind: 'worktree', label: 'Legacy sintético' }]) });
    const inside = within(resourcesSection());
    expect(inside.getByTestId('resource-res-legacy')).toBeTruthy();
    expect(inside.queryAllByTestId('resinv-row')).toHaveLength(0);
    expect(inside.getByTestId('resinv-unavailable-inventory')).toBeTruthy();
  });

  it('el DTO de Core se pinta en Resources con una sección por categoría', () => {
    view({ resourceInventory: INV });
    const inside = within(resourcesSection());
    expect(inside.queryByTestId('resinv-unavailable-inventory')).toBeNull();
    expect(inside.getByTestId('resinv-section-scan_ok')).toBeTruthy();
    expect(inside.getByTestId('resinv-section-tracked')).toBeTruthy();
    expect(inside.getByTestId('resinv-section-missing_on_disk')).toBeTruthy();
    expect(inside.getByTestId('resinv-section-external')).toBeTruthy();
    expect(inside.getByTestId('resinv-section-preserved')).toBeTruthy();
    expect(invTargets()).toEqual([
      '/synthetic/app',
      '/synthetic/app.lixbon-wt/wt-c',
      '/synthetic/app.lixbon-wt/wt-falta',
      '/synthetic/app.lixbon-wt/wt-ext',
      'lx/r/g',
    ]);
  });

  it('el externo no muestra propietario y el contador es el de Core, no uno derivado de las filas', () => {
    view({ resourceInventory: INV });
    const inside = within(resourcesSection());
    expect(within(inside.getByTestId('resinv-section-external')).getByTestId('resinv-owner').textContent).toBe('Sin propietario');
    expect(inside.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, todos los Projects): 2');
    // El filtro de aviso lo gobierna `needs_review`, no `merged === 'unmerged'`.
    fireEvent.change(inside.getByLabelText('Revisión'), { target: { value: 'needs_review' } });
    expect(invTargets()).toEqual(['/synthetic/app.lixbon-wt/wt-c', 'lx/r/g']);
  });

  it('el inventario se acota por Project ID: las filas de otro Project no se pintan', () => {
    const foreign = {
      ...INV,
      worktrees: [
        ...INV.worktrees,
        {
          target: { machine: 'synthetic-machine-1', project_id: 'synthetic-project-2', repo: '/synthetic/otro', path: '/synthetic/otro.lixbon-wt/wt' },
          state: 'tracked', origin: 'task', physical: 'present',
          git: { registered: true, branch: 'lx/r/x', detached: false, locked: false, prunable: false },
          owner: { task_id: 't-99', run_id: 'r-9', status: 'done' },
          dirty: 'clean', merged: 'merged', into: 'main', needs_review: false,
        },
      ],
    };
    view({ resourceInventory: foreign });
    expect(invTargets()).not.toContain('/synthetic/otro.lixbon-wt/wt');
    // El repo de otro Project tampoco sale.
    expect(invTargets()).not.toContain('/srv/remoto');
    expect(within(resourcesSection()).getByTestId('resinv-foreign-omitted')).toBeTruthy();
  });

  it('el inventario NO se filtra por ProjectLocation: una ruta fuera de las ubicaciones se ve igual', () => {
    // Las ubicaciones del ProjectView apuntan a /synthetic/a/repo y /synthetic/b/repo; la fila del
    // inventario está en /synthetic/app.lixbon-wt/wt-c. El acotado es por Project ID, no por ruta.
    view({ resourceInventory: INV });
    expect(invTargets()).toContain('/synthetic/app.lixbon-wt/wt-c');
  });

  it('sin branches_to_review de Core no se muestra contador', () => {
    view({ resourceInventory: { ...INV, warnings: { branches_to_review: null } } });
    expect(screen.queryByTestId('resinv-warning-count')).toBeNull();
  });

  it('el inventario sigue visible aunque el slice legacy de Resources falle, sin mezclar sus avisos', () => {
    view({ resources: { state: 'error' }, resourceInventory: INV });
    const inside = within(resourcesSection());
    expect(inside.getByTestId('slice-notice').textContent).toContain('No se pudo cargar');
    expect(inside.getAllByTestId('resinv-row')).toHaveLength(5);
  });

  it('solo lectura: sin controles de mutación, enlaces ni botones nuevos, y sin llamar a callbacks de dominio', () => {
    const cb = { onOpenTask: vi.fn(), onOpenAttempt: vi.fn(), onOpenAttention: vi.fn(), onOpenResource: vi.fn() };
    const { container } = view({ resourceInventory: INV }, cb);
    const inv = container.querySelector('[data-testid="resinv"]');
    expect(inv.querySelectorAll('button, a, input, textarea, form, [role="button"]')).toHaveLength(0);
    expect(inv.querySelectorAll('select')).toHaveLength(3);
    const MUTATION = /(crear|lanzar|ejecutar|reintentar|cancelar|detener|eliminar|borrar|limpiar|cleanup|adoptar|adopt|importar|integrar|aprobar|rechazar|guardar|enviar|create|launch|run|retry|delete|remove|clean|merge|approve|reject|save|submit)/i;
    const names = [...inv.querySelectorAll('select, option')].map((el) => el.textContent);
    expect(names.filter((n) => MUTATION.test(n))).toEqual([]);
    for (const select of inv.querySelectorAll('select')) fireEvent.change(select, { target: { value: select.options[1].value } });
    expect(Object.values(cb).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it('un inventario malformado se trata como no disponible, sin romper la vista', () => {
    expect(() => view({ resourceInventory: { worktrees: 'no-es-lista' } })).not.toThrow();
    expect(within(resourcesSection()).getByTestId('resinv-unavailable-inventory')).toBeTruthy();
  });

  it('una versión de inventario no compatible es estado desconocido en Resources: sin filas ni contador', () => {
    view({ resourceInventory: { ...INV, v: 2 } });
    const inside = within(resourcesSection());
    expect(inside.getByTestId('resinv-incompatible-version').textContent).toContain('no compatible');
    expect(inside.queryAllByTestId('resinv-row')).toHaveLength(0);
    expect(inside.queryByTestId('resinv-warning-count')).toBeNull();
    expect(inside.queryByRole('combobox')).toBeNull();
  });

  it('el contador de Core dice su alcance y no se presenta como el de este Project', () => {
    view({ resourceInventory: INV });
    const inside = within(resourcesSection());
    expect(inside.getByTestId('resinv-warning-count').textContent).toBe('Ramas por revisar (Core, todos los Projects): 2');
    expect(inside.getByTestId('resinv-count-scope-note').textContent).toContain('no es el de este Project');
  });

  it('un owner sin task_id no se pinta como «Sin propietario»', () => {
    const inv = { ...INV, worktrees: [{ ...INV.worktrees[1], owner: { run_id: 'r-5', status: 'running' } }] };
    view({ resourceInventory: inv });
    const ext = within(within(resourcesSection()).getByTestId('resinv-section-external'));
    expect(ext.getByTestId('resinv-owner').textContent).toBe('Propietario sin task_id');
  });

  it('un scan desconocido no se pinta como «No disponible» dentro de Resources', () => {
    const inv = { ...INV, repos: [{ project_id: PID, machine: 'synthetic-machine-1', path: '/synthetic/raro', scan: 'degraded' }] };
    view({ resourceInventory: inv });
    const inside = within(resourcesSection());
    expect(inside.queryByTestId('resinv-section-scan_unavailable')).toBeNull();
    expect(within(inside.getByTestId('resinv-section-unknown')).getByTestId('resinv-state').textContent).toContain('Desconocido');
  });

  it('al cambiar de Project se restablecen los filtros locales del inventario', () => {
    const other = 'synthetic-project-2';
    const inv = {
      ...INV,
      worktrees: [
        ...INV.worktrees,
        {
          target: { machine: 'synthetic-machine-1', project_id: other, repo: '/synthetic/otro', path: '/synthetic/otro.lixbon-wt/wt-2' },
          state: 'tracked', origin: 'task', physical: 'present',
          git: { registered: true, branch: 'lx/r/y', detached: false, locked: false, prunable: false },
          owner: { task_id: 't-77', run_id: 'r-7', status: 'done' },
          dirty: 'clean', merged: 'merged', into: 'main', needs_review: false,
        },
      ],
    };
    const { rerender } = view({ resourceInventory: inv });
    const inside = () => within(resourcesSection());
    fireEvent.change(inside().getByLabelText('Estado'), { target: { value: 'external' } });
    fireEvent.change(inside().getByLabelText('Revisión'), { target: { value: 'needs_review' } });
    expect(inside().getByLabelText('Estado').value).toBe('external');
    rerender(<ProjectView {...baseProps()} projectId={other} resourceInventory={inv} />);
    expect(inside().getByLabelText('Proyecto').value).toBe('all');
    expect(inside().getByLabelText('Estado').value).toBe('all');
    expect(inside().getByLabelText('Revisión').value).toBe('all');
    expect(invTargets()).toContain('/synthetic/otro.lixbon-wt/wt-2');
  });
});
