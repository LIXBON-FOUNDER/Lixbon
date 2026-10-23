import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_V1_MESSAGE_KEYS, translateActivityMessage } from './activityMessages.js';

const translate = translateActivityMessage;

const EXPECTED_V1_KEYS = [
  'activity.run.created',
  'activity.run.closed',
  'activity.run.removed',
  'activity.task.created',
  'activity.task.starting',
  'activity.task.running',
  'activity.task.waiting',
  'activity.task.awaiting_terminal_approval',
  'activity.task.done',
  'activity.task.failed',
  'activity.task.stopped',
  'activity.task.exited',
  'activity.task.phase_done',
  'activity.task.phase_started',
  'activity.task.question',
  'activity.task.reply',
  'activity.task.removed',
  'activity.task.review_requested',
  'activity.decision.review.accepted',
  'activity.decision.review.rejected',
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
  'activity.effect.git_worktree.removed',
  'activity.effect.process.launched',
  'activity.effect.process.not_launched',
  'activity.project.registered',
  'activity.project.location_added',
  'activity.project.archived',
  'activity.project.restored',
  'activity.project.relocated',
  'activity.spawn.requested',
  'activity.spawn.approved',
  'activity.spawn.rejected',
  'activity.spawn.launch_failed',
  'activity.spawn.timeout',
  'activity.spawn.coordinator_closed',
  'activity.spawn.cancelled_run_removed',
  'activity.environment.blocked',
  'activity.environment.cleared',
  'activity.attention.risk_acted',
  'activity.attention.created',
  'activity.attention.resolved',
  'activity.task.intent_created',
  'activity.task.updated',
  'activity.task.discarded',
  'activity.task.restored',
  'activity.attempt.requested',
  'activity.attempt.approved',
  'activity.attempt.rejected',
  'activity.attempt.started',
  'activity.attempt.completed',
  'activity.attempt.failed',
  'activity.attempt.stopped',
  'activity.attempt.waiting',
  'activity.attempt.awaiting_terminal_approval',
  'activity.attempt.resumed',
  'activity.attempt.exited',
  'activity.attempt.integrated',
  'activity.provider_session.opened',
  'activity.provider_session.bound',
  'activity.provider_session.resumed',
  'activity.provider_session.detached',
  'activity.provider_session.closed',
  'activity.thread.created',
  'activity.thread.summarized',
  'activity.worktree.created',
  'activity.worktree.adopted',
  'activity.worktree.attached',
  'activity.worktree.missing',
  'activity.worktree.found',
  'activity.worktree.removed',
  'activity.artifact.created',
  'activity.review.accepted',
  'activity.review.rejected',
  'activity.review.invalidated',
  'activity.core.agentic_cut',
  'activity.unknown',
];

/** Argumentos válidos de las claves del modelo Task/Attempt (LXO-233): sus códigos cerrados no son los de la v1. */
const MODEL_ARGS = {
  'activity.task.intent_created': { title: 'Preparar entrega', parent: 'task-parent', depth: 1 },
  'activity.task.updated': { changed: ['title'], title: 'Nuevo' },
  'activity.task.discarded': {},
  'activity.task.restored': {},
  'activity.attempt.requested': { task: 'task-1', n: 1, provider: 'codex', external: false, approval_required: true },
  'activity.attempt.approved': { task: 'task-1', n: 1 },
  'activity.attempt.rejected': { task: 'task-1', n: 1, cause: 'cancelled' },
  'activity.attempt.started': { task: 'task-1', n: 1 },
  'activity.attempt.completed': { task: 'task-1', n: 1, has_summary: false },
  'activity.attempt.failed': { task: 'task-1', n: 1, reason: 'launch_failed', has_summary: true },
  'activity.attempt.stopped': { task: 'task-1', n: 1, from: 'running', cause: 'run_closed' },
  'activity.attempt.waiting': { task: 'task-1', n: 1, from: 'running' },
  'activity.attempt.awaiting_terminal_approval': { task: 'task-1', n: 1, from: 'running' },
  'activity.attempt.resumed': { task: 'task-1', n: 1, from: 'waiting' },
  'activity.attempt.exited': { task: 'task-1', n: 1, from: 'running' },
  'activity.attempt.integrated': { task: 'task-1', n: 1 },
  'activity.provider_session.opened': { task: 'task-1', n: 1, provider: 'claude', resumable: true, bound: true },
  'activity.provider_session.bound': { task: 'task-1', binding: 'stream_json' },
  'activity.provider_session.resumed': { task: 'task-1', n: 2 },
  'activity.provider_session.detached': { task: 'task-1' },
  'activity.provider_session.closed': { task: 'task-1', from: 'open' },
  'activity.thread.created': { task: 'task-1' },
  'activity.thread.summarized': { task: 'task-1', has_summary: true },
  'activity.worktree.created': { task: 'task-1', n: 1 },
  'activity.worktree.adopted': { task: 'task-1', n: 1, provenance: 'adopted', branch: 'lx/x' },
  'activity.worktree.attached': { task: 'task-1', n: 2 },
  'activity.worktree.missing': { task: 'task-1' },
  'activity.worktree.found': { task: 'task-1' },
  'activity.worktree.removed': { task: 'task-1', reason: 'gone', branch_kept: false },
  'activity.artifact.created': { task: 'task-1', n: 1, kind: 'report', verifiable: true },
  'activity.review.accepted': { task: 'task-1', n: 1, head_commit: 'abc1234', has_comment: false },
  'activity.review.rejected': { task: 'task-1', n: 1, head_commit: 'abc1234', has_comment: true },
  'activity.review.invalidated': { task: 'task-1', n: 1, head_commit: 'abc1234', observed_head: 'def5678' },
  'activity.core.agentic_cut': { tasks: 1, attempts: 2 },
};

