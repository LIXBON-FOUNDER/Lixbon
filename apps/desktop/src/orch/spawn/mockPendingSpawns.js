// mockPendingSpawns.js — SOLO desarrollo (import.meta.env.DEV && VITE_ORCH_MOCK==='1').
// Simula los lanzamientos pendientes con la forma del host (approval.rs, b2aa870).
// Ids: *expired* -> expired, *already* -> already_resolved, *launchfail* -> launch_failed,
// *argv* -> error de uso (el pendiente sigue).
const inMin = (m) => Date.now() + m * 60000; // el host manda ms epoch (u64)

export const MOCK_PENDING = () => [
  { pending_id: 'mock-p1', parent_task: 'coord', run: 'mock-run', agent: 'claude', provider: 'claude', profile: 'explorar', role: 'explorador',
    title: 'mock-orch: explorar', spec_summary: 'mock-orch: revisar la carpeta src/orch', cwd: 'C:/mock-orch/coord', shared: true,
    integrate_into: null, created_at: inMin(0), expires_at: inMin(9),
    policy: { argv: ['claude', '--permission-mode', 'plan'], status: 'ok', warnings: [], cli_version: '2.0.0' } },
  { pending_id: 'mock-p2-launchfail', parent_task: 'coord', run: 'mock-run', agent: 'codex', provider: 'codex', profile: 'proponer', role: 'implementador',
    title: 'mock-orch: implementar', cwd: 'C:/mock-orch/worktrees/mock-run-sp1-implementar', shared: false,
    integrate_into: { dir: 'C:/mock-orch/coord', branch: 'mock-orch-main' }, created_at: inMin(0), expires_at: inMin(1),
    policy: { argv: ['codex', '--sandbox', 'read-only'], status: 'unverified', reason: 'mock-orch: versión no verificada', warnings: ['mock-orch: aviso'], cli_version: '0.99.0' } },
];

export async function mockListPendingSpawns() { return MOCK_PENDING(); }
const outcomeFor = (id, ok) => (id.includes('expired') ? 'expired' : id.includes('already') ? 'already_resolved' : ok);
export async function mockApproveSpawn(a) {
  await new Promise((r) => setTimeout(r, 10));
  if (a.confirm !== true) throw 'mock-orch: falta la confirmación explícita (confirm: true)';
  if (a.pending_id.includes('argv')) throw 'mock-orch: el argv confirmado no coincide con el que resolvió el host';
  if (a.pending_id.includes('launchfail')) {
    return { pending_id: a.pending_id, outcome: 'launch_failed', reason: 'Aprobado, pero no se pudo lanzar: mock-orch: git worktree add falló', decision: null };
  }
  return { pending_id: a.pending_id, outcome: outcomeFor(a.pending_id, 'approved'), task: { task: 'mock-t1' }, decision: null };
}
export async function mockRejectSpawn(a) {
  await new Promise((r) => setTimeout(r, 10));
  return { pending_id: a.pending_id, outcome: outcomeFor(a.pending_id, 'rejected'), reason: a.reason || 'Rechazado por la persona', decision: null };
}
