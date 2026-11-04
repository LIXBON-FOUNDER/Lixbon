import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// Reintentar un intento que terminó mal (RPC `attempt_retry`).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

/** `attempts_by_task` con la forma que el transporte valida (la del fixture canónico): un `attempt_brief` por número. */
const briefs = (...ns) => ({
  ...CANONICAL['attempts_by_task.v1.json'],
  task_id: 't3',
  items: ns.map((n) => ({ ...CANONICAL['attempts_by_task.v1.json'].items[0], id: `t3-a${n}`, n, status: 'failed', worktree: null })),
});

/** Un Core de pruebas: `attempt_detail` sirve el intento, `attempts_by_task` el historial y `orch_call` responde `decide`. */
function mountCore({ status = 'failed', history = briefs(1), decide = () => ({ status: 'Requested', task_id: 't3', attempt_id: 't3-a2' }), historyError = null } = {}) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_call') return decide(payload);
    if (payload.query === 'provider_capabilities') return live();
    if (payload.query === 'activity_list') return attemptActivityPage([]);
    if (payload.query === 'attempts_by_task') {
      if (historyError) throw new Error(historyError);
      return history;
    }
    return attemptDetail({ id: 't3-a1', task_id: 't3', n: 1, status });
  });
  return calls;
}
const mount = () => render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
const sent = (calls) => calls.filter((c) => c.command === 'orch_call').map((c) => c.payload);

describe('Reintentar un intento', () => {
  it('se ofrece solo cuando terminó mal: failed, stopped y exited', async () => {
    for (const status of ['failed', 'stopped', 'exited']) {
      mountCore({ status });
      const { unmount } = mount();
      await flush();
      expect(screen.getByTestId('attempt-retry-open'), status).toBeTruthy();
      unmount();
    }
    for (const status of ['pending_approval', 'starting', 'running', 'waiting', 'awaiting_terminal_approval', 'done']) {
      mountCore({ status });
      const { unmount } = mount();
      await flush();
      expect(screen.queryByTestId('attempt-retry'), status).toBeNull();
      unmount();
    }
  });

  it('no se ofrece sobre un intento que ya no es el último de la Task', async () => {
    mountCore({ history: briefs(1, 2) });
    mount();
    await flush();
    expect(screen.queryByTestId('attempt-retry')).toBeNull();
  });

  it('si no se pudo leer el historial se sigue ofreciendo: el Core vuelve a comprobar que es el último', async () => {
    mountCore({ historyError: 'model_unavailable' });
    mount();
    await flush();
    expect(screen.getByTestId('attempt-retry-open')).toBeTruthy();
  });

  it('pide confirmación, avisa de que el worktree es el mismo y no manda nada hasta confirmar', async () => {
    const calls = mountCore();
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('attempt-retry-open'));
    expect(screen.getByTestId('attempt-retry').textContent).toMatch(/mismo worktree: lo que dejó a medias este intento sigue ahí/);
    expect(sent(calls)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByTestId('attempt-retry-open')).toBeTruthy();
    expect(sent(calls)).toEqual([]);
  });

  it('confirmar manda attempt_retry con la Task y el intento exactos, dice cuál es el nuevo y vuelve a leer el detalle', async () => {
    const calls = mountCore();
    mount();
    await flush();
    const before = calls.filter((c) => c.payload?.query === 'attempt_detail').length;
    fireEvent.click(screen.getByTestId('attempt-retry-open'));
    fireEvent.click(screen.getByTestId('attempt-retry-confirm'));
    await flush();
    expect(sent(calls)).toEqual([{ cmd: 'attempt_retry', args: { task_id: 't3', from_attempt_id: 't3-a1' } }]);
    const outcome = screen.getByTestId('attempt-retry-outcome').textContent;
    expect(outcome).toMatch(/Reintento pedido/);
    expect(outcome).toContain('t3-a2');
    expect(calls.filter((c) => c.payload?.query === 'attempt_detail').length).toBeGreaterThan(before);
    expect(screen.queryByTestId('attempt-retry-open')).toBeNull();
  });

  it('un reintento que ya estaba pedido se dice como tal', async () => {
    mountCore({ decide: () => ({ status: 'Replayed', task_id: 't3', attempt_id: 't3-a2' }) });
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('attempt-retry-open'));
    fireEvent.click(screen.getByTestId('attempt-retry-confirm'));
    await flush();
    expect(screen.getByTestId('attempt-retry-outcome').textContent).toMatch(/ya estaba pedido/);
  });

  it('un rechazo del Core se dice en llano y deja reintentar', async () => {
    mountCore({ decide: () => { throw new Error('solo se reintenta el último Attempt de la Task: el actual es t3-a2'); } });
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('attempt-retry-open'));
    fireEvent.click(screen.getByTestId('attempt-retry-confirm'));
    await flush();
    expect(screen.getByTestId('attempt-retry-error').textContent).toContain('Hay un intento más reciente: reintenta ese.');
    expect(screen.getByTestId('attempt-retry-confirm').disabled).toBe(false);
    expect(screen.queryByTestId('attempt-retry-outcome')).toBeNull();
  });

  it('con el Orquestador desactivado lo dice en llano', async () => {
    mountCore({ decide: () => { throw new Error('reintentar un Attempt requiere el lifecycle de lanzamiento verificado'); } });
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('attempt-retry-open'));
    fireEvent.click(screen.getByTestId('attempt-retry-confirm'));
    await flush();
    expect(screen.getByTestId('attempt-retry-error').textContent).toContain('El Orquestador está desactivado');
  });
});
