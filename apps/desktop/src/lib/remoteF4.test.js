import { describe, expect, it, vi } from 'vitest';

import { createCoreLink } from '../../../mobile/src/observe/link.js';
import capabilities from '../../../../docs/core/fixtures/api/provider_capabilities.v1.json';
import context from '../../../../docs/core/fixtures/api/context_package_preview.v1.json';
import usage from '../../../../docs/core/fixtures/api/usage_report.v1.json';
import { handleCoreAction } from './remoteCore.js';

describe('LXO-48 · recorrido de lectura Mobile F4', () => {
  it('Mobile empareja por rid los tres resúmenes y el host solo llama a las queries permitidas', async () => {
    const source = context.package.source;
    const attempt = { id: source.attempt_id, task_id: source.task_id, provider: source.provider };
    const registry = { ...structuredClone(capabilities), status: 'ready', refreshing: false, checked_at_ms: 1000 };
    registry.providers[1].id = attempt.provider;
    registry.providers[1].transport = 'stream_json';
    let corrupt = false;
    const call = vi.fn().mockImplementation(async (cmd, args) => {
      if (cmd === 'attempt_detail_v2') {
        expect(args).toEqual({ attempt_id: attempt.id });
        return { attempt };
      }
      if (cmd === 'provider_capabilities') return registry;
      if (cmd === 'context_package_get') {
        if (corrupt) throw new Error('context_store_corrupt: SENTINEL');
        return context;
      }
      if (cmd === 'usage_report') return { v: 1, status: 'ready', refreshing: false, report: usage };
      throw new Error('La vista F4 intentó mutar el Core');
    });
    let sequence = 0;
    const frames = [];
    const link = createCoreLink({
      newRid: () => `f4-${++sequence}`,
      send: async (command) => {
        const response = await handleCoreAction(command.action, command.args, call);
        const frame = { type: response.type, ...response.fields };
        frames.push(frame);
        expect(link.handleEvent(frame)).toBe(true);
        return { ok: true };
      },
    });
    try {
      const matrix = await link.request('core_attempt_capabilities', { attempt_id: attempt.id });
      expect(matrix.data.summary.capabilities.answer.state).toBe('available');
      registry.providers[1].matrix.capabilities.answer = { state: 'environment_blocked', block: 'cli_missing' };
      const blocked = await link.request('core_attempt_capabilities', { attempt_id: attempt.id, refresh: true });
      expect(blocked.data.summary.capabilities.answer.state).toBe('environment_blocked');

      const pkg = await link.request('core_attempt_context', { attempt_id: attempt.id });
      expect(pkg.data.summary.status).toBe('valid');
      corrupt = true;
      const invalid = await link.request('core_attempt_context', { attempt_id: attempt.id });
      expect(invalid.data.summary).toMatchObject({ status: 'invalid', portable: false });
      expect(invalid.data.summary).not.toHaveProperty('package_id');

      const report = await link.request('core_usage');
      expect(report.data.summary.providers.map((provider) => provider.status)).toEqual(['fresh', 'fresh', 'unknown', 'unsupported']);
      expect(link.pendingCount).toBe(0);
      expect(new Set(frames.map((frame) => frame.rid)).size).toBe(5);
      expect(JSON.stringify(frames)).not.toContain(context.package.objective);
      expect(JSON.stringify(frames)).not.toContain('SENTINEL');
      expect(call.mock.calls.every(([cmd]) => ['attempt_detail_v2', 'provider_capabilities', 'context_package_get', 'usage_report'].includes(cmd))).toBe(true);
    } finally {
      link.close();
    }
  });
});
