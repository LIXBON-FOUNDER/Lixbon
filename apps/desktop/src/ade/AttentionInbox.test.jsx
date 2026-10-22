import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { AttentionInbox, sumAttentionCounts } from './AttentionInbox';
import { ATTENTION_LIMIT } from './coreQueries';
import { resetOutstandingQueries } from './coreQueryPolicy';

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

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

// jsdom no implementa scrollIntoView: se instala un mock observable y se retira al terminar.
function mockScrollIntoView() {
  const scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  return scrollIntoView;
}

// Geometría observable: la lista mide 0–100 px y las filas indicadas quedan fuera de ella (150–190 px).
function mockRowGeometry(hiddenAttentionIds) {
  return vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect() {
    if (this.classList.contains('attention-inbox__list')) return { top: 0, bottom: 100, left: 0, right: 100, width: 100, height: 100 };
    const hidden = hiddenAttentionIds.includes(this.dataset?.attentionId);
    return hidden
      ? { top: 150, bottom: 190, left: 0, right: 100, width: 100, height: 40 }
      : { top: 10, bottom: 50, left: 0, right: 100, width: 100, height: 40 };
  });
}

// Emula a Chrome/WebView2: al quitar del DOM el nodo enfocado dispara focusout (relatedTarget null) antes de retirarlo.
// jsdom no emite ese focusout al retirar el nodo, así que el harness lo suelta a mano.
// El registro cuenta los focusout que LLEGAN al nodo enfocado, no los intentos: si la emulación deja de
// despacharlos, el contador se queda en cero y la regresión falla en vez de quedar en verde sin probar la retirada.
function emulateBlurOnRemoval() {
  const original = Node.prototype.removeChild;
  const emulated = { focusouts: 0, targets: [] };
  vi.spyOn(Node.prototype, 'removeChild').mockImplementation(function removeChild(child) {
    const active = document.activeElement;
    if (active && active !== document.body && child.contains(active)) {
      const onFocusout = (event) => {
        if (event.target !== active) return;
        emulated.focusouts += 1;
        emulated.targets.push(active);
        active.removeEventListener('focusout', onFocusout);
      };
      active.addEventListener('focusout', onFocusout);
      active.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    }
    return original.call(this, child);
  });
  return emulated;
}

const flushAsync = () => act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
const visibleAttentionIds = () => screen.getAllByRole('listitem')
  .map((row) => row.querySelector('[data-attention-id]').dataset.attentionId);
const attentionCalls = (calls, cursor) => calls.filter(([query, args]) => query === 'attention_list' && args.cursor === cursor);

afterEach(() => {
  delete HTMLElement.prototype.scrollIntoView;
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  invoke.mockReset();
  // El registro de peticiones vivas es de módulo (LXO-101): una petición a medio camino de un
  // caso envenenaría el siguiente.
  resetOutstandingQueries();
});

