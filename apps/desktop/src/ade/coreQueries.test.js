import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ATTENTION_LIMIT, TASK_PAGE_LIMIT, listAdeActivity, listAdeTasks, queryAdeCore, readAdeResources } from './coreQueries';
import { ACTIVITY_V1_MESSAGE_KEYS } from './activityMessages.js';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

afterEach(() => invoke.mockReset());

function activityItem(overrides = {}) {
  return {
    seq: '131',
    event_id: '0192f0a0-7b1c-7000-8000-0000000000a1',
    ts: 1_760_000_130_000,
    kind: 'task.created',
    v: 1,
    class: 'state',
    message_key: 'activity.task.created',
    args: { title: 'Implementar X', agent: 'claude', depth: 0, external: false },
    visual: 'info',
    fallback: false,
    target: { kind: 'task', id: 'task-1' },
    project_id: 'project-1',
    run_id: 'run-1',
    actor: { kind: 'person', id: null },
    provenance: { channel: 'ui', client_id: null },
    correlation_id: null,
    ...overrides,
  };
}

function activityPage(overrides = {}) {
  return {
    v: 1,
    projection: 1,
    order: 'asc',
    items: [activityItem()],
    next_cursor: '131',
    has_more: false,
    head_seq: '131',
    limit: 100,
    ...overrides,
  };
}

const ACTIVITY_ARGS_CONTRACTS = [
  ['activity.run.created', { root_task: 'task-1' }],
  ['activity.run.closed', { forced: false, stopped_total: 2 }],
  ['activity.run.removed', { tasks: 2 }],
  ['activity.task.created', { title: 'Implementar', agent: 'codex', depth: 1, external: false }, { role: 'worker', model: 'gpt', parent: 'task-0' }],
  ['activity.task.phase_started', {}],
  ['activity.task.phase_done', {}],
  ['activity.task.question', { message_id: 7, to: 'task-1' }],
  ['activity.task.reply', { question_id: 6, message_id: 7 }],
  ['activity.task.removed', { cause: 'launch_failed' }],
  ['activity.task.review_requested', { branch: 'feature/activity' }],
  ['activity.decision.review.accepted', { decision_id: 1, has_comment: true }],
  ['activity.decision.review.rejected', { decision_id: 1, has_comment: false }],
  ['activity.decision.merge.merged', { decision_id: 2, branch: 'feature/activity', squash: true }, { conflict_count: 0 }],
  ['activity.decision.merge.conflict', { decision_id: 2, branch: 'feature/activity', squash: false }, { conflict_count: 1 }],
  ['activity.decision.merge.error', { decision_id: 2, branch: 'feature/activity', squash: false }, { conflict_count: 1 }],
  ['activity.decision.merge.target_moved', { decision_id: 2, branch: 'feature/activity', squash: false }, { conflict_count: 0 }],
  ['activity.decision.pr.created', { decision_id: 3, branch: 'feature/activity', has_pr_url: true }],
  ['activity.decision.pr.already_exists', { decision_id: 3, branch: 'feature/activity', has_pr_url: false }],
  ['activity.decision.pr.error', { decision_id: 3, branch: 'feature/activity', has_pr_url: false }],
  ['activity.effect.git_merge.merged', { effect_id: 'effect-1', branch: 'feature/activity' }],
  ['activity.effect.git_merge.conflict', { effect_id: 'effect-1', branch: 'feature/activity' }],
  ['activity.effect.git_merge.error', { effect_id: 'effect-1', branch: 'feature/activity' }],
  ['activity.effect.git_push_pr.created', { effect_id: 'effect-1', branch: 'feature/activity', has_pr_url: true }],
  ['activity.effect.git_push_pr.already_exists', { effect_id: 'effect-1', branch: 'feature/activity', has_pr_url: false }],
  ['activity.effect.git_push_pr.error', { effect_id: 'effect-1', branch: 'feature/activity', has_pr_url: false }],
  ['activity.effect.git_worktree.created', { effect_id: 'effect-1', branch: 'feature/activity' }, { base: 'main' }],
  ['activity.effect.git_worktree.removed', { effect_id: 'effect-1', worktree_removed: true, branch_deleted: false }, { branch: 'feature/activity' }],
  ['activity.effect.process.launched', { effect_id: 'effect-1' }],
  ['activity.effect.process.not_launched', { effect_id: 'effect-1' }],
  ['activity.project.registered', { name: 'Lixbon', origin: 'manual', has_remote: true }],
  ['activity.project.location_added', { primary: true, fingerprint_adopted: false }],
  ['activity.project.archived', {}],
  ['activity.project.restored', {}],
  ['activity.project.relocated', { fingerprint_adopted: true, confirmed_mismatch: false }],
  ['activity.spawn.requested', {
    parent_task: 'task-1', title: 'Implementar', provider: 'codex', profile: 'default',
    shared: false, policy_status: 'ok',
  }, { role: 'worker', model: 'gpt', effort: 'high' }],
  ['activity.spawn.approved', { has_reason: true }, { task: 'task-2' }],
  ['activity.spawn.rejected', { has_reason: false }, { task: 'task-2' }],
  ['activity.spawn.launch_failed', { has_reason: true }, { task: 'task-2' }],
  ['activity.spawn.timeout', { has_reason: false }, { task: 'task-2' }],
  ['activity.spawn.coordinator_closed', { has_reason: false }, { task: 'task-2' }],
  ['activity.spawn.cancelled_run_removed', { has_reason: false }, { task: 'task-2' }],
  ['activity.environment.blocked', { provider: 'codex', profile: 'default', code: 'cli_missing' }],
  ['activity.environment.cleared', { provider: 'codex', profile: 'default', code: 'cli_missing' }],
  ['activity.attention.risk_acted', { resolution: 'acted' }],
  ['activity.attention.created', { category: 'question', severity: 'high', occurrence: 1, target_kind: 'task', target_id: 'task-1' }],
  ['activity.attention.resolved', { resolution: 'condition_cleared' }],
  ['activity.unknown', { reason: 'unknown_kind', kind: 'task.future', event_version: 2 }],
  ...['starting', 'running', 'waiting', 'awaiting_terminal_approval', 'done', 'failed', 'stopped', 'exited']
    .map((to) => [`activity.task.${to}`, { from: 'running', to }, { cause: 'agent_idle_timeout' }]),
  // Modelo Task/Attempt (LXO-233).
  ['activity.task.intent_created', { title: 'Implementar', depth: 1 }, { parent: 'task-0' }],
  ['activity.task.updated', { changed: ['title', 'spec'] }, { title: 'Nuevo' }],
  ['activity.task.discarded', {}],
  ['activity.task.restored', {}],
  ['activity.attempt.requested', { task: 'task-1', n: 1, provider: 'codex', external: false, approval_required: true }, { model: 'gpt', effort: 'high', role: 'worker', profile: 'implementar' }],
  ...['approved', 'started', 'integrated'].map((s) => [`activity.attempt.${s}`, { task: 'task-1', n: 2 }]),
  ['activity.attempt.rejected', { task: 'task-1', n: 1, cause: 'cancelled' }],
  ['activity.attempt.completed', { task: 'task-1', n: 1, has_summary: true }],
  ['activity.attempt.failed', { task: 'task-1', n: 1, reason: 'launch_failed', has_summary: false }],
  ['activity.attempt.stopped', { task: 'task-1', n: 1, from: 'running', cause: 'run_closed' }],
  ...['waiting', 'awaiting_terminal_approval', 'resumed', 'exited'].map((s) => [`activity.attempt.${s}`, { task: 'task-1', n: 1, from: 'running' }]),
  ['activity.provider_session.opened', { task: 'task-1', n: 1, provider: 'claude', resumable: true, bound: false }],
  ['activity.provider_session.bound', { task: 'task-1', binding: 'session_id' }],
  ['activity.provider_session.resumed', { task: 'task-1', n: 2 }],
  ['activity.provider_session.detached', { task: 'task-1' }],
  ['activity.provider_session.closed', { task: 'task-1', from: 'idle' }],
  ['activity.thread.created', { task: 'task-1' }],
  ['activity.thread.summarized', { task: 'task-1', has_summary: true }],
  ['activity.worktree.created', { task: 'task-1', n: 1 }, { branch: 'lx/r1/t1' }],
  ['activity.worktree.adopted', { task: 'task-1', n: 1, provenance: 'adopted' }, { branch: 'lx/r1/t1' }],
  ['activity.worktree.attached', { task: 'task-1', n: 2 }],
  ['activity.worktree.missing', { task: 'task-1' }],
  ['activity.worktree.found', { task: 'task-1' }],
  ['activity.worktree.removed', { task: 'task-1', reason: 'integrated', branch_kept: false }],
  ['activity.artifact.created', { task: 'task-1', n: 1, kind: 'report', verifiable: true }],
  ['activity.review.accepted', { task: 'task-1', n: 1, head_commit: 'abc1234', has_comment: false }],
  ['activity.review.rejected', { task: 'task-1', n: 1, head_commit: 'abc1234', has_comment: true }],
  ['activity.review.invalidated', { task: 'task-1', n: 1, head_commit: 'abc1234', observed_head: 'def5678' }],
  ['activity.core.agentic_cut', { tasks: 6, attempts: 7 }],
];

