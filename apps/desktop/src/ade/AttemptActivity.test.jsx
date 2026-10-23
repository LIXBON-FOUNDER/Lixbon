import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ATTEMPT_ACTIVITY_LIMIT, AttemptActivity } from './AttemptActivity';
import { coreModelFromState } from './useCoreModel';
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
    expect(screen.getByText('El Core no responde; reintentando')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeTruthy();
  });

  it('un message_key que no es attempt.* se muestra como evento no reconocido, sin inventar texto', async () => {
    mount(() => attemptActivityPage([attemptEvent(1, 't3-a2', 'attempt.started', { task: 't3', n: 2 })].map((e) => ({ ...e, message_key: 'activity.unknown', fallback: true, args: { reason: 'unknown_kind', kind: 'attempt.future', event_version: 2 } }))));
    render(<AttemptActivity attemptId="t3-a2" coreModel={V1} />);
    await flush();
    expect(screen.getByRole('listitem').textContent).toContain('Evento no reconocido');
  });
});
