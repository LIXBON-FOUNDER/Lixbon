import { describe, expect, it } from 'vitest';
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
  'activity.unknown',
];

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
      : COMPLETE_ARGS;
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

  it('formatea estados y argumentos booleanos desde la clave y argumentos contractuales', () => {
    expect(translate('activity.task.failed', { ...COMPLETE_ARGS, to: 'failed' })).toMatch(/falló/i);
    expect(translate('activity.run.closed', { ...COMPLETE_ARGS, forced: false })).toContain('cerró');
    expect(translate('activity.decision.review.accepted', { ...COMPLETE_ARGS, has_comment: true }))
      .toContain('comentario');
  });
});