function invalidActivityArgValue(value) {
  if (typeof value === 'string') return 1;
  if (typeof value === 'boolean') return 'true';
  return '1';
}

describe('queryAdeCore', () => {
  it('solo transporta las queries observacionales permitidas', async () => {
    invoke.mockResolvedValue({
      v: 1,
      filters: { archived: 'exclude', machine: null },
      total: 0,
      projects: [],
      unassigned: {},
    });

    await queryAdeCore('projects_overview');

    expect(invoke).toHaveBeenCalledWith('orch_query', {
      query: 'projects_overview',
      args: { archived: 'exclude' },
    });
    await expect(queryAdeCore('project_archive')).rejects.toThrow('ade_query_forbidden');
    await expect(queryAdeCore('attention_detail', { attentionId: 'att_1' })).rejects.toThrow('ade_query_forbidden');
    await expect(queryAdeCore('events')).rejects.toThrow('ade_query_forbidden');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('pide projects_overview con archived del contrato y exige el eco exacto', async () => {
    invoke.mockResolvedValueOnce({
      v: 1,
      filters: { archived: 'include', machine: null },
      total: 1,
      projects: [{ id: 'project-1', name: 'Uno' }],
      unassigned: {},
    });

    await queryAdeCore('projects_overview', { archived: 'include' });

    expect(invoke).toHaveBeenCalledWith('orch_query', {
      query: 'projects_overview',
      args: { archived: 'include' },
    });

    await expect(queryAdeCore('projects_overview', { archived: 'todo' }))
      .rejects.toThrow('ade_query_invalid_request');

    invoke.mockResolvedValueOnce({
      v: 1,
      filters: { archived: 'exclude', machine: null },
      total: 0,
      projects: [],
      unassigned: {},
    });
    await expect(queryAdeCore('projects_overview', { archived: 'include' }))
      .rejects.toThrow('ade_query_invalid_response');
  });

  it('lista Activity con cursor decimal canónico y solo los filtros exactos del Core', async () => {
    invoke.mockResolvedValueOnce(activityPage());
    await listAdeActivity();
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'activity_list',
      args: { cursor: '0', limit: 100, order: 'asc' },
    });

    invoke.mockResolvedValueOnce(activityPage({
      order: 'desc',
      items: [activityItem({ seq: '49' })],
      next_cursor: '49',
      head_seq: '51',
      limit: 25,
    }));
    await listAdeActivity({
      cursor: '50',
      limit: 25,
      order: 'desc',
      projectId: ' project-1 ',
      runId: 'run-1',
      targetKind: ' task ',
      targetId: 'task-1',
    });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'activity_list',
      args: {
        cursor: '50',
        limit: 25,
        order: 'desc',
        project_id: 'project-1',
        run_id: 'run-1',
        target_kind: 'task',
        target_id: 'task-1',
      },
    });

    invoke.mockResolvedValueOnce(activityPage({
      items: [activityItem()],
      next_cursor: '131',
      head_seq: '131',
    }));
    await queryAdeCore('activity_list', { targetKind: 'task' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'activity_list',
      args: { cursor: '0', limit: 100, order: 'asc', target_kind: 'task' },
    });
  });

  it('rechaza parámetros de Activity fuera de sus tipos y rangos', async () => {
    const invalidRequests = [
      { cursor: '12x' },
      { cursor: '012' },
      { cursor: -1 },
      { cursor: 1.5 },
      { cursor: Number.MAX_SAFE_INTEGER + 1 },
      { limit: 0 },
      { limit: 501 },
      { limit: 1.5 },
      { order: 'DESC' },
      { projectId: '  ' },
      { targetId: 'task-1' },
      { eventKind: 'task.created' },
    ];
    for (const request of invalidRequests) {
      await expect(queryAdeCore('activity_list', request)).rejects.toThrow('ade_query_invalid_request');
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('normaliza siempre seq y cursores i64 como decimales canónicos y pagina sin redondearlos', async () => {
    const maxI64 = '9223372036854775807';
    invoke.mockResolvedValueOnce(activityPage({
      items: [
        activityItem({ seq: '9007199254740992' }),
        activityItem({ seq: '9007199254740993' }),
      ],
      next_cursor: '9007199254740993',
      head_seq: maxI64,
      has_more: true,
      limit: 2,
    }));

    const first = await queryAdeCore('activity_list', { cursor: Number.MAX_SAFE_INTEGER, limit: 2 });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'activity_list',
      args: { cursor: '9007199254740991', limit: 2, order: 'asc' },
    });
    expect(first.items.map((item) => item.seq)).toEqual(['9007199254740992', '9007199254740993']);
    expect(first.next_cursor).toBe('9007199254740993');
    expect(first.head_seq).toBe(maxI64);

    invoke.mockResolvedValueOnce(activityPage({
      items: [activityItem({ seq: maxI64 })],
      next_cursor: maxI64,
      head_seq: maxI64,
      limit: 1,
    }));
    const second = await queryAdeCore('activity_list', { cursor: first.next_cursor, limit: 1 });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'activity_list',
      args: { cursor: '9007199254740993', limit: 1, order: 'asc' },
    });
    expect(second.items[0].seq).toBe(maxI64);
    expect(second.next_cursor).toBe(maxI64);
    expect(second.head_seq).toBe(maxI64);

    invoke.mockResolvedValueOnce(activityPage({
      order: 'desc',
      items: [activityItem({ seq: '9223372036854775806' })],
      next_cursor: '9223372036854775806',
      head_seq: maxI64,
      limit: 1,
    }));
    const descending = await queryAdeCore('activity_list', {
      cursor: maxI64,
      limit: 1,
      order: 'desc',
    });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'activity_list',
      args: { cursor: maxI64, limit: 1, order: 'desc' },
    });
    expect(descending.items[0].seq).toBe('9223372036854775806');
    expect(descending.next_cursor).toBe('9223372036854775806');
    expect(descending.head_seq).toBe(maxI64);
  });

  it('rechaza cursores de continuación que difieren solo por uno sobre MAX_SAFE_INTEGER', async () => {
    invoke.mockResolvedValueOnce(activityPage({
      items: [activityItem({ seq: '9007199254740993' })],
      next_cursor: '9007199254740992',
      head_seq: '9007199254740994',
      has_more: true,
      limit: 1,
    }));
    await expect(queryAdeCore('activity_list', { cursor: Number.MAX_SAFE_INTEGER, limit: 1 }))
      .rejects.toThrow('ade_query_invalid_response');
  });

  it('rechaza args de Activity que no pertenecen a la message_key documentada', async () => {
    const valid = activityPage();
    for (const extra of ['body', 'private_content']) {
      invoke.mockResolvedValueOnce({
        ...valid,
        items: [activityItem({ args: { ...valid.items[0].args, [extra]: 'dato privado' } })],
      });
      await expect(queryAdeCore('activity_list')).rejects.toThrow('ade_query_invalid_response');
    }

    invoke.mockResolvedValueOnce({
      ...valid,
      items: [activityItem({ message_key: 'activity.unlisted', args: { body: 'dato privado' } })],
    });
    await expect(queryAdeCore('activity_list')).rejects.toThrow('ade_query_invalid_response');
  });

  it.each(['unknown_kind', 'unsupported_version', 'invalid_payload'])(
    'acepta activity.unknown con reason contractual %s',
    async (reason) => {
      const response = activityPage({
        items: [activityItem({
          message_key: 'activity.unknown',
          args: { reason, kind: 'task.future', event_version: 2 },
          fallback: true,
        })],
      });
      invoke.mockResolvedValueOnce(response);

      await expect(queryAdeCore('activity_list')).resolves.toMatchObject({
        items: [expect.objectContaining({
          message_key: 'activity.unknown',
          args: { reason, kind: 'task.future', event_version: 2 },
        })],
      });
    },
  );

  it('rechaza un reason no contractual de activity.unknown', async () => {
    invoke.mockResolvedValueOnce(activityPage({
      items: [activityItem({
        message_key: 'activity.unknown',
        args: { reason: 'PRIVATE_REASON_TOKEN', kind: 'task.future', event_version: 2 },
        fallback: true,
      })],
    }));

    await expect(queryAdeCore('activity_list')).rejects.toThrow('ade_query_invalid_response');
  });

  it('exige los argumentos requeridos, opcionales y tipos exactos por cada message_key', async () => {
    expect(ACTIVITY_ARGS_CONTRACTS.map(([messageKey]) => messageKey).sort())
      .toEqual([...ACTIVITY_V1_MESSAGE_KEYS].sort());

    for (const [messageKey, required, optional = {}] of ACTIVITY_ARGS_CONTRACTS) {
      const allArgs = { ...required, ...optional };
      const makeResponse = (args) => activityPage({
        items: [activityItem({ message_key: messageKey, args })],
      });

      invoke.mockResolvedValueOnce(makeResponse(allArgs));
      await expect(queryAdeCore('activity_list')).resolves.toMatchObject({
        items: [expect.objectContaining({ message_key: messageKey, args: allArgs })],
      });

      invoke.mockResolvedValueOnce(makeResponse(required));
      await expect(queryAdeCore('activity_list')).resolves.toMatchObject({
        items: [expect.objectContaining({ message_key: messageKey, args: required })],
      });

      for (const key of Object.keys(required)) {
        const missing = { ...allArgs };
        delete missing[key];
        invoke.mockResolvedValueOnce(makeResponse(missing));
        await expect(queryAdeCore('activity_list')).rejects.toThrow('ade_query_invalid_response');
      }

      invoke.mockResolvedValueOnce(makeResponse({ ...allArgs, unlisted: 'extra' }));
      await expect(queryAdeCore('activity_list')).rejects.toThrow('ade_query_invalid_response');

      for (const [key, value] of Object.entries(allArgs)) {
        invoke.mockResolvedValueOnce(makeResponse({ ...allArgs, [key]: invalidActivityArgValue(value) }));
        await expect(queryAdeCore('activity_list')).rejects.toThrow('ade_query_invalid_response');
      }
    }
  });

  it('conserva páginas con texto libre vacío ya normalizado por Core y rechaza IDs o tokens vacíos', async () => {
    const emptyTextCases = [
      ['activity.task.created', 'title'],
      ['activity.spawn.requested', 'title'],
      ['activity.project.registered', 'name'],
      ['activity.task.review_requested', 'branch'],
      ...[
        'activity.decision.merge.merged',
        'activity.decision.merge.conflict',
        'activity.decision.merge.error',
        'activity.decision.merge.target_moved',
        'activity.decision.pr.created',
        'activity.decision.pr.already_exists',
        'activity.decision.pr.error',
        'activity.effect.git_merge.merged',
        'activity.effect.git_merge.conflict',
        'activity.effect.git_merge.error',
        'activity.effect.git_push_pr.created',
        'activity.effect.git_push_pr.already_exists',
        'activity.effect.git_push_pr.error',
        'activity.effect.git_worktree.created',
      ].map((messageKey) => [messageKey, 'branch']),
      ['activity.effect.git_worktree.created', 'base'],
      ['activity.effect.git_worktree.removed', 'branch'],
    ];
    const argsByKey = new Map(ACTIVITY_ARGS_CONTRACTS.map(([messageKey, required, optional = {}]) => [
      messageKey,
      { ...required, ...optional },
    ]));
    const whitespaceNormalizedByCore = ' \t\n '.trim();

    for (const [messageKey, field] of emptyTextCases) {
      const args = { ...argsByKey.get(messageKey), [field]: whitespaceNormalizedByCore };
      const first = activityItem({ message_key: messageKey, args });
      const second = activityItem({
        seq: '132',
        event_id: '0192f0a0-7b1c-7000-8000-0000000000a2',
      });
      invoke.mockResolvedValueOnce(activityPage({
        items: [first, second],
        next_cursor: '132',
        head_seq: '132',
      }));

      await expect(queryAdeCore('activity_list')).resolves.toMatchObject({
        items: [
          expect.objectContaining({ message_key: messageKey, args }),
          expect.objectContaining({ event_id: second.event_id }),
        ],
      });
    }

    const controls = [
      ['activity.run.created', 'root_task'],
      ['activity.task.created', 'agent'],
      ['activity.effect.process.launched', 'effect_id'],
    ];
    for (const [messageKey, field] of controls) {
      const args = { ...argsByKey.get(messageKey), [field]: '' };
      invoke.mockResolvedValueOnce(activityPage({
        items: [activityItem({ message_key: messageKey, args })],
      }));
      await expect(queryAdeCore('activity_list')).rejects.toThrow('ade_query_invalid_response');
    }
  });

  it('valida versión, cursor exclusivo, filtros exactos y DTO de Activity', async () => {
    const request = {
      cursor: 130,
      limit: 1,
      order: 'asc',
      projectId: 'project-1',
      runId: 'run-1',
      targetKind: 'task',
      targetId: 'task-1',
    };
    const valid = activityPage({
      items: [activityItem()],
      next_cursor: '131',
      head_seq: '131',
      limit: 1,
    });
    const invalidResponses = [
      { ...valid, v: 2 },
      { ...valid, projection: 2 },
      { ...valid, order: 'desc' },
      { ...valid, next_cursor: '0131' },
      { ...valid, head_seq: 130 },
      { ...valid, items: [activityItem({ project_id: 'project-2' })] },
      { ...valid, items: [activityItem({ run_id: 'run-2' })] },
      { ...valid, items: [activityItem({ target: { kind: 'run', id: 'task-1' } })] },
      { ...valid, items: [activityItem({ seq: 130 })] },
      { ...valid, items: [activityItem({ payload: { secret: 'raw event' } })] },
      { ...valid, items: [activityItem({ args: ['raw event'] })] },
    ];
    for (const response of invalidResponses) {
      invoke.mockResolvedValueOnce(response);
      await expect(queryAdeCore('activity_list', request)).rejects.toThrow('ade_query_invalid_response');
    }

    invoke.mockResolvedValueOnce(valid);
    await expect(queryAdeCore('activity_list', request)).resolves.toEqual(valid);
  });

  it('transporta attention_list con limit fijo, filtros del contrato y cursor opaco', async () => {
    const attentionItem = {
      id: 'att_1',
      category: 'question',
      severity: 'high',
      status: 'active',
      target_kind: 'task',
      target_id: 'task-1',
      project_id: 'project-1',
      run_id: null,
      occurrence: 1,
      created_at: 1_000,
      resolved_at: null,
      resolution: null,
    };
    invoke.mockResolvedValue({
      v: 1,
      items: [attentionItem],
      next_cursor: 'cursor-1',
      has_more: true,
      limit: ATTENTION_LIMIT,
    });

    await queryAdeCore('attention_list');
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'attention_list',
      args: { limit: ATTENTION_LIMIT },
    });

    await queryAdeCore('attention_list', {
      projectId: 'project-1',
      category: 'review_ready',
      severity: 'critical',
      cursor: 'cursor-1',
    });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'attention_list',
      args: {
        limit: ATTENTION_LIMIT,
        project_id: 'project-1',
        category: 'review_ready',
        severity: 'critical',
        cursor: 'cursor-1',
      },
    });

    await expect(queryAdeCore('attention_list', { category: 'unknown' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('attention_list', { severity: 'urgent' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('attention_list', { cursor: '' }))
      .resolves.toBeTruthy();
  });

  it('rechaza páginas de Attention que no cumplen el contrato de LXO-89', async () => {
    const valid = {
      v: 1,
      items: [{
        id: 'att_1', category: 'risk', severity: 'high', status: 'active', target_kind: 'task',
        target_id: 'task-1', project_id: null, run_id: null, occurrence: 1, created_at: 1,
        resolved_at: null, resolution: null,
      }],
      next_cursor: null,
      has_more: false,
      limit: ATTENTION_LIMIT,
    };

    invoke.mockResolvedValue({ ...valid, v: 2 });
    await expect(queryAdeCore('attention_list')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, has_more: true, next_cursor: null });
    await expect(queryAdeCore('attention_list')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, limit: 500 });
    await expect(queryAdeCore('attention_list')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...valid,
      items: [{ ...valid.items[0], category: 'unknown' }],
    });
    await expect(queryAdeCore('attention_list')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, items: [{ ...valid.items[0], status: 'resolved' }] });
    await expect(queryAdeCore('attention_list')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(valid);
    await expect(queryAdeCore('attention_list')).resolves.toEqual(valid);
  });

  it('listAdeTasks exige un Project durable y usa active por defecto', async () => {
    invoke.mockResolvedValue({
      v: 1,
      project_id: 'project-1',
      filters: { status: 'active' },
      limit: TASK_PAGE_LIMIT,
      tasks: [],
      has_more: false,
      next_cursor: null,
    });

    await listAdeTasks('project-1');
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'tasks_by_project',
      args: { project_id: 'project-1', status: 'active', limit: TASK_PAGE_LIMIT },
    });

    await expect(listAdeTasks('')).rejects.toThrow('ade_query_invalid_request');
  });

  it('transporta target_kind y target_id juntos, valida el tipo y exige que la página corresponda al target', async () => {
    const row = {
      id: 'att_1', category: 'question', severity: 'high', status: 'active', target_kind: 'task',
      target_id: 'task-1', project_id: 'project-1', run_id: null, occurrence: 1, created_at: 1,
      resolved_at: null, resolution: null,
    };
    const response = { v: 1, items: [row], next_cursor: 'cursor-1', has_more: true, limit: ATTENTION_LIMIT };
    invoke.mockResolvedValue(response);

    await queryAdeCore('attention_list', { targetKind: 'task', targetId: 'task-1' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'attention_list',
      args: { limit: ATTENTION_LIMIT, target_kind: 'task', target_id: 'task-1' },
    });

    await queryAdeCore('attention_list', { targetKind: 'task', targetId: 'task-1', category: 'question', cursor: 'cursor-1' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'attention_list',
      args: { limit: ATTENTION_LIMIT, target_kind: 'task', target_id: 'task-1', category: 'question', cursor: 'cursor-1' },
    });

    invoke.mockClear();
    await expect(queryAdeCore('attention_list', { targetKind: 'task' })).rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('attention_list', { targetId: 'task-1' })).rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('attention_list', { targetKind: 'attention', targetId: 'x' })).rejects.toThrow('ade_query_invalid_request');
    expect(invoke).not.toHaveBeenCalled();

    // No se recorta una página ajena en cliente: se rechaza entera.
    invoke.mockResolvedValue({ ...response, items: [row, { ...row, id: 'att_2', target_id: 'task-2' }] });
    await expect(queryAdeCore('attention_list', { targetKind: 'task', targetId: 'task-1' })).rejects.toThrow('ade_query_invalid_response');
    invoke.mockResolvedValue({ ...response, items: [{ ...row, target_kind: 'run' }] });
    await expect(queryAdeCore('attention_list', { targetKind: 'task', targetId: 'task-1' })).rejects.toThrow('ade_query_invalid_response');
  });

  it('rechaza páginas incompatibles con la versión y el contrato del Core', async () => {
    invoke.mockResolvedValue({
      v: 2,
      project_id: 'project-1',
      filters: { status: 'active' },
      limit: 50,
      tasks: [],
      has_more: true,
      next_cursor: null,
    });

    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1' }))
      .rejects.toThrow('ade_query_invalid_response');
  });

  it('transporta tasks_by_project con los tres status del contrato, limit fijo y cursor opaco', async () => {
    const task = {
      id: 'task-1', run_id: 'run-1', parent_id: null, root_id: 'task-1', status: 'running',
      title: 'Implementar X', provider: 'claude', model: null, created_at: 1_000, updated_at: 2_000,
    };
    const page = (status) => ({
      v: 1,
      project_id: 'project-1',
      filters: { status },
      limit: TASK_PAGE_LIMIT,
      tasks: [task],
      has_more: false,
      next_cursor: null,
    });

    invoke.mockResolvedValue(page('active'));
    // `limit` no se acepta desde el llamador: la página fija es la del contrato y el cursor depende de ella.
    await queryAdeCore('tasks_by_project', { projectId: 'project-1', limit: 100 });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'tasks_by_project',
      args: { project_id: 'project-1', status: 'active', limit: TASK_PAGE_LIMIT },
    });

    invoke.mockResolvedValue(page('final'));
    await queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'tasks_by_project',
      args: { project_id: 'project-1', status: 'final', limit: TASK_PAGE_LIMIT },
    });

    invoke.mockResolvedValue(page('all'));
    await queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'all', cursor: 'cursor-1' });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'tasks_by_project',
      args: { project_id: 'project-1', status: 'all', limit: TASK_PAGE_LIMIT, cursor: 'cursor-1' },
    });

    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'done' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'todo' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('tasks_by_project', { projectId: '  ' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', cursor: 7 }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', cursor: '   ' }))
      .rejects.toThrow('ade_query_invalid_request');
  });

  it('exige el eco exacto de project_id, status y limit, y rechaza Tasks incompletas', async () => {
    const task = {
      id: 'task-1', run_id: 'run-1', parent_id: null, root_id: 'task-1', status: 'failed',
      title: 'Implementar X', provider: null, model: null, created_at: 1_000, updated_at: 2_000,
    };
    const valid = {
      v: 1,
      project_id: 'project-1',
      filters: { status: 'final' },
      limit: TASK_PAGE_LIMIT,
      tasks: [task],
      has_more: true,
      next_cursor: 'cursor-1',
    };

    invoke.mockResolvedValue({ ...valid, project_id: 'project-2' });
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, filters: { status: 'active' } });
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, limit: 100 });
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...valid, tasks: [{ ...task, created_at: 'ayer' }] });
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(valid);
    await expect(queryAdeCore('tasks_by_project', { projectId: 'project-1', status: 'final' }))
      .resolves.toEqual(valid);
  });
});

