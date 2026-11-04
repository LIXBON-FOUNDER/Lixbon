import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { validateProofPack } from './proofPackContract';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// LXO-155 · Proof Pack: la evidencia antes del diff y la decisión sobre el HEAD exacto que se ve.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const tick = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await tick(); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

const H1 = 'a1'.repeat(20);
const H2 = 'b2'.repeat(20);
const verified = (value) => ({ value, provenance: 'verified' });
const unknown = (reason) => ({ value: null, provenance: 'unknown', reason });

/** Un Proof Pack con la forma que manda el Core. */
function pack(over = {}) {
  return {
    v: 1, attempt_id: 't3-a1', task_id: 't3', n: 1, is_current: true,
    status: verified({ status: 'done', failure_reason: null }),
    objective: verified({ title: 'Arreglar el login', objective: 'Que entre con cookie' }),
    revision: { source: 'live_branch', base_commit: verified('c3'.repeat(20)), head_commit: verified(H1) },
    changes: {
      files: verified(2), additions: verified(7), deletions: verified(1), total_files: 2, truncated: false,
      list: [{ path: 'README.md', additions: 4, deletions: 1 }, { path: 'src/login.rs', additions: 3, deletions: 0 }],
    },
    summary: { value: 'Todas las pruebas pasan', provenance: 'agent_reported' },
    artifacts: { provenance: 'unknown', reason: 'none_recorded', items: [] },
    tests: unknown('not_collected'),
    acceptance: { state: 'none' },
    decision: { can_decide: true, head_commit: H1 },
    completeness: { state: 'complete', gaps: ['artifacts', 'tests'] },
    limits: { max_files: 200, max_summary_chars: 2000 },
    ...over,
  };
}

function mountCore({ status = 'done', packs = [pack()], decide = () => ({ outcome: 'recorded', attempt_id: 't3-a1' }) } = {}) {
  const calls = [];
  let reads = 0;
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_call') return decide(payload);
    if (payload.query === 'attempt_proof_pack') { const p = packs[Math.min(reads, packs.length - 1)]; reads += 1; return typeof p === 'function' ? p() : p; }
    if (payload.query === 'provider_capabilities') return live();
    if (payload.query === 'activity_list') return attemptActivityPage([]);
    if (payload.query === 'attempts_by_task') return { ...CANONICAL['attempts_by_task.v1.json'], task_id: 't3', items: [] };
    if (payload.query === 'pending_queue') return { v: 1, attempt_id: 't3-a1', task_id: 't3', items: [], finished: [], finished_limit: 20 };
    if (payload.query === 'attempt_lineage') return { v: 1, attempt_id: 't3-a1', forked_from: null, forks: [] };
    return attemptDetail({ id: 't3-a1', task_id: 't3', n: 1, status, provider: 'fake-completo' });
  });
  return calls;
}
const mount = () => render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
const sent = (calls) => calls.filter((c) => c.command === 'orch_call').map((c) => c.payload);
const byId = (id) => screen.getByTestId(id);

describe('Proof Pack · contrato', () => {
  const args = { attempt_id: 't3-a1' };
  const bad = (response, what) => expect(() => validateProofPack(response, args), what).toThrow(/ade_query_invalid_response: attempt_proof_pack/);

  it('acepta lo del Core y rechaza lo que desdibuja la evidencia o la decisión', () => {
    expect(validateProofPack(pack(), args)).toBeTruthy();
    bad({ ...pack(), v: 2 }, 'versión');
    bad({ ...pack(), attempt_id: 'otro-a1' }, 'otro Attempt');
    bad(pack({ tests: { value: 0, provenance: 'unknown', reason: 'not_collected' } }), 'un cero no es unknown');
    bad(pack({ summary: { value: 'x', provenance: 'inventada' } }), 'procedencia desconocida');
    bad(pack({ acceptance: { state: 'quizas' } }), 'estado de aceptación');
    bad(pack({ acceptance: { state: 'accepted', decided_head: H2, head_matches: false } }), 'aceptada pero de otro HEAD');
    bad(pack({ acceptance: { state: 'stale', decided_head: H2, head_matches: true } }), 'stale pero del mismo HEAD');
    bad(pack({ decision: { can_decide: true, head_commit: H2 } }), 'se decide un HEAD que no es el mostrado');
    bad(pack({ decision: { can_decide: false, reason: 'porque_si', head_commit: null } }), 'motivo fuera del contrato');
    bad(pack({ decision: { can_decide: false, reason: 'not_final', head_commit: H1 } }), 'sin decisión pero con HEAD');
  });
});

