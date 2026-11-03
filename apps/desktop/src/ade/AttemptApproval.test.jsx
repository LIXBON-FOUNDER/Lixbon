import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// LXO-141 · La decisión de la persona sobre la aprobación inicial, en el detalle del Attempt.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); });

/** El detalle sirve `status` hasta que se decide; después, el que el Core diga que quedó. */
function mount({ status = 'pending_approval', afterDecision = 'running', decide = () => ({ status: 'Approved', decision: null, attempt_id: 't3-a1' }) } = {}) {
  const state = { status, calls: [] };
  invoke.mockImplementation(async (command, payload) => {
    state.calls.push({ command, payload });
    if (command === 'orch_call') {
      const result = decide(payload);
      state.status = afterDecision;
      return result;
    }
    if (payload.query === 'provider_capabilities') return live();
    if (payload.query === 'activity_list') return attemptActivityPage([]);
    return attemptDetail({ id: 't3-a1', task_id: 't3', status: state.status });
  });
  return state;
}
const decisions = (state) => state.calls.filter((c) => c.command === 'orch_call');

describe('AttemptApproval (LXO-141)', () => {
  it('solo aparece mientras el Attempt espera la aprobación', async () => {
    mount({ status: 'running' });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    expect(screen.queryByTestId('attempt-approval')).toBeNull();
  });

  it('aprobar llama al Core con el id del Attempt y vuelve a leer el detalle', async () => {
    const state = mount();
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    expect(screen.getByTestId('attempt-approval')).toBeTruthy();
    const readsBefore = state.calls.filter((c) => c.payload?.query === 'attempt_detail').length;
    fireEvent.click(screen.getByTestId('attempt-approve'));
    await flush();

    expect(decisions(state)).toEqual([{ command: 'orch_call', payload: { cmd: 'attempt_approve', args: { attempt_id: 't3-a1' } } }]);
    expect(state.calls.filter((c) => c.payload?.query === 'attempt_detail').length).toBeGreaterThan(readsBefore);
    // Ya no está pendiente: la decisión desaparece con el estado nuevo.
    expect(screen.queryByTestId('attempt-approval')).toBeNull();
  });

  it('rechazar llama a attempt_reject', async () => {
    const state = mount({ afterDecision: 'stopped', decide: () => ({ status: 'Rejected', decision: null, attempt_id: 't3-a1' }) });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-reject'));
    await flush();
    expect(decisions(state)[0].payload).toEqual({ cmd: 'attempt_reject', args: { attempt_id: 't3-a1' } });
  });

  it('si la aprobación venció lo dice y el intento queda detenido', async () => {
    mount({ afterDecision: 'pending_approval', decide: () => ({ status: 'Expired', decision: null, attempt_id: 't3-a1' }) });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-approve'));
    await flush();
    expect(screen.getByTestId('attempt-approval-outcome').textContent).toMatch(/venció/);
    expect(screen.queryByTestId('attempt-approve')).toBeNull();
  });

  it('un error del Core se muestra y deja volver a decidir', async () => {
    mount({ decide: () => { throw new Error('el Attempt ya fue rechazado'); } });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-approve'));
    await flush();
    expect(screen.getByTestId('attempt-approval-error').textContent).toMatch(/ya fue rechazado/);
    expect(screen.getByTestId('attempt-approve').disabled).toBe(false);
  });
});