/** Un DTO de `resource_inventory` tal como lo da el Core (docs/core/RESOURCES.md). */
function inventario({ probe = true, projectId = null } = {}) {
  const dto = {
    v: 1,
    machine: 'machine-1',
    filters: { project_id: projectId, probe },
    repos: [
      { project_id: 'project-1', machine: 'machine-1', path: '/home/ana/app', scan: 'ok' },
      { project_id: 'project-2', machine: 'machine-1', path: '/home/ana/roto', scan: 'unavailable', reason: 'not_a_repository' },
      { project_id: 'project-3', machine: 'otro-equipo', path: '/srv/remoto', scan: 'other_machine', reason: 'other_machine' },
    ],
    worktrees: [
      {
        target: { machine: 'machine-1', project_id: 'project-1', repo: '/home/ana/app', path: '/home/ana/app.lixbon-wt/wt-c' },
        state: 'tracked',
        origin: 'task',
        physical: 'present',
        git: { registered: true, branch: 'lx/r/c', detached: false, locked: false, prunable: false },
        owner: { task_id: 't-9', run_id: 'r-1', status: 'done' },
        dirty: 'clean',
        merged: 'unmerged',
        into: 'main',
        needs_review: true,
      },
      {
        target: { machine: 'machine-1', project_id: 'project-1', repo: '/home/ana/app', path: '/srv/otro' },
        state: 'external',
        origin: 'external',
        physical: 'present',
        git: { registered: true, branch: 'ext/x', detached: false, locked: false, prunable: false },
        owner: null,
        dirty: 'dirty',
        merged: 'unknown',
        into: 'main',
        needs_review: false,
      },
    ],
    preserved_branches: [
      {
        target: { machine: 'machine-1', project_id: 'project-1', repo: '/home/ana/app', branch: 'lx/r/g' },
        branch_exists: true,
        owner: { task_id: 't-4', run_id: 'r-1', status: 'stopped' },
        merged: 'unmerged',
        into: 'main',
        needs_review: true,
      },
    ],
    warnings: {
      branches_to_review: 2,
      worktrees_by_state: {
        tracked: 1,
        missing_on_disk: 0,
        not_registered: 0,
        orphan_candidate: 0,
        external: 1,
        unknown: 0,
      },
    },
  };

  if (projectId !== null) {
    dto.repos = dto.repos.filter((repo) => repo.project_id === projectId);
    dto.worktrees = dto.worktrees.filter((worktree) => worktree.target.project_id === projectId);
    dto.preserved_branches = dto.preserved_branches.filter((branch) => branch.target.project_id === projectId);
  }
  return recontarInventario(dto);
}

