import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { queryAdeCore } from './coreQueries';
import { TaskWorkspace, TaskWorkspaceView } from './TaskWorkspace';

vi.mock('./coreQueries', () => ({ queryAdeCore: vi.fn() }));

// IMPORTANTE: todo lo de este archivo son FIXTURES explícitas con la forma del contrato `task_detail`
// (docs/core/QUERIES.md). No son una lectura de Core real ni dogfood en WebView2.

const PROJECT_ID = 'project-019a-fixture';
const T0 = 1760000000000; // 2025-10-09 08:53:20 UTC

const taskFixture = (over = {}) => ({
  id: 'task-root', run_id: 'run-1', parent_id: null, root_id: 'task-root',
  status: 'running', title: 'Implementar inspector', provider: 'claude', model: null,
  created_at: T0, updated_at: T0 + 5000, project_id: PROJECT_ID,
  child_ids: ['task-child-a', 'task-child-b'],
  phase: { name: 'probar', done: false, at: T0 + 4000 },
  messages: [], cwd: 'C:/work/wt-root', branch: 'lxo/inspector', worktree: 'C:/work/wt-root',
  merged: false, review: null, integration: null,
  ...over,
});

const childFixture = (over = {}) => taskFixture({
  id: 'task-child-a', parent_id: 'task-root', root_id: 'task-root', title: 'Hija A', child_ids: [], ...over,
});

const stateFixture = (task, over = {}) => ({
  status: 'ready', data: { v: 1, task }, error: null, reason: null, updatedAt: T0 + 9000, retry: vi.fn(), ...over,
});

const renderView = (task, { state = {}, ...props } = {}) => render(
  <TaskWorkspaceView
    projectId={task?.project_id ?? PROJECT_ID}
    taskId={task?.id}
    detail={stateFixture(task, state)}
    project={{ id: PROJECT_ID, name: 'Lixbon' }}
    {...props}
  />,
);

const field = (section, label) => within(screen.getByRole('region', { name: section })).getByText(label, { selector: 'dt' }).nextElementSibling;

afterEach(() => {
  cleanup();
  queryAdeCore.mockReset();
  vi.restoreAllMocks();
});

