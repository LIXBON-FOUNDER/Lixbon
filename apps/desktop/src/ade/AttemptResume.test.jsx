import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// Continuar la sesión del proveedor de un intento terminado (RPC `attempt_resume`).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

const SESSION = { binding: 'session_id', bound: true, id: 'ps-t3-a1', opened_by_attempt_id: 't3-a1', resumable: true, status: 'idle' };

/** `attempts_by_task` con la forma que el transporte valida (la del fixture canónico): un `attempt_brief` por número. */
const briefs = (...ns) => ({
  ...CANONICAL['attempts_by_task.v1.json'],
  task_id: 't3',
  items: ns.map((n) => ({ ...CANONICAL['attempts_by_task.v1.json'].items[0], id: `t3-a${n}`, n, status: 'done', worktree: null })),
});

/** Un Core de pruebas: `attempt_detail` sirve el intento, `attempts_by_task` el historial y `orch_call` responde `decide`. */
function mountCore({ status = 'done', session = SESSION, history = briefs(1), decide = () => ({ status: 'Requested', task_id: 't3', attempt_id: 't3-a2' }), historyError = null } = {}) {
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
    return attemptDetail({ id: 't3-a1', task_id: 't3', n: 1, status, provider_session: session });
  });
  return calls;
}
const mount = () => render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
const sent = (calls) => calls.filter((c) => c.command === 'orch_call').map((c) => c.payload);
const open = async () => { fireEvent.click(screen.getByTestId('attempt-resume-open')); await flush(); };
const write = (value) => fireEvent.change(screen.getByTestId('attempt-resume-text'), { target: { value } });

describe('Continuar la sesión de un intento', () => {
  it('se ofrece en un intento terminado con una sesión en espera que se puede reanudar', async () => {
    for (const status of ['done', 'failed', 'stopped', 'exited']) {
      mountCore({ status });
      const { unmount } = mount();
      await flush();
      expect(screen.getByTestId('attempt-resume-open'), status).toBeTruthy();
      unmount();
    }
  });

  it('no se ofrece en marcha, ni sin sesión, ni con una sesión que no se puede reanudar', async () => {
    const cases = [
      { status: 'running' }, { status: 'waiting' }, { status: 'pending_approval' },
      { session: null },
      { session: { ...SESSION, resumable: false } },
      { session: { ...SESSION, status: 'closed' } },
      { session: { ...SESSION, status: 'open' } },
    ];
    for (const over of cases) {
      mountCore(over);
      const { unmount } = mount();
      await flush();
      expect(screen.queryByTestId('attempt-resume'), JSON.stringify(over)).toBeNull();
      unmount();
    }
  });

  it('no se ofrece sobre un intento que ya no es el último, y si no se pudo leer el historial se sigue ofreciendo', async () => {
    mountCore({ history: briefs(1, 2) });
    const first = mount();
    await flush();
    expect(screen.queryByTestId('attempt-resume')).toBeNull();
    first.unmount();
    mountCore({ historyError: 'model_unavailable' });
    mount();
    await flush();
    expect(screen.getByTestId('attempt-resume-open')).toBeTruthy();
  });

  it('pide el mensaje, avisa de que conserva la conversación y no manda nada hasta enviarlo', async () => {
    const calls = mountCore();
    mount();
    await flush();
    await open();
    expect(screen.getByTestId('attempt-resume').textContent).toMatch(/misma sesión del proveedor.*mismo worktree.*mismos permisos/);
    expect(screen.getByTestId('attempt-resume-send').disabled).toBe(true);
    write('   ');
    expect(screen.getByTestId('attempt-resume-send').disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByTestId('attempt-resume-open')).toBeTruthy();
    expect(sent(calls)).toEqual([]);
  });

  it('enviar manda attempt_resume con la Task, el intento y el mensaje; dice cuál es el nuevo y vuelve a leer el detalle', async () => {
    const calls = mountCore();
    mount();
    await flush();
    const before = calls.filter((c) => c.payload?.query === 'attempt_detail').length;
    await open();
    write('  sigue con la parte dos  ');
    fireEvent.click(screen.getByTestId('attempt-resume-send'));
    await flush();
    expect(sent(calls)).toEqual([{ cmd: 'attempt_resume', args: { task_id: 't3', from_attempt_id: 't3-a1', prompt: 'sigue con la parte dos' } }]);
    const outcome = screen.getByTestId('attempt-resume-outcome').textContent;
    expect(outcome).toMatch(/Continuación pedida/);
    expect(outcome).toContain('t3-a2');
    expect(calls.filter((c) => c.payload?.query === 'attempt_detail').length).toBeGreaterThan(before);
    expect(screen.queryByTestId('attempt-resume-open')).toBeNull();
  });

  it('una continuación que ya estaba pedida se dice como tal', async () => {
    mountCore({ decide: () => ({ status: 'Replayed', task_id: 't3', attempt_id: 't3-a2' }) });
    mount();
    await flush();
    await open();
    write('sigue');
    fireEvent.click(screen.getByTestId('attempt-resume-send'));
    await flush();
    expect(screen.getByTestId('attempt-resume-outcome').textContent).toMatch(/ya estaba pedida/);
  });

  it('un rechazo del Core se dice en llano, conserva el mensaje escrito y deja reintentar', async () => {
    const reasons = [
      ['la sesión del proveedor no es resumible: no entregó una referencia para reanudarla', 'La sesión del proveedor ya no se puede reanudar.'],
      ['provider_resume_unsupported: el proveedor codex no ofrece reanudar sesiones', 'Este proveedor no permite reanudar sesiones.'],
      ['el Attempt anterior no tuvo una sesión del proveedor que reanudar', 'Este intento no guardó una sesión del proveedor'],
      ['solo se continúa el último Attempt de la Task: el actual es t3-a2', 'Hay un intento más reciente: continúa ese.'],
    ];
    for (const [raw, shown] of reasons) {
      mountCore({ decide: () => { throw new Error(raw); } });
      const { unmount } = mount();
      await flush();
      await open();
      write('mi mensaje');
      fireEvent.click(screen.getByTestId('attempt-resume-send'));
      await flush();
      expect(screen.getByTestId('attempt-resume-error').textContent, raw).toContain(shown);
      expect(screen.getByTestId('attempt-resume-text').value).toBe('mi mensaje');
      expect(screen.getByTestId('attempt-resume-send').disabled).toBe(false);
      expect(screen.queryByTestId('attempt-resume-outcome')).toBeNull();
      unmount();
    }
  });
});
