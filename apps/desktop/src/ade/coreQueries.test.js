import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ATTENTION_LIMIT, TASK_PAGE_LIMIT, listAdeActivity, listAdeTasks, queryAdeCore } from './coreQueries';
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
