import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { approveAttempt, createTaskWithAttempt, describeCommandError, newRequestId, rejectAttempt } from './attemptCommands';

// LXO-141 · Las escrituras del ADE sobre el modelo Task/Attempt: solo van por `orch_call` con la forma que el Core valida.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => invoke.mockReset());

describe('attemptCommands (LXO-141)', () => {
  it('crea la Task con su Attempt enviando solo la selección (modelo y esfuerzo vacíos no viajan)', async () => {
    invoke.mockResolvedValue({ status: 'Committed', run_id: 'r1', task_id: 't1', attempt_id: 't1-a1' });
    const created = await createTaskWithAttempt({
      requestId: 'ade-1', projectId: 'p1', title: 'Arreglar', objective: 'Arreglar', spec: 'haz algo',
      attempt: { provider: 'claude', profile: 'explorar', model: ' ', effort: '' },
    });
    expect(created.attempt_id).toBe('t1-a1');
    expect(invoke).toHaveBeenCalledWith('orch_call', {
      cmd: 'task_create',
      args: { request_id: 'ade-1', project_id: 'p1', objective: 'Arreglar', title: 'Arreglar', spec: 'haz algo', attempt: { provider: 'claude', profile: 'explorar' } },
    });
  });

  it('envía modelo y esfuerzo cuando la persona los eligió', async () => {
    invoke.mockResolvedValue({ status: 'Committed', run_id: 'r1', task_id: 't1', attempt_id: 't1-a1' });
    await createTaskWithAttempt({ requestId: 'ade-2', projectId: 'p1', title: 't', objective: 't', spec: 's', attempt: { provider: 'codex', profile: 'proponer', model: 'm1', effort: 'high' } });
    expect(invoke.mock.calls[0][1].args.attempt).toEqual({ provider: 'codex', profile: 'proponer', model: 'm1', effort: 'high' });
  });

  it('una respuesta sin Task y Attempt es un error, no un éxito', async () => {
    invoke.mockResolvedValue({ status: 'Committed' });
    await expect(createTaskWithAttempt({ requestId: 'ade-3', projectId: 'p1', title: 't', objective: 't', spec: 's', attempt: { provider: 'claude', profile: 'explorar' } }))
      .rejects.toThrow(/ade_command_invalid_response/);
  });

  it('aprobar y rechazar mandan solo el id del Attempt', async () => {
    invoke.mockResolvedValue({ status: 'Approved', attempt_id: 't1-a1' });
    await approveAttempt('t1-a1');
    await rejectAttempt('t1-a1');
    expect(invoke).toHaveBeenNthCalledWith(1, 'orch_call', { cmd: 'attempt_approve', args: { attempt_id: 't1-a1' } });
    expect(invoke).toHaveBeenNthCalledWith(2, 'orch_call', { cmd: 'attempt_reject', args: { attempt_id: 't1-a1' } });
  });

  it('la clave de idempotencia cumple el formato del Core', () => {
    for (let i = 0; i < 20; i += 1) expect(newRequestId()).toMatch(/^[A-Za-z0-9_.-]{1,64}$/);
    expect(newRequestId()).not.toBe(newRequestId());
  });

  it('traduce lo que la persona puede resolver y conserva el original como detalle', () => {
    const off = describeCommandError('task.create con Attempt requiere el lifecycle de lanzamiento verificado');
    expect(off.message).toMatch(/Orquestador está desactivado/);
    expect(off.detail).toMatch(/lifecycle de lanzamiento/);
    expect(describeCommandError(new Error('el Attempt ya fue aprobado')).message).toBe('Este intento ya fue aprobado.');
    expect(describeCommandError('la aprobación venció, pero no se pudo confirmar su expiración').message).toMatch(/venció/);
    expect(describeCommandError('algo inesperado')).toEqual({ message: 'algo inesperado', detail: 'algo inesperado' });
  });
});
