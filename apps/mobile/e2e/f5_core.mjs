// Simulated Core RPC for native UI QA. Security/durability use Rust integration tests.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { handleCoreAction } from '../../desktop/src/lib/remoteCore.js';
import { handleMobileAction } from '../../desktop/src/lib/remoteMobile.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../docs/core/fixtures/api/${name}`, import.meta.url)));
let epoch, state;
const fail = (code) => { throw new Error(`${code}: PRIVATE_SENTINEL`); };
const ATTEMPT = 't1-a1', TASK = 't1', PROJECT = 'p1';
const evidence = (value, provenance = 'verified') => ({ value, provenance });
for await (const line of createInterface({ input: process.stdin })) {
  try {
    const frame = JSON.parse(line);
    if (epoch !== frame.epoch) { epoch = frame.epoch; state = { seq: epoch * 100, question: false, launch: false, review: false, stopped: false, queue: [], mutations: 0 }; }
    const { action, args, scenario } = frame;
    const blocked = scenario === 'elevated', policy = blocked ? 'elevated' : 'confirm';
    const attempt = { ...fixture('attempt_detail.v2.json').attempt, id: ATTEMPT, task_id: TASK, n: 1, status: state.stopped ? 'stopped' : 'running', artifacts: [], review: null };
    const task = { ...fixture('task_detail_v2.json').task, id: TASK, project_id: PROJECT, title: 'Validar Mobile F5', status: attempt.status, state: 'active', attempts: [attempt], current_attempt: attempt, current_attempt_id: ATTEMPT, attempt_count: 1 };
    const items = [
      !state.question && { id: 'att_question', category: 'question', target_kind: 'attempt', target_id: ATTEMPT },
      !state.launch && { id: 'att_launch', category: 'approval', target_kind: 'attempt', target_id: ATTEMPT, launch_approval: true },
      !state.review && { id: 'att_review', category: 'review_ready', target_kind: 'task', target_id: TASK },
    ].filter(Boolean).map((a) => ({ ...a, project_id: PROJECT, status: 'active', severity: 'high', occurrence: 1, created_at: Date.now() }));
    const snapshot = { snapshot_version: 1, cursor: { events: state.seq }, core: { health: 'ok', version: 'f5-e2e' }, projects: { items: [{ id: PROJECT, name: 'Mobile F5', active: 1 }], total: 1 }, active_tasks: { items: [{ id: TASK, project_id: PROJECT, title: task.title, status: attempt.status }], total: 1 }, attention: { items, total: items.length } };
    const queries = [];
    let effect = null, drop = false;
    const changed = (kind, details = {}) => { state.seq++; state.mutations++; effect = { kind, ...details, attempt_id: ATTEMPT, mutations: state.mutations }; };
    const core = async (command, payload) => {
      queries.push(command);
      switch (command) {
        case 'compact_snapshot': return snapshot;
        case 'events': return { events: [], next_cursor: state.seq, head_seq: state.seq, has_more: false };
        case 'task_detail': case 'task_detail_v2': return { task };
        case 'attempt_detail': case 'attempt_detail_v2': return { attempt };
        case 'attention_list': return { items: items.filter((a) => !payload.category || a.category === payload.category), next_cursor: null, has_more: false };
        case 'activity_list': return { items: [], next_cursor: null, has_more: false };
        case 'provider_capabilities': return fixture('provider_capabilities.v1.json');
        case 'context_package_get': fail('context_store_not_found'); break;
        default: fail('unexpected_rpc');
      }
    };
    const invoke = async (command, input) => {
      queries.push(command);
      const a = input.args;
      if (input.userId !== 7 || input.sessionId !== 1) fail('unauthorized');
      if (a.attempt_id !== ATTEMPT) fail('stale_attempt');
      const guard = () => { if (blocked) fail('policy_out_of_band_required'); if (scenario === 'stale') fail('stale_attempt'); };
      if (command === 'orch_mobile_question') {
        if (state.question) fail('already_answered');
        if (a.reply) { guard(); state.question = true; changed('answer'); return { status: 'Answered', attempt_id: ATTEMPT, request_id: 'q-provider' }; }
        return { attempt_id: ATTEMPT, task_id: TASK, project_id: PROJECT, policy, questions: [{ kind: 'question', request_id: 'q-provider', asked_at: 123, subject: 'Que archivo revisamos?' }] };
      }
      if (command === 'orch_mobile_launch_approval') {
        if (a.decision) {
          guard(); if (scenario === 'expired') fail('approval_expired'); if (state.launch) fail('already_resolved');
          state.launch = true; changed('launch', { decision: a.decision }); return { outcome: a.decision === 'approve' ? 'approved' : 'rejected', attempt_id: ATTEMPT };
        }
        return { status: scenario === 'expired' ? 'expired' : state.launch ? 'resolved' : 'pending', deadline_ms: Date.now() + 1800000, attempt_id: ATTEMPT, task_id: TASK, project_id: PROJECT, provider: 'claude', profile: 'explorar', worktree_strategy: 'new', policy, blocked_reason: null, can_decide: !blocked && !state.launch && scenario !== 'expired' };
      }
      if (command === 'orch_mobile_review') {
        if (state.review) fail('stale_review');
        if (a.open_desktop) return { outcome: 'desktop_requested', selection: { projectId: PROJECT, taskId: TASK, attemptId: ATTEMPT } };
        const head = 'a'.repeat(40), readable = scenario !== 'large';
        if (a.decision) {
          guard(); if (scenario === 'head_moved') fail('head_moved'); if (!readable) fail('desktop_required');
          state.review = true; changed('review', { head_commit: a.decision.head_commit, decision: a.decision.verdict });
          return { outcome: 'recorded', attempt_id: ATTEMPT, head_commit: head, decision: a.decision.verdict };
        }
        return { attempt_id: ATTEMPT, task_id: TASK, project_id: PROJECT, review_id: 'att_review', policy, can_decide: readable && !blocked, blocked_reason: !readable ? 'desktop_required' : blocked ? 'policy_out_of_band_required' : null,
          proof: { objective: { ...evidence({ title: 'Validar Mobile F5', objective: 'Revisar el cambio completo' }) }, revision: { head_commit: evidence(head) }, decision: { head_commit: head, can_decide: true }, changes: { files: evidence(1) }, summary: evidence('Pruebas declaradas por agente', 'agent_reported'), tests: evidence(null, 'unknown'), artifacts: { items: [], provenance: 'unknown' }, completeness: { state: 'partial', gaps: ['tests_not_collected'] } },
          diff: { readable, files: readable ? [{ path: 'login.js', patch: '@@ -1 +1 @@\n-anterior\n+corregido' }] : [] } };
      }
      if (command === 'orch_mobile_controls') {
        const op = a.operation;
        if (op) {
          if (op.kind !== 'cancel') guard();
          if (op.kind === 'queue') {
            const existing = state.queue.find((q) => q.request_id === op.request_id);
            if (existing && existing.body !== op.body) fail('request_conflict');
            if (scenario === 'unsupported') fail('queue_unsupported');
            if (!existing) { state.queue.push({ queue_id: `${ATTEMPT}-q${state.queue.length + 1}`, request_id: op.request_id, body: op.body, status: scenario === 'queue_failure' ? 'failed' : 'queued', failure: scenario === 'queue_failure' ? 'adapter_error' : null }); changed('queue', { request_id: op.request_id }); }
            drop = scenario === 'lost_ack' && !existing;
            return { attempt_id: ATTEMPT, queue_id: (existing || state.queue.at(-1)).queue_id, status: existing ? 'Replayed' : 'Queued' };
          }
          if (op.kind === 'cancel') { const item = state.queue.find((q) => q.queue_id === op.queue_id); if (!item || item.status !== 'queued') fail('stale_queue'); item.status = 'cancelled'; changed('cancel'); return { attempt_id: ATTEMPT, queue_id: item.queue_id, status: 'Cancelled' }; }
          if (scenario === 'stop_failure') fail('attempt_stop_unavailable');
          if (scenario === 'stop_timeout') { drop = true; return null; }
          state.stopped = true; changed('stop'); return { attempt_id: ATTEMPT, status: 'Stopped' };
        }
        const map = (q, i) => ({ ...q, position: i + 1 });
        return { attempt_id: ATTEMPT, task_id: TASK, project_id: PROJECT, status: attempt.status, request_status: state.queue.find((q) => q.request_id === a.request_id) || null,
          queue: { items: state.queue.filter((q) => q.status === 'queued').map(map), finished: state.queue.filter((q) => q.status !== 'queued').map(map), pending_total: state.queue.filter((q) => q.status === 'queued').length },
          queue_control: { policy, allowed: !blocked && !state.stopped && scenario !== 'unsupported', reason: blocked ? 'policy_out_of_band_required' : scenario === 'unsupported' ? 'queue_unsupported' : null },
          stop_control: { policy, allowed: !blocked && !state.stopped && scenario !== 'unsupported', reason: blocked ? 'policy_out_of_band_required' : scenario === 'unsupported' ? 'unsupported_capability' : null } };
      }
      fail('unexpected_private_rpc');
    };
    const result = action.startsWith('mobile_')
      ? await handleMobileAction(action, args, frame.mobile, invoke, async (selection) => { effect = { kind: 'desktop_opened', selection }; })
      : await handleCoreAction(action, args, core);
    process.stdout.write(`${JSON.stringify({ event: { type: result.type, ...result.fields }, queries, effect, drop })}\n`);
  } catch (error) { process.stdout.write(`${JSON.stringify({ error: String(error) })}\n`); }
}
