import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { EffectivePolicyView, splitToolList } from './EffectivePolicyView';
import { DEFERRED_REASON } from './resolvePolicy';
import { mockResolvePolicy, CODEX_LARGE_REPORT_WARNING, ALLOWED_TOOLS_WARNING as DELEGAR_WARNING, mockLaunchArgv, PLAN_MODE_MODEL_WARNING, LXO_TOOLS, ALLOWED_TOOLS_WARNING, KNOWN_ROLES, CODEX_REPORT_MARKERS_WARNING, CODEX_REPORT_FILE_WARNING, CODEX_NO_ASK_WARNING, CODEX_COPY_BLOCK_WARNING } from './mockResolvePolicy';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(cleanup);

const launchBtn = () => screen.getByRole('button', { name: 'Lanzar' });

describe('EffectivePolicyView', () => {
  it('estado ok: muestra argv, versión y advertencias de Claude, y permite lanzar', async () => {
    const onLaunch = vi.fn();
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" role="explorador" onLaunch={onLaunch} />);
    expect(await screen.findByTestId('policy-argv')).toHaveProperty('textContent', 'claude -p --output-format stream-json --verbose --disallowedTools=EditWriteNotebookEdit --allowedTools=Bash(lxo report:*)Bash(lxo guide)Bash(lxo phase:*)Bash(lxo ask:*)Bash(lxo check) --permission-mode plan');
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
    expect(sent.argv).toEqual(['claude', '-p', '--output-format', 'stream-json', '--verbose', '--disallowedTools=Edit,Write,NotebookEdit', '--allowedTools=Bash(lxo report:*),Bash(lxo guide),Bash(lxo phase:*),Bash(lxo ask:*),Bash(lxo check)', '--permission-mode', 'plan']);
    expect(sent.ack_unverified).toBe(false);
    expect(sent.role).toBe('explorador');
    expect(screen.getByTestId('policy-role').textContent).toBe('explorador');
  });

  it('Claude + Proponer: argv igual al del host de DESKTOP', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProfile="proponer" />);
    expect((await screen.findByTestId('policy-argv')).textContent)
      .toBe('claude -p --output-format stream-json --verbose --disallowedTools=EditWriteNotebookEdit --allowedTools=Bash(lxo report:*)Bash(lxo guide)Bash(lxo phase:*)Bash(lxo ask:*)Bash(lxo check) --permission-mode plan');
    expect(document.body.textContent).not.toContain('Bash(lxo *)');
  });

  it('Codex + Delegar con revisión: argv de la tabla con -C al worktree', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProvider="codex" initialProfile="delegar_con_revision" />);
    expect((await screen.findByTestId('policy-argv')).textContent)
      .toBe('codex --sandbox workspace-write --ask-for-approval never --cd C:/wt/t1');
  });

  it('Claude + Delegar con revisión: token de --allowedTools y acceptEdits, sin --permission-prompts', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProfile="delegar_con_revision" />);
    expect((await screen.findByTestId('policy-argv')).textContent).toBe('claude --allowedTools=Bash(lxo report:*)Bash(lxo guide)Bash(lxo phase:*)Bash(lxo ask:*)Bash(lxo check) --permission-mode acceptEdits');
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
    expect(sent.argv).toEqual(['claude', '-p', '--output-format', 'stream-json', '--verbose', '--disallowedTools=Edit,Write,NotebookEdit', '--allowedTools=Bash(lxo report:*),Bash(lxo guide),Bash(lxo phase:*),Bash(lxo ask:*),Bash(lxo check)', '--permission-mode', 'plan']);
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

  it('Codex en tarea hija (cualquier rol válido): ok con las advertencias del host por perfil', async () => {
    const cases = {
      explorar: [CODEX_REPORT_MARKERS_WARNING, CODEX_NO_ASK_WARNING, CODEX_COPY_BLOCK_WARNING],
      proponer: [CODEX_REPORT_MARKERS_WARNING, CODEX_NO_ASK_WARNING, CODEX_COPY_BLOCK_WARNING],
      delegar_con_revision: [CODEX_REPORT_FILE_WARNING, CODEX_NO_ASK_WARNING],
    };
    for (const [profile, expected] of Object.entries(cases)) {
      for (const role of KNOWN_ROLES) {
        const onLaunch = vi.fn();
        render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProvider="codex" initialProfile={profile} role={role} onLaunch={onLaunch} />);
        expect((await screen.findByTestId('policy-status')).textContent).toContain('Lista para lanzar');
        for (const w of expected) expect(screen.getByText(w)).toBeTruthy();
        const absent = [CODEX_REPORT_MARKERS_WARNING, CODEX_REPORT_FILE_WARNING, CODEX_COPY_BLOCK_WARNING].filter((w) => !expected.includes(w));
        for (const w of absent) expect(screen.queryByText(w)).toBeNull();
        expect(launchBtn().disabled).toBe(false);
        fireEvent.click(launchBtn());
        expect(onLaunch).toHaveBeenCalledTimes(1);
        cleanup();
      }
    }
  });

  it('las advertencias de Codex sin red no aparecen en Claude ni sin rol', async () => {
    const all = [CODEX_REPORT_MARKERS_WARNING, CODEX_REPORT_FILE_WARNING, CODEX_NO_ASK_WARNING, CODEX_COPY_BLOCK_WARNING];
    const views = [];
    for (const profile of ['explorar', 'proponer', 'delegar_con_revision']) {
      views.push({ initialProvider: 'claude', initialProfile: profile, role: 'implementador' });
      views.push({ initialProvider: 'codex', initialProfile: profile });
      views.push({ initialProvider: 'claude', initialProfile: profile });
    }
    for (const props of views) {
      render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" {...props} />);
      await screen.findByTestId('policy-status');
      for (const w of all) expect(screen.queryByText(w)).toBeNull();
      cleanup();
    }
  });

  it('Codex con rol desconocido sigue blocked y sin advertencias de entrega', async () => {
    const p = await mockResolvePolicy({ provider: 'codex', profile: 'explorar', role: 'arquitecto', worktree: 'C:/wt/t1' });
    expect([p.status, p.reason]).toEqual(['blocked', 'Rol desconocido: arquitecto']);
    expect(p.warnings).not.toContain(CODEX_NO_ASK_WARNING);
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

  it('muestra las reglas de --allowedTools y --disallowedTools una por línea, sin cambiar el argv enviado', async () => {
    const onLaunch = vi.fn();
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" role="explorador" onLaunch={onLaunch} />);
    await screen.findByTestId('policy-argv');
    const lists = screen.getAllByTestId('policy-toollist');
    expect(lists).toHaveLength(2);
    const rules = (el) => [...el.querySelectorAll('[data-testid="policy-toolrule"]')].map((r) => r.textContent);
    expect(rules(lists[0])).toEqual(['Edit', 'Write', 'NotebookEdit']);
    expect(rules(lists[1])).toEqual(LXO_TOOLS);
    fireEvent.click(launchBtn());
    const argv = onLaunch.mock.calls[0][0].argv;
    expect(argv).toContain('--allowedTools=Bash(lxo report:*),Bash(lxo guide),Bash(lxo phase:*),Bash(lxo ask:*),Bash(lxo check)');
    expect(argv).toContain('--disallowedTools=Edit,Write,NotebookEdit');
    expect(argv.filter((a) => a.startsWith('--allowedTools'))).toHaveLength(1);
  });

  it('splitToolList: solo tokens de lista con =', () => {
    expect(splitToolList('--allowedTools=Bash(lxo report:*),Bash(lxo guide),Bash(lxo phase:*),Bash(lxo ask:*),Bash(lxo check)')).toEqual({ flag: '--allowedTools', rules: LXO_TOOLS });
    expect(splitToolList('--allowedTools')).toBeNull();
    expect(splitToolList('--permission-mode')).toBeNull();
  });

  it('modo plan con un modelo que no es Sonnet: la advertencia llega en warnings del mock y la vista la pinta', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" model="haiku" />);
    expect(await screen.findByText(PLAN_MODE_MODEL_WARNING)).toBeTruthy();
  });

  it('la vista no calcula la advertencia del modo plan: si warnings no la trae, no aparece', async () => {
    const resolver = async (a) => ({ ...(await mockResolvePolicy(a)), warnings: [] });
    render(<EffectivePolicyView resolver={resolver} worktree="C:/wt/t1" model="haiku" />);
    await screen.findByTestId('policy-argv');
    expect(screen.queryByText(PLAN_MODE_MODEL_WARNING)).toBeNull();
  });
});

