import { describe, it, expect, vi } from 'vitest';
import { coreErrorCode, handleCoreAction, parseCoreRequest, slimActivity, slimAttempt, slimAttention, slimEvent, slimTaskDetail, CORE_ACTIVITY_MAX_LIMIT, CORE_ATTEMPTS_MAX, CORE_ATTENTION_MAX_LIMIT, CORE_EVENTS_MAX_LIMIT } from './remoteCore';

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

describe('core_attention (LXO-109)', () => {
  const row = {
    id: 'att-1', category: 'question', severity: 'high', status: 'active', target_kind: 'task', target_id: 't1',
    project_id: 'p1', run_id: 'r1', occurrence: 2, created_at: 100, resolved_at: null, resolution: null,
    subject: 'SENTINEL-SUBJECT', facts: '{"secret":"SENTINEL-FACTS"}',
  };

  it('valida filtros, cursor y límite', () => {
    expect(parseCoreRequest('core_attention', { rid: 'r1' })).toEqual({ rid: 'r1', args: { limit: 50 } });
    expect(parseCoreRequest('core_attention', { rid: 'r1', project_id: 'p1', category: 'failed', severity: 'critical', cursor: 'abc', limit: 10 }).args)
      .toEqual({ project_id: 'p1', category: 'failed', severity: 'critical', cursor: 'abc', limit: 10 });
    expect(parseCoreRequest('core_attention', { rid: 'r1', category: 'otra' }).code).toBe('invalid_request');
    expect(parseCoreRequest('core_attention', { rid: 'r1', severity: 'urgent' }).code).toBe('invalid_request');
    expect(parseCoreRequest('core_attention', { rid: 'r1', project_id: '' }).code).toBe('invalid_request');
    expect(parseCoreRequest('core_attention', { rid: 'r1', cursor: 5 }).code).toBe('invalid_cursor');
    expect(parseCoreRequest('core_attention', { rid: 'r1', limit: CORE_ATTENTION_MAX_LIMIT + 1 }).code).toBe('invalid_request');
  });

  it('cada fila pasa por la allowlist', () => {
    const slim = slimAttention(row);
    expect(Object.keys(slim).sort()).toEqual(['category', 'created_at', 'id', 'occurrence', 'project_id', 'run_id', 'severity', 'status', 'target_id', 'target_kind']);
    expect(JSON.stringify(slim)).not.toContain('SENTINEL');
  });

  it('llama a attention_list y devuelve la página', async () => {
    const call = vi.fn().mockResolvedValue({ v: 1, items: [row], next_cursor: 'nx', has_more: true, limit: 50 });
    const out = await handleCoreAction('core_attention', { rid: 'r5', category: 'question' }, call);
    expect(call).toHaveBeenCalledWith('attention_list', { category: 'question', limit: 50 });
    expect(out.type).toBe('orch_core_attention');
    expect(out.fields).toMatchObject({ rid: 'r5', ok: true, protocol: 1, next_cursor: 'nx', has_more: true });
    expect(out.fields.items).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain('SENTINEL');
  });

  it('un cursor inválido del Core sale como código', async () => {
    const call = vi.fn().mockRejectedValue('attention_invalid_cursor: el cursor no es de esta consulta');
    const out = await handleCoreAction('core_attention', { rid: 'r6', cursor: 'viejo' }, call);
    expect(out.fields).toEqual({ rid: 'r6', ok: false, code: 'attention_invalid_cursor', protocol: 1 });
  });
});

