import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CodexLaunchPanel } from './CodexLaunchPanel';
import { CodexTabList } from './CodexTabs';
import { useCodexTermStore } from './codexTermStore';
import { policyArgs, normalizeSession } from './codexTermContract';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
afterEach(cleanup);
beforeEach(() => useCodexTermStore.setState({ tabs: [], activeKey: null, launcher: false, launcherResume: null, buffers: {} }));

const ID = '01a123cf-5f63-7591-b38c-67509d3a1ce1';
const resumeArgv = ['codex', 'resume', ID, '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--cd', 'C:/repo'];

describe('reanudar una sesión de Codex', () => {
  it('el panel pide la política con el id, enseña la sesión y abre con «Reanudar»', async () => {
    const api = {
      policy: vi.fn(async () => ({ policy: { provider: 'codex', profile: 'terminal', status: 'ok', resume: ID }, argv: resumeArgv, warnings: [] })),
      open: vi.fn(async () => ({ term_id: 'codex-1', argv: resumeArgv, warnings: [], policy: null })),
    };
    const onOpened = vi.fn();
    render(<CodexLaunchPanel cwd="C:/repo" codex={null} resume={{ id: ID, title: 'arregla el login' }} api={api} onOpened={onOpened} />);

    expect(screen.getByText('Reanudar sesión de Codex')).toBeTruthy();
    expect(screen.getByTestId('codex-resume-title').textContent).toBe('arregla el login');
    await waitFor(() => expect(screen.getByTestId('codex-argv').textContent).toContain(`codex resume ${ID}`));
    expect(api.policy).toHaveBeenLastCalledWith({ cwd: 'C:/repo', model: '', effort: '', resume: ID });

    fireEvent.click(screen.getByRole('button', { name: 'Reanudar' }));
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    expect(api.open).toHaveBeenCalledWith(expect.objectContaining({ cwd: 'C:/repo', resume: ID }));
    expect(onOpened.mock.calls[0][1]).toMatchObject({ resume: ID, title: 'arregla el login' });
  });

  it('sin sesión elegida el panel sigue siendo el de abrir Codex, sin rastro de resume', async () => {
    const api = { policy: vi.fn(async () => ({ policy: null, argv: ['codex'], warnings: [] })), open: vi.fn() };
    render(<CodexLaunchPanel cwd="C:/repo" codex={null} api={api} onOpened={vi.fn()} />);
    expect(screen.getByText('Codex en una terminal')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Abrir' })).toBeTruthy();
    await waitFor(() => expect(api.policy).toHaveBeenCalled());
    expect(api.policy.mock.calls[0][0]).toEqual({ cwd: 'C:/repo', model: '', effort: '' });
  });

  it('el store guarda la sesión a reanudar y la olvida al cancelar, abrir o cambiar de vista', () => {
    const st = () => useCodexTermStore.getState();
    st().openLauncher({ id: ID, title: 'x', cwd: 'C:/repo' });
    expect(st().launcher).toBe(true);
    expect(st().launcherResume).toMatchObject({ id: ID });
    st().cancelLauncher();
    expect(st().launcherResume).toBeNull();

    st().openLauncher({ id: ID });
    st().addTab({ term_id: 't1' }, { cwd: 'C:/repo', title: 'arregla el login' });
    expect(st().launcherResume).toBeNull();
    expect(st().tabs[0].title).toBe('arregla el login');

    st().openLauncher({ id: ID });
    st().deactivate();
    expect(st().launcherResume).toBeNull();
    st().openLauncher();
    expect(st().launcherResume).toBeNull();
  });

  it('la pestaña reanudada se llama por el título de su sesión', () => {
    useCodexTermStore.getState().addTab({ term_id: 't1' }, { cwd: 'C:/repo', title: 'arregla el login' });
    useCodexTermStore.getState().addTab({ term_id: 't2' }, { cwd: 'C:/proyectos/web' });
    render(<CodexTabList />);
    const tabs = screen.getAllByRole('button', { name: /^Codex/ });
    expect(tabs[0].textContent).toContain('Codex 1 · arregla el login');
    expect(tabs[1].textContent).toContain('Codex 2 · web');
  });
});

describe('contrato de sesiones', () => {
  it('policyArgs solo manda resume si lo hay', () => {
    expect(policyArgs({ cwd: 'C:/r' })).toEqual({ cwd: 'C:/r' });
    expect(policyArgs({ cwd: 'C:/r', resume: ` ${ID} ` })).toEqual({ cwd: 'C:/r', resume: ID });
    expect(policyArgs({ cwd: 'C:/r', resume: '  ' })).toEqual({ cwd: 'C:/r' });
  });

  it('normalizeSession descarta lo que no sirve y rellena lo que falta', () => {
    expect(normalizeSession(null)).toBeNull();
    expect(normalizeSession({ title: 'sin id' })).toBeNull();
    expect(normalizeSession({ id: ID })).toEqual({ id: ID, cwd: '', title: 'Sesión de Codex', updated_ms: 0, model: null });
    expect(normalizeSession({ id: ID, cwd: 'C:/r', title: 't', updated_ms: 5, model: 'gpt-6' })).toEqual({ id: ID, cwd: 'C:/r', title: 't', updated_ms: 5, model: 'gpt-6' });
  });
});