describe('mockResolvePolicy (espejo del host bb0b013)', () => {
  const base = { provider: 'claude', role: null, worktree: 'C:/wt/t1' };
  it('Claude: un solo token --allowedTools con las cuatro reglas en los tres perfiles, nunca Bash(lxo *)', async () => {
    for (const profile of ['explorar', 'proponer', 'delegar_con_revision']) {
      const p = await mockResolvePolicy({ ...base, profile });
      expect(p.argv.filter((a) => a.startsWith('--allowedTools'))).toEqual(['--allowedTools=Bash(lxo report:*),Bash(lxo guide),Bash(lxo phase:*),Bash(lxo ask:*),Bash(lxo check)']);
      expect(p.argv).not.toContain('--allowedTools');
      expect(p.argv).not.toContain('--disallowedTools');
      expect(p.argv.join(' ')).not.toContain('Bash(lxo *)');
    }
  });
  it('advertencia del modo plan: solo con plan y modelo que no es Sonnet', async () => {
    const has = async (profile, model) => (await mockResolvePolicy({ ...base, profile, model })).warnings.includes(PLAN_MODE_MODEL_WARNING);
    expect(await has('explorar', 'haiku')).toBe(true);
    expect(await has('proponer', 'opus')).toBe(true);
    expect(await has('explorar', 'claude-haiku-5-5')).toBe(true);
    expect(await has('explorar', 'sonnet')).toBe(false);
    expect(await has('explorar', 'claude-sonnet-4-5')).toBe(false);
    expect(await has('explorar', null)).toBe(false);
    expect(await has('delegar_con_revision', 'haiku')).toBe(false);
    expect((await mockResolvePolicy({ ...base, provider: 'codex', profile: 'explorar', model: 'haiku' })).warnings).not.toContain(PLAN_MODE_MODEL_WARNING);
  });
  it('lanzamiento: modelo, esfuerzo y -- antes del prompt, como el host', async () => {
    const p = await mockResolvePolicy({ ...base, profile: 'delegar_con_revision' });
    expect(mockLaunchArgv(p, { model: 'opus', effort: 'high', prompt: 'Lee la tarea' }))
      .toEqual(['claude', '--allowedTools=Bash(lxo report:*),Bash(lxo guide),Bash(lxo phase:*),Bash(lxo ask:*),Bash(lxo check)', '--permission-mode', 'acceptEdits', '--model', 'opus', '--effort', 'high', '--', 'Lee la tarea']);
    const e = await mockResolvePolicy({ ...base, profile: 'explorar' });
    expect(mockLaunchArgv(e, { model: 'haiku', prompt: '--no-es-flag' }).slice(-4)).toEqual(['--model', 'haiku', '--', '--no-es-flag']);
  });
  it('Claude: cinco reglas, con Bash(lxo check), y la advertencia de Delegar del host', async () => {
    expect(LXO_TOOLS).toEqual(['Bash(lxo report:*)', 'Bash(lxo guide)', 'Bash(lxo phase:*)', 'Bash(lxo ask:*)', 'Bash(lxo check)']);
    const p = await mockResolvePolicy({ ...base, profile: 'delegar_con_revision' });
    expect(p.warnings).toContain(DELEGAR_WARNING);
    expect(DELEGAR_WARNING).toBe('Los comandos de solo lectura y las cinco reglas de lxo corren sin pedir aprobación. Los comandos que modifican algo esperan aprobación en la terminal; si nadie responde a tiempo, la tarea falla.');
  });
  it('Codex read-only: advertencia de informes grandes; no en workspace-write ni en Claude', async () => {
    for (const profile of ['explorar', 'proponer']) {
      expect((await mockResolvePolicy({ ...base, provider: 'codex', profile })).warnings).toContain(CODEX_LARGE_REPORT_WARNING);
    }
    expect(CODEX_LARGE_REPORT_WARNING).toContain('unos 50 KB');
    expect((await mockResolvePolicy({ ...base, provider: 'codex', profile: 'delegar_con_revision' })).warnings).not.toContain(CODEX_LARGE_REPORT_WARNING);
    expect((await mockResolvePolicy({ ...base, profile: 'explorar' })).warnings).not.toContain(CODEX_LARGE_REPORT_WARNING);
  });
});

