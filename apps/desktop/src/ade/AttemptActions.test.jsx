import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { AttentionInbox } from './AttentionInbox';
import { ATTENTION_LIMIT } from './coreQueries';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// A1 · aprobar desde la bandeja · A2 · detener el intento en marcha · A3 · línea de contexto del intento.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); resetOutstandingQueries(); });

/** Un Core de pruebas: `attempt_detail` sirve el estado que se diga; `orch_call` queda registrado y responde `decide`. */
function mountCore({ status = 'running', attention = [], decide = () => ({ status: 'Approved', attempt_id: 't3-a1' }), over = {} } = {}) {
  const calls = [];
  invoke.mockImplementation(async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'orch_call') return decide(payload);
    if (payload.query === 'provider_capabilities') return live();
    if (payload.query === 'activity_list') return attemptActivityPage([]);
    if (payload.query === 'attention_list') {
      return { v: 1, items: attention, next_cursor: null, has_more: false, limit: ATTENTION_LIMIT };
    }
    if (payload.query === 'projects_overview') return { v: 1, filters: { archived: 'include', machine: null }, total: 0, projects: [], unassigned: { tasks: 0, active: 0, failed: 0, attention: { total: 0, by_category: {} } } };
    return attemptDetail({ id: 't3-a1', task_id: 't3', status, ...over });
  });
  return calls;
}
const decisions = (calls) => calls.filter((c) => c.command === 'orch_call').map((c) => c.payload);

const row = (over = {}) => ({
  id: 'att_00000000000000000000000000000001', category: 'approval', severity: 'medium', status: 'active',
  target_kind: 'attempt', target_id: 't3-a1', project_id: 'project-a', run_id: 'run-1', occurrence: 1,
  created_at: 1_000, resolved_at: null, resolution: null, ...over,
});

describe('A1 · aprobar o rechazar desde la bandeja de Attention', () => {
  it('una aprobación de lanzamiento (el intento está pending_approval) ofrece Aprobar y Rechazar y decide por su Attempt', async () => {
    const calls = mountCore({ status: 'pending_approval', attention: [row()] });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await flush();
    const actions = await screen.findByTestId('attention-launch-actions');
    expect(within(actions).getByTestId('attempt-approve')).toBeTruthy();
    expect(within(actions).getByTestId('attempt-reject')).toBeTruthy();

    fireEvent.click(within(actions).getByTestId('attempt-approve'));
    await flush();
    expect(decisions(calls)).toEqual([{ cmd: 'attempt_approve', args: { attempt_id: 't3-a1' } }]);
    expect(within(actions).getByTestId('attempt-approval-outcome').textContent).toMatch(/Aprobado/);
  });

  it('rechazar llama a attempt_reject', async () => {
    const calls = mountCore({ status: 'pending_approval', attention: [row()], decide: () => ({ status: 'Rejected', attempt_id: 't3-a1' }) });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await flush();
    fireEvent.click(await screen.findByTestId('attempt-reject'));
    await flush();
    expect(decisions(calls)).toEqual([{ cmd: 'attempt_reject', args: { attempt_id: 't3-a1' } }]);
  });

  it('la aprobación de una petición de terminal (el intento ya corre) NO ofrece decidir aquí', async () => {
    mountCore({ status: 'awaiting_terminal_approval', attention: [row()] });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await flush();
    await flush();
    expect(screen.queryByTestId('attempt-approve')).toBeNull();
    expect(screen.getByRole('button', { name: /Aprobación/i })).toBeTruthy();
  });

  it('otras Attention no leen ningún Attempt ni ofrecen botones', async () => {
    const calls = mountCore({ attention: [row({ category: 'question', target_kind: 'task', target_id: 't3' }), row({ id: 'att_2', category: 'approval', target_kind: 'task', target_id: 't3' })] });
    render(<AttentionInbox onOpenTarget={vi.fn()} />);
    await flush();
    expect(screen.queryByTestId('attention-launch-actions')).toBeNull();
    expect(calls.some((c) => c.payload?.query === 'attempt_detail')).toBe(false);
  });
});

describe('A2 · detener el intento en marcha', () => {
  it('en ejecución pide confirmación y detiene la Task del intento', async () => {
    const calls = mountCore({ status: 'running', decide: () => ({ task: 't3', status: 'stopped' }) });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-stop-open'));
    // Sin confirmar no se manda nada.
    expect(decisions(calls)).toEqual([]);
    expect(screen.getByText(/Lo ya escrito se conserva en su worktree/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('attempt-stop-confirm'));
    await flush();
    expect(decisions(calls)).toEqual([{ cmd: 'stop', args: { task: 't3' } }]);
  });

  it('cancelar la confirmación no detiene nada', async () => {
    const calls = mountCore({ status: 'running' });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-stop-open'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.getByTestId('attempt-stop-open')).toBeTruthy();
    expect(decisions(calls)).toEqual([]);
  });

  it('solo aparece mientras hay ejecución: no en pending_approval ni en un estado final', async () => {
    for (const status of ['pending_approval', 'done', 'failed', 'stopped', 'exited']) {
      mountCore({ status });
      const { unmount } = render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
      await flush();
      expect(screen.queryByTestId('attempt-stop'), status).toBeNull();
      unmount();
    }
    for (const status of ['starting', 'waiting', 'awaiting_terminal_approval']) {
      mountCore({ status });
      const { unmount } = render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
      await flush();
      expect(screen.getByTestId('attempt-stop'), status).toBeTruthy();
      unmount();
    }
  });

  it('si el Core no pudo matar el proceso lo dice y sigue ofreciendo detener', async () => {
    mountCore({ status: 'running', decide: () => { throw new Error('No se pudo detener t3: el proceso sigue vivo. Sigue en marcha; reinténtalo'); } });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    fireEvent.click(screen.getByTestId('attempt-stop-open'));
    fireEvent.click(screen.getByTestId('attempt-stop-confirm'));
    await flush();
    expect(screen.getByTestId('attempt-stop-error').textContent).toMatch(/Sigue en marcha/);
    expect(screen.getByTestId('attempt-stop-confirm').disabled).toBe(false);
  });
});

describe('A3 · línea de contexto del intento', () => {
  it('dice agente, perfil, rama ← base y host con lo que informa el Core', async () => {
    mountCore({
      status: 'running',
      over: { provider: 'claude', model: 'haiku', profile: 'explorar', worktree: { id: 'wt-1', path: '/w/t3-a1', branch: 'lx/r1/t3-a1', base_branch: 'main', machine: 'db703eb4-9b96-4ad9-9d4c-5990975547e3', state: 'active', provenance: 'created', branch_kept: false, registered_by_attempt_id: 't3-a1' } },
    });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    const line = screen.getByTestId('attempt-context');
    const part = (name) => line.querySelector(`[data-part=${name}]`);
    expect(part('agent').textContent).toBe('claude · haiku');
    expect(part('profile').textContent).toBe('explorar');
    expect(part('branch').textContent).toBe('lx/r1/t3-a1 ← main');
    expect(part('host').textContent).toBe('host db703eb4');
    expect(part('host').title).toBe('db703eb4-9b96-4ad9-9d4c-5990975547e3');
  });

  it('sin worktree, perfil ni host no inventa nada: lo dice', async () => {
    mountCore({ status: 'pending_approval', over: { provider: 'codex', model: null, profile: null, worktree: null } });
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    const line = screen.getByTestId('attempt-context');
    expect(line.textContent).toContain('codex');
    expect(line.textContent).toContain('sin perfil');
    expect(line.textContent).toContain('sin worktree');
    expect(line.textContent).toContain('host no informado');
  });
});
