import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { AttentionInbox, sumAttentionCounts } from './AttentionInbox';
import { ATTENTION_LIMIT } from './coreQueries';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const ZERO = {
  question: 0,
  approval: 0,
  review_ready: 0,
  conflict: 0,
  failed: 0,
  environment_blocked: 0,
  risk: 0,
};

const counts = (byCategory) => ({
  total: Object.values(byCategory).reduce((sum, value) => sum + value, 0),
  by_category: { ...ZERO, ...byCategory },
});

const item = (over = {}) => ({
  id: 'att_00000000000000000000000000000001',
  category: 'question',
  severity: 'medium',
  status: 'active',
  target_kind: 'task',
  target_id: 'task-1',
  project_id: 'project-a',
  run_id: 'run-1',
  occurrence: 1,
  created_at: 1_000,
  resolved_at: null,
  resolution: null,
  ...over,
});

const page = (items, { hasMore = false, next = null } = {}) => ({
  v: 1,
  items,
  next_cursor: hasMore ? next : null,
  has_more: hasMore,
  limit: ATTENTION_LIMIT,
});

const project = (id, name, attention) => ({
  id,
  name,
  state: 'active',
  status: attention.total > 0 ? 'attention' : 'active',
  counts: { tasks: 1, active: 1, failed: 0, attention },
  locations: [],
});

const overview = ({ projects = [], unassigned = counts({}) } = {}) => ({
  v: 1,
  filters: { archived: 'include', machine: null },
  total: projects.length,
  projects,
  unassigned: { tasks: 0, active: 0, failed: 0, attention: unassigned },
});

const SEVEN_CATEGORIES = [
  'question',
  'approval',
  'review_ready',
  'conflict',
  'failed',
  'environment_blocked',
  'risk',
];

function sevenFixtures() {
  return SEVEN_CATEGORIES.map((category, index) => item({
    id: `att_${String(index + 1).padStart(32, '0')}`,
    category,
    severity: index === 6 ? 'critical' : 'medium',
    target_kind: 'task',
    target_id: `task-${category}`,
    project_id: index < 4 ? 'project-a' : index < 5 ? 'project-b' : null,
    created_at: 1_000 + index,
  }));
}

function mountCore({ attention = () => page([]), projects = () => overview() } = {}) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => {
    if (command !== 'orch_query') throw new Error(`comando inesperado: ${command}`);
    calls.push([payload.query, payload.args]);
    if (payload.query === 'attention_list') return attention(payload.args);
    if (payload.query === 'projects_overview') return projects(payload.args);
    throw new Error(`query inesperada: ${payload.query}`);
  });
  return calls;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  invoke.mockReset();
});