const COMPLETE_ARGS = {
  root_task: 'task-root',
  forced: true,
  stopped_total: 3,
  tasks: 4,
  title: 'Preparar entrega',
  agent: 'codex',
  role: 'reviewer',
  model: 'gpt-6',
  parent: 'task-parent',
  depth: 2,
  external: true,
  from: 'starting',
  to: 'running',
  cause: 'launch_failed',
  message_id: 12,
  question_id: 11,
  branch: 'feat/activity-panel',
  decision_id: 1,
  squash: true,
  conflict_count: 2,
  has_pr_url: true,
  effect_id: 'effect-1',
  base: 'main',
  worktree_removed: true,
  branch_deleted: false,
  name: 'Lixbon',
  origin: 'manual',
  has_remote: true,
  primary: true,
  fingerprint_adopted: false,
  confirmed_mismatch: true,
  parent_task: 'task-parent',
  provider: 'codex',
  profile: 'general',
  effort: 'high',
  shared: true,
  policy_status: 'blocked',
  task: 'task-1',
  has_reason: false,
  code: 'cli_missing',
  resolution: 'acted',
  category: 'failed',
  severity: 'high',
  has_comment: false,
  occurrence: 2,
  target_kind: 'task',
  target_id: 'task-1',
  reason: 'new_kind',
  kind: 'new.event',
  event_version: 2,
};
const TASK_STATUS_KEYS = new Set([
  'activity.task.starting',
  'activity.task.running',
  'activity.task.waiting',
  'activity.task.awaiting_terminal_approval',
  'activity.task.done',
  'activity.task.failed',
  'activity.task.stopped',
  'activity.task.exited',
]);

