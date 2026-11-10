import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ATTEMPT_ACTIVITY_LIMIT, AttemptActivity } from './AttemptActivity';
import { coreModelFromState } from './useCoreModel';
import { COPY } from './adeLabels';
import { CANONICAL, ERRORS, VARIANTS } from './testFixtures/coreModelFixtures';
import { attemptActivityPage, attemptEvent } from './testFixtures/attemptActivityFixtures';

// LXO-121 · Actividad parcial por Attempt (activity_list con target_kind=attempt).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const LEGACY = coreModelFromState({ data: VARIANTS.coreModelLegacy, error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
function mount(handler) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => { calls.push(payload); return handler(payload); });
  return calls;
}
afterEach(() => { cleanup(); invoke.mockReset(); });

describe('AttemptActivity (LXO-121)', () => {
  it('pide activity_list filtrado por el Attempt y muestra los eventos marcados como parciales', async () => {
    const page = attemptActivityPage([
      attemptEvent(3, 't3-a2', 'attempt.failed', { task: 't3', n: 2, reason: 'agent_idle_timeout', has_summary: false }, 'error'),
      attemptEvent(2, 't3-a2', 'attempt.started', { task: 't3', n: 2 }),
      attemptEvent(1, 't3-a2', 'attempt.requested', { task: 't3', n: 2, provider: 'claude', model: 'claude-opus-5-5', external: false, approval_required: true }),
    ]);
    const calls = mount(() => page);
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    expect(calls).toEqual([{ query: 'activity_list', args: { cursor: '0', limit: ATTEMPT_ACTIVITY_LIMIT, order: 'desc', target_kind: 'attempt', target_id: 't3-a2' } }]);
    const root = screen.getByTestId('attempt-activity');
    expect(within(root).getByText('Actividad parcial: no incluye eventos de sesión ni worktree')).toBeTruthy();
    const rows = within(root).getAllByRole('listitem');
    expect(rows.map((row) => row.getAttribute('data-event-id'))).toEqual(['ev-3', 'ev-2', 'ev-1']);
    expect(rows[0].textContent).toContain('Falló');
    expect(rows[1].textContent).toContain('Iniciado');
    expect(rows[2].textContent).toContain('Solicitado');
    expect(rows[0].querySelector('time').getAttribute('dateTime')).toBe(new Date(1792000003000).toISOString());
  });

  it('sin eventos: neutro; legacy: no consulta nada', async () => {
    mount(() => attemptActivityPage([]));
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    expect(screen.getByText('Sin eventos del intento todavía').className).toContain('--neutral');
    cleanup();
    const calls = mount(() => attemptActivityPage([]));
    const { container } = render(<AttemptActivity attemptId="t3-a2" coreModel={LEGACY} />);
    await flush();
    expect(calls).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('errores por código: core_model_inactive informa sin reintento; Core caído ofrece reintento', async () => {
    mount(() => { throw new Error('core_model_inactive: el Core sigue en legacy'); });
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    expect(screen.getByText('El modelo de Attempts aún no está activo en este Core')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull();
    cleanup();
    mount(() => { throw new Error(ERRORS.unavailable); });
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    expect(screen.getByText('El Core no responde')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
  });

  it('carga: el texto viene de COPY', () => {
    mount(() => new Promise(() => {}));
    render(<AttemptActivity attemptId="loading-a1" coreModel={V1} />);
    expect(screen.getByRole('status').textContent).toBe('Cargando actividad del intento.');
  });

  it('has_more con next_cursor: avisa con el número de ATTEMPT_ACTIVITY_LIMIT; sin más páginas no avisa', async () => {
    const events = Array.from({ length: ATTEMPT_ACTIVITY_LIMIT }, (_, k) => attemptEvent(ATTEMPT_ACTIVITY_LIMIT + 1 - k, 't3-a2', 'attempt.started', { task: 't3', n: 2 }));
    mount(() => ({ ...attemptActivityPage(events), has_more: true }));
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    expect(screen.getByTestId('attempt-activity-truncated').textContent).toBe(`Mostrando los ${ATTEMPT_ACTIVITY_LIMIT} eventos más recientes`);
    cleanup();
    mount(() => attemptActivityPage(events));
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    expect(screen.queryByTestId('attempt-activity-truncated')).toBeNull();
  });

  it('el texto del corte sale del límite recibido', () => {
    expect(COPY.attemptActivityTruncated(20)).toBe('Mostrando los 20 eventos más recientes');
    expect(COPY.attemptActivityTruncated(ATTEMPT_ACTIVITY_LIMIT)).toBe(`Mostrando los ${ATTEMPT_ACTIVITY_LIMIT} eventos más recientes`);
  });

  it('un message_key que no es attempt.* se muestra como «Evento desconocido» con la clave en «Detalle técnico»', async () => {
    mount(() => attemptActivityPage([attemptEvent(1, 't3-a2', 'attempt.started', { task: 't3', n: 2 })].map((e) => ({ ...e, message_key: 'activity.unknown', fallback: true, args: { reason: 'unknown_kind', kind: 'attempt.future', event_version: 2 } }))));
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    const row = screen.getByRole('listitem');
    expect(row.textContent).toContain('Evento desconocido');
    expect(row.textContent).not.toContain('Evento no reconocido');
    const detail = row.querySelector('details');
    expect(detail.querySelector('summary').textContent).toBe('Detalle técnico');
    expect(detail.querySelector('code').textContent).toBe('activity.unknown');
  });

  it('un evento attempt.* conocido no muestra «Detalle técnico»', async () => {
    mount(() => attemptActivityPage([attemptEvent(1, 't3-a2', 'attempt.started', { task: 't3', n: 2 })]));
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    expect(screen.getByRole('listitem').querySelector('details')).toBeNull();
  });
});

describe('AttemptActivity · A7 · tramos de ejecución', () => {
  const events = [
    attemptEvent(6, 't3-a2', 'attempt.completed', { task: 't3', n: 2, has_summary: true }, 'success', 1792000000000 + 190_000),
    attemptEvent(5, 't3-a2', 'attempt.resumed', { task: 't3', n: 2, from: 'waiting' }, 'info', 1792000000000 + 100_000),
    attemptEvent(4, 't3-a2', 'attempt.waiting', { task: 't3', n: 2, from: 'running' }, 'info', 1792000000000 + 40_000),
    attemptEvent(3, 't3-a2', 'attempt.started', { task: 't3', n: 2 }, 'info', 1792000000000 + 10_000),
    attemptEvent(2, 't3-a2', 'attempt.approved', { task: 't3', n: 2 }, 'success', 1792000000000 + 5_000),
    attemptEvent(1, 't3-a2', 'attempt.requested', { task: 't3', n: 2, provider: 'claude', model: 'haiku', external: false, approval_required: true }, 'info', 1792000000000 + 1_000),
  ];

  it('agrupa por tramos con su duración, el más nuevo primero, y dice qué no registra el Core', async () => {
    mount(() => attemptActivityPage(events));
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    const groups = screen.getAllByTestId('attempt-activity-group');
    expect(groups.map((g) => g.getAttribute('data-group-kind'))).toEqual(['run', 'run', 'before']);
    expect(groups[0].querySelector('h5').textContent).toContain('Ejecución 2');
    expect(groups[0].querySelector('h5').textContent).toContain('1 min 30 s · Completado');
    expect(groups[1].querySelector('h5').textContent).toContain('Ejecución 1');
    expect(groups[1].querySelector('h5').textContent).toContain('30 s · Esperando una respuesta');
    expect(groups[2].querySelector('h5').textContent).toBe('Solicitud y aprobación');
    // Los eventos siguen siendo las únicas filas y conservan el orden del más nuevo al más viejo.
    expect(within(screen.getByTestId('attempt-activity')).getAllByRole('listitem').map((r) => r.getAttribute('data-event-id'))).toEqual(['ev-6', 'ev-5', 'ev-4', 'ev-3', 'ev-2', 'ev-1']);
    expect(screen.getByTestId('attempt-activity-grouping').textContent).toMatch(/no registra los mensajes ni las herramientas/);
  });

  it('esperar, reanudar y el resto del ciclo de vida tienen texto propio, no «Evento desconocido»', async () => {
    mount(() => attemptActivityPage(events));
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    const text = screen.getByTestId('attempt-activity').textContent;
    expect(text).toContain('Esperando una respuesta');
    expect(text).toContain('Siguió en ejecución');
    expect(text).not.toContain(COPY.unknownEvent);
  });

  it('un tramo que sigue en marcha se dice «en curso»', async () => {
    mount(() => attemptActivityPage(events.slice(3)));
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    expect(screen.getAllByTestId('attempt-activity-group')[0].querySelector('h5').textContent).toContain('en curso');
  });
});