describe('core_task y core_activity (LXO-110)', () => {
  const detail = {
    id: 't1', run_id: 'r1', parent_id: 't0', root_id: 't0', status: 'waiting', title: 'Arreglar\nla reconexión', provider: 'claude', model: null,
    branch: 'lxo/t1', worktree: 'C:/r/wt/1', created_at: 1, updated_at: 2, project_id: 'p1', child_ids: ['t2'],
    phase: { name: 'SENTINEL-FASE', done: false, note: 'SENTINEL-NOTA', at: 3 },
    messages: [
      { id: 1, kind: 'question', from: 't1', to: 't0', body: 'SENTINEL-PREGUNTA', reply_to: null, at: 4 },
      { id: 2, kind: 'question', from: 't1', to: 't0', body: 'otra', reply_to: null, at: 5 },
      { id: 3, kind: 'reply', from: 't0', to: 't1', body: 'SENTINEL-RESPUESTA', reply_to: 1, at: 6 },
    ],
    cwd: 'C:/r/api', merged: false, review: { decision: 'accepted', head_commit: 'abc', at: 7 }, integration: null,
  };

  it('task_detail sin cuerpos de mensaje ni nombre de fase', () => {
    const t = slimTaskDetail(detail);
    expect(t).toMatchObject({ id: 't1', project_id: 'p1', root_id: 't0', parent_id: 't0', child_ids: ['t2'], status: 'waiting', model: null, worktree: 'C:/r/wt/1', location: 'C:/r/wt/1' });
    expect(t.title).toBe('Arreglar la reconexión');
    expect(t.pending_questions).toBe(1);
    expect(t.phase).toEqual({ done: false, at: 3 });
    expect(t.review).toEqual({ decision: 'accepted', at: 7 });
    expect(JSON.stringify(t)).not.toContain('SENTINEL');
    expect(slimTaskDetail({ ...detail, worktree: null }).location).toBe('C:/r/api');
  });

  it('task_detail pasa el origen si el Core da `external` (LXO-38) y si no, desconocido', () => {
    expect(slimTaskDetail({ ...detail, external: true }).origin).toBe('external');
    expect(slimTaskDetail({ ...detail, external: false }).origin).toBe('lixbon');
    expect(slimTaskDetail(detail).origin).toBeNull();
    expect(slimTaskDetail({ ...detail, external: 'sí' }).origin).toBeNull();
  });

  it('activity sin provenance, ids de evento ni de persona', () => {
    const a = slimActivity({
      seq: 9, event_id: 'ev', ts: 10, kind: 'task.status_changed', v: 1, class: 'state', message_key: 'activity.task.failed',
      args: { from: 'running', to: 'failed', cause: 'agent_idle_timeout', nested: { x: 1 } }, visual: 'error', fallback: false,
      target: { kind: 'task', id: 't1' }, project_id: 'p1', run_id: 'r1', actor: { kind: 'person', id: 'SENTINEL-PERSONA' },
      provenance: { channel: 'ui', client_id: 'SENTINEL-CLIENTE' }, correlation_id: 'SENTINEL-CORR',
    });
    expect(a).toEqual({
      seq: 9, ts: 10, kind: 'task.status_changed', message_key: 'activity.task.failed',
      args: { from: 'running', to: 'failed', cause: 'agent_idle_timeout' }, visual: 'error', fallback: false,
      target: { kind: 'task', id: 't1' }, actor: { kind: 'person' },
    });
    expect(JSON.stringify(a)).not.toContain('SENTINEL');
  });

  it('valida las peticiones', () => {
    expect(parseCoreRequest('core_task', { rid: 'r1', project_id: 'p1', task_id: 't1' }).args).toEqual({ project_id: 'p1', task_id: 't1' });
    expect(parseCoreRequest('core_task', { rid: 'r1', task_id: 't1' }).code).toBe('invalid_request');
    expect(parseCoreRequest('core_activity', { rid: 'r1', task_id: 't1' }).args).toEqual({ target_kind: 'task', target_id: 't1', order: 'desc', cursor: 0, limit: 30 });
    expect(parseCoreRequest('core_activity', { rid: 'r1', task_id: 't1', cursor: -1 }).code).toBe('invalid_cursor');
    expect(parseCoreRequest('core_activity', { rid: 'r1', task_id: 't1', limit: CORE_ACTIVITY_MAX_LIMIT + 1 }).code).toBe('invalid_request');
    expect(parseCoreRequest('core_attention', { rid: 'r1', target_kind: 'task', target_id: 't1' }).args).toEqual({ target_kind: 'task', target_id: 't1', limit: 50 });
    expect(parseCoreRequest('core_attention', { rid: 'r1', target_id: 't1' }).code).toBe('invalid_request');
    expect(parseCoreRequest('core_attention', { rid: 'r1', target_kind: 'nave' }).code).toBe('invalid_request');
  });

  it('llama a task_detail y activity_list', async () => {
    const call = vi.fn().mockImplementation(async (cmd) =>
      cmd === 'task_detail' ? { v: 1, task: detail } : { v: 1, items: [{ seq: 5, message_key: 'activity.task.created', args: { title: 'x' } }], next_cursor: 5, has_more: true },
    );
    const task = await handleCoreAction('core_task', { rid: 'a', project_id: 'p1', task_id: 't1' }, call);
    expect(call).toHaveBeenCalledWith('task_detail', { project_id: 'p1', task_id: 't1' });
    expect(task.type).toBe('orch_core_task');
    expect(task.fields.task.id).toBe('t1');
    const act = await handleCoreAction('core_activity', { rid: 'b', task_id: 't1', cursor: 0 }, call);
    expect(call).toHaveBeenCalledWith('activity_list', { target_kind: 'task', target_id: 't1', order: 'desc', cursor: 0, limit: 30 });
    expect(act.fields).toMatchObject({ rid: 'b', ok: true, next_cursor: 5, has_more: true });
    const missing = await handleCoreAction('core_task', { rid: 'c', project_id: 'p1', task_id: 'x' }, vi.fn().mockRejectedValue('tasks_not_found: no existe la Task x'));
    expect(missing.fields).toEqual({ rid: 'c', ok: false, code: 'tasks_not_found', protocol: 1 });
  });
});

