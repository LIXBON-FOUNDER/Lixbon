import { describe, expect, it } from 'vitest';
import { ATTENTION, attentionItems, reviewStatus } from './attention';

const child = (over = {}) => ({
  id: 't1', parent: 'c', status: 'done', branch: 'lxo/t1', head_commit: 'aaa', created: 1, last_integration: null, last_review: null, ...over,
});
const accepted = { decision: 'accepted', head_commit: 'aaa' };
const kinds = (tasks) => attentionItems(tasks).map((i) => i.kind);

describe('reviewStatus', () => {
  it('distingue sin revisión, desactualizada, aceptada y rechazada', () => {
    expect(reviewStatus(child())).toBe('none');
    expect(reviewStatus(child({ last_review: { ...accepted, head_commit: 'old' } }))).toBe('stale');
    expect(reviewStatus(child({ last_review: accepted }))).toBe('accepted');
    expect(reviewStatus(child({ last_review: { decision: 'rejected', head_commit: 'aaa' } }))).toBe('rejected');
  });

  it('un host sin revisión por tarea no la exige', () => {
    expect(reviewStatus(child({ last_review: undefined }))).toBe('accepted');
  });
});

describe('attentionItems', () => {
  it('tarea terminada sin revisión pide revisar', () => {
    expect(kinds([child()])).toEqual([ATTENTION.review]);
  });

  it('revisión aceptada sobre el commit actual pide integrar', () => {
    expect(kinds([child({ last_review: accepted })])).toEqual([ATTENTION.integrate]);
  });

  it('revisión sobre un commit anterior vuelve a pedir revisar', () => {
    expect(kinds([child({ last_review: { ...accepted, head_commit: 'old' } })])).toEqual([ATTENTION.review]);
  });

  it('un diff rechazado no pide nada a la persona', () => {
    expect(kinds([child({ last_review: { decision: 'rejected', head_commit: 'aaa' } })])).toEqual([]);
  });

  it('ya integrada, sin rama, coordinador o sin terminar: nada', () => {
    expect(kinds([
      child({ last_integration: { outcome: 'merged' } }),
      child({ id: 't2', branch: null }),
      child({ id: 't3', parent: null }),
      child({ id: 't4', status: 'running' }),
    ])).toEqual([]);
  });

  it('esperando aprobación en la terminal y fallidas aparecen, la espera primero', () => {
    const items = attentionItems([
      child({ id: 'f', status: 'failed', created: 1, failure_reason: 'terminal_approval_timeout' }),
      child({ id: 'r', created: 2 }),
      child({ id: 'a', status: 'awaiting_terminal_approval', created: 3 }),
    ]);
    expect(items.map((i) => [i.task.id, i.kind])).toEqual([
      ['a', ATTENTION.approveInTerminal],
      ['r', ATTENTION.review],
      ['f', ATTENTION.failed],
    ]);
    expect(items[2].hint).toMatch(/aprobó/);
  });
});
