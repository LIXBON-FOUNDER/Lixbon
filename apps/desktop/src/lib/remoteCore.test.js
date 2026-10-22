import { describe, it, expect, vi } from 'vitest';
import { coreErrorCode, handleCoreAction, parseCoreRequest, slimEvent, CORE_EVENTS_MAX_LIMIT } from './remoteCore';

const event = {
  seq: 7, id: 'ev-7', ts: 1000, v: 2, kind: 'task.created', class: 'state',
  actor: { kind: 'person', id: 'user' }, channel: 'ui', client_id: 'client-secret-id',
  project_id: 'p1', run_id: 'r1', entity: { kind: 'task', id: 't1' }, correlation_id: 'corr',
  payload: { spec: 'SENTINEL-SPEC', cwd: 'C:/ruta/privada' },
};

describe('slimEvent', () => {
  it('deja solo cursor, tipo, hora e ids', () => {
    expect(slimEvent(event)).toEqual({ seq: 7, kind: 'task.created', ts: 1000, project_id: 'p1', run_id: 'r1', entity: { kind: 'task', id: 't1' } });
  });
  it('no deja pasar payload, actor ni cliente', () => {
    const text = JSON.stringify(slimEvent(event));
    for (const s of ['SENTINEL-SPEC', 'ruta/privada', 'client-secret-id', 'corr', 'person']) expect(text).not.toContain(s);
  });
});

describe('parseCoreRequest', () => {
  it('exige un rid válido', () => {
    expect(parseCoreRequest('core_snapshot', {}).code).toBe('invalid_request');
    expect(parseCoreRequest('core_snapshot', { rid: 'a b' }).code).toBe('invalid_request');
    expect(parseCoreRequest('core_snapshot', { rid: 'x'.repeat(65) }).code).toBe('invalid_request');
  });
  it('valida attention_items', () => {
    expect(parseCoreRequest('core_snapshot', { rid: 'r1' })).toEqual({ rid: 'r1', args: {} });
    expect(parseCoreRequest('core_snapshot', { rid: 'r1', attention_items: 20 }).args).toEqual({ attention_items: 20 });
    expect(parseCoreRequest('core_snapshot', { rid: 'r1', attention_items: 21 }).code).toBe('invalid_request');
    expect(parseCoreRequest('core_snapshot', { rid: 'r1', attention_items: '5' }).code).toBe('invalid_request');
  });
  it('valida cursor y limit de events', () => {
    expect(parseCoreRequest('core_events', { rid: 'r1', cursor: 3 })).toEqual({ rid: 'r1', args: { cursor: 3, limit: 100 } });
    expect(parseCoreRequest('core_events', { rid: 'r1', cursor: -1 }).code).toBe('invalid_cursor');
    expect(parseCoreRequest('core_events', { rid: 'r1', cursor: '3' }).code).toBe('invalid_cursor');
    expect(parseCoreRequest('core_events', { rid: 'r1', cursor: 0, limit: CORE_EVENTS_MAX_LIMIT + 1 }).code).toBe('invalid_request');
  });
});

describe('coreErrorCode', () => {
  it('toma el código estable y descarta el mensaje', () => {
    expect(coreErrorCode('cursor_ahead: `cursor` 9 supera head_seq 3')).toBe('cursor_ahead');
    expect(coreErrorCode(new Error('compact_snapshot_unavailable: C:/ruta'))).toBe('compact_snapshot_unavailable');
    expect(coreErrorCode('Acción no permitida para esta identidad: ForbiddenAction')).toBe('forbidden');
    expect(coreErrorCode('algo raro en C:/Users/x')).toBe('core_error');
  });
});

describe('handleCoreAction', () => {
  it('snapshot: llama a compact_snapshot y devuelve el rid', async () => {
    const call = vi.fn().mockResolvedValue({ snapshot_version: 1 });
    const out = await handleCoreAction('core_snapshot', { rid: 'r1', attention_items: 5 }, call);
    expect(call).toHaveBeenCalledWith('compact_snapshot', { attention_items: 5 });
    expect(out).toEqual({ type: 'orch_core_snapshot', fields: { rid: 'r1', ok: true, protocol: 1, snapshot: { snapshot_version: 1 } } });
  });
  it('events: llama a events con el cursor y adelgaza la página', async () => {
    const call = vi.fn().mockResolvedValue({ events: [event], next_cursor: 7, has_more: false, head_seq: 7 });
    const out = await handleCoreAction('core_events', { rid: 'r2', cursor: 6, limit: 50 }, call);
    expect(call).toHaveBeenCalledWith('events', { cursor: 6, limit: 50 });
    expect(out.type).toBe('orch_core_events');
    expect(out.fields).toMatchObject({ rid: 'r2', ok: true, next_cursor: 7, has_more: false, head_seq: 7 });
    expect(JSON.stringify(out)).not.toContain('SENTINEL-SPEC');
  });
  it('un error del Core sale como código, sin el mensaje', async () => {
    const call = vi.fn().mockRejectedValue('cursor_ahead: el cursor 99 no pertenece a C:/datos');
    const out = await handleCoreAction('core_events', { rid: 'r3', cursor: 99 }, call);
    expect(out.fields).toEqual({ rid: 'r3', ok: false, code: 'cursor_ahead', protocol: 1 });
  });
  it('una petición inválida no llega al Core', async () => {
    const call = vi.fn();
    const out = await handleCoreAction('core_events', { rid: 'r4', cursor: -5 }, call);
    expect(call).not.toHaveBeenCalled();
    expect(out.fields.code).toBe('invalid_cursor');
  });
});
