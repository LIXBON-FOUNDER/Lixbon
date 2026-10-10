import { describe, it, expect, beforeEach } from 'vitest';
import { mockTaskDiff, mockReviewTask, resetMockTaskReview, onMockTaskReviewed } from './mockTaskReview';
import { FILE_STATUSES } from './reviewContract';

beforeEach(() => resetMockTaskReview());

describe('mockTaskReview', () => {
  it('diff normal cumple el contrato', async () => {
    const d = await mockTaskDiff({ task_id: 't1' });
    expect(d.base_source).toBe('recorded');
    expect(d.truncated).toBe(false);
    expect(d.files.length).toBeGreaterThan(0);
    for (const f of d.files) {
      expect(FILE_STATUSES).toContain(f.status);
      expect(typeof f.additions).toBe('number');
      expect(typeof f.patch).toBe('string');
    }
  });
  it('escenarios empty, truncated, mergebase, diff-error y missing', async () => {
    expect((await mockTaskDiff({ task_id: 't-empty' })).files).toEqual([]);
    expect((await mockTaskDiff({ task_id: 't-truncated' })).truncated).toBe(true);
    expect((await mockTaskDiff({ task_id: 't-mergebase' })).base_source).toBe('merge_base');
    await expect(mockTaskDiff({ task_id: 't-diff-error' })).rejects.toMatch(/mock-orch/);
    await expect(mockTaskDiff({ task_id: 't-missing' })).rejects.toMatch(/^not_found/);
    await expect(mockReviewTask({ task_id: 't-missing', decision: 'accepted', head_commit: 'x' })).rejects.toMatch(/^not_found/);
  });
  it('decisión con el head del diff: ok', async () => {
    const d = await mockTaskDiff({ task_id: 't1' });
    const r = await mockReviewTask({ task_id: 't1', decision: 'accepted', head_commit: d.head_commit });
    expect(r).toMatchObject({ ok: true, decision: 'accepted', head_commit: d.head_commit });
    expect(typeof r.at).toBe('string');
  });
  it('emite orch-task-reviewed tras aceptar y tras rechazar, no tras head_moved', async () => {
    const seen = [];
    onMockTaskReviewed((p) => seen.push(p));
    const d = await mockTaskDiff({ task_id: 't1' });
    await mockReviewTask({ task_id: 't1', decision: 'accepted', head_commit: d.head_commit });
    await mockReviewTask({ task_id: 't1', decision: 'rejected', head_commit: d.head_commit });
    await mockReviewTask({ task_id: 't-moved', decision: 'accepted', head_commit: 'viejo' });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.map((p) => p.decision)).toEqual(['accepted', 'rejected']);
    expect(Object.keys(seen[0]).sort()).toEqual(['at', 'decision', 'head_commit', 'task_id']);
    expect(seen[0].task_id).toBe('t1');
  });
  it('moved: head_moved con el head viejo y ok tras recargar', async () => {
    const d1 = await mockTaskDiff({ task_id: 't-moved' });
    const r1 = await mockReviewTask({ task_id: 't-moved', decision: 'accepted', head_commit: d1.head_commit });
    expect(r1.error).toBe('head_moved');
    expect(r1.found_commit).not.toBe(d1.head_commit);
    const d2 = await mockTaskDiff({ task_id: 't-moved' });
    expect(d2.head_commit).toBe(r1.found_commit);
    expect((await mockReviewTask({ task_id: 't-moved', decision: 'rejected', head_commit: d2.head_commit })).ok).toBe(true);
  });
});