describe('Proof Pack · vista', () => {
  it('muestra la evidencia con su procedencia: lo del agente se ve como suyo y las pruebas siguen sin dato', async () => {
    mountCore();
    mount();
    await flush();
    const p = byId('proof-pack');
    expect(byId('proof-completeness').textContent).toMatch(/Evidencia completa para decidir · sin dato: los artefactos, los resultados de pruebas/);
    expect(p.textContent).toContain('Arreglar el login');
    expect(byId('proof-head').textContent).toBe(H1.slice(0, 12));
    const summary = [...p.querySelectorAll('dd')].find((d) => d.textContent.includes('Todas las pruebas pasan'));
    expect(summary.dataset.provenance).toBe('agent_reported');
    expect(summary.textContent).toContain('⚠ Lo dice el agente');
    const tests = [...p.querySelectorAll('dd')].find((d) => d.textContent.includes('el Core aún no recoge resultados de pruebas'));
    expect(tests.dataset.provenance).toBe('unknown');
    expect(tests.textContent).toContain('? Sin dato');
    expect(p.textContent).toContain('2 archivos');
    expect(p.textContent).toContain('+7 −1');
  });

  it('un Proof Pack parcial lo dice y no ofrece decidir', async () => {
    mountCore({
      packs: [pack({
        revision: { source: null, base_commit: unknown('no_worktree'), head_commit: unknown('no_worktree') },
        changes: { files: unknown('no_worktree'), additions: unknown('no_worktree'), deletions: unknown('no_worktree'), list: [], truncated: false, total_files: null },
        completeness: { state: 'partial', gaps: ['revision', 'changes', 'tests'] },
        decision: { can_decide: false, reason: 'no_revision', head_commit: null },
      })],
    });
    mount();
    await flush();
    expect(byId('proof-completeness').dataset.state).toBe('partial');
    expect(byId('proof-completeness').textContent).toMatch(/parcial.*la revisión, los cambios/);
    expect(screen.queryByTestId('proof-accept')).toBeNull();
    expect(byId('proof-blocked').dataset.reason).toBe('no_revision');
    expect(byId('proof-pack').textContent).not.toMatch(/\b0 archivos/);
  });

  it('un intento que espera su aprobación no tiene Proof Pack que leer', async () => {
    const calls = mountCore({ status: 'pending_approval' });
    mount();
    await flush();
    expect(screen.queryByTestId('proof-pack')).toBeNull();
    expect(calls.some((c) => c.payload?.query === 'attempt_proof_pack')).toBe(false);
  });

  it('aceptar pide confirmación, manda EXACTAMENTE el HEAD mostrado y dice que no integra nada', async () => {
    const calls = mountCore();
    mount();
    await flush();
    fireEvent.click(byId('proof-accept'));
    expect(byId('proof-confirm').textContent).toMatch(/aceptar la revisión a1a1a1a1a1a1 exacta\. No se integra nada/);
    expect(sent(calls)).toEqual([]);
    fireEvent.click(byId('proof-confirm-yes'));
    await flush();
    expect(sent(calls)).toEqual([{ cmd: 'attempt_review', args: { attempt_id: 't3-a1', decision: 'accepted', head_commit: H1, confirm: true } }]);
    expect(byId('proof-recorded').textContent).toMatch(/Revisión aceptada\. Aceptar no integra nada/);
  });

  it('rechazar lleva el comentario opcional y avisa de que no se borra nada', async () => {
    const calls = mountCore();
    mount();
    await flush();
    fireEvent.click(byId('proof-reject'));
    expect(byId('proof-confirm').textContent).toMatch(/No se borra nada/);
    fireEvent.change(byId('proof-comment'), { target: { value: '  falta cubrir el caso X  ' } });
    fireEvent.click(byId('proof-confirm-yes'));
    await flush();
    expect(sent(calls)[0].args).toMatchObject({ decision: 'rejected', head_commit: H1, comment: 'falta cubrir el caso X' });
    expect(byId('proof-recorded').textContent).toMatch(/El intento y su worktree siguen donde estaban/);
  });

  it('si la rama se movió entre el render y el clic no se registra nada, se avisa y se ofrece el HEAD nuevo', async () => {
    const calls = mountCore({
      packs: [pack(), pack({ revision: { source: 'live_branch', base_commit: verified('c3'.repeat(20)), head_commit: verified(H2) }, decision: { can_decide: true, head_commit: H2 } })],
      decide: () => ({ outcome: 'head_moved', attempt_id: 't3-a1', expected_commit: H1, found_commit: H2 }),
    });
    mount();
    await flush();
    fireEvent.click(byId('proof-accept'));
    fireEvent.click(byId('proof-confirm-yes'));
    await flush();
    expect(sent(calls)).toHaveLength(1);
    expect(byId('proof-head-moved').textContent).toMatch(/aceptaste a1a1a1a1a1a1 pero ahora está en b2b2b2b2b2b2\. No se registró nada/);
    expect(screen.queryByTestId('proof-recorded')).toBeNull();
    // Con el Proof Pack ya recargado se ve el HEAD nuevo y se vuelve a poder decidir, ahora sobre ese.
    expect(byId('proof-head').textContent).toBe(H2.slice(0, 12));
    fireEvent.click(byId('proof-accept'));
    fireEvent.click(byId('proof-confirm-yes'));
    await flush();
    expect(sent(calls)[1].args.head_commit).toBe(H2);
  });

  it('una aceptación de otro HEAD se ve como vieja y no impide volver a decidir', async () => {
    mountCore({ packs: [pack({ acceptance: { state: 'stale', decided_head: H2, head_matches: false, decision_id: 3, at: 1 } })] });
    mount();
    await flush();
    expect(byId('proof-acceptance').dataset.state).toBe('stale');
    expect(byId('proof-acceptance').textContent).toMatch(/aceptación anterior era de otro HEAD \(b2b2b2b2b2b2\).*ya no vale/);
    expect(byId('proof-accept').disabled).toBe(false);
  });

  it('una revisión ya aceptada no se acepta otra vez, y un intento en marcha no se decide', async () => {
    mountCore({ packs: [pack({ acceptance: { state: 'accepted', decided_head: H1, head_matches: true, decision_id: 3, at: 1 } })] });
    mount();
    await flush();
    expect(byId('proof-accept').disabled).toBe(true);
    cleanup();
    mountCore({ status: 'running', packs: [pack({ status: verified({ status: 'running', failure_reason: null }), decision: { can_decide: false, reason: 'not_final', head_commit: null } })] });
    mount();
    await flush();
    expect(byId('proof-blocked').textContent).toMatch(/sigue en marcha/);
  });

  it('un error del Core al decidir se dice en llano y no da la decisión por tomada', async () => {
    mountCore({ decide: () => { throw new Error('review_not_final: el Attempt todavía no terminó'); } });
    mount();
    await flush();
    fireEvent.click(byId('proof-accept'));
    fireEvent.click(byId('proof-confirm-yes'));
    await flush();
    expect(byId('proof-error').textContent).toMatch(/El intento todavía no terminó/);
    expect(screen.queryByTestId('proof-recorded')).toBeNull();
  });
});
