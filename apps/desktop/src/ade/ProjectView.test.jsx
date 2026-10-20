import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { ProjectView, taskMatchesFilter, ACTIVE_TASK_STATUSES, FINAL_TASK_STATUSES } from './ProjectView';

afterEach(cleanup);

// Todos los datos son SINTÉTICOS: ni IDs, ni hosts, ni rutas, ni textos vienen de Core real.
const PID = 'synthetic-project-1';
const LOC_A = { location_id: 'synthetic-loc-a', host_id: 'synthetic-host-a', host_label: 'Host sintético A', path: '/synthetic/a/repo', availability: 'available' };
const LOC_B = { location_id: 'synthetic-loc-b', host_id: 'synthetic-host-b', host_label: 'Host sintético B', path: '/synthetic/b/repo', availability: 'available' };
const LOC_DOWN = { location_id: 'synthetic-loc-down', host_id: 'synthetic-host-c', path: '/synthetic/c/repo', availability: 'unavailable' };

const ready = (items = [], extra = {}) => ({ state: 'ready', items, ...extra });
const task = (id, status, extra = {}) => ({ task_id: id, title: `Task ${id}`, status, ...extra });

const T_RUNNING = task('t-live', 'running', { location_id: LOC_A.location_id });
const T_STARTING = task('t-start', 'starting');
const T_WAIT = task('t-wait', 'awaiting_terminal_approval');
const T_DONE = task('t-done', 'done');
const T_FAILED = task('t-fail', 'failed', { location_id: LOC_B.location_id });
const T_EXITED = task('t-exit', 'exited');
const T_STOPPED = task('t-stop', 'stopped');
const T_UNKNOWN = task('t-weird', 'paused_by_synthetic');
const ALL_TASKS = [T_RUNNING, T_STARTING, T_WAIT, T_DONE, T_FAILED, T_EXITED, T_STOPPED, T_UNKNOWN];

