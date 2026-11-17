// Fixture-only Core RPC; the host uses the production summary/allowlist code.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { handleCoreAction } from '../../desktop/src/lib/remoteCore.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../docs/core/fixtures/api/${name}`, import.meta.url)));
const context = fixture('context_package_preview.v1.json');
const source = context.package.source;
const attempt = { ...fixture('attempt_detail.v2.json').attempt, id: source.attempt_id, task_id: source.task_id, provider: source.provider };
const task = { ...fixture('task_detail_v2.json').task, id: source.task_id, project_id: source.project_id, title: 'Validar Mobile F4', attempts: [attempt], current_attempt: attempt, current_attempt_id: attempt.id };
const snapshot = { snapshot_version: 1, cursor: { events: 0 }, core: { health: 'ok', version: 'e2e' }, projects: { items: [{ id: source.project_id, name: 'Mobile F4', active: 1 }], total: 1 }, active_tasks: { items: [{ id: task.id, project_id: task.project_id, title: task.title, status: 'running' }], total: 1 }, attention: { items: [], total: 0 } };

for await (const line of createInterface({ input: process.stdin })) {
  try {
    const { action, args, scenario = 'ready' } = JSON.parse(line);
    const registry = { ...fixture('provider_capabilities.v1.json'), status: 'ready', refreshing: false, checked_at_ms: Date.now() };
    registry.providers[1].id = attempt.provider;
    if (scenario === 'blocked') {
      registry.providers[1].matrix.capabilities.answer = { state: 'environment_blocked', block: 'cli_missing' };
      registry.providers[1].matrix.capabilities.steer = { state: 'unsupported' };
    }
    const report = fixture('usage_report.v1.json');
    for (const provider of report.providers) if (provider.snapshot) provider.snapshot.observed_at_ms = Date.now();
    if (scenario === 'rate_limited') { report.providers[0].error = { kind: 'rate_limited', message: 'Fixture rate limit' }; report.providers[0].throttled = true; }
    const queries = [];
    const result = await handleCoreAction(action, args, async (command) => {
      queries.push(command);
      switch (command) {
        case 'compact_snapshot': return snapshot;
        case 'events': return { items: [], next_cursor: 0, head_seq: 0, has_more: false };
        case 'task_detail': return { task: { ...task, status: 'running' } };
        case 'task_detail_v2': return { task };
        case 'attempt_detail': case 'attempt_detail_v2': return { attempt };
        case 'attention_list': case 'activity_list': return { items: [], next_cursor: null, has_more: false };
        case 'provider_capabilities': return registry;
        case 'context_package_get':
          if (scenario === 'corrupt') throw new Error('context_store_corrupt: PRIVATE_SENTINEL');
          if (scenario === 'absent') throw new Error('context_store_not_found: fixture');
          if (scenario === 'partial') {
            const partial = structuredClone(context);
            partial.summary.completeness = 'partial';
            partial.summary.counts.redactions = 2;
            partial.summary.counts.truncated_fields = 1;
            partial.summary.notes = ['redacted', 'truncated'];
            return partial;
          }
          return context;
        case 'usage_report': return { v: 1, status: 'ready', refreshing: false, report };
        default: throw new Error(`Unexpected E2E mutation: ${command}`);
      }
    });
    process.stdout.write(`${JSON.stringify({ event: { type: result.type, ...result.fields }, queries })}\n`);
  } catch (error) { process.stdout.write(`${JSON.stringify({ error: String(error) })}\n`); }
}
