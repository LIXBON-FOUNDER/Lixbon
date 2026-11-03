import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// A5 · cambios de la rama del intento · A6 · revisar sobre el commit que se vio.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

const WORKTREE = { id: 'wt-1', path: '/w/t3-a1', branch: 'lx/r1/t3-a1', base_branch: 'main', machine: 'm1', state: 'active', provenance: 'created', branch_kept: false, registered_by_attempt_id: 't3-a1' };
const DIFF = {
  task_id: 't3', branch: 'lx/r1/t3-a1', base_commit: 'aaaaaaa1111', base_source: 'recorded', head_commit: 'bbbbbbb2222',
  files: [{ path: 'src/nuevo.txt', status: 'A', additions: 2, deletions: 0, patch: '@@ -0,0 +1,2 @@\n+uno\n+dos\n' }],
  truncated: false, limit_bytes: 524288,
};

function mountCore({ status = 'done', worktree = WORKTREE, review = () => ({ outcome: 'recorded', task_id: 't3', decision: 'accepted', head_commit: DIFF.head_commit }), diff = DIFF } = {}) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_task_diff') return diff;
    if (command === 'orch_review_task') return review(payload);
    if (payload?.query === 'provider_capabilities') return live();
    if (payload?.query === 'activity_list') return attemptActivityPage([]);
    return attemptDetail({ id: 't3-a1', task_id: 't3', status, worktree });
  });
  return calls;
}
const mount = () => render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
const sent = (calls, command) => calls.filter((c) => c.command === command).map((c) => c.payload);

describe('A5 · cambios de la rama del intento', () => {
  it('ofrece ver los cambios con una rama que revisar y no lee el diff hasta pedirlo', async () => {
    const calls = mountCore();
    mount();
    await flush();
    expect(screen.getByTestId('attempt-changes-toggle').textContent).toBe('Ver cambios');
    expect(sent(calls, 'orch_task_diff')).toEqual([]);

    fireEvent.click(screen.getByTestId('attempt-changes-toggle'));
    await flush();
    expect(sent(calls, 'orch_task_diff')).toEqual([{ task_id: 't3' }]);
    expect(screen.getByTestId('tdv-file-src/nuevo.txt')).toBeTruthy();
    expect(screen.getByTestId('tdv-head').title).toBe('bbbbbbb2222');
    expect(screen.getByTestId('attempt-changes-toggle').textContent).toBe('Ocultar cambios');
  });

  it('con el worktree retirado solo se ofrece si la rama se conservó', async () => {
    mountCore({ worktree: { ...WORKTREE, path: null, state: 'removed', branch_kept: true } });
    const { unmount } = mount();
    await flush();
    expect(screen.getByTestId('attempt-changes-toggle')).toBeTruthy();
    unmount();
  });

  it('no aparece sin rama (sin worktree o retirado sin conservar la rama) ni mientras espera la aprobación del lanzamiento', async () => {
    for (const over of [{ worktree: null }, { worktree: { ...WORKTREE, branch: null } }, { worktree: { ...WORKTREE, path: null, state: 'removed', branch_kept: false } }, { status: 'pending_approval' }]) {
      mountCore(over);
      const { unmount } = mount();
      await flush();
      expect(screen.queryByTestId('attempt-changes'), JSON.stringify(over)).toBeNull();
      unmount();
    }
  });

  it('un rechazo del Core al leer el diff se dice y no rompe el detalle', async () => {
    const calls = mountCore();
    invoke.mockImplementation(async (command, payload) => {
      calls.push({ command, payload });
      if (command === 'orch_task_diff') throw new Error('La rama lx/r1/t3-a1 ya no existe');
      if (payload?.query === 'provider_capabilities') return live();
      if (payload?.query === 'activity_list') return attemptActivityPage([]);
      return attemptDetail({ id: 't3-a1', task_id: 't3', status: 'done', worktree: WORKTREE });
    });
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('attempt-changes-toggle'));
    await flush();
    expect(screen.getByTestId('tdv-load-error').textContent).toMatch(/ya no existe/);
    expect(screen.getByTestId('attempt-detail')).toBeTruthy();
  });
});

describe('A6 · revisar sobre un commit fijo', () => {
  async function openAndAccept(calls) {
    fireEvent.click(screen.getByTestId('attempt-changes-toggle'));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Aceptar' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar aceptar' }));
    await flush();
    return calls;
  }

  it('aceptar manda el head_commit visto con confirmación y refresca el detalle del intento', async () => {
    const calls = mountCore();
    mount();
    await flush();
    const before = calls.filter((c) => c.payload?.query === 'attempt_detail').length;
    await openAndAccept(calls);
    expect(sent(calls, 'orch_review_task')).toEqual([{ task_id: 't3', decision: 'accepted', head_commit: 'bbbbbbb2222', confirm: true }]);
    expect(screen.getByTestId('tdv-done').textContent).toMatch(/Diff aceptado/);
    expect(calls.filter((c) => c.payload?.query === 'attempt_detail').length).toBeGreaterThan(before);
  });

  it('si la rama se movió no se registra nada y se pide recargar', async () => {
    const calls = mountCore({ review: () => ({ outcome: 'head_moved', task_id: 't3', expected_commit: 'bbbbbbb2222', found_commit: 'ccccccc3333' }) });
    mount();
    await flush();
    await openAndAccept(calls);
    expect(screen.getByTestId('tdv-head-moved').textContent).toMatch(/La rama se movió/);
    expect(screen.queryByTestId('tdv-done')).toBeNull();
  });

  it('rechazar lleva el comentario', async () => {
    const calls = mountCore({ review: () => ({ outcome: 'recorded', task_id: 't3', decision: 'rejected', head_commit: 'bbbbbbb2222' }) });
    mount();
    await flush();
    fireEvent.click(screen.getByTestId('attempt-changes-toggle'));
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Rechazar' }));
    fireEvent.change(screen.getByLabelText(/Comentario/), { target: { value: 'falta una prueba' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar rechazo' }));
    await flush();
    expect(sent(calls, 'orch_review_task')).toEqual([{ task_id: 't3', decision: 'rejected', head_commit: 'bbbbbbb2222', comment: 'falta una prueba', confirm: true }]);
  });
});