describe('translateActivityMessage', () => {
  it('exports the Spanish v1 catalog translator and key list', () => {
    expect(translateActivityMessage).toBeTypeOf('function');
    expect([...ACTIVITY_V1_MESSAGE_KEYS].sort()).toEqual([...EXPECTED_V1_KEYS].sort());
  });

  it.each(EXPECTED_V1_KEYS)('traduce la clave contractual %s', (key) => {
    const args = TASK_STATUS_KEYS.has(key)
      ? { ...COMPLETE_ARGS, to: key.slice('activity.task.'.length) }
      : key === 'activity.unknown'
        ? { ...COMPLETE_ARGS, reason: 'unknown_kind', kind: 'task.future', event_version: 2 }
      : MODEL_ARGS[key] ?? COMPLETE_ARGS;
    const translated = translate(key, args);
    expect(translated).toBeTypeOf('string');
    expect(translated.trim().length).toBeGreaterThan(0);
    expect(translated).not.toContain('[object Object]');
  });

  it('deja las claves desconocidas y los argumentos requeridos inválidos al fallback', () => {
    expect(translate('activity.nueva_clave', COMPLETE_ARGS)).toBeNull();
    expect(translate('activity.task.created', { ...COMPLETE_ARGS, title: { body: 'secreto' } })).toBeNull();
    expect(translate('activity.run.closed', { ...COMPLETE_ARGS, stopped_total: Number.NaN })).toBeNull();
  });

  it('limita texto libre y elimina controles sin convertir objetos en texto', () => {
    const text = translate('activity.task.review_requested', {
      branch: `rama\n${'x'.repeat(1_000)}`,
    });
    expect(text).toBeTypeOf('string');
    expect(text.length).toBeLessThan(180);
    expect(text).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(translate('activity.task.review_requested', { branch: ['rama'] })).toBeNull();
  });

  it.each([
    ['activity.task.created', { title: '' }],
    ['activity.spawn.requested', { title: '' }],
    ['activity.project.registered', { name: '' }],
    ['activity.task.review_requested', { branch: '' }],
    ['activity.decision.merge.merged', { branch: '' }],
    ['activity.effect.git_worktree.created', { branch: '' }],
  ])('deja el texto libre vacío de %s al fallback seguro', (key, emptyText) => {
    expect(translate(key, { ...COMPLETE_ARGS, ...emptyText })).toBeNull();
  });

  it.each([
    [
      'activity.effect.git_worktree.created',
      'base',
      'Se creó un worktree para «feat/activity-panel» (efecto effect-1).',
    ],
    [
      'activity.effect.git_worktree.removed',
      'branch',
      'Se retiró el worktree (efecto effect-1).',
    ],
  ])('conserva el mensaje de %s si el campo opcional está vacío o ausente', (key, field, expected) => {
    expect(translate(key, { ...COMPLETE_ARGS, [field]: '' })).toBe(expected);

    const argsWithoutOptionalField = { ...COMPLETE_ARGS };
    delete argsWithoutOptionalField[field];
    expect(translate(key, argsWithoutOptionalField)).toBe(expected);
  });

  it.each([
    ['activity.effect.git_worktree.created', { base: '' }],
    ['activity.effect.git_worktree.removed', { branch: '' }],
  ])('sigue rechazando un effect_id vacío en %s', (key, optionalText) => {
    expect(translate(key, { ...COMPLETE_ARGS, ...optionalText, effect_id: '' })).toBeNull();
  });

  it('las claves del modelo Task/Attempt rechazan códigos fuera de su lista y nombran el intento', () => {
    expect(translate('activity.attempt.failed', { ...MODEL_ARGS['activity.attempt.failed'], reason: 'otra' })).toBeNull();
    expect(translate('activity.attempt.stopped', { ...MODEL_ARGS['activity.attempt.stopped'], from: 'done' })).toBeNull();
    expect(translate('activity.attempt.started', { task: 'task-1' })).toBeNull();
    expect(translate('activity.task.updated', { changed: ['otro'] })).toBeNull();
    expect(translate('activity.worktree.created', { task: 'task-1', n: 1, branch: ['x'] })).toBeNull();
    expect(translate('activity.attempt.integrated', { task: 'task-1', n: 3 })).toBe('Se integró el trabajo del intento 3 de la tarea task-1.');
  });

  it('formatea estados y argumentos booleanos desde la clave y argumentos contractuales', () => {
    expect(translate('activity.task.failed', { ...COMPLETE_ARGS, to: 'failed' })).toMatch(/falló/i);
    expect(translate('activity.run.closed', { ...COMPLETE_ARGS, forced: false })).toContain('cerró');
    expect(translate('activity.decision.review.accepted', { ...COMPLETE_ARGS, has_comment: true }))
      .toContain('comentario');
  });
});

describe('casos compartidos con lxo (docs/core/fixtures/activity_messages_es.json)', () => {
  it('cada caso da la misma frase que espera lxo task show', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const path = resolve(root, 'docs', 'core', 'fixtures', 'activity_messages_es.json');
    const { cases } = JSON.parse(readFileSync(path, 'utf8'));
    for (const { key, args, text } of cases) {
      expect(translate(key, args), `${key} ${JSON.stringify(args)}`).toBe(text);
    }
    expect(new Set(cases.map((c) => c.key))).toEqual(new Set(ACTIVITY_V1_MESSAGE_KEYS));
  });
});
