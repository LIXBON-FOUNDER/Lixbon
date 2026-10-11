// mockTaskReview.js - SOLO desarrollo (import.meta.env.DEV && VITE_ORCH_MOCK==='1').
// Simula orch_task_diff y orch_review_task con las formas del host (review.rs), según el id:
//   *empty*      -> diff sin archivos            *truncated* -> truncated: true, último patch null
//   *mergebase*  -> base_source 'merge_base'     *missing*   -> rechazo 'not_found: ...'
//   *nobranch*   -> rechazo 'no_branch: ...'     *diff-error* -> rechazo de texto sin prefijo
//   *moved*      -> la rama ya avanzó: la decisión con el head del primer diff da head_moved;
//                   al recargar, el diff trae el head nuevo y la decisión pasa
//   *gone*       -> head_moved con found_commit null (la rama ya no existe)
//   cualquier otra -> diff con 4 archivos (uno binario); la decisión se registra (outcome recorded)
// Tras registrar emite orch-task-reviewed ({ task_id, decision, head_commit, at }) a quien se
// suscriba con onMockTaskReviewed.

const BASE = 'aaaa111bbbb222cccc333dddd444eeee555ffff6';
const HEAD = '1234567890abcdef1234567890abcdef12345678';
const MOVED = 'fedcba0987654321fedcba0987654321fedcba09';
const LIMIT = 512 * 1024;

const diffCalls = new Map();
const listeners = new Set();
let decisionSeq = 0;
export function resetMockTaskReview() { diffCalls.clear(); listeners.clear(); decisionSeq = 0; }
export function onMockTaskReviewed(cb) { listeners.add(cb); return () => listeners.delete(cb); }

const delay = () => new Promise((r) => setTimeout(r, 10));
const currentHead = (id) => (id.includes('gone') ? null : id.includes('moved') ? MOVED : HEAD);

const FILES = () => [
  { path: 'src/orch/nuevo.js', status: 'A', additions: 3, deletions: 0,
    patch: 'diff --git a/src/orch/nuevo.js b/src/orch/nuevo.js\n@@ -0,0 +1,3 @@\n+// mock-orch: archivo nuevo\n+export const a = 1;\n+export const b = 2;\n' },
  { path: 'src/orch/canIntegrate.js', status: 'M', additions: 1, deletions: 1,
    patch: '@@ -10,3 +10,3 @@\n contexto\n-const viejo = true;\n+const nuevo = true;\n contexto\n' },
  { path: 'docs/viejo.md', status: 'D', additions: 0, deletions: 2,
    patch: '@@ -1,2 +0,0 @@\n-# mock-orch\n-texto\n' },
  { path: 'assets/logo.png', status: 'A', additions: null, deletions: null,
    patch: 'Binary files /dev/null and b/assets/logo.png differ\n' },
];

function check(id) {
  if (id.includes('missing')) throw `not_found: mock-orch: no existe la tarea ${id}`;
  if (id.includes('nobranch')) throw `no_branch: mock-orch: ${id} no tiene rama propia`;
}

export async function mockTaskDiff(args = {}) {
  await delay();
  const id = String(args.task_id ?? '');
  check(id);
  if (id.includes('diff-error')) throw 'mock-orch: Sin base para revisar lx/t';
  const n = (diffCalls.get(id) || 0) + 1;
  diffCalls.set(id, n);
  const truncated = id.includes('truncated');
  const files = id.includes('empty') ? [] : FILES();
  if (truncated) files[files.length - 1].patch = null;
  return {
    task_id: id,
    branch: `lx/${id}`,
    base_commit: BASE,
    base_source: id.includes('mergebase') ? 'merge_base' : 'recorded',
    head_commit: id.includes('moved') && n > 1 ? MOVED : HEAD,
    files,
    truncated,
    limit_bytes: LIMIT,
  };
}

export async function mockReviewTask(args = {}) {
  await delay();
  const id = String(args.task_id ?? '');
  if (args.confirm !== true) throw 'mock-orch: Revisar exige confirmación explícita de la persona (confirm: true)';
  if (args.decision !== 'accepted' && args.decision !== 'rejected') throw 'mock-orch: decision debe ser accepted o rejected';
  check(id);
  const head = currentHead(id);
  if (args.head_commit !== head) {
    return { task_id: id, outcome: 'head_moved', expected_commit: args.head_commit, found_commit: head };
  }
  const at = 1760054400;
  const comment = typeof args.comment === 'string' && args.comment.trim() ? args.comment.trim() : null;
  const ev = { task_id: id, decision: args.decision, head_commit: head, at };
  const targets = [...listeners]; // los suscritos al momento de decidir
  setTimeout(() => targets.forEach((cb) => cb(ev)), 0);
  return { task_id: id, outcome: 'recorded', decision: args.decision, decision_id: ++decisionSeq, head_commit: head,
    base_commit: BASE, base_source: id.includes('mergebase') ? 'merge_base' : 'recorded', comment, at };
}
