import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { EffectivePolicyView } from './EffectivePolicyView';
import { DEFERRED_REASON } from './resolvePolicy';
import { mockResolvePolicy, ALLOWED_TOOLS_WARNING, LXO_ONLY_WARNING, CODEX_LXO_DONE_REASON, KNOWN_ROLES } from './mockResolvePolicy';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(cleanup);

const launchBtn = () => screen.getByRole('button', { name: 'Lanzar' });

describe('EffectivePolicyView', () => {
  it('estado ok: muestra argv, versión y advertencias de Claude, y permite lanzar', async () => {
    const onLaunch = vi.fn();
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" role="explorador" onLaunch={onLaunch} />);
    expect(await screen.findByTestId('policy-argv')).toHaveProperty('textContent', 'claude --disallowedTools Edit Write NotebookEdit --allowedTools "Bash(lxo *)" --permission-mode plan');
    expect(screen.getByTestId('policy-status').textContent).toContain('Lista para lanzar');
    expect(screen.getByText('2.1.296')).toBeTruthy();
    expect(screen.getByText(/sin sandbox|no tiene sandbox del sistema operativo/)).toBeTruthy();
    expect(screen.getByText('Claude no corta la red.')).toBeTruthy();
    expect(screen.getByText(/worktree de git/)).toBeTruthy();
    expect(launchBtn().disabled).toBe(false);
    fireEvent.click(launchBtn());
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const sent = onLaunch.mock.calls[0][0];
    expect(sent.profile).toBe('explorar');
    expect(sent.provider).toBe('claude');
    expect(sent.argv).toEqual(['claude', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', '--allowedTools', 'Bash(lxo *)', '--permission-mode', 'plan']);
    expect(sent.ack_unverified).toBe(false);
    expect(sent.role).toBe('explorador');
    expect(screen.getByTestId('policy-role').textContent).toBe('explorador');
  });

  it('Claude + Proponer: argv igual al del host de DESKTOP', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProfile="proponer" />);
    expect((await screen.findByTestId('policy-argv')).textContent)
      .toBe('claude --disallowedTools Edit Write NotebookEdit --allowedTools "Bash(lxo *)" --permission-mode plan');
    expect(screen.getByText(LXO_ONLY_WARNING)).toBeTruthy();
  });

  it('Codex + Delegar con revisión: argv de la tabla con -C al worktree', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProvider="codex" initialProfile="delegar_con_revision" />);
    expect((await screen.findByTestId('policy-argv')).textContent)
      .toBe('codex --sandbox workspace-write --ask-for-approval never --cd C:/wt/t1');
  });

  it('Claude + Delegar con revisión: solo acceptEdits, sin --permission-prompts, con advertencia de --allowedTools', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProfile="delegar_con_revision" />);
    expect((await screen.findByTestId('policy-argv')).textContent).toBe('claude --permission-mode acceptEdits');
    expect(document.body.textContent).not.toContain('--permission-prompts');
    expect(screen.getByText(ALLOWED_TOOLS_WARNING)).toBeTruthy();
  });

  it('Codex 0.162.1 también cuenta como verificada', async () => {
    const resolver = (a) => mockResolvePolicy(a, { detectedVersion: '0.162.1' });
    render(<EffectivePolicyView worktree="C:/wt/t1" initialProvider="codex" resolver={resolver} />);
    expect((await screen.findByTestId('policy-status')).textContent).toContain('Lista para lanzar');
  });

  it('estado blocked: muestra el motivo y deshabilita Lanzar', async () => {
    const resolver = (a) => mockResolvePolicy(a, { detectedVersion: null });
    const onLaunch = vi.fn();
    render(<EffectivePolicyView worktree="C:/wt/t1" resolver={resolver} onLaunch={onLaunch} />);
    const status = await screen.findByTestId('policy-status');
    expect(status.textContent).toContain('Bloqueada');
    expect(status.textContent).toContain('No se detectó la CLI de claude');
    expect(launchBtn().disabled).toBe(true);
    fireEvent.click(launchBtn());
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('estado unverified: se marca "No verificado" y Lanzar exige la casilla', async () => {
    const resolver = (a) => mockResolvePolicy(a, { detectedVersion: '2.2.0' });
    const onLaunch = vi.fn();
    render(<EffectivePolicyView worktree="C:/wt/t1" role="explorador" resolver={resolver} onLaunch={onLaunch} />);
    const status = await screen.findByTestId('policy-status');
    expect(status.textContent).toContain('No verificado');
    expect(status.textContent).toContain('2.2.0');
    expect(launchBtn().disabled).toBe(true);
    fireEvent.click(launchBtn());
    expect(onLaunch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Entiendo que esta versión no está verificada' }));
    expect(launchBtn().disabled).toBe(false);
    fireEvent.click(launchBtn());
    expect(onLaunch).toHaveBeenCalledTimes(1);
    const sent = onLaunch.mock.calls[0][0];
    expect(sent.ack_unverified).toBe(true);
    expect(sent.status).toBe('unverified');
    expect(sent.role).toBe('explorador');
    expect(sent.argv).toEqual(['claude', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', '--allowedTools', 'Bash(lxo *)', '--permission-mode', 'plan']);
  });

  it('estado ok: no hay casilla y onLaunch recibe ack_unverified false', async () => {
    const onLaunch = vi.fn();
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" role="explorador" onLaunch={onLaunch} />);
    await screen.findByTestId('policy-status');
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(launchBtn());
    expect(onLaunch.mock.calls[0][0].ack_unverified).toBe(false);
  });

  it('estado blocked: sin casilla y nunca se puede lanzar', async () => {
    const resolver = async (a) => ({ ...(await mockResolvePolicy(a)), status: 'blocked', reason: 'Flag ausente en --help' });
    const onLaunch = vi.fn();
    render(<EffectivePolicyView worktree="C:/wt/t1" resolver={resolver} onLaunch={onLaunch} />);
    expect((await screen.findByTestId('policy-status')).textContent).toContain('Flag ausente en --help');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(launchBtn().disabled).toBe(true);
    fireEvent.click(launchBtn());
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('Codex en tarea hija (cualquier rol válido): blocked y Lanzar deshabilitado', async () => {
    for (const role of KNOWN_ROLES) {
      const onLaunch = vi.fn();
      render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProvider="codex" role={role} onLaunch={onLaunch} />);
      const status = await screen.findByTestId('policy-status');
      expect(status.textContent).toContain('Bloqueada');
      expect(status.textContent).toContain(CODEX_LXO_DONE_REASON);
      expect(launchBtn().disabled).toBe(true);
      fireEvent.click(launchBtn());
      expect(onLaunch).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it('Claude con rol: ok, pasa el rol al resolver y onLaunch lo incluye', async () => {
    const onLaunch = vi.fn();
    const resolver = vi.fn(mockResolvePolicy);
    render(<EffectivePolicyView resolver={resolver} worktree="C:/wt/t1" role="implementador" initialProfile="delegar_con_revision" onLaunch={onLaunch} />);
    expect((await screen.findByTestId('policy-status')).textContent).toContain('Lista para lanzar');
    expect(resolver).toHaveBeenCalledWith({ provider: 'claude', profile: 'delegar_con_revision', role: 'implementador', worktree: 'C:/wt/t1' });
    fireEvent.click(launchBtn());
    const sent = onLaunch.mock.calls[0][0];
    expect(sent.role).toBe('implementador');
    expect(sent.profile).toBe('delegar_con_revision');
    expect(sent.ack_unverified).toBe(false);
  });

  it('Claude ok con cualquier rol válido en los tres perfiles', async () => {
    for (const profile of ['explorar', 'proponer', 'delegar_con_revision']) {
      for (const role of KNOWN_ROLES) {
        const p = await mockResolvePolicy({ provider: 'claude', profile, role, worktree: 'C:/wt/t1' });
        expect([p.status, p.role]).toEqual(['ok', role]);
      }
    }
  });

  it('rol desconocido: blocked con el motivo del host', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" role="arquitecto" />);
    expect((await screen.findByTestId('policy-status')).textContent).toContain('Rol desconocido: arquitecto');
    expect(launchBtn().disabled).toBe(true);
  });

  it('sin rol: solo consulta, role null y Lanzar deshabilitado aunque el estado sea ok', async () => {
    const onLaunch = vi.fn();
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProvider="codex" onLaunch={onLaunch} />);
    expect((await screen.findByTestId('policy-status')).textContent).toContain('Lista para lanzar');
    expect(screen.getByTestId('policy-role').textContent).toBe('Sin rol (solo consulta)');
    expect(launchBtn().disabled).toBe(true);
    fireEvent.click(launchBtn());
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it('Autonomía amplia visible pero deshabilitada con su motivo; no hay bypass', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" />);
    await screen.findByTestId('policy-status');
    const radio = screen.getByRole('radio', { name: /Autonomía amplia/ });
    expect(radio.disabled).toBe(true);
    expect(screen.getByText(new RegExp(DEFERRED_REASON))).toBeTruthy();
    const all = document.body.textContent;
    expect(all).not.toMatch(/bypassPermissions|danger-full-access|dangerously/);
  });
});
