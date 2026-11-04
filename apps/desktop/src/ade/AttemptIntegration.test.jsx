import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { validateIntegrationPreview } from './integrationContract';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// LXO-156 · Integración: fusionar o publicar un PR de un intento revisado, con el destino a la vista y los resultados del efecto.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const tick = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
const flush = async () => { for (let i = 0; i < 4; i += 1) await tick(); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

const H = 'a1'.repeat(20);
const T1 = 'c3'.repeat(20);
const T2 = 'd4'.repeat(20);

/** Una vista previa con la forma que manda el Core. */
function preview(over = {}) {
  return {
    v: 1, attempt_id: 't3-a1', task_id: 't3', is_current: true,
    revision: { head_commit: H },
    review: { state: 'accepted' },
    merge: { merged: false, result_commit: null },
    pr: { url: null, has_remote: true },
    target: { kind: 'project_checkout', branch: 'main', expected_branch: 'main', branch_matches: true, head: T1, expected_head: T1, moved: false, clean: true },
    can_merge: { ok: true },
    can_publish_pr: { ok: true },
    ...over,
  };
}

function mountCore({ status = 'done', previews = [preview()], decide = () => ({ outcome: 'merged', result_commit: T2, attempt_id: 't3-a1' }) } = {}) {
  const calls = [];
  let reads = 0;
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_call') return decide(payload);
    if (payload.query === 'attempt_integration_preview') { const p = previews[Math.min(reads, previews.length - 1)]; reads += 1; return p; }
    if (payload.query === 'provider_capabilities') return live();
    if (payload.query === 'activity_list') return attemptActivityPage([]);
    if (payload.query === 'attempts_by_task') return { ...CANONICAL['attempts_by_task.v1.json'], task_id: 't3', items: [] };
    if (payload.query === 'pending_queue') return { v: 1, attempt_id: 't3-a1', task_id: 't3', items: [], finished: [], finished_limit: 20 };
    if (payload.query === 'attempt_lineage') return { v: 1, attempt_id: 't3-a1', forked_from: null, forks: [] };
    if (payload.query === 'attempt_proof_pack') throw new Error('sin proof pack en esta prueba');
    return attemptDetail({ id: 't3-a1', task_id: 't3', n: 1, status, provider: 'fake-completo' });
  });
  return calls;
}
const mount = () => render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
const sent = (calls) => calls.filter((c) => c.command === 'orch_call').map((c) => c.payload);
const byId = (id) => screen.getByTestId(id);

describe('Integración · contrato', () => {
  const args = { attempt_id: 't3-a1' };
  const bad = (response, what) => expect(() => validateIntegrationPreview(response, args), what).toThrow(/ade_query_invalid_response: attempt_integration_preview/);

  it('acepta lo del Core y rechaza ofrecer lo que no se debe', () => {
    expect(validateIntegrationPreview(preview(), args)).toBeTruthy();
    bad({ ...preview(), v: 2 }, 'versión');
    bad({ ...preview(), attempt_id: 'otro-a1' }, 'otro Attempt');
    bad(preview({ can_merge: { ok: false } }), 'sin motivo');
    bad(preview({ can_merge: { ok: false, reason: 'porque_si' } }), 'motivo fuera del contrato');
    bad(preview({ can_merge: { ok: true, reason: 'x' } }), 'lo posible no trae motivo');
    bad(preview({ review: { state: 'stale' } }), 'se ofrece integrar con una revisión que no es de este HEAD');
    bad(preview({ revision: { head_commit: null } }), 'se ofrece integrar sin HEAD');
    bad(preview({ merge: { merged: true, result_commit: T2 } }), 'ya integrado y aún se ofrece');
    bad(preview({ target: { ...preview().target, kind: 'otro' } }), 'tipo de destino');
  });
});