const baseProps = () => ({
  projectId: PID,
  projectName: 'Project sintético',
  locations: ready([LOC_A, LOC_B]),
  selectedLocationId: LOC_A.location_id,
  summary: { state: 'ready', counts: { tasks: 8, attempts: 3, attention: 2, resources: 1 } },
  tasks: ready(ALL_TASKS),
  attention: ready([
    { attention_id: 'attn-review', kind: 'review', text: 'Texto sintético de revisión', task_id: 't-done' },
    { attention_id: 'attn-failed', kind: 'failed', text: 'Texto sintético de fallo', task_id: 't-fail', attempt_id: 'att-1' },
  ]),
  activity: ready([
    { activity_id: 'act-1', kind: 'synthetic.kind', text: 'Texto de Activity puesto por Core sintético', occurred_at: '2026-01-01T00:00:00Z', task_id: 't-live' },
  ]),
  resources: ready([{ resource_id: 'res-1', kind: 'worktree', label: 'Recurso sintético', availability: 'available', location_id: LOC_A.location_id }]),
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
    expect(visibleTaskIds().sort()).toEqual(['t-live', 't-start', 't-wait']);
    expect(screen.getByTestId('unknown-status-hidden')).toBeTruthy();
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
    expect(visibleTaskIds()).toHaveLength(3);
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
  it('muestra host y ruta de cada ubicación, y marca la actual', () => {
    view({}, { onSelectLocation: vi.fn() });
    const a = screen.getByTestId('location-synthetic-loc-a');
    const b = screen.getByTestId('location-synthetic-loc-b');
    expect(a.textContent).toContain('Host sintético A');
    expect(a.textContent).toContain('synthetic-host-a');
    expect(a.textContent).toContain('/synthetic/a/repo');
    expect(b.textContent).toContain('Host sintético B');
    expect(screen.getByTestId('open-location-synthetic-loc-a').getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('open-location-synthetic-loc-b').getAttribute('aria-current')).toBeNull();
    expect(screen.getByTestId('current-location').textContent).toContain('Host sintético A · /synthetic/a/repo');
  });

  it('cambiar de ubicación conserva el mismo project_id y nombre', () => {
    const onSelectLocation = vi.fn();
    const { rerender } = render(<ProjectView {...baseProps()} onSelectLocation={onSelectLocation} />);
    expect(screen.getByTestId('project-id').textContent).toBe(PID);
    rerender(<ProjectView {...baseProps()} selectedLocationId={LOC_B.location_id} onSelectLocation={onSelectLocation} />);
    expect(screen.getByTestId('project-id').textContent).toBe(PID);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Project sintético');
    expect(screen.getByTestId('current-location').textContent).toContain('Host sintético B');
    expect(screen.getByTestId('open-location-synthetic-loc-b').getAttribute('aria-current')).toBe('true');
  });

  it('seleccionar una ubicación llama solo con location_id', () => {
    const onSelectLocation = vi.fn();
    view({}, { onSelectLocation });
    fireEvent.click(screen.getByTestId('open-location-synthetic-loc-b'));
    expect(onSelectLocation).toHaveBeenCalledTimes(1);
    expect(onSelectLocation.mock.calls[0]).toEqual(['synthetic-loc-b']);
  });

  it('ubicación no disponible: se muestra, es explícita y no navegable; host sin etiqueta usa su id', () => {
    const onSelectLocation = vi.fn();
    view({ locations: ready([LOC_A, LOC_DOWN]) }, { onSelectLocation });
    const down = screen.getByTestId('location-synthetic-loc-down');
    expect(down.textContent).toContain('No disponible');
    expect(down.textContent).toContain('synthetic-host-c');
    expect(screen.queryByTestId('open-location-synthetic-loc-down')).toBeNull();
    expect(onSelectLocation).not.toHaveBeenCalled();
  });

  it('disponibilidad ausente o rara = desconocida; host ausente = host desconocido; ruta ausente explícita', () => {
    view({ locations: ready([{ location_id: 'synthetic-loc-x', availability: 'rarísima' }]), selectedLocationId: undefined });
    const row = screen.getByTestId('location-synthetic-loc-x');
    expect(row.textContent).toContain('Disponibilidad desconocida');
    expect(row.textContent).toContain('Host desconocido');
    expect(row.textContent).toContain('Ruta desconocida');
    expect(screen.getByTestId('current-location').textContent).toBe('Sin ubicación seleccionada.');
  });

  it('ubicación seleccionada que Core no conoce: aviso explícito, sin inventar host', () => {
    view({ selectedLocationId: 'synthetic-loc-ghost' });
    expect(screen.getByTestId('selected-location-unknown').textContent).toContain('synthetic-loc-ghost');
    expect(screen.getByTestId('current-location').textContent).toContain('Ubicación desconocida (synthetic-loc-ghost)');
  });

  it('las filas muestran la ubicación en la que ocurren (host · ruta) y una desconocida se marca', () => {
    view({ tasks: ready([T_RUNNING, task('t-lost', 'running', { location_id: 'synthetic-loc-lost' })]) });
    expect(within(screen.getByTestId('task-t-live')).getByTestId('location-chip').textContent).toBe('Host sintético A · /synthetic/a/repo');
    expect(within(screen.getByTestId('task-t-lost')).getByTestId('location-chip').textContent).toBe('Ubicación desconocida (synthetic-loc-lost)');
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
  const callbacks = () => ({ onOpenTask: vi.fn(), onOpenAttempt: vi.fn(), onOpenAttention: vi.fn(), onOpenResource: vi.fn(), onSelectLocation: vi.fn() });

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
    expect(screen.queryByTestId('selected-location-unknown')).toBeNull();
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
    view({}, { onOpenTask: vi.fn(), onOpenAttention: vi.fn(), onOpenResource: vi.fn(), onSelectLocation: vi.fn(), onOpenAttempt: vi.fn() });
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
  const MUTATION = /(crear|nueva|nuevo|lanzar|ejecutar|iniciar|reintentar|reanudar|cancelar|detener|eliminar|borrar|limpiar|cleanup|adoptar|adopt|importar|integrar|aprobar|rechazar|guardar|enviar|create|launch|spawn|run|retry|delete|remove|clean|merge|approve|reject|save|submit)/i;

  it('sin controles de mutación aunque se pasen todos los callbacks', () => {
    const { container } = view({}, { onOpenTask: vi.fn(), onOpenAttempt: vi.fn(), onOpenAttention: vi.fn(), onOpenResource: vi.fn(), onSelectLocation: vi.fn(), onFilterChange: vi.fn() });
    fireEvent.click(screen.getByTestId('filter-all'));
    for (const el of container.querySelectorAll('button, [role="button"], a, input, select, textarea, form')) {
      const name = el.getAttribute('aria-label') || el.textContent;
      expect(name).not.toMatch(MUTATION);
    }
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
    const cb = { onOpenTask: vi.fn(), onOpenAttempt: vi.fn(), onOpenAttention: vi.fn(), onOpenResource: vi.fn(), onSelectLocation: vi.fn() };
    view({}, cb);
    fireEvent.click(screen.getByTestId('filter-final'));
    fireEvent.click(screen.getByTestId('filter-all'));
    expect(Object.values(cb).every((f) => f.mock.calls.length === 0)).toBe(true);
  });
});