describe('AttentionInbox', () => {
  it('lista las siete categorías del contrato y muestra los conteos autoritativos del Core', async () => {
    mountCore({
      attention: () => page(sevenFixtures()),
      projects: () => overview({
        projects: [
          project('project-a', 'Alpha', counts({ question: 1, approval: 1, review_ready: 1, conflict: 1 })),
          project('project-b', 'Beta', counts({ failed: 1 })),
        ],
        unassigned: counts({ environment_blocked: 1, risk: 1 }),
      }),
    });

    render(<AttentionInbox onOpenTarget={vi.fn()} />);

    expect((await screen.findByTestId('attention-total')).textContent).toBe('7');
    expect(screen.getAllByRole('listitem')).toHaveLength(7);
    for (const visible of ['Pregunta', 'Aprobación', 'Revisión lista', 'Conflicto', 'Fallida', 'Entorno bloqueado', 'Riesgo']) {
      expect(screen.getAllByText(visible).length).toBeGreaterThan(0);
    }

    const categoryFilter = screen.getByLabelText('Categoría');
    expect(within(categoryFilter).getByRole('option', { name: 'Riesgo (1)' })).toBeTruthy();
    expect(within(categoryFilter).getByRole('option', { name: 'Pregunta (1)' })).toBeTruthy();
    expect(within(screen.getByLabelText('Severidad')).getAllByRole('option')).toHaveLength(5);
    expect(within(screen.getByLabelText('Project')).getByRole('option', { name: 'Alpha · 4' })).toBeTruthy();
  });

  it('filtra con project_id, category y severity del contrato, y limpia los filtros', async () => {
    const calls = mountCore({
      attention: () => page([item()]),
      projects: () => overview({ projects: [project('project-a', 'Alpha', counts({ question: 1 })), project('project-b', 'Beta', counts({ review_ready: 1 }))] }),
    });

    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await screen.findByRole('button', { name: /Media: Pregunta/ });

    expect(calls).toContainEqual(['projects_overview', { archived: 'include' }]);
    expect(calls).toContainEqual(['attention_list', { limit: ATTENTION_LIMIT }]);

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-b' } });
    await waitFor(() => expect(calls).toContainEqual([
      'attention_list',
      { project_id: 'project-b', limit: ATTENTION_LIMIT },
    ]));
    expect(screen.getByTestId('attention-total').textContent).toBe('1');

    fireEvent.change(screen.getByLabelText('Categoría'), { target: { value: 'review_ready' } });
    await waitFor(() => expect(calls).toContainEqual([
      'attention_list',
      { project_id: 'project-b', category: 'review_ready', limit: ATTENTION_LIMIT },
    ]));
    expect(screen.getByTestId('attention-total').textContent).toBe('1');

    fireEvent.change(screen.getByLabelText('Severidad'), { target: { value: 'high' } });
    await waitFor(() => expect(calls).toContainEqual([
      'attention_list',
      { project_id: 'project-b', category: 'review_ready', severity: 'high', limit: ATTENTION_LIMIT },
    ]));

    fireEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    await waitFor(() => expect(calls.filter(([query]) => query === 'attention_list').at(-1))
      .toEqual(['attention_list', { limit: ATTENTION_LIMIT }]));
    expect(screen.getByTestId('attention-total').textContent).toBe('2');
  });

  it('abre el destino con los IDs durables exactos, sin transformarlos', async () => {
    const onOpenTarget = vi.fn();
    const target = item({
      id: 'att_AbC1234567890',
      category: 'risk',
      severity: 'critical',
      target_kind: 'spawn_request',
      target_id: '0192F0A0-7b1c-7000-8000-0000000000A1',
      project_id: null,
      run_id: null,
      occurrence: 2,
      created_at: 1_750_000_000_000,
    });
    mountCore({ attention: () => page([target]) });

    render(<AttentionInbox onOpenTarget={onOpenTarget} />);
    const button = await screen.findByRole('button', { name: /Crítica: Riesgo\. Solicitud de lanzamiento 0192F0A0/ });
    expect(button.dataset.attentionId).toBe('att_AbC1234567890');
    expect(button.dataset.targetKind).toBe('spawn_request');
    expect(button.dataset.targetId).toBe('0192F0A0-7b1c-7000-8000-0000000000A1');

    fireEvent.click(button);
    expect(onOpenTarget).toHaveBeenCalledTimes(1);
    expect(onOpenTarget).toHaveBeenCalledWith({
      attentionId: 'att_AbC1234567890',
      kind: 'spawn_request',
      id: '0192F0A0-7b1c-7000-8000-0000000000A1',
      projectId: null,
      runId: null,
      category: 'risk',
      severity: 'critical',
      occurrence: 2,
      createdAt: 1_750_000_000_000,
    });
  });

  it('navega con teclado y expone nombres y descripciones ARIA', async () => {
    const rows = [1, 2, 3].map((n) => item({
      id: `att_${n}`,
      target_id: `task-${n}`,
      created_at: n,
      severity: ['critical', 'high', 'low'][n - 1],
    }));
    mountCore({ attention: () => page(rows) });

    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    const buttons = await screen.findAllByRole('button', { name: /^(Crítica|Alta|Baja): / });
    expect(buttons).toHaveLength(3);

    expect(screen.getByRole('region', { name: 'Attention' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Filtros de Attention' })).toBeTruthy();
    expect(buttons[0].tabIndex).toBe(0);
    expect(buttons[1].tabIndex).toBe(-1);

    buttons[0].focus();
    fireEvent.keyDown(buttons[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1], { key: 'End' });
    expect(document.activeElement).toBe(buttons[2]);
    fireEvent.keyDown(buttons[2], { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(buttons[2]);

    const describedBy = buttons[0].getAttribute('aria-describedby');
    expect(document.getElementById(describedBy).textContent).toContain('att_1');
    expect(buttons[0].getAttribute('aria-label')).toBe('Crítica: Pregunta. Task task-1');
  });

  it('pagina con el cursor opaco y no duplica filas que se solapan', async () => {
    const calls = mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-1') {
          return page([
            item({ id: 'att_2', target_id: 'task-2', created_at: 2 }),
            item({ id: 'att_3', target_id: 'task-3', created_at: 3 }),
          ]);
        }
        return page([
          item({ id: 'att_1', target_id: 'task-1', created_at: 1 }),
          item({ id: 'att_2', target_id: 'task-2', created_at: 2 }),
        ], { hasMore: true, next: 'cursor-1' });
      },
    });

    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await screen.findAllByRole('listitem');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(calls).toContainEqual(['attention_list', { limit: ATTENTION_LIMIT, cursor: 'cursor-1' }]);

    const ids = screen.getAllByRole('listitem').map((row) => row.querySelector('[data-attention-id]').dataset.attentionId);
    expect(ids).toEqual(['att_1', 'att_2', 'att_3']);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();
  });

  it('reinicia las páginas cargadas cuando se actualiza la cabecera y conserva los destinos durables', async () => {
    vi.useFakeTimers();
    let refreshed = false;
    const durableTargetId = '0192F0A0-7b1c-7000-8000-0000000000A1';
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const third = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    const resolvedAfterRefresh = item({ id: 'att_4', target_id: 'task-4', created_at: 4 });
    const fifth = item({
      id: 'att_5',
      category: 'risk',
      severity: 'critical',
      target_kind: 'spawn_request',
      target_id: durableTargetId,
      occurrence: 2,
      created_at: 5,
    });
    const calls = mountCore({
      attention: (args) => {
        if (!args.cursor) {
          return refreshed
            ? page([first, second], { hasMore: true, next: 'cursor-new-1' })
            : page([first, second], { hasMore: true, next: 'cursor-old-1' });
        }
        if (args.cursor === 'cursor-old-1') return page([third, resolvedAfterRefresh], { hasMore: true, next: 'cursor-old-2' });
        if (args.cursor === 'cursor-old-2') return page([fifth]);
        if (args.cursor === 'cursor-new-1') return page([second, third], { hasMore: true, next: 'cursor-new-2' });
        if (args.cursor === 'cursor-new-2') return page([fifth]);
        throw new Error(`cursor inesperado: ${args.cursor}`);
      },
    });
    const onOpenTarget = vi.fn();
    const visibleIds = () => screen.getAllByRole('listitem')
      .map((row) => row.querySelector('[data-attention-id]').dataset.attentionId);

    render(<AttentionInbox onOpenTarget={onOpenTarget} pollMs={1_000} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2']);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3', 'att_4']);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3', 'att_4', 'att_5']);

    refreshed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(visibleIds()).toEqual(['att_1', 'att_2']);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3']);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const ids = visibleIds();
    expect(ids).toEqual(['att_1', 'att_2', 'att_3', 'att_5']);
    expect(new Set(ids).size).toBe(ids.length);
    expect(calls).toContainEqual(['attention_list', { limit: ATTENTION_LIMIT, cursor: 'cursor-old-1' }]);
    expect(calls).toContainEqual(['attention_list', { limit: ATTENTION_LIMIT, cursor: 'cursor-old-2' }]);
    expect(calls).toContainEqual(['attention_list', { limit: ATTENTION_LIMIT, cursor: 'cursor-new-1' }]);
    expect(calls).toContainEqual(['attention_list', { limit: ATTENTION_LIMIT, cursor: 'cursor-new-2' }]);
    expect(screen.queryByRole('button', { name: /Task task-4/ })).toBeNull();

    const targetButton = screen.getByRole('button', { name: /Crítica: Riesgo\. Solicitud de lanzamiento/ });
    expect(targetButton.dataset.targetId).toBe(durableTargetId);
    fireEvent.click(targetButton);
    expect(onOpenTarget).toHaveBeenCalledWith({
      attentionId: 'att_5',
      kind: 'spawn_request',
      id: durableTargetId,
      projectId: 'project-a',
      runId: 'run-1',
      category: 'risk',
      severity: 'critical',
      occurrence: 2,
      createdAt: 5,
    });
  });

  it('reinicia la paginación si el Core rechaza el cursor opaco', async () => {
    const calls = mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-1') throw new Error('attention_invalid_cursor: el cursor no pertenece a esta clave');
        return page([
          item({ id: 'att_1', target_id: 'task-1', created_at: 1 }),
          item({ id: 'att_2', target_id: 'task-2', created_at: 2 }),
        ], { hasMore: true, next: 'cursor-1' });
      },
    });

    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));

    expect(await screen.findByText(/el cursor caducó: se volvió a la primera página/)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(calls.filter(([query]) => query === 'attention_list').length).toBeGreaterThanOrEqual(3);
  });

  it('reinicia desde la primera página al reconectar y no arrastra duplicados de la sesión anterior', async () => {
    vi.useFakeTimers();
    let failing = false;
    let head = [
      item({ id: 'att_1', target_id: 'task-1', created_at: 1 }),
      item({ id: 'att_2', target_id: 'task-2', created_at: 2 }),
    ];
    invoke.mockImplementation(async (command, payload) => {
      if (payload.query === 'projects_overview') return overview();
      if (payload.query === 'attention_list') {
        if (failing) throw new Error('ade_query_timeout: Core no respondió a tiempo');
        if (payload.args.cursor === 'cursor-1') {
          return page([item({ id: 'att_3', target_id: 'task-3', created_at: 3 })]);
        }
        return page(head, { hasMore: true, next: 'cursor-1' });
      }
      throw new Error(`query inesperada: ${payload.query}`);
    });

    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getAllByRole('listitem')).toHaveLength(3);

    failing = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText(/Attention desactualizada: Core desconectado/)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    failing = false;
    head = [
      item({ id: 'att_1', target_id: 'task-1', created_at: 1 }),
      item({ id: 'att_2', target_id: 'task-2', created_at: 2 }),
      item({ id: 'att_4', target_id: 'task-4', created_at: 4 }),
    ];
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    const ids = screen.getAllByRole('listitem').map((row) => row.querySelector('[data-attention-id]').dataset.attentionId);
    expect(ids).toEqual(['att_1', 'att_2', 'att_4']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('muestra carga, vacío, error y degradado sin inventar datos', async () => {
    const pending = new Promise(() => {});
    mountCore({ attention: () => pending });
    const first = render(<AttentionInbox onOpenTarget={vi.fn()} />);
    expect(screen.getByText('Cargando Attention activa desde el Core…')).toBeTruthy();
    first.unmount();

    cleanup();
    mountCore({ attention: () => page([]) });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    expect(await screen.findByText(/El Core no tiene Attention activa/)).toBeTruthy();
    expect(screen.getByTestId('attention-total').textContent).toBe('0');
    cleanup();

    mountCore({ attention: () => { throw new Error('attention_unavailable: el Core no tiene un almacén autoritativo disponible'); } });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    const degraded = await screen.findByRole('alert');
    expect(degraded.textContent).toContain('Core degradado');
    expect(degraded.textContent).toContain('almacén autoritativo');
    cleanup();

    mountCore({ attention: () => { throw new Error('ade_query_timeout: Core no respondió a tiempo'); } });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    const disconnected = await screen.findByRole('alert');
    expect(disconnected.textContent).toContain('Core desconectado');
    cleanup();

    mountCore({ attention: () => { throw new Error('attention_read_failed: no se pudo leer la tabla'); } });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    const failed = await screen.findByRole('alert');
    expect(failed.textContent).toContain('Error de Core');
    expect(failed.textContent).toContain('Core no pudo leer la Attention');
  });

  it('conserva la lista si solo fallan los conteos de projects_overview', async () => {
    mountCore({
      attention: () => page([item()]),
      projects: () => { throw new Error('projects_overview_unavailable: sin almacén'); },
    });

    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    expect(await screen.findByRole('button', { name: /Media: Pregunta/ })).toBeTruthy();
    expect(screen.getByTestId('attention-total').textContent).toBe('—');
    expect(screen.getByText(/Los conteos y el filtro por Project no están disponibles/)).toBeTruthy();
  });

  it('agrega solo los contadores que publica el Core y tolera overview incompleto', () => {
    expect(sumAttentionCounts(undefined)).toEqual({ total: 0, byCategory: { ...ZERO } });
    expect(sumAttentionCounts({
      projects: [
        { id: 'p1', counts: { attention: counts({ question: 1, risk: 2 }) } },
        { id: 'p2', counts: {} },
      ],
      unassigned: { attention: counts({ failed: 1 }) },
    })).toEqual({
      total: 4,
      byCategory: { ...ZERO, question: 1, risk: 2, failed: 1 },
    });
  });
});
