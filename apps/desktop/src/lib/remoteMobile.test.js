import { describe, expect, it, vi } from 'vitest';
import { handleMobileAction } from './remoteMobile.js';
import { createCoreLink } from '../../../mobile/src/observe/link.js';

describe('operaciones privadas Mobile', () => {
  it('el enlace Mobile empareja la respuesta y la identidad viene solo del relé', async () => {
    const invoke = vi.fn().mockResolvedValue({ attempt_id: 't1-a1', review_id: 'r1' });
    const link = createCoreLink({ send: async (command) => {
      const response = await handleMobileAction(command.action, command.args, { user_id: 7, session_id: 42 }, invoke);
      link.handleEvent({ type: response.type, ...response.fields });
      return { ok: true };
    } });
    try {
      const response = await link.request('mobile_review', { attempt_id: 't1-a1', attention_id: 'r1' });
      expect(response.data.result.attempt_id).toBe('t1-a1');
      expect(invoke).toHaveBeenCalledWith('orch_mobile_review', { userId: 7, sessionId: 42, args: { attempt_id: 't1-a1', attention_id: 'r1' } });
    } finally { link.close(); }
  });
  it('Queue conserva la clave de negocio al cambiar el RID de transporte', async () => {
    const seen = [];
    const invoke = vi.fn(async (command, input) => {
      seen.push(input.args);
      return { attempt_id: input.args.attempt_id, queue_id: 't1-a1-q1', status: seen.length === 1 ? 'Queued' : 'Replayed' };
    });
    const operation = { kind: 'queue', request_id: 'business-key', body: 'sigue', confirm: true };
    for (const rid of ['transport-1', 'transport-2']) {
      const result = await handleMobileAction('mobile_controls', { rid, attempt_id: 't1-a1', operation }, { user_id: 7, session_id: 42 }, invoke);
      expect(result.fields.rid).toBe(rid);
      expect(result.fields.result.queue_id).toBe('t1-a1-q1');
    }
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]).not.toHaveProperty('rid');
  });
  it('identidades inválidas y acciones no permitidas no llegan al Core', async () => {
    const invoke = vi.fn();
    for (const mobile of [null, {}, { user_id: 0, session_id: 42 }, { user_id: 7, session_id: '42' }]) {
      expect(await handleMobileAction('mobile_review', { rid: 'r' }, mobile, invoke)).toBeNull();
    }
    expect(await handleMobileAction('review', { rid: 'r' }, { user_id: 7, session_id: 42 }, invoke)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('el error privado queda reducido a código y abrir Desktop requiere un destino validado', async () => {
    const identity = { user_id: 7, session_id: 42 };
    const args = { rid: 'r', attempt_id: 't1-a1' };
    const failed = await handleMobileAction('mobile_review', args, identity, vi.fn().mockRejectedValue(new Error('head_moved: PRIVATE_SENTINEL')));
    expect(failed.fields.code).toBe('head_moved');
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_SENTINEL');
    const open = vi.fn();
    const invoke = vi.fn().mockResolvedValue({ outcome: 'desktop_requested', selection: { projectId: 'p1', taskId: 't1', attemptId: 't1-a1' } });
    expect((await handleMobileAction('mobile_review', args, identity, invoke, open)).fields.result.outcome).toBe('desktop_opened');
    expect(open).toHaveBeenCalledOnce();
    expect((await handleMobileAction('mobile_review', { ...args, attempt_id: 't2-a1' }, identity, invoke, open)).fields.code).toBe('desktop_unavailable');
    expect(open).toHaveBeenCalledOnce();
  });
});