function recontarInventario(dto) {
  const states = ['tracked', 'missing_on_disk', 'not_registered', 'orphan_candidate', 'external', 'unknown'];
  const allReviewable = [...dto.worktrees, ...dto.preserved_branches];
  return {
    ...dto,
    warnings: {
      ...dto.warnings,
      branches_to_review: dto.filters.probe ? allReviewable.filter((entry) => entry.needs_review === true).length : null,
      worktrees_by_state: Object.fromEntries(states.map((state) => [
        state,
        dto.worktrees.filter((worktree) => worktree.state === state).length,
      ])),
    },
  };
}

function conWorktrees(dto, worktrees) {
  return recontarInventario({ ...dto, worktrees });
}

function conRamasConservadas(dto, preserved_branches) {
  return recontarInventario({ ...dto, preserved_branches });
}

/** El mismo DTO sin sondeo: `dirty`/`merged` quedan «no evaluado» y no hay contador de avisos. */
function inventarioSinSondeo(projectId = null) {
  const out = inventario({ probe: false, projectId });
  out.worktrees = out.worktrees.map((worktree) => ({
    ...worktree,
    dirty: 'skipped',
    merged: 'skipped',
    needs_review: null,
  }));
  out.preserved_branches = out.preserved_branches.map((branch) => ({
    ...branch,
    merged: 'skipped',
    needs_review: null,
  }));
  out.warnings = { ...out.warnings, branches_to_review: null };
  return out;
}

