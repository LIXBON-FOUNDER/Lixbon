import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptOwnership } from './AttemptOwnership';
import { AttemptTransfer } from './AttemptTransfer';
import { DeepLinkGate } from './DeepLinkGate';
import { validateLink, validateOwnership, validateWorkspace } from './f6Contract';
import { resetOutstandingQueries } from './coreQueryPolicy';
import { live } from './testFixtures/providerCapabilitiesFixtures';
import { validVariant } from './testFixtures/contextPreviewFixtures';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const native = vi.hoisted(() => ({ receive: null, show: vi.fn(), off: vi.fn() }));
vi.mock('@tauri-apps/plugin-deep-link', () => ({ getCurrent: vi.fn(async () => null), onOpenUrl: vi.fn(async (cb) => { native.receive = cb; return native.off; }) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ show: native.show, unminimize: async () => {}, setFocus: async () => {} }) }));

const attempt = { id: 't3-a1', task_id: 't3', project_id: 'p1', n: 1, status: 'running', provider: 'fake-completo', provider_session: { resumable: true } };
const link = (over = {}) => ({ v: 1, status: 'ready', canonical: 'lixbon://project/p1/task/t3?view=overview', target: { project_id: 'p1', task_id: 't3', attempt_id: null, view: 'overview', file: null, line: null, revision: null }, revision: { state: 'not_requested', current: null, requested: null }, ...over });
const owner = (over = {}) => ({ v: 1, attempt_id: attempt.id, owner: 'agent', can_return: false, blocker: null, human_changes: null, ...over });
const flush = () => act(async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); invoke.mockReset(); resetOutstandingQueries(); native.receive = null; native.show.mockReset(); useTerminalStore.setState({ sessions: [], activeKey: null }); });

