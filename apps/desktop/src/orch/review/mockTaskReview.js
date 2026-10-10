// mockTaskReview.js - SOLO desarrollo (import.meta.env.DEV && VITE_ORCH_MOCK==='1').
// Simula orch_task_diff y orch_review_task según el id de la tarea:
//   *empty*      -> diff sin archivos            *truncated* -> truncated: true
//   *mergebase*  -> base_source 'merge_base'     *missing*   -> not_found
//   *diff-error* -> el diff falla (rechazo de texto)
//   *moved*      -> la rama ya avanzó: la decisión con el head del primer diff da head_moved;
//                   al recargar, el diff trae el head nuevo y la decisión pasa
//   cualquier otra -> diff con 3 archivos; la decisión se registra

const BASE = 'aaaa111bbbb222cccc333dddd444eeee555ffff6';
const HEAD = '1234567890abcdef1234567890abcdef12345678';
const MOVED = 'fedcba0987654321fedcba0987654321fedcba09';

const diffCalls = new Map();
export function resetMockTaskReview() { diffCalls.clear(); }

const delay = () => new Promise((r) => setTimeout(r, 10));
const currentHead = (id) => (id.includes('moved') ? MOVED : HEAD);

const FILES = [
  { path: 'src/orch/nuevo.js', status: 'added', additions: 3, deletions: 0,
    patch: '@@ -0,0 +1,3 @@\n+// mock-orch: archivo nuevo\n+export const a = 1;\n+export const b = 2;\n' },
  { path: 'src/orch/canIntegrate.js', status: 'modified', additions: 1, deletions: 1,
    patch: '@@ -10,3 +10,3 @@\n contexto\n-const viejo = true;\n+const nuevo = true;\n contexto\n' },
  { path: 'docs/viejo.md', status: 'deleted', additions: 0, deletions: 2,
    patch: '@@ -1,2 +0,0 @@\n-# mock-orch\n-texto\n' },
];

export async function mockTaskDiff(args = {}) {
  await delay();
  const id = String(args.task_id ?? '');
  if (id.includes('diff-error')) throw 'mock-orch: no se pudo calcular el diff';
  if (id.includes('missing')) throw { error: 'not_found' };
  const n = (diffCalls.get(id) || 0) + 1;
  diffCalls.set(id, n);
  return {
    base_commit: BASE,
    base_source: id.includes('mergebase') ? 'merge_base' : 'recorded',
    head_commit: id.includes('moved') && n > 1 ? MOVED : HEAD,
    files: id.includes('empty') ? [] : FILES,
    truncated: id.includes('truncated'),
  };
}

export async function mockReviewTask(args = {}) {
  await delay();
  const id = String(args.task_id ?? '');
  if (id.includes('missing')) return { error: 'not_found' };
  if (args.decision !== 'accepted' && args.decision !== 'rejected') throw 'mock-orch: decisión inválida';
  const head = currentHead(id);
  if (args.head_commit !== head) return { error: 'head_moved', found_commit: head };
  return { ok: true, decision: args.decision, head_commit: head, at: new Date(0).toISOString() };
}