describe('TaskWorkspace · identidad y metadatos (fixtures)', () => {
  it('Task raíz con worktree: identidad, estado, ejecución, ubicación y tiempos', () => {
    renderView(taskFixture({ model: 'modelo-pedido' }));

    expect(screen.getByRole('heading', { level: 2, name: 'Implementar inspector' })).toBeTruthy();
    expect(field('Identidad', 'Task ID').textContent).toBe('task-root');
    expect(field('Identidad', 'Project').textContent).toBe('Lixbon');
    expect(field('Identidad', 'Project ID').textContent).toBe(PROJECT_ID);
    expect(field('Identidad', 'Tipo').textContent).toBe('Raíz');

    expect(field('Estado', 'Estado').textContent).toContain('En ejecución');
    expect(field('Estado', 'Grupo').textContent).toBe('Activa');
    expect(field('Estado', 'Fase').textContent).toContain('probar · en curso');
    expect(field('Estado', 'Revisión').textContent).toBe('Sin revisión registrada');
    expect(field('Estado', 'Integración').textContent).toBe('Sin integración registrada');
    expect(field('Estado', 'Marca merged').textContent).toBe('No marcada');

    expect(field('Ejecución y jerarquía', 'Proveedor').textContent).toBe('claude');
    expect(field('Ejecución y jerarquía', 'Modelo solicitado').textContent).toBe('modelo-pedido');
    expect(field('Ejecución y jerarquía', 'Run').textContent).toBe('run-1');
    expect(field('Ejecución y jerarquía', 'Raíz').textContent).toBe('Esta Task');
    expect(field('Ejecución y jerarquía', 'Padre').textContent).toBe('Sin padre (raíz)');

    expect(field('Ubicación', 'cwd').textContent).toBe('C:/work/wt-root');
    expect(field('Ubicación', 'Rama').textContent).toBe('lxo/inspector');
    expect(field('Ubicación', 'Worktree').textContent).toBe('C:/work/wt-root');
    expect(screen.getByText(/La ruta es una ubicación, no la identidad/)).toBeTruthy();

    expect(field('Tiempos', 'Creada').textContent).toBe('2025-10-09 08:53:20 UTC');
    expect(field('Tiempos', 'Actualizada').textContent).toBe('2025-10-09 08:53:25 UTC');
    expect(field('Tiempos', 'Última lectura').textContent).toBe('2025-10-09 08:53:29 UTC');
    expect(screen.getByText(/Target verificado/)).toBeTruthy();
  });

  it('Task hija: tipo, padre y raíz son IDs durables distintos de la propia Task', () => {
    renderView(childFixture(), { onNavigate: vi.fn() });

    expect(field('Identidad', 'Tipo').textContent).toBe('Hija');
    expect(field('Ejecución y jerarquía', 'Padre').textContent).toBe('task-root');
    expect(field('Ejecución y jerarquía', 'Raíz').textContent).toBe('task-root');
    expect(field('Ejecución y jerarquía', 'Hijas').textContent).toBe('Sin hijas');
  });

  it('checkout compartido (sin worktree ni rama) muestra "No informado" sin inferir nada', () => {
    renderView(taskFixture({ worktree: null, branch: null, cwd: 'C:/repo-compartido' }));

    expect(field('Ubicación', 'cwd').textContent).toBe('C:/repo-compartido');
    expect(field('Ubicación', 'Rama').textContent).toBe('No informado');
    expect(field('Ubicación', 'Worktree').textContent).toBe('No informado');
  });

  it('host/origen se muestra como "No informado" aunque cwd y worktree existan: el DTO no los expone', () => {
    renderView(taskFixture());
    expect(field('Ubicación', 'Host / origen').textContent).toBe('No informado');
    expect(field('Ubicación', 'cwd').textContent).toBe('C:/work/wt-root');
    expect(screen.getByText(/Core no informa host ni origen/)).toBeTruthy();
  });

  it('Task final integrada: revisión, integración y marca merged son señales separadas', () => {
    renderView(taskFixture({
      status: 'done', merged: true,
      review: { decision: 'accepted', head_commit: 'abc123', at: T0 + 6000 },
      integration: { decision_id: 7, outcome: 'merged', at: T0 + 7000 },
    }));

    expect(field('Estado', 'Estado').textContent).toContain('Terminada');
    expect(field('Estado', 'Grupo').textContent).toBe('Final');
    expect(field('Estado', 'Revisión').textContent).toContain('Aceptada · commit abc123 · 2025-10-09 08:53:26 UTC');
    expect(field('Estado', 'Integración').textContent).toContain('Integrada · decisión #7');
    expect(field('Estado', 'Marca merged').textContent).toBe('Marcada como integrada');
  });

  it('Task fallida: estado real, grupo final y revisión rechazada sin integración', () => {
    renderView(taskFixture({
      status: 'failed', phase: { name: 'compilar', done: true, at: T0 },
      review: { decision: 'rejected', head_commit: 'def456', at: T0 },
      integration: { decision_id: 9, outcome: 'conflict', at: T0 },
    }));

    expect(document.querySelector('.twk__status').getAttribute('data-status')).toBe('failed');
    expect(document.querySelector('.twk__status').textContent).toBe('Fallida');
    expect(field('Estado', 'Grupo').textContent).toBe('Final');
    expect(field('Estado', 'Fase').textContent).toContain('compilar · completada');
    expect(field('Estado', 'Revisión').textContent).toContain('Rechazada');
    expect(field('Estado', 'Integración').textContent).toContain('Conflicto');
  });

  it('preguntas: cuenta solo lo registrado y marca las que no tienen respuesta', () => {
    renderView(taskFixture({
      messages: [
        { id: 14, kind: 'question', from: 'task-root', to: 'coord', body: '¿qué rama?', reply_to: null, at: T0 },
        { id: 15, kind: 'reply', from: 'coord', to: 'task-root', body: 'lxo/x', reply_to: 14, at: T0 },
        { id: 16, kind: 'question', from: 'task-root', to: 'coord', body: '<b>¿merge?</b>', reply_to: null, at: T0 },
      ],
    }));

    const value = field('Estado', 'Preguntas');
    expect(value.textContent).toContain('2 registradas · 1 sin respuesta');
    expect(within(value).getByRole('list', { name: 'Preguntas sin respuesta' }).textContent).toContain('#16');
    expect(value.textContent).toContain('<b>¿merge?</b>'); // texto, nunca HTML
    expect(value.querySelector('b')).toBeNull();
    expect(value.textContent).not.toContain('¿qué rama?');
  });

  it('sin proyecto coincidente no inventa el nombre del Project', () => {
    renderView(taskFixture(), { project: { id: 'otro-project', name: 'Ajeno' } });
    expect(field('Identidad', 'Project').textContent).toBe('No informado');
    expect(field('Identidad', 'Project ID').textContent).toBe(PROJECT_ID);
    expect(screen.queryByText('Ajeno')).toBeNull();
  });
});