describe('F6 boundaries', () => {
  it('rejects malformed destinations and mismatched workspace or ambiguous owner data', () => {
    expect(validateLink(link()).target.task_id).toBe('t3');
    for (const file of ['../x', '/x', 'C:/x', 'a\\b', '%2e/x']) expect(() => validateLink(link({ target: { ...link().target, file } }))).toThrow();
    expect(() => validateLink(link({ status: 'stale' }))).toThrow();
    expect(() => validateWorkspace({ v: 1, attempt_id: 'other' }, { attempt_id: attempt.id })).toThrow();
    expect(() => validateOwnership({ v: 1, project_id: 'p1', path: 'x', owner: { state: 'ambiguous', attempt, candidates: [] }, touched_by: [] }, { project_id: 'p1', path: 'x' })).toThrow();
  });

  it('waits for the safe boundary before opening the same Attempt workspace and keeps owner on failure', async () => {
    let finish;
    const open = vi.spyOn(useAppStore.getState(), 'openWorkspace').mockResolvedValue('/repo/wt');
    invoke.mockImplementation(async (cmd, p) => {
      if (cmd === 'orch_query' && p.query === 'attempt_return_preview') return owner();
      if (cmd === 'orch_query' && p.query === 'provider_capabilities') return live();
      if (cmd === 'orch_call') return new Promise((resolve) => { finish = resolve; });
      if (p.query === 'attempt_workspace') return { v: 1, ...attempt, attempt_id: attempt.id, worktree_id: 'wt1', root: '/repo/wt', file: null };
    });
    render(<AttemptOwnership attempt={attempt} />); await flush();
    fireEvent.click(await screen.findByText('Take Over…'));
    fireEvent.click(screen.getByText('Confirmar')); await flush();
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText('Esperando confirmación del Core…')).toBeTruthy();
    await act(async () => { finish({ status: 'TakenOver', attempt_id: attempt.id, owner: 'human' }); });
    await waitFor(() => expect(open).toHaveBeenCalledWith('/repo/wt'));
    expect(useTerminalStore.getState().sessions[0].cwd).toBe('/repo/wt');
    expect(invoke.mock.calls.find(([c]) => c === 'orch_call')[1].args.attempt_id).toBe(attempt.id);
  });

  it('does not open resources when take over fails', async () => {
    invoke.mockImplementation(async (cmd, p) => {
      if (p.query === 'attempt_return_preview') return owner();
      if (p.query === 'provider_capabilities') return live();
      if (cmd === 'orch_call') throw new Error('failed/stop_timeout');
    });
    render(<AttemptOwnership attempt={attempt} />); await flush();
    fireEvent.click(await screen.findByText('Take Over…')); fireEvent.click(screen.getByText('Confirmar')); await flush();
    expect(invoke.mock.calls.some(([, p]) => p.query === 'attempt_workspace')).toBe(false);
    expect(screen.getByText('El agente tiene el control.')).toBeTruthy();
  });

  it('requires explicit provider, new Task and a verified package before delegating; keeps focus after success', async () => {
    const pkg = validVariant((r) => Object.assign(r.package.source, { project_id: 'p1', task_id: 't3', attempt_id: 't3-a1' }));
    invoke.mockImplementation(async (cmd, p) => {
      if (p.query === 'provider_capabilities') return live();
      if (p.query === 'context_package_preview') return pkg;
      if (p.cmd === 'context_package_build') return pkg;
      if (p.cmd === 'attempt_delegate') return { status: 'Requested', task_id: 't9', attempt_id: 't9-a1' };
    });
    useWorkbenchStore.setState({ mode: 'editor' });
    const { rerender } = render(<AttemptTransfer attempt={attempt} source={{ file: 'first.rs', revision: 'abcdef1', line: 2 }} />);
    fireEvent.click(screen.getByText('Delegate…')); await flush();
    expect(screen.getByRole('button', { name: 'Confirmar transferencia' }).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Proveedor receptor'), { target: { value: 'fake-completo' } });
    fireEvent.change(screen.getByLabelText('Encargo'), { target: { value: 'Arregla los errores' } });
    fireEvent.click(screen.getByLabelText('Crear una Task nueva desde este origen'));
    fireEvent.click(screen.getByText('Construir y verificar ContextPackage')); await flush();
    fireEvent.click(screen.getByLabelText(/Revisé el origen/));
    // Changing the editor selection must not retarget the open transfer.
    rerender(<AttemptTransfer attempt={attempt} source={{ file: 'other.rs', revision: 'bbbbbbb', line: 9 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar transferencia' })); await flush();
    const sent = invoke.mock.calls.find(([, p]) => p.cmd === 'attempt_delegate')?.[1];
    expect(sent.args).toMatchObject({ file: 'first.rs', revision: 'abcdef1', line: 2, new_task: true, provider: 'fake-completo' });
    expect(useWorkbenchStore.getState().mode).toBe('editor');
    expect(screen.getByText('Abrir Attempt nuevo')).toBeTruthy();
  });

  it('resolves a warm link through Core and refuses stale navigation until explicit confirmation', async () => {
    const stale = link({ canonical: 'lixbon://project/p1/task/t3?view=overview&revision=aaaaaaa', status: 'stale', revision: { state: 'stale', requested: 'aaaaaaa', current: 'bbbbbbb' }, target: { ...link().target, revision: 'aaaaaaa' } });
    invoke.mockImplementation(async (_, p) => p.query === 'deep_link_resolve' ? stale : link());
    useWorkbenchStore.setState({ mode: 'editor' });
    render(<DeepLinkGate />); await flush();
    await act(async () => native.receive(['lixbon://project/p1/task/t3?revision=aaaaaaa']));
    expect(useWorkbenchStore.getState().mode).toBe('editor');
    expect(screen.getByText(/No se abrió el recurso/)).toBeTruthy();
    fireEvent.click(screen.getByText('Abrir explícitamente la versión actual')); await flush();
    expect(useWorkbenchStore.getState().adeSelection).toMatchObject({ projectId: 'p1', taskId: 't3' });
    expect(useWorkbenchStore.getState().mode).toBe('orch');
    expect(invoke.mock.calls.some(([, p]) => p.query === 'deep_link_generate' && p.args.revision === undefined)).toBe(true);
  });

  it('Handoff shows a verified package, uses the same Task and keeps source/package after a failure', async () => {
    const pkg = validVariant((r) => Object.assign(r.package.source, { project_id: 'p1', task_id: 't3', attempt_id: 't3-a1' }));
    invoke.mockImplementation(async (_, p) => {
      if (p.query === 'provider_capabilities') return live();
      if (p.query === 'context_package_preview' || p.cmd === 'context_package_build') return pkg;
      if (p.cmd === 'attempt_handoff') throw new Error('context_package_source_mismatch');
    });
    render(<AttemptTransfer attempt={{ ...attempt, status: 'done' }} />);
    fireEvent.click(screen.getByText('Agent Handoff…')); await flush();
    fireEvent.change(screen.getByLabelText('Proveedor receptor'), { target: { value: 'fake-completo' } });
    fireEvent.click(screen.getByText('Construir y verificar ContextPackage')); await flush();
    fireEvent.click(screen.getByLabelText(/Revisé el origen/));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar transferencia' })); await flush();
    const sent = invoke.mock.calls.find(([, p]) => p.cmd === 'attempt_handoff')[1];
    expect(sent.args).toEqual({ task_id: 't3', from_attempt_id: 't3-a1', provider: 'fake-completo', package_id: pkg.package_id });
    expect(screen.getByTestId('context-preview-valid')).toBeTruthy();
    expect(screen.getByLabelText('Proveedor receptor').value).toBe('fake-completo');
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('Return requires the current Core preview and does not offer returning without verified changes', async () => {
    invoke.mockImplementation(async (_, p) => p.query === 'attempt_return_preview'
      ? owner({ owner: 'human', can_return: true }) : p.query === 'provider_capabilities' ? live() : null);
    render(<AttemptOwnership attempt={attempt} />); await flush();
    fireEvent.click(screen.getByText('Return to Agent…'));
    expect(screen.getByRole('button', { name: 'Confirmar' }).disabled).toBe(true);
    expect(invoke.mock.calls.some(([c]) => c === 'orch_call')).toBe(false);
  });

  it('acknowledges remote opening only after resolving the URL and showing the destination', async () => {
    invoke.mockImplementation(async () => link());
    render(<DeepLinkGate />); await flush();
    const ack = vi.fn();
    await act(async () => window.dispatchEvent(new CustomEvent('lixbon:open-link', { detail: { url: 'lixbon://project/p1/task/t3?view=overview', ack } })));
    await flush();
    expect(ack).toHaveBeenCalledWith(true); expect(native.show).toHaveBeenCalledTimes(1);
  });
});