describe('resource_inventory (adaptador de lectura)', () => {
  /** El Core hace eco de los filtros que se le piden: el mock responde a lo que se le pidió. */
  const mockInventario = (mutar) => invoke.mockImplementation((_cmd, payload) => {
    const projectId = payload.args.project_id ?? null;
    const probe = payload.args.probe ?? true;
    const dto = probe ? inventario({ projectId }) : inventarioSinSondeo(projectId);
    return mutar ? mutar(dto) : dto;
  });

  it('transporta solo los dos parámetros del contrato y el sondeo por defecto', async () => {
    mockInventario();

    await queryAdeCore('resource_inventory');
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'resource_inventory',
      args: { probe: true },
    });

    await queryAdeCore('resource_inventory', { projectId: 'project-1', probe: false });
    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'resource_inventory',
      args: { project_id: 'project-1', probe: false },
    });
  });

  it('rechaza parámetros inválidos antes de preguntar al Core', async () => {
    invoke.mockClear();

    await expect(queryAdeCore('resource_inventory', { probe: 'si' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('resource_inventory', { projectId: '  ' }))
      .rejects.toThrow('ade_query_invalid_request');
    await expect(queryAdeCore('resource_inventory', { projectId: 3 }))
      .rejects.toThrow('ade_query_invalid_request');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('exige filters.project_id en el eco del Core y project_id en readAdeResources', async () => {
    const { project_id: _omitido, ...sinProject } = inventario().filters;
    invoke.mockResolvedValue({ ...inventario(), filters: sinProject });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockClear();
    await expect(readAdeResources()).rejects.toThrow('ade_query_invalid_request');
    await expect(readAdeResources({ projectId: '   ' })).rejects.toThrow('ade_query_invalid_request');
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValue(inventario({ projectId: 'project-1' }));
    await expect(readAdeResources({ projectId: 'project-1' })).resolves.toEqual(inventario({ projectId: 'project-1' }));
    expect(invoke).toHaveBeenLastCalledWith('orch_query', { query: 'resource_inventory', args: { project_id: 'project-1', probe: true } });
  });

  it('exige que la respuesta sea la lectura que se pidió', async () => {
    invoke.mockResolvedValue(inventario({ projectId: 'project-9' }));
    await expect(queryAdeCore('resource_inventory', { projectId: 'project-1' }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...inventario(), filters: { project_id: null, probe: false } });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...inventario(), v: 2 });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(inventario());
    await expect(queryAdeCore('resource_inventory')).resolves.toEqual(inventario());
  });

  it('limita repos, worktrees y ramas conservadas al Project pedido', async () => {
    const scoped = inventario({ projectId: 'project-1' });
    invoke.mockResolvedValue(scoped);
    await expect(queryAdeCore('resource_inventory', { projectId: 'project-1' })).resolves.toEqual(scoped);

    const otherRepo = inventario().repos[1];
    invoke.mockResolvedValue({ ...scoped, repos: [...scoped.repos, otherRepo] });
    await expect(queryAdeCore('resource_inventory', { projectId: 'project-1' }))
      .rejects.toThrow('ade_query_invalid_response');

    const otherWorktree = {
      ...scoped.worktrees[0],
      target: { ...scoped.worktrees[0].target, project_id: 'project-2' },
    };
    invoke.mockResolvedValue(conWorktrees(scoped, [otherWorktree, ...scoped.worktrees.slice(1)]));
    await expect(queryAdeCore('resource_inventory', { projectId: 'project-1' }))
      .rejects.toThrow('ade_query_invalid_response');

    const otherBranch = {
      ...scoped.preserved_branches[0],
      target: { ...scoped.preserved_branches[0].target, project_id: 'project-2' },
    };
    invoke.mockResolvedValue(conRamasConservadas(scoped, [otherBranch]));
    await expect(queryAdeCore('resource_inventory', { projectId: 'project-1' }))
      .rejects.toThrow('ade_query_invalid_response');

    const nullRepo = { project_id: null, machine: 'machine-1', path: '/tmp/unassigned', scan: 'ok' };
    invoke.mockResolvedValue({ ...scoped, repos: [...scoped.repos, nullRepo] });
    await expect(queryAdeCore('resource_inventory', { projectId: 'project-1' }))
      .rejects.toThrow('ade_query_invalid_response');

    const nullProjectWorktree = {
      ...scoped.worktrees[1],
      target: { ...scoped.worktrees[1].target, project_id: null },
    };
    invoke.mockResolvedValue(conWorktrees(scoped, [scoped.worktrees[0], nullProjectWorktree]));
    await expect(queryAdeCore('resource_inventory', { projectId: 'project-1' }))
      .rejects.toThrow('ade_query_invalid_response');

    const nullProjectBranch = {
      ...scoped.preserved_branches[0],
      target: { ...scoped.preserved_branches[0].target, project_id: null },
    };
    invoke.mockResolvedValue(conRamasConservadas(scoped, [nullProjectBranch]));
    await expect(queryAdeCore('resource_inventory', { projectId: 'project-1' }))
      .rejects.toThrow('ade_query_invalid_response');
  });

  it('exige que cada target corresponda a un repo por ruta, máquina y Project', async () => {
    const base = inventario();
    const repoUnavailable = base.repos[1];

    const worktreeRepoMismatch = {
      ...base.worktrees[0],
      target: { ...base.worktrees[0].target, repo: repoUnavailable.path },
    };
    invoke.mockResolvedValue(conWorktrees(base, [worktreeRepoMismatch, base.worktrees[1]]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    const worktreeProjectMismatch = {
      ...base.worktrees[0],
      target: { ...base.worktrees[0].target, project_id: 'project-2' },
    };
    invoke.mockResolvedValue(conWorktrees(base, [worktreeProjectMismatch, base.worktrees[1]]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    const worktreeMachineMismatch = {
      ...base.worktrees[0],
      target: { ...base.worktrees[0].target, machine: null },
    };
    invoke.mockResolvedValue(conWorktrees(base, [worktreeMachineMismatch, base.worktrees[1]]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    const branchRepoMismatch = {
      ...base.preserved_branches[0],
      target: { ...base.preserved_branches[0].target, repo: repoUnavailable.path },
    };
    invoke.mockResolvedValue(conRamasConservadas(base, [branchRepoMismatch]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    const branchProjectMismatch = {
      ...base.preserved_branches[0],
      target: { ...base.preserved_branches[0].target, project_id: 'project-2' },
    };
    invoke.mockResolvedValue(conRamasConservadas(base, [branchProjectMismatch]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    const branchMachineMismatch = {
      ...base.preserved_branches[0],
      target: { ...base.preserved_branches[0].target, machine: null },
    };
    invoke.mockResolvedValue(conRamasConservadas(base, [branchMachineMismatch]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('permite candidatos externos sin Project solo cuando no se pidió un filtro', async () => {
    const base = inventario();
    const nullRepo = { project_id: null, machine: 'machine-1', path: '/tmp/unassigned', scan: 'ok' };
    const nullProjectWorktree = {
      ...base.worktrees[1],
      target: { ...base.worktrees[1].target, project_id: null, repo: '/tmp/unassigned', path: '/tmp/unassigned/wt' },
    };
    const unfiltered = recontarInventario({
      ...base,
      repos: [...base.repos, nullRepo],
      worktrees: [...base.worktrees, nullProjectWorktree],
    });

    invoke.mockResolvedValue(unfiltered);
    await expect(queryAdeCore('resource_inventory')).resolves.toEqual(unfiltered);

    const filteredBase = inventario({ projectId: 'project-1' });
    const filtered = recontarInventario({
      ...filteredBase,
      repos: [...filteredBase.repos, nullRepo],
      worktrees: [...filteredBase.worktrees, nullProjectWorktree],
    });
    invoke.mockResolvedValue(filtered);
    await expect(queryAdeCore('resource_inventory', { projectId: 'project-1' }))
      .rejects.toThrow('ade_query_invalid_response');
  });

  it('rechaza un inventario con vocabulario fuera del contrato', async () => {
    const base = inventario();

    invoke.mockResolvedValue({
      ...base,
      worktrees: [{ ...base.worktrees[0], state: 'perdido' }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...base,
      worktrees: [{ ...base.worktrees[0], dirty: 'limpio' }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...base,
      worktrees: [{ ...base.worktrees[0], merged: 'fusionado' }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...base,
      worktrees: [{ ...base.worktrees[0], physical: 'perdido' }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...base,
      worktrees: [{ ...base.worktrees[0], origin: 'sistema' }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...base,
      repos: [{ ...base.repos[0], scan: 'tal_vez' }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('no confunde «no evaluado» con «limpio» ni con «fusionado»', async () => {
    const sinSondeo = inventarioSinSondeo();
    invoke.mockResolvedValue(sinSondeo);

    const respuesta = await queryAdeCore('resource_inventory', { probe: false });
    expect(respuesta.worktrees[0].dirty).toBe('skipped');
    expect(respuesta.worktrees[0].merged).toBe('skipped');
    expect(respuesta.preserved_branches[0].merged).toBe('skipped');
    expect(respuesta.worktrees[0].needs_review).toBeNull();
    expect(respuesta.warnings.branches_to_review).toBeNull();

    // Sin sondeo el Core no evaluó nada: un «limpio» aquí es un dato inventado.
    invoke.mockResolvedValue({
      ...sinSondeo,
      worktrees: [{ ...sinSondeo.worktrees[0], dirty: 'clean' }],
    });
    await expect(queryAdeCore('resource_inventory', { probe: false }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...sinSondeo,
      worktrees: [{ ...sinSondeo.worktrees[0], needs_review: false }],
    });
    await expect(queryAdeCore('resource_inventory', { probe: false }))
      .rejects.toThrow('ade_query_invalid_response');

    // Con sondeo, «no evaluado» solo es coherente si no hay carpeta que mirar: con la carpeta
    // presente y registrada en git, el Core sí evaluó `dirty` y un `skipped` ahí es incoherente.
    const conSondeo = inventario();
    invoke.mockResolvedValue({
      ...conSondeo,
      worktrees: [{ ...conSondeo.worktrees[0], dirty: 'skipped' }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // Sin carpeta que mirar, «no evaluado» es lo coherente y se conserva tal cual: no se
    // reescribe como «limpio» ni como «fusionado».
    const sinCarpeta = conWorktrees(conSondeo, [{
      ...conSondeo.worktrees[0],
      state: 'unknown',
      physical: 'unknown',
      dirty: 'skipped',
      merged: 'unknown',
      needs_review: false,
    }]);
    invoke.mockResolvedValue(sinCarpeta);
    const respuestaSinCarpeta = await queryAdeCore('resource_inventory');
    expect(respuestaSinCarpeta.worktrees[0].dirty).toBe('skipped');
    expect(respuestaSinCarpeta.worktrees[0].merged).toBe('unknown');
  });

  it('exige que los avisos coincidan con el propio inventario', async () => {
    const base = inventario();

    invoke.mockResolvedValue({ ...base, warnings: { ...base.warnings, branches_to_review: 5 } });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...base,
      warnings: { ...base.warnings, worktrees_by_state: { ...base.warnings.worktrees_by_state, tracked: 7 } },
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // Sin sondeo no hay contador de avisos.
    const sinSondeo = inventarioSinSondeo();
    invoke.mockResolvedValue({ ...sinSondeo, warnings: { ...sinSondeo.warnings, branches_to_review: 2 } });
    await expect(queryAdeCore('resource_inventory', { probe: false }))
      .rejects.toThrow('ade_query_invalid_response');
  });

  it('exige que branches_to_review sea un número con sondeo y null sin sondeo', async () => {
    const base = inventario();

    // Con sondeo el aviso es un veredicto numérico: que falte no es «cero ramas por revisar».
    invoke.mockResolvedValue({ ...base, warnings: { ...base.warnings, branches_to_review: null } });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...base, warnings: { ...base.warnings, branches_to_review: '2' } });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // Sin sondeo el Core no evaluó nada: el contador es null, nunca un número.
    const sinSondeo = inventarioSinSondeo();
    invoke.mockResolvedValue({ ...sinSondeo, warnings: { ...sinSondeo.warnings, branches_to_review: 0 } });
    await expect(queryAdeCore('resource_inventory', { probe: false }))
      .rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(base);
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();

    invoke.mockResolvedValue(sinSondeo);
    await expect(queryAdeCore('resource_inventory', { probe: false })).resolves.toBeTruthy();
  });

  it('rechaza un estado que no cuadra con el disco ni con lo que dijo git', async () => {
    const base = inventario();
    const tracked = base.worktrees[0];

    // `tracked` con un git que no lo registra.
    invoke.mockResolvedValue({
      ...base,
      worktrees: [{ ...tracked, git: { ...tracked.git, registered: false } }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // El estado dice `tracked`, pero el disco dice `missing`: ambos campos deben concordar.
    invoke.mockResolvedValue(conWorktrees(base, [{ ...tracked, physical: 'missing' }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // A la inversa, `missing_on_disk` con el disco presente también contradice la matriz.
    invoke.mockResolvedValue(conWorktrees(base, [{
      ...tracked,
      state: 'missing_on_disk',
      git: { ...tracked.git, prunable: true },
    }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // La existencia física determina missing_on_disk; prunable solo refleja el tag que Git emitió.
    invoke.mockResolvedValue(conWorktrees(base, [{
      ...tracked,
      state: 'missing_on_disk',
      physical: 'missing',
      dirty: 'skipped',
      git: { ...tracked.git, locked: true, prunable: false },
    }]));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();

    // La etiqueta sí puede venir presente cuando Git marca la entrada como podable.
    invoke.mockResolvedValue(conWorktrees(base, [{
      ...tracked,
      state: 'missing_on_disk',
      physical: 'missing',
      dirty: 'skipped',
      git: { ...tracked.git, prunable: true },
    }]));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();

    const missingUnowned = {
      ...base.worktrees[1],
      state: 'missing_on_disk',
      physical: 'missing',
      dirty: 'skipped',
      git: { ...base.worktrees[1].git, locked: true, prunable: false },
    };
    invoke.mockResolvedValue(conWorktrees(base, [missingUnowned]));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();

    // `unknown` + `present` + git registrado + origen Task no es una combinación del productor.
    invoke.mockResolvedValue(conWorktrees(base, [{
      ...tracked,
      state: 'unknown',
      git: { ...tracked.git, registered: true },
    }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('solo acepta dirty cuando la carpeta está presente y git confirma el registro', async () => {
    const base = inventario();
    const tracked = base.worktrees[0];

    invoke.mockResolvedValue(conWorktrees(base, [{
      ...tracked,
      state: 'unknown',
      physical: 'unknown',
      dirty: 'dirty',
    }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(conWorktrees(base, [{
      ...tracked,
      state: 'not_registered',
      git: { registered: false, branch: null, detached: null, locked: null, prunable: null },
      dirty: 'clean',
    }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(conWorktrees(base, [{ ...tracked, dirty: 'skipped' }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('acepta unknown con disco no comprobable para Tasks y candidatos sin dueño', async () => {
    const base = inventario();
    const taskUnknown = {
      ...base.worktrees[0],
      state: 'unknown',
      physical: 'unknown',
      dirty: 'skipped',
    };
    const externalUnknown = {
      ...base.worktrees[1],
      state: 'unknown',
      physical: 'unknown',
      dirty: 'skipped',
    };
    const orphanUnknown = {
      ...base.worktrees[1],
      target: { ...base.worktrees[1].target, path: '/home/ana/app.lixbon-wt/orphan' },
      state: 'unknown',
      origin: 'lixbon_dir',
      physical: 'unknown',
      dirty: 'skipped',
    };
    const unknownDisk = conWorktrees(base, [taskUnknown, externalUnknown, orphanUnknown]);
    invoke.mockResolvedValue(unknownDisk);
    await expect(queryAdeCore('resource_inventory')).resolves.toEqual(unknownDisk);

    // Si existe el directorio pero git no respondió, solo una Task puede conocer el worktree.
    const gitUnavailable = conWorktrees({
      ...base,
      repos: [{ ...base.repos[0], scan: 'unavailable', reason: 'git_failed' }],
      preserved_branches: [],
    }, [{
      ...base.worktrees[0],
      state: 'unknown',
      git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
      dirty: 'skipped',
      merged: 'unknown',
      needs_review: false,
    }]);
    invoke.mockResolvedValue(gitUnavailable);
    await expect(queryAdeCore('resource_inventory')).resolves.toEqual(gitUnavailable);
  });

  it('relaciona scan del repo con registro Git y existencia de ramas', async () => {
    const base = inventario();

    const unavailableWithGitFacts = conWorktrees({
      ...base,
      repos: [{ ...base.repos[0], scan: 'unavailable', reason: 'git_failed' }],
      preserved_branches: [],
    }, base.worktrees);
    invoke.mockResolvedValue(unavailableWithGitFacts);
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    const scannedWithoutRegistration = conWorktrees(base, [{
      ...base.worktrees[0],
      state: 'unknown',
      git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
      dirty: 'skipped',
      merged: 'unknown',
      needs_review: false,
    }]);
    invoke.mockResolvedValue(scannedWithoutRegistration);
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    const registeredWithoutGitFacts = conWorktrees(base, [{
      ...base.worktrees[0],
      git: { ...base.worktrees[0].git, detached: null, locked: null, prunable: null },
    }]);
    invoke.mockResolvedValue(registeredWithoutGitFacts);
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    const unavailableBranch = conWorktrees({
      ...base,
      repos: [{ ...base.repos[0], scan: 'unavailable', reason: 'git_failed' }],
      preserved_branches: [{ ...base.preserved_branches[0], branch_exists: true }],
    }, []);
    invoke.mockResolvedValue(unavailableBranch);
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('limita los merges de worktrees cuando el escaneo Git no está disponible', async () => {
    const base = inventario();
    const unavailable = (overrides) => conWorktrees({
      ...base,
      repos: [{ ...base.repos[0], scan: 'unavailable', reason: 'git_failed' }],
      preserved_branches: [],
    }, [{
      ...base.worktrees[0],
      state: 'unknown',
      git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
      dirty: 'skipped',
      merged: 'unknown',
      needs_review: false,
      ...overrides,
    }]);

    invoke.mockResolvedValue(unavailable({ merged: 'unknown' }));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();

    // Task.merged puede suministrar el valor sin un escaneo local.
    invoke.mockResolvedValue(unavailable({ merged: 'merged' }));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();

    invoke.mockResolvedValue(unavailable({ merged: 'unmerged' }));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(unavailable({ merged: 'unmerged', needs_review: true }));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('rechaza estados y orígenes incompatibles del worktree', async () => {
    const base = inventario();
    const tracked = base.worktrees[0];
    const external = base.worktrees[1];

    // Un unknown con disco no comprobable sigue siendo una Task conocida y no puede perder su dueño.
    invoke.mockResolvedValue(conWorktrees(base, [{
      ...tracked,
      state: 'unknown',
      physical: 'unknown',
      dirty: 'skipped',
      owner: null,
      needs_review: false,
    }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // `orphan_candidate` es el worktree bajo <repo>.lixbon-wt/ que nadie declara, no otro origen.
    invoke.mockResolvedValue(conWorktrees(base, [{ ...external, state: 'orphan_candidate', origin: 'external' }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // `tracked` sin Task que lo declare no es `tracked`.
    invoke.mockResolvedValue(conWorktrees(base, [{ ...tracked, origin: 'lixbon_dir', needs_review: false }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // Un candidato unknown sin dueño todavía debe venir de una worktree que git sí listó.
    invoke.mockResolvedValue(conWorktrees(base, [{
      ...external,
      state: 'unknown',
      physical: 'unknown',
      dirty: 'skipped',
      git: { ...external.git, registered: null },
    }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // Un candidato unknown tampoco puede ser un worktree que git consultó y no registró.
    invoke.mockResolvedValue(conWorktrees(base, [{
      ...external,
      state: 'unknown',
      physical: 'unknown',
      dirty: 'skipped',
      git: { ...external.git, registered: false },
    }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('rechaza un repo o un worktree de otra máquina que no sale como other_machine', async () => {
    const base = inventario();

    // Otra máquina: el motivo es su propio motivo.
    invoke.mockResolvedValue({
      ...base,
      repos: [{ ...base.repos[2], reason: 'git_failed' }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // Una ubicación de otra máquina sale como `other_machine`, no escaneada.
    invoke.mockResolvedValue({ ...base, repos: [{ ...base.repos[0], machine: 'otro-equipo' }] });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...base, repos: [{ ...base.repos[2], machine: null }] });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({ ...base, repos: [{ ...base.repos[2], project_id: null }] });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // El Core no ejecuta git en otro host: no puede haber worktrees de otra máquina.
    invoke.mockResolvedValue({
      ...base,
      worktrees: [{ ...base.worktrees[0], target: { ...base.worktrees[0].target, machine: 'otro-equipo' } }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('no permite targets de repos other_machine y exige la máquina del Core cuando existe', async () => {
    const base = inventario();
    const targetOtherMachine = {
      ...base.worktrees[0].target,
      machine: 'otro-equipo',
      project_id: 'project-3',
      repo: '/srv/remoto',
    };
    invoke.mockResolvedValue({
      ...base,
      machine: null,
      worktrees: [{ ...base.worktrees[0], target: targetOtherMachine }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...base,
      machine: null,
      preserved_branches: [{ ...base.preserved_branches[0], target: { ...targetOtherMachine, branch: 'lx/r/g' } }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue({
      ...base,
      repos: [{ ...base.repos[0], machine: null }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('requiere machine null en repos y targets locales cuando Core no informa machine', async () => {
    const base = inventario();
    const withoutMachine = {
      ...base,
      machine: null,
      repos: base.repos.map((repo) => repo.scan === 'other_machine' ? repo : { ...repo, machine: null }),
      worktrees: base.worktrees.map((worktree) => ({
        ...worktree,
        target: { ...worktree.target, machine: null },
      })),
      preserved_branches: base.preserved_branches.map((branch) => ({
        ...branch,
        target: { ...branch.target, machine: null },
      })),
    };

    invoke.mockResolvedValue(withoutMachine);
    await expect(queryAdeCore('resource_inventory')).resolves.toEqual(withoutMachine);

    // Repo y target coinciden entre sí, pero no con machine=null del Core.
    const nonNullLocalMachine = {
      ...withoutMachine,
      repos: withoutMachine.repos.map((repo) => repo.scan === 'other_machine' ? repo : { ...repo, machine: 'machine-1' }),
      worktrees: withoutMachine.worktrees.map((worktree) => ({
        ...worktree,
        target: { ...worktree.target, machine: 'machine-1' },
      })),
      preserved_branches: withoutMachine.preserved_branches.map((branch) => ({
        ...branch,
        target: { ...branch.target, machine: 'machine-1' },
      })),
    };
    invoke.mockResolvedValue(nonNullLocalMachine);
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('rechaza una rama conservada que git da por inexistente y que a la vez pide revisar', async () => {
    const base = inventario();
    // El contador de avisos sigue cuadrando: lo único que falla es la contradicción de la rama.
    invoke.mockResolvedValue({
      ...base,
      preserved_branches: [{ ...base.preserved_branches[0], branch_exists: false }],
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('rechaza merged=unmerged en una rama conservada cuando el repo no se pudo escanear', async () => {
    const base = inventario();
    const repos = [
      { ...base.repos[0], scan: 'unavailable', reason: 'git_failed' },
      ...base.repos.slice(1),
    ];
    const preserved = {
      ...base.preserved_branches[0],
      branch_exists: null,
      merged: 'unmerged',
      needs_review: false,
    };
    invoke.mockResolvedValue(conRamasConservadas({ ...base, repos, worktrees: [] }, [preserved]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(conRamasConservadas({ ...base, repos, worktrees: [] }, [{
      ...preserved,
      merged: 'unknown',
    }]));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();
  });

  it('rechaza un veredicto needs_review incoherente con una sola variación', async () => {
    const base = inventario();
    invoke.mockResolvedValue(conWorktrees(base, [
      base.worktrees[0],
      { ...base.worktrees[1], needs_review: true },
    ]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(conRamasConservadas(base, [{
      ...base.preserved_branches[0],
      needs_review: false,
    }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('rechaza mismatches aislados de machine en repos y targets', async () => {
    const base = inventario();
    invoke.mockResolvedValue({
      ...base,
      repos: base.repos.map((repo, index) => index === 1 ? { ...repo, machine: null } : repo),
    });
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(conWorktrees(base, [
      { ...base.worktrees[0], target: { ...base.worktrees[0].target, machine: null } },
      base.worktrees[1],
    ]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(conRamasConservadas(base, [{
      ...base.preserved_branches[0],
      target: { ...base.preserved_branches[0].target, machine: null },
    }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('rechaza state y physical contradictorios en las dos direcciones', async () => {
    const base = inventario();
    const task = base.worktrees[0];
    invoke.mockResolvedValue(conWorktrees(base, [
      { ...task, physical: 'missing', dirty: 'skipped' },
      base.worktrees[1],
    ]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(conWorktrees(base, [
      { ...task, state: 'missing_on_disk' },
      base.worktrees[1],
    ]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('rechaza registered=false/null incompatibles y conserva missing_on_disk conocido por Task', async () => {
    const base = inventario();
    const task = base.worktrees[0];
    invoke.mockResolvedValue(conWorktrees(base, [{
      ...task,
      git: { registered: false, branch: null, detached: null, locked: null, prunable: null },
      dirty: 'skipped',
      merged: 'unknown',
      needs_review: false,
    }, base.worktrees[1]]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(conWorktrees(base, [{
      ...task,
      state: 'unknown',
      git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
      dirty: 'skipped',
      merged: 'unknown',
      needs_review: false,
    }, base.worktrees[1]]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    const missingUnregistered = {
      ...task,
      state: 'missing_on_disk',
      physical: 'missing',
      git: { registered: false, branch: null, detached: null, locked: null, prunable: null },
      dirty: 'skipped',
      merged: 'unknown',
      needs_review: false,
    };
    invoke.mockResolvedValue(conWorktrees(base, [missingUnregistered, base.worktrees[1]]));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();

    const unavailableRepos = [
      { ...base.repos[0], scan: 'unavailable', reason: 'git_failed' },
      ...base.repos.slice(1),
    ];
    invoke.mockResolvedValue(conWorktrees({ ...base, repos: unavailableRepos, preserved_branches: [] }, [{
      ...missingUnregistered,
      git: { registered: null, branch: null, detached: null, locked: null, prunable: null },
    }]));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();
  });

  it('rechaza incoherencias aisladas entre origin y owner', async () => {
    const base = inventario();
    const task = base.worktrees[0];
    const external = base.worktrees[1];

    invoke.mockResolvedValue(conWorktrees(base, [
      { ...task, owner: null, needs_review: false },
      external,
    ]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    invoke.mockResolvedValue(conWorktrees(base, [
      task,
      { ...external, owner: { task_id: 't-9', run_id: 'r-1', status: 'done' } },
    ]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // `lixbon_dir` también identifica un candidato sin dueño; el resto del DTO mantiene coherencia.
    invoke.mockResolvedValue(conWorktrees(base, [
      task,
      {
        ...external,
        state: 'orphan_candidate',
        origin: 'lixbon_dir',
        owner: { task_id: 't-9', run_id: 'r-1', status: 'done' },
      },
    ]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
  });

  it('valida needs_review con los campos visibles sin inferir existencia de ramas de worktrees', async () => {
    const base = inventario();
    const task = base.worktrees[0];
    const preserved = base.preserved_branches[0];

    // El DTO de worktrees no expone branch_exists; git.branch no permite inferir ese resultado.
    const unknownBranch = {
      ...task,
      git: { ...task.git, branch: null },
      needs_review: false,
    };
    invoke.mockResolvedValue(conWorktrees(base, [unknownBranch, base.worktrees[1]]));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();

    // Una Task aún activa no cuenta aunque su rama esté sin fusionar.
    const activeTask = { ...task, owner: { ...task.owner, status: 'running' }, needs_review: false };
    invoke.mockResolvedValue(conWorktrees(base, [activeTask, base.worktrees[1]]));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();

    for (const invalidTask of [
      { ...task, merged: 'unknown' },
      { ...task, merged: 'merged' },
      { ...task, owner: { ...task.owner, status: 'running' } },
    ]) {
      invoke.mockResolvedValue(conWorktrees(base, [invalidTask, base.worktrees[1]]));
      await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
    }

    const externalClaimedForReview = { ...base.worktrees[1], needs_review: true };
    invoke.mockResolvedValue(conWorktrees(base, [task, externalClaimedForReview]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // Para ramas conservadas `branch_exists` sí es explícito: true + unmerged exige needs_review=true.
    invoke.mockResolvedValue(conRamasConservadas(base, [{ ...preserved, needs_review: false }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // Con existencia desconocida, merged=unmerged puede venir de merge-base, pero no se confirma revisión.
    invoke.mockResolvedValue(conRamasConservadas(base, [{ ...preserved, branch_exists: null, needs_review: false }]));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();
    invoke.mockResolvedValue(conRamasConservadas(base, [{ ...preserved, branch_exists: null }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // Sin existencia no puede haber estado unmerged; con rama inexistente y merged desconocido, false sí cuadra.
    invoke.mockResolvedValue(conRamasConservadas(base, [{ ...preserved, branch_exists: false, merged: 'unmerged', needs_review: false }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
    invoke.mockResolvedValue(conRamasConservadas(base, [{ ...preserved, branch_exists: false, merged: 'unknown', needs_review: false }]));
    await expect(queryAdeCore('resource_inventory')).resolves.toBeTruthy();

    // Las ramas conservadas proceden de una Task y no pueden perder su dueño.
    invoke.mockResolvedValue(conRamasConservadas(base, [{ ...preserved, owner: null }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    // El productor nunca devuelve skipped con probe=true; sin probe sí se conserva.
    invoke.mockResolvedValue(conWorktrees(base, [{ ...task, merged: 'skipped' }, base.worktrees[1]]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');
    invoke.mockResolvedValue(conRamasConservadas(base, [{ ...preserved, merged: 'skipped', needs_review: false }]));
    await expect(queryAdeCore('resource_inventory')).rejects.toThrow('ade_query_invalid_response');

    const withoutProbe = inventarioSinSondeo();
    invoke.mockResolvedValue(withoutProbe);
    await expect(queryAdeCore('resource_inventory', { probe: false })).resolves.toEqual(withoutProbe);
  });

  it('readAdeResources devuelve el DTO del Core tal cual, sin traducirlo', async () => {
    const base = inventario({ projectId: 'project-1' });
    invoke.mockResolvedValue(base);

    const respuesta = await readAdeResources({ projectId: 'project-1' });

    expect(invoke).toHaveBeenLastCalledWith('orch_query', {
      query: 'resource_inventory',
      args: { project_id: 'project-1', probe: true },
    });
    expect(respuesta).toEqual(base);
    // Lo que no dice el Core no se inventa: sin dueño y sin evaluación siguen tal cual.
    expect(respuesta.worktrees[1].owner).toBeNull();
    expect(respuesta.worktrees[1].merged).toBe('unknown');
  });
});
