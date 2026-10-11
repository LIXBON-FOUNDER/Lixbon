import { describe, it, expect, beforeEach } from 'vitest';
import { mockTaskDiff, mockReviewTask, resetMockTaskReview, onMockTaskReviewed } from './mockTaskReview';
import { FILE_STATUS_CODES, reviewArgs } from './reviewContract';

beforeEach(() => resetMockTaskReview());
const review = (task_id, decision, head_commit, comment) => mockReviewTask(reviewArgs({ task_id, decision, head_commit, comment }));

describe('mockTaskReview', () => {
  it('diff normal con la forma del host', async () => {
    const d = await mockTaskDiff({ task_id: 't1' });
    expect(Object.keys(d).sort()).toEqual(['base_commit', 'base_source', 'branch', 'files', 'head_commit', 'limit_bytes', 'task_id', 'truncated']);
    expect(d.base_source).toBe('recorded');
    expect(d.limit_bytes).toBe(512 * 1024);
    expect(d.truncated).toBe(false);
    for (const f of d.files) {
      expect(Object.keys(FILE_STATUS_CODES)).toContain(f.status);
      expect(typeof f.patch).toBe('string');
    }
    expect(d.files.some((f) => f.additions === null && f.deletions === null)).toBe(true);
  });
  it('escenarios empty, truncated, mergebase, diff-error, missing y nobranch', async () => {
    expect((await mockTaskDiff({ task_id: 't-empty' })).files).toEqual([]);
    const tr = await mockTaskDiff({ task_id: 't-truncated' });
    expect(tr.truncated).toBe(true);
    expect(tr.files.at(-1).patch).toBe(null);
    expect((await mockTaskDiff({ task_id: 't-mergebase' })).base_source).toBe('merge_base');
    await expect(mockTaskDiff({ task_id: 't-diff-error' })).rejects.toMatch(/Sin base/);
    await expect(mockTaskDiff({ task_id: 't-missing' })).rejects.toMatch(/^not_found:/);
    await expect(mockTaskDiff({ task_id: 't-nobranch' })).rejects.toMatch(/^no_branch:/);
    await expect(review('t-missing', 'accepted', 'x')).rejects.toMatch(/^not_found:/);
  });
  it('sin confirm: true el mock rechaza, como el host', async () => {
    await expect(mockReviewTask({ task_id: 't1', decision: 'accepted', head_commit: 'x' })).rejects.toMatch(/confirm/);
  });
  it('decisión con el head del diff: recorded con decision_id y at numérico', async () => {
    const d = await mockTaskDiff({ task_id: 't1' });
    const r = await review('t1', 'accepted', d.head_commit, ' bien ');
    expect(r).toMatchObject({ task_id: 't1', outcome: 'recorded', decision: 'accepted', head_commit: d.head_commit, comment: 'bien' });
    expect(typeof r.decision_id).toBe('number');
    expect(typeof r.at).toBe('number');
  });
  it('emite orch-task-reviewed tras aceptar y tras rechazar, no tras head_moved', async () => {
    const seen = [];
    onMockTaskReviewed((p) => seen.push(p));
    const d = await mockTaskDiff({ task_id: 't1' });
    await review('t1', 'accepted', d.head_commit);
    await review('t1', 'rejected', d.head_commit);
    await review('t-moved', 'accepted', 'viejo');
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.map((p) => p.decision)).toEqual(['accepted', 'rejected']);
    expect(Object.keys(seen[0]).sort()).toEqual(['at', 'decision', 'head_commit', 'task_id']);
  });
  it('moved: head_moved con expected y found, y recorded tras recargar', async () => {
    const d1 = await mockTaskDiff({ task_id: 't-moved' });
    const r1 = await review('t-moved', 'accepted', d1.head_commit);
    expect(r1).toMatchObject({ outcome: 'head_moved', expected_commit: d1.head_commit });
    expect(r1.found_commit).not.toBe(d1.head_commit);
    const d2 = await mockTaskDiff({ task_id: 't-moved' });
    expect(d2.head_commit).toBe(r1.found_commit);
    expect((await review('t-moved', 'rejected', d2.head_commit)).outcome).toBe('recorded');
  });
  it('gone: head_moved con found_commit null', async () => {
    const r = await review('t-gone', 'accepted', 'x');
    expect(r).toMatchObject({ outcome: 'head_moved', found_commit: null });
  });
});
