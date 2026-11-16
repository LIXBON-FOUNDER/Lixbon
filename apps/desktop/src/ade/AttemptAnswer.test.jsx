import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptAnswer, MAX_ANSWER_CHARS } from './AttemptAnswer';
import { AttemptDetail } from './AttemptDetail';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// LXO-247 · Responder desde Desktop a un permiso o una pregunta del proveedor.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

const PERMISSION = { request_id: 'p1', kind: 'permission', subject: 'Bash', summary: 'rm -rf build', asked_at: 1 };
const QUESTION = { request_id: 'q1', kind: 'question', subject: '¿Sigo con la migración?', summary: '', asked_at: 2 };

/**
 * Un Core de pruebas: `attempt_pending_requests` sirve `state.requests`; `attempt_answer` lo resuelve `answer`. Si `answer` lanza, la
 * petición SIGUE pendiente (como en el Core real); si responde, sale de las pendientes.
 */
function mountCore({ requests = [PERMISSION], liveRun = true, answer } = {}) {
  const state = { requests: [...requests], calls: [] };
  invoke.mockImplementation(async (command, payload) => {
    state.calls.push({ command, payload });
    if (command === 'orch_call') {
      if (payload.cmd === 'attempt_pending_requests') return { attempt_id: 't3-a1', live: liveRun, requests: state.requests };
      if (payload.cmd === 'attempt_answer') {
        const result = answer ? answer(payload.args) : { status: 'Answered', attempt_id: 't3-a1', request_id: payload.args.request_id, kind: 'permission' };
        state.requests = state.requests.filter((r) => r.request_id !== payload.args.request_id);
        return result;
      }
    }
    if (payload?.query === 'provider_capabilities') return live();
    if (payload?.query === 'activity_list') return attemptActivityPage([]);
    return attemptDetail({ id: 't3-a1', task_id: 't3', status: 'awaiting_terminal_approval' });
  });
  return state;
}
const answers = (state) => state.calls.filter((c) => c.payload?.cmd === 'attempt_answer').map((c) => c.payload.args);