describe('TaskWorkspace · navegación por IDs durables', () => {
  it('padre, raíz e hijas navegan con { projectId, taskId }, nunca con rutas', () => {
    const onNavigate = vi.fn();
    renderView(childFixture({ child_ids: ['task-grandchild'] }), { onNavigate });

    fireEvent.click(screen.getByRole('button', { name: 'Abrir Task padre task-root' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abrir Task raíz task-root' }));
    fireEvent.click(screen.getByRole('button', { name: 'Abrir Task hija task-grandchild' }));

    expect(onNavigate.mock.calls).toEqual([
      [{ projectId: PROJECT_ID, taskId: 'task-root' }],
      [{ projectId: PROJECT_ID, taskId: 'task-root' }],
      [{ projectId: PROJECT_ID, taskId: 'task-grandchild' }],
    ]);
    expect(JSON.stringify(onNavigate.mock.calls)).not.toContain('wt-root');
  });

  it('sin onNavigate las relaciones son texto y no hay botones de navegación', () => {
    renderView(taskFixture(), { state: { retry: undefined } });
    expect(field('Ejecución y jerarquía', 'Hijas').textContent).toContain('task-child-a');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('la raíz no se ofrece como navegación a sí misma', () => {
    renderView(taskFixture(), { onNavigate: vi.fn() });
    expect(screen.queryByRole('button', { name: /Task raíz/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Abrir Task hija/ })).toHaveLength(2);
  });
});

describe('TaskWorkspace · contrato de Activity y Attention contextuales', () => {
  const contextList = () => screen.getByRole('list', { name: 'Contexto de la Task' });

  it('sin callbacks declara ambas superficies como no disponibles, sin botones ni vistas simuladas', () => {
    renderView(taskFixture(), { state: { retry: undefined } });
    const items = within(contextList()).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.getAttribute('data-available')).toBe('false');
      expect(item.textContent).toContain('No disponible: esta superficie todavía no está conectada');
      expect(within(item).queryByRole('button')).toBeNull();
    }
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('con callbacks entrega exactamente { projectId, taskId } de la Task verificada, sin rutas ni otros campos', () => {
    const onOpenActivity = vi.fn();
    const onOpenAttention = vi.fn();
    renderView(childFixture(), { onOpenActivity, onOpenAttention });

    fireEvent.click(screen.getByRole('button', { name: 'Abrir Activity de la Task task-child-a' }));
    expect(onOpenActivity).toHaveBeenCalledTimes(1);
    expect(onOpenActivity).toHaveBeenCalledWith({ projectId: PROJECT_ID, taskId: 'task-child-a' });
    expect(onOpenAttention).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Abrir Attention de la Task task-child-a' }));
    expect(onOpenAttention).toHaveBeenCalledTimes(1);
    expect(onOpenAttention.mock.calls[0]).toEqual([{ projectId: PROJECT_ID, taskId: 'task-child-a' }]);
    expect(Object.keys(onOpenAttention.mock.calls[0][0]).sort()).toEqual(['projectId', 'taskId']);
    expect(JSON.stringify([onOpenActivity.mock.calls, onOpenAttention.mock.calls])).not.toContain('wt-root');
  });

  it('un solo callback habilita solo esa superficie; la otra sigue honestamente no disponible', () => {
    renderView(taskFixture(), { onOpenAttention: vi.fn() });
    const [activity, attention] = within(contextList()).getAllByRole('listitem');
    expect(activity.getAttribute('data-available')).toBe('false');
    expect(attention.getAttribute('data-available')).toBe('true');
  });

  it('con respuesta no verificada no hay accesos contextuales ni se invocan los callbacks', () => {
    const onOpenActivity = vi.fn();
    const onOpenAttention = vi.fn();
    render(<TaskWorkspaceView projectId={PROJECT_ID} taskId="task-nueva" detail={stateFixture(taskFixture())} onOpenActivity={onOpenActivity} onOpenAttention={onOpenAttention} />);
    expect(screen.queryByRole('list', { name: 'Contexto de la Task' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(onOpenActivity).not.toHaveBeenCalled();
    expect(onOpenAttention).not.toHaveBeenCalled();
  });
});

describe('TaskWorkspace · refresh y target ausente', () => {
  it('Actualizar solo aparece con datos listos y ejecuta retry', () => {
    const state = stateFixture(taskFixture());
    render(<TaskWorkspaceView projectId={PROJECT_ID} taskId="task-root" detail={state} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
    expect(state.retry).toHaveBeenCalledTimes(1);
  });

  it('refreshing conserva los datos, marca aria-busy y anuncia la actualización', () => {
    renderView(taskFixture(), { state: { status: 'refreshing' } });
    expect(screen.getByRole('region', { name: 'Implementar inspector' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('status').textContent).toContain('Actualizando desde Core');
    expect(field('Identidad', 'Task ID').textContent).toBe('task-root');
  });

  it('stale conserva la última respuesta, avisa del fallo y permite reintentar', () => {
    const state = stateFixture(taskFixture(), { status: 'stale', reason: 'disconnected', error: 'ade_query_timeout: Core no respondió a tiempo' });
    render(<TaskWorkspaceView projectId={PROJECT_ID} taskId="task-root" detail={state} />);

    const banner = screen.getByText(/Datos desactualizados · Core desconectado/).closest('[role=status]');
    expect(banner.textContent).toContain('Se conserva la última respuesta');
    expect(field('Identidad', 'Task ID').textContent).toBe('task-root');
    fireEvent.click(within(banner).getByRole('button', { name: 'Reintentar' }));
    expect(state.retry).toHaveBeenCalled();
  });

  it('Task desaparecida sin datos: alerta de target no encontrado, con los IDs pedidos', () => {
    const retry = vi.fn();
    render(<TaskWorkspaceView projectId={PROJECT_ID} taskId="task-fantasma" detail={{ status: 'error', data: null, error: 'tasks_not_found', retry }} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Target no encontrado');
    expect(alert.textContent).toContain('La Task ya no está disponible en este Project');
    expect(alert.textContent).toContain('task-fantasma');
    expect(alert.textContent).toContain(PROJECT_ID);
    expect(screen.queryByText(/Target verificado/)).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    expect(retry).toHaveBeenCalled();
  });

  it('Task desaparecida tras un refresh (stale) conserva datos y explica que ya no está', () => {
    renderView(taskFixture(), { state: { status: 'stale', reason: 'error', error: 'tasks_not_found' } });
    expect(screen.getByRole('status', {}).textContent).toContain('La Task ya no está disponible en este Project');
    expect(field('Identidad', 'Task ID').textContent).toBe('task-root');
  });

  it('Project inexistente se distingue de Task inexistente', () => {
    render(<TaskWorkspaceView projectId="p-borrado" taskId="t1" detail={{ status: 'error', data: null, error: 'tasks_project_not_found' }} />);
    expect(screen.getByRole('alert').textContent).toContain('El Project ya no existe en el registro de Core');
  });

  it('datos de otra Task (selección cambiada) no se muestran: respuesta no verificada', () => {
    render(<TaskWorkspaceView projectId={PROJECT_ID} taskId="task-nueva" detail={stateFixture(taskFixture({ title: 'Task anterior' }), { status: 'refreshing' })} />);

    expect(screen.getByRole('alert').textContent).toContain('Respuesta no verificada');
    expect(screen.queryByText('Task anterior')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Identidad' })).toBeNull();
  });

  it('Task con el mismo ID pero de otro Project tampoco se verifica', () => {
    render(<TaskWorkspaceView projectId="otro-project" taskId="task-root" detail={stateFixture(taskFixture())} />);
    expect(screen.getByRole('alert').textContent).toContain('Respuesta no verificada');
    expect(screen.queryByRole('region', { name: 'Identidad' })).toBeNull();
  });

  it.each([
    ['otro task.id', { id: 'task-vieja' }],
    ['otro project_id', { project_id: 'project-vieja' }],
    ['ambos distintos', { id: 'task-vieja', project_id: 'project-vieja' }],
  ])('regresión: respuesta obsoleta con %s no renderiza ningún detalle ni acción', (_name, over) => {
    const onNavigate = vi.fn();
    const onOpenActivity = vi.fn();
    render(
      <TaskWorkspaceView
        projectId={PROJECT_ID}
        taskId="task-actual"
        detail={stateFixture(taskFixture({ title: 'Título obsoleto', cwd: 'C:/work/obsoleta', branch: 'lxo/obsoleta', ...over }), { status: 'refreshing' })}
        project={{ id: PROJECT_ID, name: 'Lixbon' }}
        onNavigate={onNavigate}
        onOpenActivity={onOpenActivity}
        onOpenAttention={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert').textContent).toContain('Respuesta no verificada');
    expect(screen.getByRole('alert').textContent).toContain('task-actual');
    expect(document.body.textContent).not.toContain('Título obsoleto');
    expect(document.body.textContent).not.toContain('C:/work/obsoleta');
    expect(document.body.textContent).not.toContain('lxo/obsoleta');
    expect(document.body.textContent).not.toContain('task-child-a');
    expect(document.body.textContent).not.toContain('Target verificado');
    expect(document.querySelector('[data-target-verified]').getAttribute('data-target-verified')).toBe('false');
    expect(document.querySelector('.twk__status')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Identidad' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(onNavigate).not.toHaveBeenCalled();
    expect(onOpenActivity).not.toHaveBeenCalled();
  });

  it('sin selección no hay lectura: estado vacío anunciado', () => {
    render(<TaskWorkspaceView projectId={null} taskId={null} />);
    expect(screen.getByRole('status').textContent).toContain('Selecciona un Project y una Task');
  });
});

describe('TaskWorkspace · metadatos desconocidos o parciales', () => {
  it('respuesta parcial: lista los campos ausentes y muestra "No informado"', () => {
    const task = taskFixture();
    for (const key of ['provider', 'model', 'phase', 'messages', 'cwd', 'branch', 'worktree', 'merged', 'review', 'integration', 'created_at', 'updated_at', 'child_ids', 'root_id']) delete task[key];
    renderView(task);

    const banner = screen.getByText('Respuesta parcial de Core').closest('[role=status]');
    expect(banner.textContent).toContain('provider');
    expect(banner.textContent).toContain('integration');
    for (const [section, label] of [
      ['Ejecución y jerarquía', 'Proveedor'], ['Ejecución y jerarquía', 'Modelo solicitado'], ['Ejecución y jerarquía', 'Hijas'],
      ['Estado', 'Fase'], ['Estado', 'Preguntas'], ['Estado', 'Revisión'], ['Estado', 'Integración'], ['Estado', 'Marca merged'],
      ['Ubicación', 'cwd'], ['Ubicación', 'Rama'], ['Ubicación', 'Worktree'], ['Tiempos', 'Creada'], ['Tiempos', 'Actualizada'],
    ]) {
      expect(field(section, label).textContent, `${section} · ${label}`).toBe('No informado');
    }
  });

  it('status desconocido, strings vacíos y tiempos inválidos no rompen ni se inventan', () => {
    renderView(taskFixture({
      status: 'working', title: '', provider: '  ', cwd: '', created_at: 'ayer', updated_at: -1,
      phase: { name: '' }, review: { decision: 'maybe' }, integration: { outcome: 'raro' }, messages: 'no-es-lista',
    }));

    expect(screen.getByRole('heading', { level: 2, name: 'Task sin título' })).toBeTruthy();
    expect(field('Estado', 'Estado').textContent).toContain('working (estado desconocido)');
    expect(field('Estado', 'Grupo').textContent).toBe('No informado');
    expect(field('Ejecución y jerarquía', 'Proveedor').textContent).toBe('No informado');
    expect(field('Ubicación', 'cwd').textContent).toBe('No informado');
    expect(field('Tiempos', 'Creada').textContent).toBe('No informado');
    expect(field('Tiempos', 'Actualizada').textContent).toBe('No informado');
    expect(field('Estado', 'Fase').textContent).toBe('No informado');
    expect(field('Estado', 'Preguntas').textContent).toBe('No informado');
    expect(field('Estado', 'Revisión').textContent).toContain('maybe (decisión desconocida)');
    expect(field('Estado', 'Integración').textContent).toContain('raro (resultado desconocido)');
  });

  it('modelo null se informa como no informado: solo existe el modelo pedido al lanzar', () => {
    renderView(taskFixture({ model: null }));
    expect(field('Ejecución y jerarquía', 'Modelo solicitado').textContent).toBe('No informado');
  });
});

describe('TaskWorkspace · carga, error y degradación', () => {
  const noData = (over) => ({ status: 'loading', data: null, error: null, reason: null, updatedAt: null, retry: vi.fn(), ...over });

  it('loading: estado anunciado, aria-busy y sin datos', () => {
    render(<TaskWorkspaceView projectId={PROJECT_ID} taskId="task-root" detail={noData()} />);
    expect(screen.getByRole('status').textContent).toContain('Conectando con Core');
    expect(screen.getByRole('region', { name: 'Task' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('region', { name: 'Identidad' })).toBeNull();
  });

  it.each([
    ['degraded', 'tasks_unavailable', 'Core degradado', 'Core no tiene un almacén autoritativo disponible'],
    ['disconnected', 'ade_query_timeout: Core no respondió a tiempo', 'Core desconectado', 'No se pudo completar la conexión con Core'],
    ['error', 'tasks_read_failed', 'Error de Core', 'Core no pudo leer este dato'],
    ['error', 'tasks_auth_required', 'Error de Core', 'Core no pudo autenticar esta lectura'],
  ])('%s (%s): alerta accesible con reintento y sin datos', (status, error, title, message) => {
    const state = noData({ status, error });
    render(<TaskWorkspaceView projectId={PROJECT_ID} taskId="task-root" detail={state} />);

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain(error);
    fireEvent.click(within(alert).getByRole('button', { name: 'Reintentar' }));
    expect(state.retry).toHaveBeenCalledTimes(1);
  });

  it('stale por Core degradado conserva los datos y lo dice', () => {
    renderView(taskFixture(), { state: { status: 'stale', reason: 'degraded', error: 'tasks_unavailable' } });
    expect(screen.getByRole('status').textContent).toContain('Core degradado');
    expect(field('Identidad', 'Task ID').textContent).toBe('task-root');
  });
});

describe('TaskWorkspace · solo lectura y accesibilidad', () => {
  it('no ofrece escritura, editor, chat, intentos, retry/resume/fork ni comandos', () => {
    renderView(taskFixture(), { onNavigate: vi.fn() });

    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(document.querySelector('input, textarea, select, form, [contenteditable]')).toBeNull();
    const names = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(names.sort()).toEqual(['Abrir Task hija task-child-a', 'Abrir Task hija task-child-b', 'Actualizar']);
    expect(screen.queryByText(/reanudar|resume|fork|reintentar intento|comando/i)).toBeNull();
  });

  it('regiones con nombre, listas de definición y botones nativos enfocables por teclado', () => {
    renderView(taskFixture(), { onNavigate: vi.fn() });

    expect(screen.getByRole('region', { name: 'Implementar inspector' })).toBeTruthy();
    for (const name of ['Identidad', 'Estado', 'Ejecución y jerarquía', 'Ubicación', 'Tiempos']) {
      expect(screen.getByRole('region', { name }), name).toBeTruthy();
    }
    expect(screen.getByRole('list', { name: 'Tasks hijas' })).toBeTruthy();
    expect(document.querySelectorAll('dl > div > dt').length).toBeGreaterThan(10);

    for (const button of screen.getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('type')).toBe('button');
      expect(button.tabIndex).toBe(0);
      button.focus();
      expect(document.activeElement).toBe(button);
    }
  });

  it('variant inspector solo añade la clase compacta y conserva el contenido', () => {
    renderView(taskFixture(), { variant: 'inspector' });
    expect(document.querySelector('.twk').classList.contains('twk--inspector')).toBe(true);
    expect(field('Identidad', 'Task ID').textContent).toBe('task-root');
  });
});

describe('TaskWorkspace conectado · queries read-only (mock de queryAdeCore, no Core)', () => {
  it('consulta task_detail con project_id + task_id y presenta la respuesta verificada', async () => {
    queryAdeCore.mockResolvedValue({ v: 1, task: taskFixture() });
    render(<TaskWorkspace projectId={PROJECT_ID} taskId="task-root" project={{ id: PROJECT_ID, name: 'Lixbon' }} pollMs={60_000} />);

    expect(await screen.findByRole('region', { name: 'Identidad' })).toBeTruthy();
    expect(queryAdeCore).toHaveBeenCalledWith('task_detail', { projectId: PROJECT_ID, taskId: 'task-root' });
    expect(field('Identidad', 'Project').textContent).toBe('Lixbon');
  });

  it('un fallo de Core sin datos previos se presenta como alerta', async () => {
    queryAdeCore.mockRejectedValue(new Error('tasks_not_found'));
    render(<TaskWorkspace projectId={PROJECT_ID} taskId="task-root" pollMs={60_000} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Target no encontrado'));
  });

  it('no consulta sin target, deshabilitado o cuando el shell aporta su propio estado', () => {
    const { rerender } = render(<TaskWorkspace projectId={PROJECT_ID} taskId={null} />);
    rerender(<TaskWorkspace projectId={PROJECT_ID} taskId="task-root" enabled={false} />);
    rerender(<TaskWorkspace projectId={PROJECT_ID} taskId="task-root" detail={stateFixture(taskFixture())} />);

    expect(queryAdeCore).not.toHaveBeenCalled();
    expect(field('Identidad', 'Task ID').textContent).toBe('task-root');
  });
});
