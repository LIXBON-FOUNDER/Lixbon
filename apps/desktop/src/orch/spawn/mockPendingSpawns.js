// mockPendingSpawns.js — SOLO desarrollo (import.meta.env.DEV && VITE_ORCH_MOCK==='1').
// Simula los lanzamientos pendientes. Ids: *expired* -> expired, *already* -> already_resolved.
const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();

export const MOCK_PENDING = () => [
  { pending_id: 'mock-p1', parent_task: 'coord', agent: 'claude', provider: 'claude', profile: 'explorar', role: 'explorador',
    spec_summary: 'mock-orch: revisar la carpeta src/orch', expires_at: inMin(9),
    policy: { argv: ['claude', '--permission-mode', 'plan'], status: 'ok', warnings: [], cli_version: '2.0.0' } },
  { pending_id: 'mock-p2-expired', parent_task: 'coord', agent: 'codex', provider: 'codex', profile: 'proponer', role: 'implementador',
    expires_at: inMin(1),
    policy: { argv: ['codex', '--sandbox', 'read-only'], status: 'unverified', reason: 'mock-orch: versión no verificada', warnings: ['mock-orch: aviso'], cli_version: '0.99.0' } },
];

export async function mockListPendingSpawns() { return MOCK_PENDING(); }
const outcomeFor = (id, ok) => (id.includes('expired') ? 'expired' : id.includes('already') ? 'already_resolved' : ok);
export async function mockApproveSpawn(a) {
  await new Promise((r) => setTimeout(r, 10));
  if (a.confirm !== true) throw 'mock-orch: falta la confirmación explícita (confirm: true)';
  return { pending_id: a.pending_id, outcome: outcomeFor(a.pending_id, 'approved'), task: 'mock-t1' };
}
export async function mockRejectSpawn(a) {
  await new Promise((r) => setTimeout(r, 10));
  return { pending_id: a.pending_id, outcome: outcomeFor(a.pending_id, 'rejected') };
}