describe('modelo pedido en la política efectiva', () => {
  it('Codex sin modelo: "el que defina config.toml"', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProvider="codex" />);
    expect((await screen.findByTestId('policy-model')).textContent).toBe('el que defina config.toml');
  });
  it('con modelo: su id tal cual', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" initialProvider="codex" model="gpt-6-sol" />);
    expect((await screen.findByTestId('policy-model')).textContent).toBe('gpt-6-sol');
  });
  it('muestra el texto del host tal cual (policy.model), sin inventar', async () => {
    const resolver = async (a) => ({ ...(await mockResolvePolicy(a)), model: 'texto del host' });
    render(<EffectivePolicyView resolver={resolver} worktree="C:/wt/t1" initialProvider="codex" />);
    expect((await screen.findByTestId('policy-model')).textContent).toBe('texto del host');
  });
  it('host anterior sin campo model: no hay fila', async () => {
    const resolver = async (a) => { const p = await mockResolvePolicy(a); delete p.model; return p; };
    render(<EffectivePolicyView resolver={resolver} worktree="C:/wt/t1" initialProvider="codex" />);
    await screen.findByTestId('policy-argv');
    expect(screen.queryByTestId('policy-model')).toBeNull();
  });
  it('mock: model como agents::set_model', async () => {
    const base = { role: null, worktree: 'C:/wt/t1', profile: 'explorar' };
    expect((await mockResolvePolicy({ ...base, provider: 'codex' })).model).toBe('el que defina config.toml');
    expect((await mockResolvePolicy({ ...base, provider: 'codex', model: ' ' })).model).toBe('el que defina config.toml');
    expect((await mockResolvePolicy({ ...base, provider: 'claude' })).model).toBeNull();
    expect((await mockResolvePolicy({ ...base, provider: 'claude', model: 'opus' })).model).toBe('opus');
  });
  it('Claude sin modelo: model null y no se muestra la fila', async () => {
    render(<EffectivePolicyView resolver={mockResolvePolicy} worktree="C:/wt/t1" />);
    await screen.findByTestId('policy-argv');
    expect(screen.queryByTestId('policy-model')).toBeNull();
  });
});