describe('AttentionInbox', () => {
  it('lista las siete categorías del contrato y muestra los conteos autoritativos del Core', { timeout: 20_000 }, async () => {
    mountCore({
      attention: () => page(sevenFixtures()),
      projects: () => overview({
        projects: [
          project('project-a', 'Alpha', counts({ question: 1, approval: 2, review_ready: 3, conflict: 4 })),
          project('project-b', 'Beta', counts({ failed: 5 })),
        ],
        unassigned: counts({ environment_blocked: 6, risk: 7 }),
      }),
    });

    render(<AttentionInbox onOpenTarget={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('attention-total').textContent).toBe('28'));
    expect(screen.getByText('activas en el overview')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(7));
    for (const visible of ['Pregunta', 'Aprobación', 'Revisión lista', 'Conflicto', 'Fallida', 'Entorno bloqueado', 'Riesgo']) {
      expect(screen.getAllByText(visible).length).toBeGreaterThan(0);
    }

    const categoryFilter = screen.getByLabelText('Categoría');
    expect(within(categoryFilter).getAllByRole('option')).toHaveLength(8);
    for (const [name, count] of [
      ['Pregunta', 1],
      ['Aprobación', 2],
      ['Revisión lista', 3],
      ['Conflicto', 4],
      ['Fallida', 5],
      ['Entorno bloqueado', 6],
      ['Riesgo', 7],
    ]) {
      expect(within(categoryFilter).getByRole('option', { name: `${name} (${count})` })).toBeTruthy();
    }
    expect(within(screen.getByLabelText('Severidad')).getAllByRole('option')).toHaveLength(5);
    const projectFilter = screen.getByLabelText('Project');
    expect(within(projectFilter).getByRole('option', { name: 'Alpha · 10' })).toBeTruthy();
    expect(within(projectFilter).getByRole('option', { name: 'Beta · 5' })).toBeTruthy();
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
    const categoryFilter = screen.getByLabelText('Categoría');
    expect(within(categoryFilter).getByRole('option', { name: 'Revisión lista (1)' })).toBeTruthy();
    expect(within(categoryFilter).getByRole('option', { name: 'Pregunta (0)' })).toBeTruthy();

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

  it('con severidad no presenta el total global como si fuera el de la consulta: usa la página y marca «+»', async () => {
    const critical = item({ id: 'att_critical', category: 'risk', severity: 'critical', created_at: 1 });
    const calls = mountCore({
      attention: (args) => {
        if (args.severity !== 'critical') return page([]);
        if (args.cursor === 'cursor-1') return page([]);
        return page([critical], { hasMore: true, next: 'cursor-1' });
      },
      projects: () => overview({ projects: [project('project-a', 'Alpha', counts({ question: 3, risk: 2 }))] }),
    });

    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('attention-total').textContent).toBe('5'));
    expect(screen.getByText('activas en el overview')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Severidad'), { target: { value: 'critical' } });
    await waitFor(() => expect(calls).toContainEqual([
      'attention_list',
      { severity: 'critical', limit: ATTENTION_LIMIT },
    ]));
    await waitFor(() => expect(screen.getByTestId('attention-total').textContent).toBe('1+'));
    expect(screen.getByText('activas con esta severidad')).toBeTruthy();
    // Los conteos por categoría del overview no están cruzados con la severidad: no se insinúa que lo estén.
    expect(screen.getByLabelText('Categoría').textContent).not.toMatch(/\(\d+\)/);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await waitFor(() => expect(screen.getByTestId('attention-total').textContent).toBe('1'));
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();
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

  it('con target pide target_kind/target_id al Core, lo conserva al paginar y se puede quitar', async () => {
    const own = item({ id: 'att_1', target_id: 'task-9', created_at: 1 });
    const more = item({ id: 'att_2', target_id: 'task-9', created_at: 2 });
    const calls = mountCore({
      attention: (args) => (args.cursor ? page([more]) : page([own], { hasMore: true, next: 'cursor-1' })),
      projects: () => overview({ projects: [project('project-a', 'Alpha', counts({ question: 5 }))] }),
    });
    const onClearTarget = vi.fn();

    render(<AttentionInbox onOpenTarget={vi.fn()} target={{ kind: 'task', id: 'task-9', projectId: 'project-a', seq: 1 }} onClearTarget={onClearTarget} />);
    await screen.findByRole('button', { name: /Media: Pregunta/ });

    expect(calls).toContainEqual(['attention_list', { target_kind: 'task', target_id: 'task-9', limit: ATTENTION_LIMIT }]);
    // Los contadores de projects_overview no son del target: no se presentan como si lo fueran.
    expect(screen.getByTestId('attention-total').textContent).toBe('1+');
    expect(screen.getByRole('group', { name: 'Filtro por target' }).textContent).toContain('Task task-9');
    expect(screen.getByLabelText('Categoría').textContent).not.toMatch(/\(\d+\)/);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Media: Pregunta/ })).toHaveLength(2));
    expect(calls).toContainEqual(['attention_list', { target_kind: 'task', target_id: 'task-9', cursor: 'cursor-1', limit: ATTENTION_LIMIT }]);
    expect(screen.getByTestId('attention-total').textContent).toBe('2');

    fireEvent.click(screen.getByRole('button', { name: 'Quitar el filtro por Task task-9' }));
    expect(onClearTarget).toHaveBeenCalledTimes(1);
  });

  it('una apertura nueva del target parte sin filtros heredados', async () => {
    const calls = mountCore({ attention: () => page([item()]) });
    const { rerender } = render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await screen.findByRole('button', { name: /Media: Pregunta/ });
    fireEvent.change(screen.getByLabelText('Severidad'), { target: { value: 'high' } });
    await waitFor(() => expect(calls).toContainEqual(['attention_list', { severity: 'high', limit: ATTENTION_LIMIT }]));

    rerender(<AttentionInbox onOpenTarget={vi.fn()} target={{ kind: 'task', id: 'task-1', projectId: null, seq: 1 }} />);
    await waitFor(() => expect(calls.at(-1)).toEqual(['attention_list', { target_kind: 'task', target_id: 'task-1', limit: ATTENTION_LIMIT }]));
    expect(screen.getByLabelText('Severidad').value).toBe('');

    // Un cambio de filtro posterior se respeta mientras el mismo target siga abierto.
    fireEvent.change(screen.getByLabelText('Severidad'), { target: { value: 'low' } });
    rerender(<AttentionInbox onOpenTarget={vi.fn()} target={{ kind: 'task', id: 'task-1', projectId: null, seq: 1 }} />);
    expect(screen.getByLabelText('Severidad').value).toBe('low');
  });

  it('navega con teclado y expone nombres y descripciones ARIA', async () => {
    const rows = [1, 2, 3].map((n) => item({
      id: `att_${n}`,
      target_id: `task-${n}`,
      created_at: n,
      severity: ['critical', 'high', 'low'][n - 1],
    }));
    mountCore({
      attention: () => page(rows),
      projects: () => overview({ projects: [project('project-a', 'Alpha', counts({ question: 3 }))] }),
    });

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

    expect(screen.getByTestId('attention-inbox').getAttribute('aria-busy')).toBe('false');
    expect(screen.getByRole('list', { name: 'Attention activa' }).getAttribute('aria-busy')).toBe('false');
    const live = document.querySelector('.attention-inbox__sr');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('3 Attention activas en el overview.');
  });

  it('es de solo lectura: ninguna interacción emite mutaciones ni otras queries', async () => {
    mountCore({
      attention: () => page([item()]),
      projects: () => overview({ projects: [project('project-a', 'Alpha', counts({ question: 1 }))] }),
    });
    const onOpenTarget = vi.fn();
    render(<AttentionInbox onOpenTarget={onOpenTarget} />);
    await screen.findByRole('button', { name: /Media: Pregunta/ });

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'project-a' } });
    await waitFor(() => expect(invoke.mock.calls.some(([, payload]) => payload.query === 'attention_list'
      && payload.args.project_id === 'project-a')).toBe(true));
    fireEvent.change(screen.getByLabelText('Categoría'), { target: { value: 'question' } });
    await waitFor(() => expect(invoke.mock.calls.some(([, payload]) => payload.query === 'attention_list'
      && payload.args.category === 'question')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /Media: Pregunta/ }));
    expect(onOpenTarget).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
    await waitFor(() => expect(invoke.mock.calls.some(([, payload]) => payload.query === 'attention_list'
      && !payload.args.project_id && !payload.args.category)).toBe(true));

    expect(invoke).toHaveBeenCalled();
    for (const [command, payload] of invoke.mock.calls) {
      expect(command).toBe('orch_query');
      expect(['attention_list', 'projects_overview']).toContain(payload.query);
    }
    const trace = invoke.mock.calls.map(([command, payload]) => `${command}:${payload.query}`).join(' ');
    expect(trace).not.toMatch(/act_risk|resolve|snooze|push|unread|mark|approve|review|reply|orch_call/i);
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

  it('detiene la paginación cuando una página posterior vacía informa has_more=false', async () => {
    mountCore({
      attention: (args) => args.cursor
        ? page([])
        : page([
          item({ id: 'att_1', target_id: 'task-1', created_at: 1 }),
          item({ id: 'att_2', target_id: 'task-2', created_at: 2 }),
        ], { hasMore: true, next: 'cursor-1' }),
    });

    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();
  });

  it('reinicia las páginas en cada sondeo predeterminado de 15 segundos y conserva los destinos durables', async () => {
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

    render(<AttentionInbox onOpenTarget={onOpenTarget} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2']);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3', 'att_4']);

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3', 'att_4', 'att_5']);

    refreshed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3', 'att_4', 'att_5']);
    expect(calls.filter(([query, args]) => query === 'attention_list' && !args.cursor)).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
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

  it('conserva el foco por ID durable cuando una página anexada vuelve en la nueva cabecera', async () => {
    vi.useFakeTimers();
    let refreshed = false;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    const oldOnly = item({ id: 'att_old', target_id: 'task-old', created_at: 4 });
    const newFirst = item({ id: 'att_0', target_id: 'task-0', created_at: 0 });
    const newPage = item({ id: 'att_5', target_id: 'task-5', created_at: 5 });
    const calls = mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-old') return page([focused, oldOnly]);
        if (args.cursor === 'cursor-new') return page([newPage]);
        return refreshed
          ? page([newFirst, focused], { hasMore: true, next: 'cursor-new' })
          : page([first, second], { hasMore: true, next: 'cursor-old' });
      },
    });
    const visibleIds = () => screen.getAllByRole('listitem')
      .map((row) => row.querySelector('[data-attention-id]').dataset.attentionId);

    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3', 'att_old']);

    const focusedButton = screen.getByRole('button', { name: /Task task-3/ });
    focusedButton.focus();
    const scrollIntoView = mockScrollIntoView();

    refreshed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    const refreshedFocusedButton = screen.getByRole('button', { name: /Task task-3/ });
    expect(visibleIds()).toEqual(['att_0', 'att_3']);
    expect(document.activeElement).toBe(refreshedFocusedButton);
    expect(refreshedFocusedButton.tabIndex).toBe(0);
    expect(screen.getByRole('button', { name: /Task task-0/ }).tabIndex).toBe(-1);
    // La fila sigue visible: el foco vuelve sin ningún scroll adicional.
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Task task-old/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_0', 'att_3', 'att_5']);
    expect(calls).toContainEqual(['attention_list', { limit: ATTENTION_LIMIT, cursor: 'cursor-new' }]);
    expect(calls.filter(([query, args]) => query === 'attention_list' && args.cursor === 'cursor-old')).toHaveLength(1);
  });

  it('mueve el foco a la primera fila nueva cuando desaparece el destino enfocado al sondear', async () => {
    vi.useFakeTimers();
    let refreshed = false;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    const oldOnly = item({ id: 'att_old', target_id: 'task-old', created_at: 4 });
    const newFirst = item({ id: 'att_0', target_id: 'task-0', created_at: 0 });
    const newSecond = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const newPage = item({ id: 'att_5', target_id: 'task-5', created_at: 5 });
    const calls = mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-old') return page([focused, oldOnly]);
        if (args.cursor === 'cursor-new') return page([newPage]);
        return refreshed
          ? page([newFirst, newSecond], { hasMore: true, next: 'cursor-new' })
          : page([first, second], { hasMore: true, next: 'cursor-old' });
      },
    });
    const visibleIds = () => screen.getAllByRole('listitem')
      .map((row) => row.querySelector('[data-attention-id]').dataset.attentionId);

    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3', 'att_old']);

    screen.getByRole('button', { name: /Task task-3/ }).focus();
    refreshed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    const fallbackButton = screen.getByRole('button', { name: /Task task-0/ });
    expect(visibleIds()).toEqual(['att_0', 'att_2']);
    expect(document.activeElement).toBe(fallbackButton);
    expect(fallbackButton.tabIndex).toBe(0);
    expect(screen.getByRole('button', { name: /Task task-2/ }).tabIndex).toBe(-1);
    expect(screen.queryByRole('button', { name: /Task task-3|Task task-old/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_0', 'att_2', 'att_5']);
    expect(calls).toContainEqual(['attention_list', { limit: ATTENTION_LIMIT, cursor: 'cursor-new' }]);
    expect(calls.filter(([query, args]) => query === 'attention_list' && args.cursor === 'cursor-old')).toHaveLength(1);
  });

  describe.each([
    ['un relatedTarget externo', (row, outside) => outside.focus()],
    ['relatedTarget null', (row) => row.blur()],
  ])('si el foco sale de la lista hacia %s', (_name, leave) => {
    it('el sondeo siguiente no roba el foco ni deja que Enter active una fila, en varios sondeos', async () => {
      vi.useFakeTimers();
      let reads = 0;
      const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
      const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
      mountCore({
        attention: () => {
          reads += 1;
          return page([item({ id: `att_new${reads}`, target_id: `task-new${reads}`, created_at: 0 }), first, second]);
        },
      });
      const onOpenTarget = vi.fn();
      render(<><button type="button">fuera</button><AttentionInbox onOpenTarget={onOpenTarget} pollMs={1_000} /></>);
      await flushAsync();
      const outside = screen.getByRole('button', { name: 'fuera' });
      const row = screen.getByRole('button', { name: /Task task-1/ });
      row.focus();
      expect(document.activeElement).toBe(row);

      act(() => leave(row, outside));
      const expectedActive = document.activeElement;
      expect(expectedActive.closest('[data-attention-id]')).toBeNull();

      for (let poll = 1; poll <= 3; poll += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(visibleAttentionIds()).toContain(`att_new${reads}`);
        expect(document.activeElement).toBe(expectedActive);
        // Enter sobre el elemento activo (fuera de la lista) no abre ninguna fila.
        fireEvent.keyDown(document.activeElement, { key: 'Enter' });
        expect(onOpenTarget).not.toHaveBeenCalled();
      }
      // Roving tabindex intacto: una única fila es tab stop.
      const tabStops = screen.getAllByRole('button', { name: /^Media: / }).filter((button) => button.tabIndex === 0);
      expect(tabStops).toHaveLength(1);
    });
  });

  it('un blur que provoca la sustitución del nodo por el refresh no cuenta como perder el foco', async () => {
    vi.useFakeTimers();
    let refreshed = false;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    const newFirst = item({ id: 'att_0', target_id: 'task-0', created_at: 0 });
    mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-old') return page([focused]);
        if (args.cursor === 'cursor-new') return page([focused]);
        return refreshed
          ? page([newFirst, second], { hasMore: true, next: 'cursor-new' })
          : page([first, second], { hasMore: true, next: 'cursor-old' });
      },
    });
    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await flushAsync();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await flushAsync();
    screen.getByRole('button', { name: /Task task-3/ }).focus();

    emulateBlurOnRemoval();
    refreshed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();

    expect(visibleAttentionIds()).toEqual(['att_0', 'att_2', 'att_3']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Task task-3/ }));
  });

  it('una fila de página anexada enfocada sobrevive a varios sondeos si la consulta fresca la encuentra', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    const oldOnly = item({ id: 'att_old', target_id: 'task-old', created_at: 4 });
    const later = item({ id: 'att_9', target_id: 'task-9', created_at: 9 });
    const calls = mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-old') return page([focused, oldOnly]);
        if (args.cursor) return page([focused, later]);
        reads += 1;
        if (reads === 1) return page([first, second], { hasMore: true, next: 'cursor-old' });
        return page([item({ id: `att_new${reads}`, target_id: `task-new${reads}`, created_at: 0 }), second],
          { hasMore: true, next: `cursor-fresh-${reads}` });
      },
    });
    const onOpenTarget = vi.fn();
    render(<AttentionInbox onOpenTarget={onOpenTarget} pollMs={1_000} />);
    await flushAsync();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await flushAsync();
    screen.getByRole('button', { name: /Task task-3/ }).focus();

    for (const freshCursor of ['cursor-fresh-2', 'cursor-fresh-3']) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      await flushAsync();
      const focusedButton = screen.getByRole('button', { name: /Task task-3/ });
      expect(document.activeElement).toBe(focusedButton);
      expect(focusedButton.tabIndex).toBe(0);
      expect(visibleAttentionIds()).toEqual([expect.stringMatching(/^att_new/), 'att_2', 'att_3', 'att_9']);
      expect(attentionCalls(calls, freshCursor)).toHaveLength(1);
      expect(screen.queryByRole('button', { name: /Task task-old/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();
    }
    // Los cursores de la sesión anterior no se reutilizan nunca.
    expect(attentionCalls(calls, 'cursor-old')).toHaveLength(1);
    expect(onOpenTarget).not.toHaveBeenCalled();
  });

  it('mientras rehidrata la página anexada bloquea «Cargar más» y no roba el foco si el usuario ya se fue', async () => {
    vi.useFakeTimers();
    const search = deferred();
    let refreshed = false;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-old') return page([focused]);
        if (args.cursor === 'cursor-new') return search.promise;
        return refreshed
          ? page([item({ id: 'att_0', target_id: 'task-0', created_at: 0 }), second], { hasMore: true, next: 'cursor-new' })
          : page([first, second], { hasMore: true, next: 'cursor-old' });
      },
    });
    render(<><button type="button">fuera</button><AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} /></>);
    await flushAsync();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await flushAsync();
    screen.getByRole('button', { name: /Task task-3/ }).focus();

    emulateBlurOnRemoval();
    refreshed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(visibleAttentionIds()).toEqual(['att_0', 'att_2']);
    expect(screen.getByRole('list', { name: 'Attention activa' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: 'Cargando…' }).disabled).toBe(true);

    // El usuario pasa a otro control antes de que acabe la búsqueda.
    const outside = screen.getByRole('button', { name: 'fuera' });
    outside.focus();
    await act(async () => {
      search.resolve(page([focused]));
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
    expect(document.activeElement).toBe(outside);
    expect(screen.getByRole('list', { name: 'Attention activa' }).getAttribute('aria-busy')).toBe('false');
  });

  it('si la consulta fresca no puede probar presencia ni ausencia conserva el ID y no mueve el foco a otra fila', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-old') return page([focused]);
        if (args.cursor === 'cursor-broken') throw new Error('ade_query_timeout: Core no respondió a tiempo');
        if (args.cursor === 'cursor-ok') return page([focused]);
        reads += 1;
        if (reads === 1) return page([first, second], { hasMore: true, next: 'cursor-old' });
        return page([item({ id: 'att_0', target_id: 'task-0', created_at: 0 }), second],
          { hasMore: true, next: reads === 2 ? 'cursor-broken' : 'cursor-ok' });
      },
    });
    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await flushAsync();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await flushAsync();
    screen.getByRole('button', { name: /Task task-3/ }).focus();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();
    expect(visibleAttentionIds()).toEqual(['att_0', 'att_2']);
    // Ninguna fila ajena recibe el foco.
    expect(document.activeElement).toBe(document.body);

    // En el sondeo siguiente la fila ya se puede probar presente: el ID se había conservado.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();
    expect(visibleAttentionIds()).toEqual(['att_0', 'att_2', 'att_3']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Task task-3/ }));
  });

  it('un target realmente ausente cae a la primera fila nueva tras agotar la búsqueda fresca, también en varios sondeos', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    const newFirst = item({ id: 'att_0', target_id: 'task-0', created_at: 0 });
    const calls = mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-old') return page([focused]);
        if (args.cursor) return page([item({ id: 'att_7', target_id: 'task-7', created_at: 7 })]);
        reads += 1;
        return reads === 1
          ? page([first, second], { hasMore: true, next: 'cursor-old' })
          : page([newFirst, second], { hasMore: true, next: `cursor-gone-${reads}` });
      },
    });
    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await flushAsync();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await flushAsync();
    screen.getByRole('button', { name: /Task task-3/ }).focus();

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();
    const fallback = screen.getByRole('button', { name: /Task task-0/ });
    expect(visibleAttentionIds()).toEqual(['att_0', 'att_2']);
    expect(document.activeElement).toBe(fallback);
    expect(fallback.tabIndex).toBe(0);
    expect(attentionCalls(calls, 'cursor-gone-2')).toHaveLength(1);

    // El nuevo foco es la primera fila; el sondeo siguiente la conserva sin buscar de nuevo.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Task task-0/ }));
    expect(attentionCalls(calls, 'cursor-gone-3')).toHaveLength(0);
    expect(attentionCalls(calls, 'cursor-old')).toHaveLength(1);
  });

  it('un nodo que conserva el foco DOM no se desplaza al sondear, aunque el usuario lo sacara de vista', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    mountCore({
      attention: () => {
        reads += 1;
        return page([item({ id: `att_new${reads}`, target_id: `task-new${reads}`, created_at: 0 }), first, focused]);
      },
    });
    const scrollIntoView = mockScrollIntoView();
    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await flushAsync();
    screen.getByRole('list', { name: 'Attention activa' }).style.overflowY = 'auto';

    const focusedButton = screen.getByRole('button', { name: /Task task-3/ });
    focusedButton.focus();
    // El usuario desplazó la lista: la fila enfocada queda fuera de vista, pero su nodo sigue siendo el activo.
    mockRowGeometry(['att_3']);
    for (let poll = 1; poll <= 3; poll += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
      await flushAsync();
      expect(visibleAttentionIds()).toContain(`att_new${reads}`);
      expect(screen.getByRole('button', { name: /Task task-3/ })).toBe(focusedButton);
      expect(document.activeElement).toBe(focusedButton);
      expect(focusedButton.tabIndex).toBe(0);
    }
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('al restaurar el foco en un nodo nuevo fuera de vista hace el scroll mínimo (nearest) solo esa vez', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    mountCore({
      attention: (args) => {
        if (args.cursor) return page([focused]);
        reads += 1;
        if (reads === 1) return page([first, second], { hasMore: true, next: 'cursor-old' });
        return page([item({ id: `att_new${reads}`, target_id: `task-new${reads}`, created_at: 0 }), second],
          { hasMore: true, next: `cursor-fresh-${reads}` });
      },
    });
    const scrollIntoView = mockScrollIntoView();
    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await flushAsync();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await flushAsync();
    screen.getByRole('list', { name: 'Attention activa' }).style.overflowY = 'auto';
    mockRowGeometry(['att_3']);
    const oldNode = screen.getByRole('button', { name: /Task task-3/ });
    oldNode.focus();

    emulateBlurOnRemoval();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();

    // La fila vive en una página anexada: el refresh retiró su nodo y la rehidratación crea uno nuevo.
    const newNode = screen.getByRole('button', { name: /Task task-3/ });
    expect(newNode).not.toBe(oldNode);
    expect(document.activeElement).toBe(newNode);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect(scrollIntoView.mock.contexts[0]).toBe(newNode);
  });

  it('si el Core falla con el foco en una página anexada, al reconectar rehidrata con cursores frescos y restaura el foco', async () => {
    vi.useFakeTimers();
    let failing = false;
    let reads = 0;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    const calls = mountCore({
      attention: (args) => {
        if (failing) throw new Error('ade_query_timeout: Core no respondió a tiempo');
        if (args.cursor) return page([focused]);
        reads += 1;
        return reads === 1
          ? page([first, second], { hasMore: true, next: 'cursor-old' })
          : page([item({ id: 'att_0', target_id: 'task-0', created_at: 0 }), second], { hasMore: true, next: 'cursor-fresh' });
      },
    });
    const onOpenTarget = vi.fn();
    render(<AttentionInbox onOpenTarget={onOpenTarget} pollMs={1_000} />);
    await flushAsync();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await flushAsync();
    const focusedButton = screen.getByRole('button', { name: /Task task-3/ });
    focusedButton.focus();
    const emulated = emulateBlurOnRemoval();

    failing = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();
    // Las páginas anexadas se descartan con la cabecera retenida; el foco no pasa a una fila ajena.
    expect(screen.getByText(/Attention desactualizada: Core sin respuesta a tiempo/)).toBeTruthy();
    expect(visibleAttentionIds()).toEqual(['att_1', 'att_2']);
    // Precondición de la regresión: el nodo enfocado se retiró con focusout emulado (WebView2/Chromium).
    // Sin esta comprobación el caso pasaría en verde aunque la retirada del nodo dejara de probarse.
    expect(emulated.focusouts).toBeGreaterThan(0);
    expect(emulated.targets).toContain(focusedButton);
    expect(document.activeElement).toBe(document.body);
    // Un sondeo más con el Core caído: el target sigue conservado.
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();
    expect(document.activeElement).toBe(document.body);

    failing = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();
    const restored = screen.getByRole('button', { name: /Task task-3/ });
    expect(visibleAttentionIds()).toEqual(['att_0', 'att_2', 'att_3']);
    expect(document.activeElement).toBe(restored);
    expect(restored.tabIndex).toBe(0);
    // Solo se usó el cursor de la cabecera fresca; el de la sesión anterior no se reutiliza.
    expect(attentionCalls(calls, 'cursor-fresh')).toHaveLength(1);
    expect(attentionCalls(calls, 'cursor-old')).toHaveLength(1);
    expect(onOpenTarget).not.toHaveBeenCalled();
  });

  it('si al reconectar la fila ya no existe, no salta a una fila ajena hasta probar su ausencia con cursores frescos', async () => {
    vi.useFakeTimers();
    let failing = false;
    let reads = 0;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    const calls = mountCore({
      attention: (args) => {
        if (failing) throw new Error('ade_query_timeout: Core no respondió a tiempo');
        if (args.cursor === 'cursor-old') return page([focused]);
        if (args.cursor) return page([item({ id: 'att_7', target_id: 'task-7', created_at: 7 })]);
        reads += 1;
        return reads === 1
          ? page([first, second], { hasMore: true, next: 'cursor-old' })
          : page([item({ id: 'att_0', target_id: 'task-0', created_at: 0 }), second], { hasMore: true, next: 'cursor-gone' });
      },
    });
    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await flushAsync();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await flushAsync();
    const focusedButton = screen.getByRole('button', { name: /Task task-3/ });
    focusedButton.focus();
    const emulated = emulateBlurOnRemoval();

    failing = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();
    // Precondición de la regresión: el nodo enfocado se retiró con focusout emulado (WebView2/Chromium).
    expect(emulated.focusouts).toBeGreaterThan(0);
    expect(emulated.targets).toContain(focusedButton);
    expect(document.activeElement).toBe(document.body);

    failing = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await flushAsync();
    // Con cursores frescos la ausencia queda probada: respaldo determinista en la primera fila de la cabecera.
    expect(visibleAttentionIds()).toEqual(['att_0', 'att_2']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Task task-0/ }));
    expect(attentionCalls(calls, 'cursor-gone')).toHaveLength(1);
    expect(attentionCalls(calls, 'cursor-old')).toHaveLength(1);
  });

  it('si un cursor caducado descarta las páginas con el foco en una fila anexada, rehidrata con la cabecera nueva y restaura el foco', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const focused = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    const calls = mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-old') return page([focused], { hasMore: true, next: 'cursor-expired' });
        if (args.cursor === 'cursor-expired') throw new Error('attention_invalid_cursor: el cursor no pertenece a esta clave');
        if (args.cursor) return page([focused]);
        reads += 1;
        return reads === 1
          ? page([first, second], { hasMore: true, next: 'cursor-old' })
          : page([item({ id: 'att_0', target_id: 'task-0', created_at: 0 }), second], { hasMore: true, next: 'cursor-fresh' });
      },
    });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await flushAsync();
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await flushAsync();
    expect(visibleAttentionIds()).toEqual(['att_1', 'att_2', 'att_3']);
    // El foco queda en la fila anexada (el clic no lo mueve, como en Safari/Firefox).
    const focusedButton = screen.getByRole('button', { name: /Task task-3/ });
    focusedButton.focus();
    const emulated = emulateBlurOnRemoval();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await flushAsync();

    expect(screen.getByText(/el cursor caducó: se volvió a la primera página/)).toBeTruthy();
    // Precondición de la regresión: el nodo enfocado se retiró con focusout emulado (WebView2/Chromium).
    expect(emulated.focusouts).toBeGreaterThan(0);
    expect(emulated.targets).toContain(focusedButton);
    const restored = screen.getByRole('button', { name: /Task task-3/ });
    expect(visibleAttentionIds()).toEqual(['att_0', 'att_2', 'att_3']);
    expect(document.activeElement).toBe(restored);
    expect(attentionCalls(calls, 'cursor-fresh')).toHaveLength(1);
    expect(attentionCalls(calls, 'cursor-old')).toHaveLength(1);
    expect(attentionCalls(calls, 'cursor-expired')).toHaveLength(1);
  });

  it('con cabecera idéntica pero una página posterior cambiada, el sondeo descarta las páginas y el total deja de ser exacto', async () => {
    vi.useFakeTimers();
    let laterChanged = false;
    const first = item({ id: 'att_1', severity: 'critical', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', severity: 'critical', target_id: 'task-2', created_at: 2 });
    const third = item({ id: 'att_3', severity: 'critical', target_id: 'task-3', created_at: 3 });
    const fourth = item({ id: 'att_4', severity: 'critical', target_id: 'task-4', created_at: 4 });
    const calls = mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-1') {
          return laterChanged
            ? page([third, fourth], { hasMore: true, next: 'cursor-2' })
            : page([third]);
        }
        // La cabecera es byte a byte la misma antes y después del sondeo.
        return page([first, second], { hasMore: true, next: 'cursor-1' });
      },
    });
    const visibleIds = () => screen.getAllByRole('listitem')
      .map((row) => row.querySelector('[data-attention-id]').dataset.attentionId);
    const total = () => screen.getByTestId('attention-total').textContent;

    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText('Severidad'), { target: { value: 'critical' } });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(total()).toBe('2+');

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3']);
    expect(total()).toBe('3');
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();

    laterChanged = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    // La página 2 anexada ya no se revalidó: no se presenta su total como exacto ni se conservan sus filas.
    expect(visibleIds()).toEqual(['att_1', 'att_2']);
    expect(total()).toBe('2+');
    expect(screen.getByRole('button', { name: 'Cargar más' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3', 'att_4']);
    expect(total()).toBe('4+');
    expect(calls.filter(([query, args]) => query === 'attention_list' && args.cursor === 'cursor-1')).toHaveLength(2);
  });

  it('invalida una página en vuelo al cambiar la cabecera y evita que su finally libere la carga nueva', async () => {
    vi.useFakeTimers();
    const oldRequest = deferred();
    const newRequest = deferred();
    let refreshed = false;
    const first = item({ id: 'att_1', target_id: 'task-1', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-2', created_at: 2 });
    const stalePageItem = item({ id: 'att_old', target_id: 'task-old', created_at: 3 });
    const currentPageItem = item({ id: 'att_3', target_id: 'task-3', created_at: 3 });
    const calls = mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-old') return oldRequest.promise;
        if (args.cursor === 'cursor-new') return newRequest.promise;
        return page([first, second], { hasMore: true, next: refreshed ? 'cursor-new' : 'cursor-old' });
      },
    });
    const visibleIds = () => screen.getAllByRole('listitem')
      .map((row) => row.querySelector('[data-attention-id]').dataset.attentionId);

    render(<AttentionInbox onOpenTarget={vi.fn()} pollMs={1_000} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    expect(calls.filter(([query, args]) => query === 'attention_list' && args.cursor === 'cursor-old')).toHaveLength(1);

    refreshed = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(visibleIds()).toEqual(['att_1', 'att_2']);
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    expect(calls.filter(([query, args]) => query === 'attention_list' && args.cursor === 'cursor-new')).toHaveLength(1);

    const loadingButton = screen.getByRole('button', { name: 'Cargando…' });
    await act(async () => {
      oldRequest.resolve(page([stalePageItem]));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(visibleIds()).toEqual(['att_1', 'att_2']);

    // Bypass the disabled presentation to exercise the request lock after the stale finally ran.
    loadingButton.disabled = false;
    fireEvent.click(loadingButton);
    expect(calls.filter(([query, args]) => query === 'attention_list' && args.cursor === 'cursor-new')).toHaveLength(1);

    await act(async () => {
      newRequest.resolve(page([currentPageItem]));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(visibleIds()).toEqual(['att_1', 'att_2', 'att_3']);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();
  });

  it('reinicia la paginación si el Core rechaza el cursor opaco', async () => {
    let headReads = 0;
    const calls = mountCore({
      attention: (args) => {
        if (args.cursor === 'cursor-1') throw new Error('attention_invalid_cursor: el cursor no pertenece a esta clave');
        headReads += 1;
        if (headReads > 1) return page([item({ id: 'att_3', target_id: 'task-3', created_at: 3 })]);
        return page([
          item({ id: 'att_1', target_id: 'task-1', created_at: 1 }),
          item({ id: 'att_2', target_id: 'task-2', created_at: 2 }),
        ], { hasMore: true, next: 'cursor-1' });
      },
    });

    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await screen.findAllByRole('listitem');
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));

    expect(await screen.findByRole('button', { name: /Media: Pregunta\. Task task-3/ })).toBeTruthy();
    expect(screen.getByText(/el cursor caducó: se volvió a la primera página/)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(calls.filter(([query]) => query === 'attention_list').length).toBeGreaterThanOrEqual(3);

    fireEvent.click(screen.getByRole('button', { name: 'Cerrar aviso' }));
    expect(screen.queryByText(/el cursor caducó: se volvió a la primera página/)).toBeNull();
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
    expect(screen.getByText(/Attention desactualizada: Core sin respuesta a tiempo/)).toBeTruthy();
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

  it('al reconectar conserva el target, deduplica el solape y vuelve a paginar con la misma cabecera', async () => {
    vi.useFakeTimers();
    let failing = false;
    const first = item({ id: 'att_1', target_id: 'task-9', created_at: 1 });
    const second = item({ id: 'att_2', target_id: 'task-9', created_at: 2 });
    const third = item({ id: 'att_3', target_id: 'task-9', created_at: 3 });
    const calls = mountCore({
      attention: (args) => {
        if (failing) throw new Error('ade_query_timeout: Core no respondió a tiempo');
        if (args.cursor === 'cursor-1') return page([second, third]);
        return page([first, second], { hasMore: true, next: 'cursor-1' });
      },
      projects: () => overview({ projects: [project('project-a', 'Alpha', counts({ question: 3 }))] }),
    });
    const ids = () => screen.getAllByRole('listitem')
      .map((row) => row.querySelector('[data-attention-id]').dataset.attentionId);
    const attentionCalls = () => calls.filter(([query]) => query === 'attention_list');

    render(
      <AttentionInbox
        onOpenTarget={vi.fn()}
        target={{ kind: 'task', id: 'task-9', projectId: 'project-a', seq: 1 }}
        onClearTarget={vi.fn()}
        pollMs={1_000}
      />,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(ids()).toEqual(['att_1', 'att_2']);
    expect(screen.getByRole('group', { name: 'Filtro por target' }).textContent).toContain('Task task-9');

    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(ids()).toEqual(['att_1', 'att_2', 'att_3']);
    expect(screen.queryByRole('button', { name: 'Cargar más' })).toBeNull();

    failing = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText(/Attention desactualizada: Core sin respuesta a tiempo/)).toBeTruthy();
    expect(ids()).toEqual(['att_1', 'att_2']);
    expect(screen.getByRole('group', { name: 'Filtro por target' }).textContent).toContain('Task task-9');

    failing = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByText(/Attention desactualizada/)).toBeNull();
    expect(ids()).toEqual(['att_1', 'att_2']);
    expect(screen.getByRole('group', { name: 'Filtro por target' }).textContent).toContain('Task task-9');

    // La cabecera reconectada es idéntica (updatedAt no cambia) y aun así la paginación sigue ligada a ella.
    fireEvent.click(screen.getByRole('button', { name: 'Cargar más' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(ids()).toEqual(['att_1', 'att_2', 'att_3']);
    expect(new Set(ids()).size).toBe(3);

    // El target se conserva en todas las consultas, también en las de paginación posteriores.
    for (const [, args] of attentionCalls()) {
      expect(args).toMatchObject({ target_kind: 'task', target_id: 'task-9' });
    }
  });

  it('muestra carga, vacío, vacío filtrado, error y degradado con roles accesibles', async () => {
    const pending = new Promise(() => {});
    mountCore({ attention: () => pending });
    const first = render(<AttentionInbox onOpenTarget={vi.fn()} />);
    const loading = screen.getByTestId('attention-loading');
    expect(loading.getAttribute('role')).toBe('status');
    expect(loading.textContent).toBe('Cargando Attention activa desde el Core…');
    expect(screen.getByTestId('attention-inbox').getAttribute('aria-busy')).toBe('true');
    first.unmount();
    // La petición de carga nunca llega: se libera su hueco para que el caso siguiente pueda leer
    // de verdad (la política no abandona la petición, pero entre casos de prueba no se hereda).
    resetOutstandingQueries();

    cleanup();
    mountCore({ attention: () => page([]) });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    const empty = await screen.findByTestId('attention-empty');
    expect(empty.getAttribute('role')).toBe('status');
    expect(empty.textContent).toMatch(/El Core no tiene Attention activa/);
    expect(screen.getByTestId('attention-total').textContent).toBe('0');
    expect(screen.getByTestId('attention-inbox').getAttribute('aria-busy')).toBe('false');

    fireEvent.change(screen.getByLabelText('Categoría'), { target: { value: 'risk' } });
    await waitFor(() => expect(screen.getByTestId('attention-empty').textContent).toMatch(/con estos filtros/));
    cleanup();

    mountCore({ attention: () => { throw new Error('attention_unavailable: el Core no tiene un almacén autoritativo disponible'); } });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    const degraded = await screen.findByTestId('attention-error');
    expect(degraded.getAttribute('role')).toBe('alert');
    expect(degraded.textContent).toContain('Core degradado');
    expect(degraded.textContent).toContain('almacén autoritativo');
    expect(within(degraded).getByRole('button', { name: 'Reintentar' })).toBeTruthy();
    cleanup();

    mountCore({ attention: () => { throw new Error('ade_query_timeout: Core no respondió a tiempo'); } });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    const timedOut = await screen.findByTestId('attention-error');
    expect(timedOut.getAttribute('role')).toBe('alert');
    // Un plazo agotado no es una desconexión: no hay evidencia de transporte roto (LXO-101).
    expect(timedOut.textContent).not.toContain('Core desconectado');
    expect(timedOut.textContent).toContain('Error de Core');
    expect(timedOut.textContent).toContain('no respondió dentro del umbral');
    cleanup();

    mountCore({ attention: () => { throw new Error('attention_read_failed: no se pudo leer la tabla'); } });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    const failed = await screen.findByTestId('attention-error');
    expect(failed.getAttribute('role')).toBe('alert');
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
