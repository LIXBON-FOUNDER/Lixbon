import { describe, expect, it, vi } from 'vitest';
import { handleCoreAction } from './remoteCore';
import { createCoreLink } from '../../../mobile/src/observe/link.js';
import { verifiedDesktopLink } from '../../../mobile/src/observe/desktopLink.js';

const core = (over = {}) => vi.fn(async (cmd, args) => {
  if (cmd === 'attention_detail') return { id: args.attention_id, status: 'active', project_id: 'p1', target_kind: 'attempt', target_id: 't1-a1', ...over.attention };
  if (cmd === 'attempt_detail_v2') return { attempt: { id: args.attempt_id, task_id: 't1' } };
  if (cmd === 'task_detail_v2') return { task: { id: args.task_id, project_id: 'p1' } };
  if (cmd === 'deep_link_generate') {
    const target = { task_id: null, attempt_id: null, view: null, file: null, line: null, revision: null, ...args };
    const u = new URL(`lixbon://project/${args.project_id}${args.task_id ? `/task/${args.task_id}` : ''}${args.attempt_id ? `/attempt/${args.attempt_id}` : ''}`);
    for (const k of ['view', 'file', 'line', 'revision']) if (args[k] != null) u.searchParams.set(k, args[k]);
    return { v: 1, status: over.stale ? 'stale' : 'ready', canonical: u.href, target, revision: { state: over.stale ? 'stale' : args.revision ? 'current' : 'not_requested', requested: args.revision ?? null, current: args.revision ?? null } };
  }
  throw new Error('Apertura intentó mutar Core o usar una query inesperada');
});

describe('LXO-50 Mobile → relay → Desktop → canonical Core link', () => {
  it.each([{ task_id: 't1' }, { attempt_id: 't1-a1' }, { attention_id: 'att-1' }, { attempt_id: 't1-a1', view: 'review', revision: 'abcdef1' }])('opens the exact target %j without mutation', async (source) => {
    const call = core(), open = vi.fn(async () => {}); let sequence = 0; const frames = [];
    const link = createCoreLink({ newRid: () => `f6-${++sequence}`, send: async (request) => {
      const out = await handleCoreAction(request.action, request.args, call, open);
      const frame = { type: out.type, ...out.fields }; frames.push(frame); link.handleEvent(frame); return { ok: true };
    } });
    try {
      const res = await link.request('core_desktop_link', { ...source, open_desktop: true });
      expect(res.ok).toBe(true); const checked = verifiedDesktopLink(res.data, source);
      expect(checked?.status).toBe('opened'); expect(open).toHaveBeenCalledWith(checked.url);
      expect(call.mock.calls.at(-1)[0]).toBe('deep_link_generate');
      expect(link.pendingCount).toBe(0); expect(frames[0]).not.toHaveProperty('path');
    } finally { link.close(); }
  });
  it('stale revision never opens Desktop; unavailable opener preserves canonical copy/share fallback', async () => {
    const open = vi.fn(async () => { throw new Error('private absolute path'); });
    const stale = await handleCoreAction('core_desktop_link', { rid: 's1', attempt_id: 't1-a1', view: 'review', revision: 'abcdef1', open_desktop: true }, core({ stale: true }), open);
    expect(stale.fields.open_status).toBe('stale'); expect(open).not.toHaveBeenCalled();
    const failed = await handleCoreAction('core_desktop_link', { rid: 's2', task_id: 't1', open_desktop: true }, core(), open);
    expect(failed.fields.open_status).toBe('unavailable'); expect(failed.fields.link.canonical).toBe('lixbon://project/p1/task/t1');
    expect(JSON.stringify(failed)).not.toContain('private');
  });
  it('resolved Attention and missing target fail before generating or opening', async () => {
    const open = vi.fn(), call = core({ attention: { status: 'resolved' } });
    const result = await handleCoreAction('core_desktop_link', { rid: 'a1', attention_id: 'att-1', open_desktop: true }, call, open);
    expect(result.fields.code).toBe('link_stale'); expect(open).not.toHaveBeenCalled(); expect(call).toHaveBeenCalledTimes(1);
  });
  it.each([{ task_id: 't1', attempt_id: 't1-a1' }, { task_id: 't1', url: 'lixbon://project/other' }, { task_id: 't1', file: '/etc/passwd' }, { task_id: 't1', file: '../keys' }, { task_id: 't1', token: 'secret' }])('rejects hostile input %j before Core', async (source) => {
    const call = core(), result = await handleCoreAction('core_desktop_link', { rid: 'bad', ...source }, call);
    expect(result.fields.ok).toBe(false); expect(call).not.toHaveBeenCalled();
  });
});
