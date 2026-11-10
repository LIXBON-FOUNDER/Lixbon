import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { queryAdeCore } from './coreQueries';
import { validatePendingQueue } from './queueContract';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => invoke.mockReset());

const item = (n, over = {}) => ({
  queue_id: `t3-a1-q${n}`, seq: n, author_kind: 'person', body: `instrucción ${n}`, status: 'queued', failure: null, confirmed_by: null,
  created_at: 1_792_000_000_000 + n, delivered_at: null, ended_at: null, ...over,
});
const response = (over = {}) => ({ v: 1, attempt_id: 't3-a1', task_id: 't3', items: [{ ...item(1), position: 1 }, { ...item(2, { status: 'delivering' }), position: 2 }], finished: [], finished_limit: 20, ...over });
const args = { attempt_id: 't3-a1' };

describe('pending_queue (contrato cliente)', () => {
  it('acepta la cola tal como la manda el Core, pendientes y terminados', () => {
    const ok = response({
      finished: [
        item(3, { status: 'delivered', confirmed_by: 'adapter_event', delivered_at: 1_792_000_000_100 }),
        item(4, { status: 'cancelled' }),
        item(5, { status: 'failed', failure: 'attempt_ended' }),
      ],
    });
    expect(validatePendingQueue(ok, args)).toBe(ok);
  });

  it('rechaza lo que sale del contrato: otro Attempt, otra versión, un orden o un estado que no son del Core', () => {
    const bad = [
      response({ attempt_id: 't3-a2' }),
      response({ v: 2 }),
      response({ items: [{ ...item(1), position: 2 }] }),
      response({ items: [{ ...item(1, { status: 'delivered', confirmed_by: 'adapter_result' }), position: 1 }] }),
      response({ finished: [item(3, { status: 'queued' })] }),
      response({ finished: [item(3, { status: 'inventado' })] }),
      response({ finished: [item(3, { status: 'failed', failure: 'se_cayo_el_cable' })] }),
      response({ items: null }),
    ];
    for (const r of bad) expect(() => validatePendingQueue(r, args)).toThrow(/pending_queue/);
  });

  it('una entrega se confirma con el adapter y solo ella; un fallo lleva su motivo y solo él', () => {
    expect(() => validatePendingQueue(response({ finished: [item(3, { status: 'delivered', confirmed_by: null })] }), args)).toThrow(/se confirma con el adapter/);
    expect(() => validatePendingQueue(response({ finished: [item(3, { status: 'cancelled', confirmed_by: 'adapter_result' })] }), args)).toThrow(/se confirma con el adapter/);
    expect(() => validatePendingQueue(response({ finished: [item(3, { status: 'failed', failure: null })] }), args)).toThrow(/lleva su motivo/);
    expect(() => validatePendingQueue(response({ finished: [item(3, { status: 'cancelled', failure: 'adapter_error' })] }), args)).toThrow(/lleva su motivo/);
  });

  it('se pide por orch_query con el Attempt exacto y se exige un id', async () => {
    invoke.mockResolvedValue(response());
    await queryAdeCore('pending_queue', { attemptId: 't3-a1' });
    expect(invoke).toHaveBeenCalledWith('orch_query', { query: 'pending_queue', args: { attempt_id: 't3-a1' } });
    await expect(queryAdeCore('pending_queue', { attemptId: '  ' })).rejects.toThrow(/exige attempt_id/);
    await expect(queryAdeCore('pending_queue', {})).rejects.toThrow(/exige attempt_id/);
  });
});
