// ActivityTimeline.test.jsx — pruebas de la rodaja LXO-99 (presentacional, solo fixtures).
//
// SOLO SINTÉTICO: estas fixtures imitan la forma normalizada provisional que deberá
// entregar la proyección de LXO-92. No son salida del Core, no se leen del Event Log
// y no demuestran la aceptación de LXO-99 ni una vista Activity conectada.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ActivityTimeline } from './ActivityTimeline';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const T0 = 1792045113470;

function activityItem(overrides = {}) {
  return {
    eventId: 'evt-1',
    seq: 1,
    timestamp: T0,
    class: 'state',
    kind: 'task.created',
    target: { kind: 'task', id: 't-1' },
    project: { id: 'p-1', name: 'lixbon' },
    actor: { kind: 'agent', id: 't-1' },
    client: { channel: 'core', clientId: null },
    message: { key: 'activity.task.created', text: 'Tarea creada' },
    known: true,
    severity: null,
    metadata: [],
    ...overrides,
  };
}

describe('ActivityTimeline · estados de la vista', () => {
  it('loading: anuncia la carga y no pinta elementos previos', () => {
    render(<ActivityTimeline status="loading" items={[activityItem()]} />);
    expect(screen.getByTestId('activity-timeline').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('activity-loading').textContent).toContain('Cargando actividad');
    expect(screen.queryByTestId('activity-list')).toBeNull();
    expect(screen.queryByTestId('activity-evt-1')).toBeNull();
  });

  it('empty: sin actividad no inventa filas ni textos de eventos', () => {
    render(<ActivityTimeline status="ready" items={[]} />);
    expect(screen.getByTestId('activity-empty').textContent).toContain('Sin actividad todavía');
    expect(screen.getByTestId('activity-count').textContent).toBe('0');
    expect(screen.queryByTestId('activity-list')).toBeNull();
  });

  it('error: muestra el mensaje y el código, y reintenta con el alcance', () => {
    const onRetry = vi.fn();
    render(
      <ActivityTimeline
        status="error"
        error={{ code: 'internal', message: 'Fallo de lectura.' }}
        onRetry={onRetry}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('No se pudo cargar la actividad');
    expect(alert.textContent).toContain('Fallo de lectura.');
    expect(alert.textContent).toContain('internal');
    fireEvent.click(screen.getByTestId('activity-retry'));
    expect(onRetry).toHaveBeenCalledWith({ scope: { kind: 'global' } });
  });

  it('error sin stale no muestra filas cacheadas', () => {
    render(
      <ActivityTimeline
        status="error"
        items={[activityItem()]}
        error={{ message: 'Fallo.' }}
      />,
    );
    expect(screen.queryByTestId('activity-list')).toBeNull();
    expect(screen.queryByTestId('activity-evt-1')).toBeNull();
    expect(screen.queryByTestId('activity-stale')).toBeNull();
    expect(screen.getByTestId('activity-count').textContent).toBe('0');
  });

  it('stale+error conserva filas, cuenta y anuncia el aviso además del error', () => {
    const onRetry = vi.fn();
    const onRefresh = vi.fn();
    render(
      <ActivityTimeline
        status="error"
        stale
        items={[activityItem()]}
        error={{ code: 'internal', message: 'Reconexión fallida.' }}
        onRetry={onRetry}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByTestId('activity-error').textContent).toContain('Reconexión fallida.');
    expect(screen.getByTestId('activity-stale').textContent).toContain('Vista desactualizada');
    expect(screen.getByTestId('activity-list')).toBeTruthy();
    expect(screen.getByTestId('activity-evt-1')).toBeTruthy();
    expect(screen.getByTestId('activity-count').textContent).toBe('1');
    expect(screen.getByTestId('activity-count').getAttribute('aria-label')).toBe(
      '1 evento cargado',
    );
    expect(screen.getByTestId('activity-timeline').getAttribute('aria-busy')).toBe('false');

    fireEvent.click(screen.getByTestId('activity-refresh'));
    expect(onRefresh).toHaveBeenCalledWith({ scope: { kind: 'global' } });
    fireEvent.click(screen.getByTestId('activity-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('stale+error sin filas conserva el aviso y no inventa una lista', () => {
    render(<ActivityTimeline status="error" stale error={{ message: 'Fallo.' }} />);
    expect(screen.getByTestId('activity-stale')).toBeTruthy();
    expect(screen.getByTestId('activity-error')).toBeTruthy();
    expect(screen.queryByTestId('activity-list')).toBeNull();
    expect(screen.getByTestId('activity-count').textContent).toBe('0');
  });

  it('degraded: explica que el Core no tiene Event Log y no finge actividad', () => {
    render(<ActivityTimeline status="degraded" items={[activityItem()]} />);
    const state = screen.getByTestId('activity-degraded');
    expect(state.textContent).toMatch(/modo degradado/i);
    expect(state.textContent).toContain('Event Log');
    expect(screen.queryByTestId('activity-list')).toBeNull();
    expect(screen.queryByTestId('activity-empty')).toBeNull();
  });

  it('stale: avisa y deja actualizar sin ocultar lo ya cargado', () => {
    const onRefresh = vi.fn();
    render(<ActivityTimeline items={[activityItem()]} stale onRefresh={onRefresh} />);
    expect(screen.getByTestId('activity-stale').textContent).toContain('Vista desactualizada');
    expect(screen.getByTestId('activity-evt-1')).toBeTruthy();
    fireEvent.click(screen.getByTestId('activity-refresh'));
    expect(onRefresh).toHaveBeenCalledWith({ scope: { kind: 'global' } });
  });

  it('stale sin filas no se confunde con un vacío limpio', () => {
    render(<ActivityTimeline items={[]} stale onRefresh={vi.fn()} />);
    expect(screen.getByTestId('activity-stale')).toBeTruthy();
    expect(screen.getByTestId('activity-empty')).toBeTruthy();
  });

  it('stale durante la reconexión conserva las filas y el aviso mientras carga', () => {
    render(
      <ActivityTimeline
        status="loading"
        items={[activityItem()]}
        stale
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByTestId('activity-timeline').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('activity-loading').textContent).toContain('Cargando actividad');
    expect(screen.getByTestId('activity-stale').textContent).toContain('Vista desactualizada');
    expect(screen.getByTestId('activity-refresh')).toBeTruthy();
    expect(screen.getByTestId('activity-list')).toBeTruthy();
    expect(screen.getByTestId('activity-evt-1')).toBeTruthy();
    expect(screen.getByTestId('activity-count').textContent).toBe('1');
  });

  it('loadingMore: deshabilita el cursor y mantiene la lista visible', () => {
    const onLoadMore = vi.fn();
    render(
      <ActivityTimeline
        items={[activityItem()]}
        cursor={{ next: 2, hasMore: true }}
        loadingMore
        onLoadMore={onLoadMore}
      />,
    );
    const more = screen.getByTestId('activity-load-more');
    expect(more.disabled).toBe(true);
    expect(more.textContent).toBe('Cargando…');
    expect(screen.getByTestId('activity-timeline').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('activity-evt-1')).toBeTruthy();
    fireEvent.click(more);
    expect(onLoadMore).not.toHaveBeenCalled();
  });
});

describe('ActivityTimeline · alcance y cursor', () => {
  it('acepta alcance global, Project y Task; el id durable queda visible', () => {
    const item = activityItem();
    const { rerender } = render(<ActivityTimeline items={[item]} scope={{ kind: 'global' }} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Actividad global');
    expect(screen.queryByTestId('activity-scope-id')).toBeNull();

    rerender(<ActivityTimeline items={[item]} scope={{ kind: 'project', id: 'p-1', name: 'lixbon' }} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Proyecto · lixbon');
    expect(screen.getByTestId('activity-scope-id').textContent).toBe('p-1');

    rerender(<ActivityTimeline items={[item]} scope={{ kind: 'task', id: 't-1', title: 'Arreglar login' }} />);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Tarea · Arreglar login');
    expect(screen.getByTestId('activity-scope-id').textContent).toBe('t-1');
  });

  it('load-more entrega el next_cursor y el alcance, no un offset', () => {
    const onLoadMore = vi.fn();
    render(
      <ActivityTimeline
        items={[activityItem()]}
        scope={{ kind: 'project', id: 'p-1', name: 'lixbon' }}
        cursor={{ next: 7, hasMore: true, headSeq: 9 }}
        onLoadMore={onLoadMore}
      />,
    );
    const more = screen.getByTestId('activity-load-more');
    expect(more.textContent).toBe('Cargar más actividad');
    more.focus();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    expect(onLoadMore).toHaveBeenCalledWith({
      cursor: 7,
      scope: { kind: 'project', id: 'p-1', name: 'lixbon' },
    });
  });

  it('hasMore=false muestra el fin y no ofrece un cursor inválido', () => {
    const { rerender } = render(
      <ActivityTimeline
        items={[activityItem()]}
        cursor={{ next: 1, hasMore: false }}
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('activity-load-more')).toBeNull();
    expect(screen.getByText('No hay más actividad.')).toBeTruthy();

    rerender(
      <ActivityTimeline
        items={[activityItem()]}
        cursor={{ next: -1, hasMore: true }}
        onLoadMore={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('activity-load-more')).toBeNull();
  });

  it.each([
    ['null', null],
    ['cero', 0],
    ['negativo', -2],
    ['decimal', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['texto', '7'],
    ['booleano', true],
  ])('has_more=true con next_cursor %s no habilita load-more', (_name, next) => {
    const onLoadMore = vi.fn();
    render(
      <ActivityTimeline
        items={[activityItem()]}
        cursor={{ next, hasMore: true }}
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.queryByTestId('activity-load-more')).toBeNull();
    expect(screen.queryByText('No hay más actividad.')).toBeNull();
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it('sin cursor o con has_more no booleano no ofrece load-more ni fin', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(
      <ActivityTimeline items={[activityItem()]} cursor={null} onLoadMore={onLoadMore} />,
    );
    expect(screen.queryByTestId('activity-load-more')).toBeNull();
    expect(screen.queryByText('No hay más actividad.')).toBeNull();

    rerender(
      <ActivityTimeline
        items={[activityItem()]}
        cursor={{ next: 7, hasMore: 'true' }}
        onLoadMore={onLoadMore}
      />,
    );
    expect(screen.queryByTestId('activity-load-more')).toBeNull();
    expect(screen.queryByText('No hay más actividad.')).toBeNull();
  });
});

describe('ActivityTimeline · clases y procedencia', () => {
  it('pinta state, decision, effect, project y spawn como filas separadas con destino durable', () => {
    const items = [
      activityItem({
        eventId: 'state',
        seq: 1,
        class: 'state',
        kind: 'task.created',
        target: { kind: 'task', id: 't-1' },
        actor: { kind: 'agent', id: 't-1' },
        client: { channel: 'core', clientId: null },
        message: { key: 'k.state', text: 'Tarea creada' },
      }),
      activityItem({
        eventId: 'decision',
        seq: 2,
        class: 'decision',
        kind: 'spawn.approved',
        target: { kind: 'spawn_request', id: 'sp-1' },
        actor: { kind: 'person', id: 'ana' },
        client: { channel: 'ui', clientId: 'c-9' },
        message: { key: 'k.decision', text: 'Lanzamiento aprobado' },
        severity: 'warning',
      }),
      activityItem({
        eventId: 'effect',
        seq: 3,
        class: 'effect',
        kind: 'run.created',
        target: { kind: 'run', id: 'r-1' },
        message: { key: 'k.effect', text: 'Run creado' },
      }),
      activityItem({
        eventId: 'project',
        seq: 4,
        class: 'state',
        kind: 'project.registered',
        target: { kind: 'project', id: 'p-1' },
        project: { id: 'p-1', name: 'lixbon' },
        message: { key: 'k.project', text: 'Proyecto registrado' },
      }),
      activityItem({
        eventId: 'spawn',
        seq: 5,
        class: 'state',
        kind: 'spawn.requested',
        target: { kind: 'spawn_request', id: 'sp-2' },
        message: { key: 'k.spawn', text: 'Lanzamiento pendiente' },
      }),
    ];
    render(<ActivityTimeline items={items} />);

    const state = screen.getByTestId('activity-state');
    expect(state.textContent).toContain('Estado');
    expect(state.textContent).toContain('Tarea t-1');
    expect(state.textContent).toContain('Proyecto p-1 · lixbon');
    expect(state.textContent).toContain('Agente · t-1');

    const decision = screen.getByTestId('activity-decision');
    expect(decision.textContent).toContain('Decisión');
    expect(decision.textContent).toContain('Lanzamiento sp-1');
    expect(decision.textContent).toContain('Persona · ana');
    expect(decision.textContent).toContain('UI · c-9');
    expect(decision.textContent).toContain('Aviso');

    const effect = screen.getByTestId('activity-effect');
    expect(effect.textContent).toContain('Efecto');
    expect(effect.textContent).toContain('Run r-1');
    expect(effect.textContent).toContain('Core');

    expect(screen.getByTestId('activity-project').textContent).toContain('Proyecto p-1');
    expect(screen.getByTestId('activity-spawn').textContent).toContain('Lanzamiento sp-2');
    expect(screen.getByTestId('activity-count').textContent).toBe('5');
  });

  it('expone eventId, seq y timestamp sin dejar que la hora ordene', () => {
    const { container } = render(<ActivityTimeline items={[activityItem({ timestamp: T0 })]} />);
    const row = screen.getByTestId('activity-evt-1');
    expect(row.getAttribute('data-event-id')).toBe('evt-1');
    expect(row.getAttribute('data-seq')).toBe('1');
    expect(row.textContent).toContain('#1');

    const time = container.querySelector('time');
    expect(time.getAttribute('datetime')).toBe(new Date(T0).toISOString());
    expect(time.getAttribute('title')).toContain('no ordena');
  });

  it('una decisión y su efecto con la misma correlación no se fusionan', () => {
    const decision = activityItem({
      eventId: 'd',
      seq: 1,
      class: 'decision',
      correlationId: 'corr-1',
      target: { kind: 'spawn_request', id: 'sp-1' },
      message: { key: 'k.d', text: 'Decisión: aprobar' },
    });
    const effect = activityItem({
      eventId: 'e',
      seq: 2,
      class: 'effect',
      correlationId: 'corr-1',
      target: { kind: 'run', id: 'r-1' },
      message: { key: 'k.e', text: 'Efecto: lanzar' },
    });
    render(<ActivityTimeline items={[decision, effect]} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    const d = screen.getByTestId('activity-d');
    const e = screen.getByTestId('activity-e');
    expect(d.textContent).toContain('Decisión: aprobar');
    expect(d.textContent).not.toContain('Efecto: lanzar');
    expect(e.textContent).toContain('Efecto: lanzar');
    expect(e.textContent).not.toContain('Decisión: aprobar');
    expect(d.textContent).toContain('correlación corr-1');
    expect(e.textContent).toContain('correlación corr-1');
  });
});

describe('ActivityTimeline · fallbacks sin inventar texto', () => {
  it('evento desconocido: fallback estable con kind y sin traducir el kind', () => {
    const translate = vi.fn(() => 'NO DEBE USARSE');
    render(
      <ActivityTimeline
        items={[
          activityItem({
            eventId: 'u',
            seq: 8,
            class: 'system',
            kind: 'worktree.rotated',
            known: false,
            message: { key: 'activity.future', text: 'Texto que no debe salir' },
            target: { kind: 'run', id: 'r-1' },
          }),
        ]}
        translateMessage={translate}
      />,
    );
    const row = screen.getByTestId('activity-u');
    expect(row.textContent).toContain('Evento desconocido');
    expect(row.textContent).toContain('worktree.rotated');
    expect(row.textContent).not.toContain('Texto que no debe salir');
    expect(row.textContent).not.toMatch(/rotad|rotación/i);
    expect(translate).not.toHaveBeenCalled();
  });

  it('evento conocido sin texto: no deriva una frase del kind y conserva la clave', () => {
    render(
      <ActivityTimeline
        items={[activityItem({ eventId: 'm', message: { key: 'activity.task.created' } })]}
      />,
    );
    const row = screen.getByTestId('activity-m');
    expect(row.textContent).toContain('Actividad sin descripción');
    expect(row.textContent).not.toMatch(/creada|creado/i);
    expect(screen.getByTestId('activity-message-m').getAttribute('data-message-key')).toBe(
      'activity.task.created',
    );
  });

  it('resuelve la clave con el catálogo inyectado y tolera un catálogo roto', () => {
    const translate = vi.fn((key, params) => `Traducido ${key} ${params.n}`);
    const { rerender } = render(
      <ActivityTimeline
        items={[
          activityItem({
            eventId: 'tr',
            message: { key: 'activity.task.created', params: { n: 3 } },
          }),
        ]}
        translateMessage={translate}
      />,
    );
    expect(screen.getByTestId('activity-tr').textContent).toContain('Traducido activity.task.created 3');
    expect(translate).toHaveBeenCalledWith('activity.task.created', { n: 3 });

    rerender(
      <ActivityTimeline
        items={[activityItem({ eventId: 'tr', message: { key: 'activity.task.created' } })]}
        translateMessage={() => {
          throw new Error('catálogo roto');
        }}
      />,
    );
    expect(screen.getByTestId('activity-tr').textContent).toContain('Actividad sin descripción');
  });
});

describe('ActivityTimeline · orden estable y reconexión', () => {
  it('respeta el orden entregado por Core; no ordena por timestamp ni por seq', () => {
    const items = [
      activityItem({ eventId: 's5', seq: 5, timestamp: 300, message: { key: 'k', text: 'Cinco' } }),
      activityItem({ eventId: 's2', seq: 2, timestamp: 100, message: { key: 'k', text: 'Dos' } }),
      activityItem({ eventId: 's9', seq: 9, timestamp: 200, message: { key: 'k', text: 'Nueve' } }),
    ];
    render(<ActivityTimeline items={items} />);
    expect(
      screen.getAllByRole('listitem').map((li) => li.getAttribute('data-event-id')),
    ).toEqual(['s5', 's2', 's9']);
  });

  it('un reemplazo por reconexión reutiliza la fila por eventId y deduplica repeticiones', () => {
    const a = activityItem({ eventId: 'a', seq: 1, message: { key: 'k', text: 'A' } });
    const b = activityItem({ eventId: 'b', seq: 2, message: { key: 'k', text: 'B' } });
    const { rerender } = render(<ActivityTimeline items={[a, b]} />);
    const rowA = screen.getByTestId('activity-a');
    const rowB = screen.getByTestId('activity-b');

    rerender(
      <ActivityTimeline
        items={[
          { ...a },
          { ...b },
          activityItem({ eventId: 'c', seq: 3, message: { key: 'k', text: 'C' } }),
          { ...a },
        ]}
      />,
    );

    expect(screen.getByTestId('activity-a')).toBe(rowA);
    expect(screen.getByTestId('activity-b')).toBe(rowB);
    expect(screen.getAllByTestId('activity-a')).toHaveLength(1);
    expect(
      screen.getAllByRole('listitem').map((li) => li.getAttribute('data-event-id')),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('ActivityTimeline · seguridad del límite de presentación', () => {
  it('no acepta un evento crudo del Event Log como fuente de presentación', () => {
    const raw = {
      id: '01a13e36-607e-71eb-8e8d-43d75c9836d3',
      seq: 1,
      ts: T0,
      v: 1,
      kind: 'task.created',
      class: 'state',
      actor: { kind: 'system', id: null },
      channel: 'core',
      client_id: null,
      project_id: null,
      run_id: 'r1',
      entity: { kind: 'task', id: 't2' },
      correlation_id: null,
      payload: { title: 'CRUDO' },
    };
    render(<ActivityTimeline items={[raw]} />);
    expect(screen.getByTestId('activity-empty')).toBeTruthy();
    expect(screen.queryByTestId('activity-list')).toBeNull();
    expect(screen.queryByText('CRUDO')).toBeNull();
  });

  it('ignora payload crudo, resúmenes de IA, unread/Attention y metadatos no permitidos', () => {
    const { container } = render(
      <ActivityTimeline
        items={[
          activityItem({
            eventId: 'safe',
            seq: 1,
            payload: { token: 'RAW_SECRET', body: 'CUERPO_CRUDO' },
            summary: 'RESUMEN_IA',
            aiSummary: 'RESUMEN_IA_2',
            unread: true,
            attention: { total: 3, category: 'failed' },
            metadata: [
              { label: 'agente', value: 'claude' },
              { label: 'modelo', value: 'gpt-6-sol' },
              { label: 'payload', value: 'NO_PAYLOAD' },
              { label: 'unread', value: 'NO_UNREAD' },
              { label: 'atención', value: 'NO_ATTENTION' },
              { label: 'anidado', value: { secreto: 'SECRETO_ANIDADO' } },
              { label: 'html', value: '<img src=x onerror="alert(1)">' },
              { label: 'largo', value: 'x'.repeat(400) },
              ...Array.from({ length: 6 }, (_, i) => ({ label: `extra_${i}`, value: `v${i}` })),
            ],
          }),
        ]}
      />,
    );

    const text = screen.getByTestId('activity-safe').textContent;
    expect(text).toContain('claude');
    expect(text).toContain('gpt-6-sol');
    expect(text).not.toContain('RAW_SECRET');
    expect(text).not.toContain('CUERPO_CRUDO');
    expect(text).not.toContain('RESUMEN_IA');
    expect(text).not.toContain('RESUMEN_IA_2');
    expect(text).not.toContain('NO_PAYLOAD');
    expect(text).not.toContain('NO_UNREAD');
    expect(text).not.toContain('NO_ATTENTION');
    expect(text).not.toContain('SECRETO_ANIDADO');
    expect(text.toLowerCase()).not.toContain('attention');
    expect(text).not.toMatch(/sin leer/i);
    expect(screen.queryByTestId('activity-unread')).toBeNull();

    // El HTML de un metadato descartado no se pinta como nodo ni como texto.
    expect(container.querySelector('img')).toBeNull();
    expect(text).not.toContain('<img src=x');

    // Solo quedan las dos etiquetas técnicas explícitamente seguras.
    expect(screen.getAllByTestId(/^activity-meta-/)).toHaveLength(2);
  });

  it('escapa el HTML de valores de metadatos seguros y del mensaje', () => {
    const { container } = render(
      <ActivityTimeline
        items={[
          activityItem({
            eventId: 'esc',
            metadata: [{ label: 'modelo', value: '<img src=x onerror="alert(1)">' }],
          }),
        ]}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('activity-esc').textContent).toContain('<img src=x');
  });

  it('limita a 8 metadatos seguros y recorta valores largos', () => {
    const metadata = [
      { label: 'agent', value: 'x'.repeat(400) },
      { label: 'model', value: 'm' },
      { label: 'status', value: 'ok' },
      { label: 'duration_ms', value: 10 },
      { label: 'retry_count', value: 2 },
      { label: 'version', value: '1.0' },
      { label: 'channel', value: 'core' },
      { label: 'project_id', value: 'p-1' },
      { label: 'task_id', value: 'CUT_TASK' },
      { label: 'run_id', value: 'CUT_RUN' },
    ];
    render(<ActivityTimeline items={[activityItem({ eventId: 'cap', metadata })]} />);
    expect(screen.getAllByTestId(/^activity-meta-/)).toHaveLength(8);

    const text = screen.getByTestId('activity-cap').textContent;
    // 120 caracteres contando el ellipsis de recorte.
    expect(text).not.toContain('x'.repeat(120));
    expect(text).toContain('x'.repeat(119));
    expect(text).not.toContain('CUT_TASK');
    expect(text).not.toContain('CUT_RUN');
  });

  it('bloquea familias sensibles en variantes exactas, camel, mayúsculas y anidadas', () => {
    const blocked = [
      ['access_key', 'SECRETO_ACCESS_KEY'],
      ['accessKey', 'SECRETO_ACCESS_CAMEL'],
      ['ACCESS_KEY_ID', 'SECRETO_ACCESS_ID'],
      ['secretkey', 'SECRETO_SECRETKEY'],
      ['secretKey', 'SECRETO_SECRET_CAMEL'],
      ['jwttoken', 'SECRETO_JWT'],
      ['jwtToken', 'SECRETO_JWT_CAMEL'],
      ['bearertoken', 'SECRETO_BEARER'],
      ['bearerToken', 'SECRETO_BEARER_CAMEL'],
      ['cookietoken', 'SECRETO_COOKIE'],
      ['cookieToken', 'SECRETO_COOKIE_CAMEL'],
      ['passwordhash', 'SECRETO_PASSWORD_HASH'],
      ['passwordHash', 'SECRETO_PASSWORD_CAMEL'],
      ['sinleer', 'NO_SINLEER'],
      ['SINLEER', 'NO_SINLEER_MAYUS'],
      ['sin_leer', 'NO_SIN_LEER'],
      ['SinLeer', 'NO_SIN_LEER_CAMEL'],
      ['unread', 'NO_UNREAD'],
      ['is_unread', 'NO_IS_UNREAD'],
      ['unread_count', 'NO_UNREAD_COUNT'],
      ['IsUnread', 'NO_IS_UNREAD_CAMEL'],
      ['attention', 'NO_ATTENTION'],
      ['atención', 'NO_ATENCION'],
      ['auth.session.secret', 'NO_AUTH_NESTED'],
      ['context.access_key', 'NO_CONTEXT_ACCESS'],
      ['context.accessKey', 'NO_CONTEXT_ACCESS_CAMEL'],
      ['context.sinleer', 'NO_CONTEXT_SINLEER'],
      ['meta.SINLEER', 'NO_META_SINLEER'],
      ['meta.passwordhash', 'NO_META_PASSWORD'],
    ];

    render(
      <ActivityTimeline
        items={[
          activityItem({
            eventId: 'familias',
            metadata: [
              ...blocked.map(([label, value]) => ({ label, value })),
              { label: 'agente', value: 'claude' },
              { label: 'modelo', value: 'gpt-6-sol' },
              { label: 'reintentos', value: 'tres' },
              { label: 'readiness', value: 'listo' },
              { label: 'thread', value: 'worker' },
            ],
          }),
        ]}
      />,
    );

    const row = screen.getByTestId('activity-familias');
    const text = row.textContent;
    for (const [label, value] of blocked) {
      expect(text).not.toContain(value);
      expect(text).not.toContain(label);
    }
    expect(text).toContain('claude');
    expect(text).toContain('gpt-6-sol');
    expect(text).toContain('tres');
    expect(text).toContain('listo');
    expect(text).toContain('worker');
    expect(screen.getAllByTestId(/^activity-meta-/)).toHaveLength(5);
  });

  it('descarta etiquetas desconocidas, valores anidados y metadata que no es una lista plana', () => {
    const { container } = render(
      <ActivityTimeline
        items={[
          activityItem({
            eventId: 'nested',
            metadata: [
              { label: 'unknown_field', value: 'SECRETO_UNKNOWN' },
              { label: 'custom', value: 'SECRETO_CUSTOM' },
              { label: 'html', value: 'SECRETO_HTML' },
              { label: 'body', value: 'SECRETO_BODY' },
              { label: 'context.agent', value: 'SECRETO_NESTED_SAFE_LEAF' },
              { label: 'agent', value: { access_key: 'SECRETO_NESTED_OBJ' } },
              { label: 'model', value: { accessKey: 'SECRETO_NESTED_CAMEL' } },
              { label: 'status', value: ['SECRETO_NESTED_ARRAY'] },
              { label: 'channel', value: { sinleer: 'NO_NESTED_SINLEER', SINLEER: 'NO_NESTED_SINLEER_MAYUS' } },
              { label: 'version', value: 3 },
              { label: 'run_id', value: null },
            ],
          }),
          activityItem({
            eventId: 'nonlist',
            metadata: { access_key: 'SECRETO_OBJECT_METADATA', agent: 'claude' },
          }),
        ]}
      />,
    );

    const nested = screen.getByTestId('activity-nested');
    expect(nested.textContent).not.toContain('SECRETO_');
    expect(nested.textContent).not.toContain('NO_NESTED_');
    expect(nested.textContent).not.toContain('[object Object]');
    expect(nested.textContent).toContain('3');
    expect(screen.getAllByTestId(/^activity-meta-/)).toHaveLength(1);
    expect(screen.getByTestId('activity-nonlist').textContent).not.toContain(
      'SECRETO_OBJECT_METADATA',
    );
    expect(container.textContent).not.toContain('SECRETO_');
    expect(container.textContent).not.toContain('NO_NESTED_');
  });

  it('no publica valores con forma de credencial o estado de lectura aunque la clave sea segura', () => {
    render(
      <ActivityTimeline
        items={[
          activityItem({
            eventId: 'values',
            metadata: [
              { label: 'agent', value: 'Bearer abcdefghijklmnop' },
              { label: 'model', value: 'sk-live-1234567890abcdef' },
              { label: 'status', value: 'SECRETO_EN_VALOR' },
              { label: 'version', value: 'token=abc123' },
              { label: 'channel', value: 'sinleer' },
              { label: 'run_id', value: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
              { label: 'status', value: 'READ_STATE' },
              { label: 'severity', value: 'SEEN_STATE' },
              { label: 'state', value: 'LEÍDO' },
              { label: 'project_id', value: 'proyecto-ok' },
              { label: 'task_id', value: true },
            ],
          }),
        ]}
      />,
    );
    const text = screen.getByTestId('activity-values').textContent;
    expect(text).not.toContain('Bearer');
    expect(text).not.toContain('sk-live');
    expect(text).not.toContain('SECRETO_EN_VALOR');
    expect(text).not.toContain('token=');
    expect(text).not.toContain('sinleer');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('READ_STATE');
    expect(text).not.toContain('SEEN_STATE');
    expect(text).not.toContain('LEÍDO');
    expect(text).toContain('proyecto-ok');
    expect(text).toContain('true');
    expect(screen.getAllByTestId(/^activity-meta-/)).toHaveLength(2);
  });

  it('conserva metadatos técnicos explícitamente seguros', () => {
    render(
      <ActivityTimeline
        items={[
          activityItem({
            eventId: 'safemeta',
            metadata: [
              { label: 'agent_id', value: 'a-1' },
              { label: 'model_name', value: 'gpt-6-sol' },
              { label: 'durationMs', value: 12 },
              { label: 'retry_count', value: 3 },
              { label: 'event_kind', value: 'task.created' },
              { label: 'project_id', value: 'p-1' },
              { label: 'run_id', value: 'r-1' },
              { label: 'status', value: 'ok' },
            ],
          }),
        ]}
      />,
    );
    const text = screen.getByTestId('activity-safemeta').textContent;
    for (const expected of [
      'agent_id',
      'a-1',
      'model_name',
      'gpt-6-sol',
      'durationMs',
      'retry_count',
      'event_kind',
      'project_id',
      'p-1',
      'run_id',
      'r-1',
      'status',
      'ok',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('un target de tipo attention es una referencia opaca, sin estado de lectura', () => {
    render(
      <ActivityTimeline
        items={[
          activityItem({
            eventId: 'at',
            target: { kind: 'attention', id: 'at-1' },
            unread: true,
            attention: { total: 1 },
          }),
        ]}
      />,
    );
    const row = screen.getByTestId('activity-at');
    expect(row.textContent).toContain('Destino at-1');
    expect(row.textContent).not.toContain('Atención');
    expect(row.textContent).not.toMatch(/sin leer|unread|attention/i);
  });

  it('escapa el texto humano provisto por Core', () => {
    const { container } = render(
      <ActivityTimeline
        items={[activityItem({ message: { key: 'k', text: '<b>hola</b>' } })]}
      />,
    );
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByTestId('activity-message-evt-1').textContent).toBe('<b>hola</b>');
  });
});

describe('ActivityTimeline · teclado y accesibilidad', () => {
  it('usa un aria-label plural correcto en el contador', () => {
    const { rerender } = render(<ActivityTimeline status="ready" items={[]} />);
    expect(screen.getByTestId('activity-count').getAttribute('aria-label')).toBe(
      '0 eventos cargados',
    );

    rerender(<ActivityTimeline items={[activityItem()]} />);
    expect(screen.getByTestId('activity-count').getAttribute('aria-label')).toBe(
      '1 evento cargado',
    );

    rerender(
      <ActivityTimeline
        items={[activityItem(), activityItem({ eventId: 'evt-2', seq: 2 })]}
      />,
    );
    expect(screen.getByTestId('activity-count').getAttribute('aria-label')).toBe(
      '2 eventos cargados',
    );
  });

  it('expone eventId y seq en la metadata accesible de la fila', () => {
    render(<ActivityTimeline items={[activityItem()]} />);
    const row = screen.getByTestId('activity-evt-1');
    expect(row.getAttribute('data-event-id')).toBe('evt-1');
    expect(row.getAttribute('data-seq')).toBe('1');
    expect(row.getAttribute('aria-label')).toContain('Evento evt-1');
    expect(row.getAttribute('aria-label')).toContain('secuencia 1');

    expect(row.getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByTestId('activity-row-meta-evt-1')).toBeNull();
    expect(screen.getByTestId('activity-seq-evt-1').getAttribute('aria-label')).toBe(
      'Secuencia 1',
    );
  });

  it('la sección está etiquetada, la lista conserva semántica y los controles son botones nativos', () => {
    const onLoadMore = vi.fn();
    const items = [
      activityItem({ eventId: 'a', seq: 1 }),
      activityItem({ eventId: 'b', seq: 2 }),
    ];
    render(
      <ActivityTimeline items={items} cursor={{ next: 2, hasMore: true }} onLoadMore={onLoadMore} />,
    );

    const section = screen.getByTestId('activity-timeline');
    expect(section.tagName).toBe('SECTION');
    const labelledBy = section.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy).textContent).toBe('Actividad global');
    expect(section.getAttribute('aria-busy')).toBe('false');

    expect(screen.getByRole('list').tagName).toBe('OL');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    const more = screen.getByTestId('activity-load-more');
    expect(more.tagName).toBe('BUTTON');
    expect(more.getAttribute('type')).toBe('button');
    expect(more.getAttribute('tabindex')).toBeNull();
    more.focus();
    expect(document.activeElement).toBe(more);
    fireEvent.click(more);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('el reintento de error es enfocable y tiene nombre accesible', () => {
    const onRetry = vi.fn();
    render(
      <ActivityTimeline
        status="error"
        error={{ code: 'internal', message: 'Fallo.' }}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Reintentar' });
    retry.focus();
    expect(document.activeElement).toBe(retry);
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('loading anuncia con role=status y aria-busy; stale usa role=status', () => {
    const { rerender } = render(<ActivityTimeline status="loading" />);
    expect(screen.getByRole('status').textContent).toContain('Cargando actividad');
    expect(screen.getByTestId('activity-timeline').getAttribute('aria-busy')).toBe('true');

    rerender(<ActivityTimeline items={[activityItem()]} stale />);
    expect(screen.getByTestId('activity-stale').getAttribute('role')).toBe('status');
  });
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

describe('ActivityTimeline · navegación por destino (solo fixtures, sin Core)', () => {
  it('entrega kind e id exactos del destino durable al activar el botón', () => {
    const onOpenTarget = vi.fn();
    render(
      <ActivityTimeline
        items={[
          activityItem({ eventId: 'a', seq: 1, target: { kind: 'task', id: 't-Ab_9' } }),
          activityItem({ eventId: 'b', seq: 2, target: { kind: 'project', id: 'p-77' } }),
        ]}
        onOpenTarget={onOpenTarget}
      />,
    );

    fireEvent.click(screen.getByTestId('activity-target-a'));
    expect(onOpenTarget).toHaveBeenLastCalledWith({ kind: 'task', id: 't-Ab_9' });
    fireEvent.click(screen.getByTestId('activity-target-b'));
    expect(onOpenTarget).toHaveBeenLastCalledWith({ kind: 'project', id: 'p-77' });
    expect(onOpenTarget).toHaveBeenCalledTimes(2);
    // Solo kind e id: nada de scope, cursor, eventId ni texto derivado.
    expect(Object.keys(onOpenTarget.mock.calls[0][0]).sort()).toEqual(['id', 'kind']);
  });

  it('es un botón nativo, enfocable por teclado y con nombre accesible', () => {
    const onOpenTarget = vi.fn();
    render(<ActivityTimeline items={[activityItem()]} onOpenTarget={onOpenTarget} />);

    const button = screen.getByRole('button', { name: 'Abrir Tarea t-1' });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('tabindex')).toBeNull();
    expect(button.getAttribute('disabled')).toBeNull();
    // El texto visible del destino se conserva.
    expect(button.textContent).toContain('Tarea');
    expect(button.textContent).toContain('t-1');

    button.focus();
    expect(document.activeElement).toBe(button);
    // Enter/Espacio sobre un <button> nativo disparan click; jsdom no los sintetiza, por eso se
    // verifica la semántica nativa y se emite el click que el navegador generaría.
    fireEvent.click(button);
    expect(onOpenTarget).toHaveBeenCalledTimes(1);
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'task', id: 't-1' });
  });

  it('sin callback el destino es solo informativo (sin botón ni rol interactivo)', () => {
    render(<ActivityTimeline items={[activityItem()]} />);
    const target = screen.getByTestId('activity-target-evt-1');
    expect(target.tagName).toBe('SPAN');
    expect(target.textContent).toContain('Tarea');
    expect(target.textContent).toContain('t-1');
    expect(screen.queryByRole('button', { name: /Abrir/ })).toBeNull();
    expect(target.getAttribute('tabindex')).toBeNull();
  });

  it('un callback que no es función se trata como ausente', () => {
    render(<ActivityTimeline items={[activityItem()]} onOpenTarget="no-soy-funcion" />);
    expect(screen.getByTestId('activity-target-evt-1').tagName).toBe('SPAN');
    expect(screen.queryByRole('button', { name: /Abrir/ })).toBeNull();
  });

  it('destinos ausentes o mal formados no ofrecen navegación', () => {
    const onOpenTarget = vi.fn();
    const items = [
      activityItem({ eventId: 'none', seq: 1, target: undefined }),
      activityItem({ eventId: 'null', seq: 2, target: null }),
      activityItem({ eventId: 'str', seq: 3, target: 'task:t-1' }),
      activityItem({ eventId: 'noid', seq: 4, target: { kind: 'task' } }),
      activityItem({ eventId: 'blank', seq: 5, target: { kind: 'task', id: '   ' } }),
      activityItem({ eventId: 'empty', seq: 6, target: { kind: 'task', id: '' } }),
      activityItem({ eventId: 'num', seq: 7, target: { kind: 'task', id: 42 } }),
      activityItem({ eventId: 'obj', seq: 8, target: { kind: 'task', id: { x: 1 } } }),
      activityItem({ eventId: 'pad', seq: 9, target: { kind: 'task', id: ' t-1 ' } }),
      activityItem({ eventId: 'ctrl', seq: 10, target: { kind: 'task', id: 't-1\n' } }),
      activityItem({ eventId: 'long', seq: 11, target: { kind: 'task', id: 'x'.repeat(201) } }),
      activityItem({ eventId: 'kpad', seq: 12, target: { kind: ' task', id: 't-1' } }),
      activityItem({ eventId: 'kupper', seq: 13, target: { kind: 'Task', id: 't-1' } }),
      activityItem({ eventId: 'nokind', seq: 14, target: { id: 't-1' } }),
      activityItem({ eventId: 'knum', seq: 15, target: { kind: 7, id: 't-1' } }),
    ];
    render(<ActivityTimeline items={items} onOpenTarget={onOpenTarget} />);

    expect(screen.getByTestId('activity-list')).toBeTruthy();
    expect(screen.queryAllByRole('button', { name: /Abrir/ })).toHaveLength(0);
    for (const item of items) {
      const el = screen.queryByTestId(`activity-target-${item.eventId}`);
      if (el) expect(el.tagName).toBe('SPAN');
    }
    expect(onOpenTarget).not.toHaveBeenCalled();
  });

  it('kinds desconocidos o fuera de alcance quedan como texto informativo', () => {
    const onOpenTarget = vi.fn();
    const kinds = ['run', 'spawn_request', 'agent', 'core', 'attention', 'attempt', 'zzz'];
    const items = kinds.map((kind, i) =>
      activityItem({ eventId: `k-${kind}`, seq: i + 1, target: { kind, id: `${kind}-1` } }),
    );
    render(<ActivityTimeline items={items} onOpenTarget={onOpenTarget} />);

    expect(screen.queryAllByRole('button', { name: /Abrir/ })).toHaveLength(0);
    for (const kind of kinds) {
      expect(screen.getByTestId(`activity-target-k-${kind}`).tagName).toBe('SPAN');
    }
    // Un kind desconocido conserva su rótulo genérico y no se traduce.
    expect(screen.getByTestId('activity-target-k-zzz').textContent).toContain('Destino zzz-1');
    expect(onOpenTarget).not.toHaveBeenCalled();
  });

  it('un evento con known=false sigue mostrando su fallback; el destino válido es navegable', () => {
    const onOpenTarget = vi.fn();
    render(
      <ActivityTimeline
        items={[
          activityItem({
            eventId: 'unk',
            known: false,
            kind: 'algo.nuevo',
            message: null,
            target: { kind: 'project', id: 'p-1' },
          }),
        ]}
        onOpenTarget={onOpenTarget}
      />,
    );
    expect(screen.getByTestId('activity-message-unk').textContent).toBe('Evento desconocido');
    fireEvent.click(screen.getByTestId('activity-target-unk'));
    expect(onOpenTarget).toHaveBeenCalledWith({ kind: 'project', id: 'p-1' });
  });

  it('no muta items, scope ni cursor, ni dispara refresh/retry/load-more al navegar', () => {
    const items = deepFreeze([activityItem()]);
    const scope = deepFreeze({ kind: 'project', id: 'p-1', name: 'lixbon' });
    const cursor = deepFreeze({ next: 1, hasMore: true });
    const snapshot = JSON.stringify({ items, scope, cursor });
    const onOpenTarget = vi.fn((target) => {
      // El host puede alterar lo que recibe sin tocar el estado de la vista.
      target.id = 'mutado';
    });
    const onLoadMore = vi.fn();
    const onRefresh = vi.fn();
    const onRetry = vi.fn();
    render(
      <ActivityTimeline
        items={items}
        scope={scope}
        cursor={cursor}
        stale
        onOpenTarget={onOpenTarget}
        onLoadMore={onLoadMore}
        onRefresh={onRefresh}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByTestId('activity-target-evt-1'));
    fireEvent.click(screen.getByTestId('activity-target-evt-1'));

    expect(onOpenTarget).toHaveBeenCalledTimes(2);
    expect(onOpenTarget.mock.calls[1][0]).toEqual({ kind: 'task', id: 'mutado' });
    expect(onOpenTarget.mock.calls[0][0]).not.toBe(onOpenTarget.mock.calls[1][0]);
    expect(JSON.stringify({ items, scope, cursor })).toBe(snapshot);
    expect(items[0].target).toEqual({ kind: 'task', id: 't-1' });
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    // La fila y el destino siguen igual tras activar.
    expect(screen.getByTestId('activity-target-evt-1').textContent).toContain('t-1');
    expect(screen.getByTestId('activity-count').textContent).toBe('1');
  });

  it('conserva los callbacks de alcance y cursor con navegación activa', () => {
    const onOpenTarget = vi.fn();
    const onLoadMore = vi.fn();
    const onRefresh = vi.fn();
    render(
      <ActivityTimeline
        scope={{ kind: 'task', id: 't-1', title: 'Hacer' }}
        items={[activityItem()]}
        cursor={{ next: 1, hasMore: true }}
        stale
        onOpenTarget={onOpenTarget}
        onLoadMore={onLoadMore}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByTestId('activity-load-more'));
    expect(onLoadMore).toHaveBeenCalledWith({
      cursor: 1,
      scope: { kind: 'task', id: 't-1', title: 'Hacer' },
    });
    fireEvent.click(screen.getByTestId('activity-refresh'));
    expect(onRefresh).toHaveBeenCalledWith({
      scope: { kind: 'task', id: 't-1', title: 'Hacer' },
    });
    expect(onOpenTarget).not.toHaveBeenCalled();
  });
});