describe('core_attempts y core_attempt (LXO-126)', () => {
  const brief = (n, status) => ({ id: `t1-a${n}`, n, status, provider: 'codex', model: 'gpt-5', role: null, external: n === 2, created_at: 1000 + n, started_at: 1100 + n, ended_at: status === 'running' ? null : 1200 + n });
  const full = (n, status) => ({
    ...brief(n, status), task_id: 't1', effort: 'high', profile: 'implementar', summary: n === 1 ? '' : 'Hecho', failure_reason: status === 'failed' ? 'agent_idle_timeout' : null,
    integrated: status === 'done', provider_session: { id: 'ps-1', status: 'idle', resumable: true, binding: 'session_id', bound: true, opened_by_attempt_id: `t1-a${n}`, external_ref: 'SENTINEL-REF' },
    worktree: { id: 'wt-1', path: 'C:/r/app-wt/t1', branch: 'lx/r1/t1', base_branch: 'main', provenance: 'created', state: 'active', machine: n === 2 ? 'portatil' : null, branch_kept: false },
    artifacts: [{ id: 'x', kind: 'pull_request', uri: 'https://github.com/o/r/pull/1', sha256: null, bytes: null }],
    review: { decision_id: 1, verdict: 'accepted', status: 'stale', head_commit: 'c3', base_commit: 'b0' },
  });
  const task = { id: 't1', project_id: 'p1', run_id: 'r1', parent_task_id: null, title: 'API', intent: 'open', state: 'in_progress', origin: 'lixbon', spec: 'SENTINEL-SPEC',
    attempt_count: 3, current_attempt: brief(3, 'running'), attempts: [brief(1, 'failed'), brief(2, 'done'), brief(3, 'running')], created_at: 1, updated_at: 2 };

  it('valida las peticiones', () => {
    expect(parseCoreRequest('core_attempts', { rid: 'r1', task_id: 't1' }).args).toEqual({ task_id: 't1' });
    expect(parseCoreRequest('core_attempts', { rid: 'r1' }).code).toBe('invalid_request');
    expect(parseCoreRequest('core_attempt', { rid: 'r1', attempt_id: 't1-a2' }).args).toEqual({ attempt_id: 't1-a2' });
    expect(parseCoreRequest('core_attempt', { rid: 'r1', attempt_id: 7 }).code).toBe('invalid_request');
  });

  it('lista los intentos con el detalle de cada uno, sin el encargo ni la referencia del proveedor', async () => {
    const call = vi.fn().mockImplementation(async (cmd, args) => {
      if (cmd === 'task_detail_v2') return { v: 2, core_model: 'task_attempt_v1', task };
      if (args.attempt_id === 't1-a3') throw new Error('model_unavailable: cerrado');
      const n = Number(args.attempt_id.slice(-1));
      return { v: 1, attempt: full(n, n === 1 ? 'failed' : 'done') };
    });
    const out = await handleCoreAction('core_attempts', { rid: 'a', task_id: 't1' }, call);
    expect(call).toHaveBeenCalledWith('task_detail_v2', { task_id: 't1' });
    expect(out.type).toBe('orch_core_attempts');
    expect(out.fields.task).toMatchObject({ id: 't1', state: 'in_progress', attempt_count: 3, current_attempt_id: 't1-a3' });
    const [a1, a2, a3] = out.fields.attempts;
    expect(a1).toMatchObject({ id: 't1-a1', status: 'failed', failure_reason: 'agent_idle_timeout', has_summary: false, host: null, origin: 'lixbon' });
    expect(a2).toMatchObject({ id: 't1-a2', integrated: true, has_summary: true, host: 'portatil', origin: 'external' });
    // Si el detalle de uno falla, va lo de la lista: lo demás, desconocido.
    expect(a3).toMatchObject({ id: 't1-a3', status: 'running', integrated: null, host: null, has_summary: null });
    expect(out.fields.truncated).toBe(false);
    expect(JSON.stringify(out)).not.toContain('SENTINEL');
  });

  it(`detalla solo los últimos ${CORE_ATTEMPTS_MAX} y dice que hay más`, async () => {
    const many = Array.from({ length: CORE_ATTEMPTS_MAX + 3 }, (_, i) => brief(i + 1, 'failed'));
    const call = vi.fn().mockImplementation(async (cmd, args) => (cmd === 'task_detail_v2' ? { task: { ...task, attempts: many } } : { attempt: { id: args.attempt_id } }));
    const out = await handleCoreAction('core_attempts', { rid: 'b', task_id: 't1' }, call);
    expect(out.fields.attempts).toHaveLength(CORE_ATTEMPTS_MAX);
    expect(out.fields.attempts[0].id).toBe('t1-a4');
    expect(out.fields.truncated).toBe(true);
  });

  it('antes del corte devuelve el código del Core', async () => {
    const out = await handleCoreAction('core_attempts', { rid: 'c', task_id: 't1' }, vi.fn().mockRejectedValue('core_model_inactive: el Core aún sirve el modelo legacy'));
    expect(out.fields).toEqual({ rid: 'c', ok: false, code: 'core_model_inactive', protocol: 1 });
  });

  it('la ficha lleva sesión, worktree, artifacts y revisión, sin la referencia del proveedor', async () => {
    const out = await handleCoreAction('core_attempt', { rid: 'd', attempt_id: 't1-a2' }, vi.fn().mockResolvedValue({ v: 1, attempt: full(2, 'done') }));
    expect(out.type).toBe('orch_core_attempt');
    const a = out.fields.attempt;
    expect(a.provider_session).toEqual({ status: 'idle', resumable: true, bound: true, binding: 'session_id', opened_here: true });
    expect(a.worktree).toMatchObject({ path: 'C:/r/app-wt/t1', branch: 'lx/r1/t1', provenance: 'created', machine: 'portatil' });
    expect(a.artifacts).toEqual([{ kind: 'pull_request', uri: 'https://github.com/o/r/pull/1' }]);
    expect(a.review).toEqual({ verdict: 'accepted', status: 'stale', head_commit: 'c3', base_commit: 'b0' });
    expect(a.summary).toBe('Hecho');
    expect(JSON.stringify(out)).not.toContain('SENTINEL');
    expect(slimAttempt({}).provider_session).toBeNull();
  });

  it('la ficha nombra su Task, y sin ella se enseña igual (LXO-127)', async () => {
    const call = vi.fn().mockImplementation(async (cmd) => (cmd === 'attempt_detail' ? { attempt: full(2, 'done') } : { v: 2, task }));
    const out = await handleCoreAction('core_attempt', { rid: 'e', attempt_id: 't1-a2' }, call);
    expect(call).toHaveBeenCalledWith('task_detail_v2', { task_id: 't1' });
    expect(out.fields.task).toEqual({ id: 't1', title: 'API', state: 'in_progress', project_id: 'p1', current_attempt_id: 't1-a3' });
    expect(JSON.stringify(out)).not.toContain('SENTINEL-SPEC');
    const sinTask = await handleCoreAction('core_attempt', { rid: 'f', attempt_id: 't1-a2' }, vi.fn().mockImplementation(async (cmd) => {
      if (cmd === 'attempt_detail') return { attempt: full(2, 'done') };
      throw new Error('model_unavailable: x');
    }));
    expect(sinTask.fields).toMatchObject({ ok: true, task: null });
  });

  it('la Activity de un intento concreto (LXO-127)', () => {
    expect(parseCoreRequest('core_activity', { rid: 'r1', attempt_id: 't1-a2' }).args).toEqual({ target_kind: 'attempt', target_id: 't1-a2', order: 'desc', cursor: 0, limit: 30 });
    expect(parseCoreRequest('core_activity', { rid: 'r1', attempt_id: 't1-a2', task_id: 't1' }).code).toBe('invalid_request');
    expect(parseCoreRequest('core_activity', { rid: 'r1', attempt_id: '' }).code).toBe('invalid_request');
  });
});