describe('AttemptAnswer (LXO-247)', () => {
  it('muestra el permiso con lo que pide y responde allow con el id de la petición', async () => {
    const state = mountCore();
    render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    const request = screen.getByTestId('attempt-answer-request');
    expect(request.dataset.kind).toBe('permission');
    expect(within(request).getByText('Bash')).toBeTruthy();
    expect(within(request).getByText(/rm -rf build/)).toBeTruthy();

    fireEvent.click(screen.getByTestId('attempt-answer-allow'));
    await flush();
    // Permitir lleva la confirmación explícita que pide la policy (`provider_permissions`).
    expect(answers(state)).toEqual([{ attempt_id: 't3-a1', request_id: 'p1', answer: 'allow', confirm: true }]);
    expect(screen.getByTestId('attempt-answer-outcome').textContent).toMatch(/enviada/i);
    // Ya no está pendiente: la lista se relee y desaparece.
    expect(screen.queryByTestId('attempt-answer-request')).toBeNull();
  });

  it('denegar envía deny', async () => {
    const state = mountCore();
    render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-answer-deny'));
    await flush();
    expect(answers(state)).toEqual([{ attempt_id: 't3-a1', request_id: 'p1', answer: 'deny' }]);
    expect(answers(state)[0]).not.toHaveProperty('confirm');
  });

  it('una pregunta se responde con texto libre: sin texto no se envía, y se acota a 4 000 caracteres', async () => {
    const state = mountCore({ requests: [QUESTION] });
    render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    expect(screen.getByText('¿Sigo con la migración?')).toBeTruthy();
    const send = screen.getByTestId('attempt-answer-send');
    expect(send.disabled).toBe(true);
    const box = screen.getByTestId('attempt-answer-text');
    expect(box.maxLength).toBe(MAX_ANSWER_CHARS);
    fireEvent.change(box, { target: { value: '   ' } });
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: 'sí, sin borrar nada' } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await flush();
    expect(answers(state)).toEqual([{ attempt_id: 't3-a1', request_id: 'q1', answer: 'sí, sin borrar nada' }]);
  });

  it('con varias peticiones cada una se responde por separado', async () => {
    const state = mountCore({ requests: [PERMISSION, QUESTION] });
    render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    expect(screen.getAllByTestId('attempt-answer-request')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('attempt-answer-allow'));
    await flush();
    expect(answers(state).map((a) => a.request_id)).toEqual(['p1']);
    expect(screen.getAllByTestId('attempt-answer-request')).toHaveLength(1);
  });

  it('si el proveedor rechaza la respuesta lo dice, la petición sigue y se puede reintentar', async () => {
    let first = true;
    const state = mountCore({
      answer: (args) => {
        if (first) {
          first = false;
          throw new Error('failed/answer_failed: el proveedor rechazó la respuesta');
        }
        return { status: 'Answered', attempt_id: 't3-a1', request_id: args.request_id, kind: 'permission' };
      },
    });
    render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-answer-allow'));
    await flush();
    expect(screen.getByTestId('attempt-answer-error').textContent).toMatch(/volver a intentarlo/i);
    expect(screen.getByTestId('attempt-answer-request')).toBeTruthy();
    fireEvent.click(screen.getByTestId('attempt-answer-allow'));
    await flush();
    expect(answers(state)).toHaveLength(2);
    expect(screen.queryByTestId('attempt-answer-error')).toBeNull();
  });

  it('una respuesta repetida (Replayed) se dice como tal', async () => {
    mountCore({ answer: (args) => ({ status: 'Replayed', attempt_id: 't3-a1', request_id: args.request_id, kind: null }) });
    render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-answer-allow'));
    await flush();
    expect(screen.getByTestId('attempt-answer-outcome').textContent).toMatch(/ya estaba respondida/i);
  });

  it('un conflicto con otra decisión ya tomada no se confunde con el de la cola', async () => {
    mountCore({ answer: () => { throw new Error('invalid/request_conflict: esa petición ya se respondió de otra forma'); } });
    render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-answer-deny'));
    await flush();
    const text = screen.getByTestId('attempt-answer-error').textContent;
    expect(text).toMatch(/otra decisión/i);
    expect(text).not.toMatch(/instrucci/i);
  });

  it('sin peticiones pendientes lo dice; sin ejecución viva, también', async () => {
    mountCore({ requests: [] });
    const { unmount } = render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    expect(screen.getByTestId('attempt-answer-empty').textContent).toMatch(/ninguna petición pendiente/i);
    unmount();
    mountCore({ requests: [], liveRun: false });
    render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    expect(screen.getByTestId('attempt-answer-empty').textContent).toMatch(/ejecución viva/i);
  });

  it('un fallo al leer lo muestra sin inventar peticiones', async () => {
    invoke.mockImplementation(async () => { throw new Error('boom'); });
    render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    expect(screen.getByTestId('attempt-answer-load-error')).toBeTruthy();
    expect(screen.queryByTestId('attempt-answer-request')).toBeNull();
  });

  it('el texto del proveedor se pinta como texto, nunca como HTML', async () => {
    mountCore({ requests: [{ ...QUESTION, subject: '<img src=x onerror=alert(1)> ¿seguro?' }] });
    const { container } = render(<AttemptAnswer attemptId="t3-a1" />);
    await flush();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)> ¿seguro\?/)).toBeTruthy();
  });
});

describe('AttemptAnswer en el detalle del Attempt', () => {
  it('solo aparece mientras el intento espera una respuesta', async () => {
    mountCore();
    const { unmount } = render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    expect(screen.getByTestId('attempt-answer')).toBeTruthy();
    unmount();
    invoke.mockImplementation(async (command, payload) => {
      if (payload?.query === 'provider_capabilities') return live();
      if (payload?.query === 'activity_list') return attemptActivityPage([]);
      return attemptDetail({ id: 't3-a1', task_id: 't3', status: 'running' });
    });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    expect(screen.queryByTestId('attempt-answer')).toBeNull();
  });
});