describe('Integración · vista', () => {
  it('muestra la revisión, el destino y el estado antes de confirmar, y solo para un intento terminado', async () => {
    mountCore();
    mount();
    await flush();
    expect(byId('integration-revision').textContent).toContain('a1a1a1a1a1a1 · aceptada sobre este HEAD');
    expect(byId('integration-target').textContent).toMatch(/proyecto · rama main · HEAD c3c3c3c3c3c3/);
    expect(byId('integration-state').textContent).toContain('Sin integrar');
    expect(byId('integration-merge').textContent).toBe('Fusionar en main');
    cleanup();
    const calls = mountCore({ status: 'running' });
    mount();
    await flush();
    expect(screen.queryByTestId('attempt-integration')).toBeNull();
    expect(calls.some((c) => c.payload?.query === 'attempt_integration_preview')).toBe(false);
  });

  it('fusionar pide confirmación mostrando el destino y manda EXACTAMENTE el HEAD visto', async () => {
    const calls = mountCore();
    mount();
    await flush();
    fireEvent.click(byId('integration-merge'));
    expect(byId('integration-confirm').textContent).toMatch(/fusionar la revisión a1a1a1a1a1a1 en la rama main del proyecto \(HEAD c3c3c3c3c3c3\).*cambia el checkout del proyecto.*No se limpia el worktree/);
    expect(sent(calls)).toEqual([]);
    fireEvent.click(byId('integration-confirm-yes'));
    await flush();
    expect(sent(calls)).toEqual([{ cmd: 'attempt_integrate', args: { attempt_id: 't3-a1', action: 'merge', head_commit: H, confirm: true } }]);
    expect(byId('integration-result').textContent).toMatch(/Fusionado\. Commit resultante d4d4d4d4d4d4\. El worktree no se limpia/);
  });

  it('un conflicto es el resultado del efecto: lista los archivos y dice que no se perdió nada', async () => {
    mountCore({ decide: () => ({ outcome: 'conflict', conflicts: ['README.md', 'src/a.rs'] }) });
    mount();
    await flush();
    fireEvent.click(byId('integration-merge'));
    fireEvent.click(byId('integration-confirm-yes'));
    await flush();
    const r = byId('integration-result');
    expect(r.dataset.tone).toBe('error');
    expect(r.textContent).toMatch(/Conflicto: git abortó la fusión y no se perdió nada/);
    expect([...r.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['README.md', 'src/a.rs']);
  });

  it('un destino movido exige aceptar el commit que se ve, y entonces lo manda', async () => {
    const calls = mountCore({ previews: [preview({ target: { ...preview().target, head: T2, moved: true } })] });
    mount();
    await flush();
    expect(byId('integration-target').textContent).toContain('se movió fuera de Lixbon (esperado c3c3c3c3c3c3)');
    fireEvent.click(byId('integration-merge'));
    expect(byId('integration-confirm-yes').disabled).toBe(true);
    fireEvent.click(byId('integration-accept-moved'));
    expect(byId('integration-confirm-yes').disabled).toBe(false);
    fireEvent.click(byId('integration-confirm-yes'));
    await flush();
    expect(sent(calls)[0].args).toMatchObject({ action: 'merge', head_commit: H, accept_moved_target: T2 });
  });

  it('target_moved, head_moved y la rama equivocada se explican y no dan nada por integrado', async () => {
    for (const [outcome, extra, pattern] of [
      ['target_moved', { expected_commit: T1, found_commit: T2 }, /El destino cambió fuera de Lixbon \(esperado c3c3c3c3c3c3, encontrado d4d4d4d4d4d4\)\. No se integró/],
      ['head_moved', { found_commit: T2 }, /La rama se movió desde que la viste.*No se integró nada/],
      ['target_branch_mismatch', { expected_branch: 'main', found_branch: 'otra' }, /está en «otra» y esta tarea nació de «main»/],
      ['review_required', {}, /aceptar la revisión de este HEAD exacto/],
    ]) {
      mountCore({ decide: () => ({ outcome, ...extra }) });
      const { unmount } = mount();
      await flush();
      fireEvent.click(byId('integration-merge'));
      fireEvent.click(byId('integration-confirm-yes'));
      await flush();
      expect(byId('integration-result').textContent, outcome).toMatch(pattern);
      expect(byId('integration-result').dataset.tone, outcome).toBe('warn');
      unmount();
    }
  });

  it('publicar un PR dice que publica fuera, y muestra el PR creado o el ya existente', async () => {
    const calls = mountCore({ decide: () => ({ outcome: 'created', pr_url: 'https://github.com/lixbon/demo/pull/7' }) });
    mount();
    await flush();
    fireEvent.click(byId('integration-pr-open'));
    expect(byId('integration-confirm').textContent).toMatch(/empujar la rama a «origin» y abrir un PR con la revisión a1a1a1a1a1a1.*publica fuera/);
    fireEvent.click(byId('integration-confirm-yes'));
    await flush();
    expect(sent(calls)[0]).toEqual({ cmd: 'attempt_integrate', args: { attempt_id: 't3-a1', action: 'publish_pr', head_commit: H, confirm: true } });
    expect(byId('integration-result').textContent).toContain('PR creado.');
    expect(byId('integration-result').textContent).toContain('https://github.com/lixbon/demo/pull/7');
    cleanup();
    mountCore({ decide: () => ({ outcome: 'already_exists', pr_url: 'https://github.com/lixbon/demo/pull/7' }) });
    mount();
    await flush();
    fireEvent.click(byId('integration-pr-open'));
    fireEvent.click(byId('integration-confirm-yes'));
    await flush();
    expect(byId('integration-result').textContent).toMatch(/Ya existía un PR: no se abrió otro/);
  });

  it('lo que el Core no deja hacer sale desactivado con su motivo en llano', async () => {
    mountCore({
      previews: [preview({
        review: { state: 'none' },
        can_merge: { ok: false, reason: 'review_required' },
        can_publish_pr: { ok: false, reason: 'review_required' },
      })],
    });
    mount();
    await flush();
    expect(byId('integration-merge').disabled).toBe(true);
    expect(byId('integration-pr-open').disabled).toBe(true);
    expect(byId('integration-blocks').textContent).toMatch(/Fusionar: Primero acepta la revisión de este HEAD exacto/);
    cleanup();
    mountCore({ previews: [preview({ can_merge: { ok: false, reason: 'checkout_dirty' }, can_publish_pr: { ok: false, reason: 'no_remote' }, target: { ...preview().target, clean: false } })] });
    mount();
    await flush();
    expect(byId('integration-blocks').textContent).toMatch(/cambios sin commit.*remoto «origin»/);
    expect(byId('integration-target').textContent).toContain('con cambios sin commit');
  });

  it('un intento ya integrado se ve como tal y no se ofrece otra vez; el error del efecto lleva su detalle', async () => {
    mountCore({ previews: [preview({ merge: { merged: true, result_commit: T2 }, can_merge: { ok: false, reason: 'already_merged' } })] });
    mount();
    await flush();
    expect(byId('integration-state').textContent).toContain('Integrado (d4d4d4d4d4d4)');
    expect(byId('integration-merge').disabled).toBe(true);
    cleanup();
    mountCore({ decide: () => ({ outcome: 'error', message: 'El checkout del padre tiene cambios sin commit' }) });
    mount();
    await flush();
    fireEvent.click(byId('integration-merge'));
    fireEvent.click(byId('integration-confirm-yes'));
    await flush();
    expect(byId('integration-result').dataset.tone).toBe('error');
    expect(byId('integration-result').textContent).toContain('El efecto falló.');
    expect(byId('integration-result').textContent).toContain('cambios sin commit');
  });
});
