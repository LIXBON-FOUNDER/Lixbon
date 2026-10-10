import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { listProviders, normalizeProvider, PROVIDERS_COMMAND } from './providersContract';
import { mockListProviders, MOCK_CLAUDE, MOCK_CODEX } from './mockListProviders';
import { migrateRoleCfg, migrateRoles, modelOptions, effortOptions, providerOptions, profileForRole } from './roleConfig';
import { RolesSettings } from './RolesSettings';
import { normalizeSaveWarnings, isSnapshotResponse, snapshotFromSaveResponse, warningsForRole, providersOfSettings, dropClaudeOnly } from './roleSaveContract';
import { mockRoleSaveWarnings } from './mockRoleSaveWarnings';
import { newAgentEntries } from './newAgentEntries';
import { NewAgentItems } from './NewAgentItems';
import { mockResolvePolicy, CODEX_LARGE_REPORT_WARNING, CODEX_COPY_BLOCK_WARNING } from '../policy/mockResolvePolicy';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.mocked(invoke).mockReset(); });

const providers = async (codex) => (await mockListProviders({ codex })).map(normalizeProvider);
const ROLES = [
  { id: 'explorador', label: 'Explorador', purpose: 'lee', read_only: true, model: 'haiku', effort: '', agent: 'claude' },
  { id: 'implementador', label: 'Implementador', purpose: 'programa', read_only: false, model: 'sonnet', effort: 'medium', agent: 'claude' },
];
const openSelect = (title) => fireEvent.click(screen.getByTitle(title));

describe('contrato orch_list_providers', () => {
  it('sin VITE_ORCH_MOCK llama al host con refresh y normaliza', async () => {
    vi.stubEnv('VITE_ORCH_MOCK', '');
    vi.mocked(invoke).mockResolvedValue([{ id: 'codex', version: null, available: false, disabled_reason: 'codex no está instalado o no está en el PATH de Lixbon', models: [], efforts: ['low'], models_source: 'none' }]);
    const l = await listProviders({ refresh: true });
    expect(invoke).toHaveBeenCalledWith(PROVIDERS_COMMAND, { refresh: true });
    expect(PROVIDERS_COMMAND).toBe('orch_list_providers');
    expect(l[0]).toMatchObject({ id: 'codex', available: false, models_source: 'none' });
  });
  it('con VITE_ORCH_MOCK=1 usa el mock y no llama al host', async () => {
    vi.stubEnv('VITE_ORCH_MOCK', '1');
    const l = await listProviders();
    expect(invoke).not.toHaveBeenCalled();
    expect(l.map((p) => p.id)).toEqual(['claude', 'codex']);
  });
  it('mock con la forma del host: esfuerzos y modelos del fixture', () => {
    expect(MOCK_CLAUDE.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(MOCK_CLAUDE.models.map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet']);
    expect(MOCK_CODEX.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(MOCK_CODEX.models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    for (const p of [MOCK_CLAUDE, MOCK_CODEX]) {
      expect(Object.keys(p).sort()).toEqual(['available', 'blocked_profiles', 'disabled_reason', 'efforts', 'id', 'models', 'models_source', 'sandbox_elevated', 'version', 'warnings']);
    }
  });
  it('campos ausentes no rompen', () => {
    expect(normalizeProvider({ id: 'codex' })).toEqual({ id: 'codex', version: null, available: false, disabled_reason: null, models: [], efforts: [], models_source: 'none', sandbox_elevated: false, warnings: [], blocked_profiles: [] });
  });
});

describe('roleConfig', () => {
  it('migra configs viejas a claude sin tocar modelo ni esfuerzo', () => {
    expect(migrateRoleCfg({ model: 'haiku', effort: '' })).toEqual({ provider: 'claude', model: 'haiku', effort: '' });
    expect(migrateRoleCfg({ provider: 'codex', model: 'gpt-6-sol', effort: 'ultra' }).provider).toBe('codex');
    expect(migrateRoles({ revisor: { model: 'opus', effort: 'medium' } })).toEqual({ revisor: { provider: 'claude', model: 'opus', effort: 'medium' } });
    expect(migrateRoleCfg(undefined, { model: 'opus', effort: 'high' })).toEqual({ provider: 'claude', model: 'opus', effort: 'high' });
  });
  it('modelo guardado que el proveedor no lista se conserva como sin verificar; verified:false se marca', async () => {
    const [claude] = await providers();
    const o = modelOptions(claude, 'haiku');
    expect(o[0]).toEqual({ value: 'haiku', label: 'haiku (sin verificar)', verified: false });
    expect(o.map((x) => x.value)).toEqual(['haiku', 'fable', 'opus', 'sonnet']);
    const cfgCodex = normalizeProvider({ id: 'codex', models: [{ id: 'gpt-6.1-sol', label: 'gpt-6.1-sol', verified: false }] });
    expect(modelOptions(cfgCodex, 'gpt-6.1-sol')).toEqual([{ value: '', label: 'Modelo de config.toml de Codex', verified: true }, { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol (sin verificar)', verified: false }]);
  });
  it('esfuerzos del proveedor y el guardado ajeno se conserva', async () => {
    const [claude, codex] = await providers();
    expect(effortOptions(codex, '').map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(effortOptions(claude, 'ultra').at(-1).label).toContain('sin verificar');
  });
  it('proveedor no disponible: deshabilitado con su motivo, no oculto', async () => {
    const l = await providers({ available: false, disabled_reason: 'versión 0.170.0 de codex no verificada (verificadas: 0.159.0, 0.162.1)' });
    expect(providerOptions(l)[1]).toMatchObject({ value: 'codex', disabled: true, hint: expect.stringContaining('0.170.0') });
    expect(profileForRole(true)).toBe('explorar');
    expect(profileForRole(false)).toBe('delegar_con_revision');
  });
});

describe('RolesSettings', () => {
  it('cada rol: proveedor, modelo y esfuerzo; haiku guardado sale sin verificar sin cambiarse', async () => {
    const onSave = vi.fn();
    render(<RolesSettings roles={ROLES} settings={{ roles: { explorador: { model: 'haiku', effort: '' } } }} providers={await providers()} onSave={onSave} resolver={mockResolvePolicy} />);
    expect(screen.getByTitle('Proveedor del explorador').textContent).toContain('Claude Code');
    expect(screen.getByTitle('Modelo del explorador').textContent).toContain('haiku (sin verificar)');
    expect(screen.getByTestId('role-unverified-explorador')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('elegir Codex guarda provider con un modelo de Codex; solo lectura muestra badge y advertencias de la política', async () => {
    const onSave = vi.fn();
    const resolver = vi.fn(mockResolvePolicy);
    const l = await providers();
    const { rerender } = render(<RolesSettings roles={ROLES} settings={{ roles: {} }} providers={l} onSave={onSave} resolver={resolver} />);
    openSelect('Proveedor del explorador');
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Codex'));
    expect(onSave).toHaveBeenCalledWith({ roles: { explorador: { provider: 'codex', model: 'gpt-6.1-sol', effort: '' } } });
    // El host devuelve la config con provider: ya no hay aviso de "no guardó".
    rerender(<RolesSettings roles={ROLES.map((r) => (r.id === 'explorador' ? { ...r, agent: 'codex' } : r))} settings={{ roles: onSave.mock.calls[0][0].roles }} providers={l} onSave={onSave} resolver={resolver} />);
    expect(screen.queryByTestId('role-host-agent-explorador')).toBeNull();
    const row = screen.getByTestId('role-explorador');
    expect(within(row).getByText('Solo lectura')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('role-warnings-explorador')).toBeTruthy());
    expect(resolver).toHaveBeenCalledWith({ provider: 'codex', profile: 'explorar', role: 'explorador', worktree: '', model: 'gpt-6.1-sol' });
    expect(screen.getByText(CODEX_LARGE_REPORT_WARNING)).toBeTruthy();
    expect(screen.getByText(CODEX_COPY_BLOCK_WARNING)).toBeTruthy();
    // El implementador (no solo lectura) en Claude no pide política de solo lectura.
    expect(screen.queryByTestId('role-warnings-implementador')).toBeNull();
    expect(screen.getByTitle('Esfuerzo del explorador')).toBeTruthy();
  });

  it('si el host no guarda provider (RoleCfg sin el campo), lo dice en el rol', async () => {
    const onSave = vi.fn();
    render(<RolesSettings roles={ROLES} settings={{ roles: {} }} providers={await providers()} onSave={onSave} resolver={mockResolvePolicy} />);
    openSelect('Proveedor del implementador');
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Codex'));
    expect(screen.getByTestId('role-host-agent-implementador').textContent).toContain('Claude Code');
  });

  it('Codex no disponible: deshabilitado con su motivo y no se puede elegir', async () => {
    const onSave = vi.fn();
    render(<RolesSettings roles={ROLES} settings={{ roles: {} }} providers={await providers({ available: false, disabled_reason: 'codex no está instalado o no está en el PATH de Lixbon' })} onSave={onSave} resolver={mockResolvePolicy} />);
    openSelect('Proveedor del explorador');
    const opt = within(screen.getByRole('listbox')).getByText(/Codex \(no disponible\)/).closest('li');
    expect(opt.className).toContain('is-disabled');
    expect(opt.textContent).toContain('no está instalado');
    fireEvent.click(opt);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('Codex disponible en Roles sigue habilitado', async () => {
    const l = await providers();
    expect(providerOptions(l).find((o) => o.value === 'codex').disabled).toBe(false);
  });
});

describe('"+ Nuevo" del modo Agente', () => {
  it('Codex disponible: habilitado como terminal; abre el panel de terminal y nunca llama a onPick (newSession)', async () => {
    const onPick = vi.fn();
    const onOpenTerminal = vi.fn();
    render(<NewAgentItems providers={await providers()} onPick={onPick} onOpenTerminal={onOpenTerminal} />);
    const codex = screen.getByTestId('newagent-codex');
    expect(codex.disabled).toBe(false);
    expect(codex.textContent).not.toContain('chat con Codex aún no disponible');
    fireEvent.click(codex);
    expect(onOpenTerminal).toHaveBeenCalledWith('codex');
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('newagent-claude'));
    expect(onPick).toHaveBeenCalledWith('claude');
    expect(onPick).toHaveBeenCalledTimes(1);
  });
  it('Codex no disponible: deshabilitado con su disabled_reason y sin efecto al pulsar', async () => {
    const onPick = vi.fn();
    const onOpenTerminal = vi.fn();
    render(<NewAgentItems providers={await providers({ available: false, disabled_reason: 'codex no está instalado o no está en el PATH de Lixbon' })} onPick={onPick} onOpenTerminal={onOpenTerminal} />);
    const codex = screen.getByTestId('newagent-codex');
    expect(codex.disabled).toBe(true);
    expect(codex.textContent).toContain('codex no está instalado');
    fireEvent.click(codex);
    expect(onOpenTerminal).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });
  it('Claude no disponible muestra su disabled_reason sin ocultarse; otro proveedor, el suyo', async () => {
    const l = (await providers({ available: false, disabled_reason: 'codex no está instalado' }));
    l[0] = { ...l[0], available: false, disabled_reason: 'no se pudo leer `claude --version`' };
    const e = newAgentEntries(l);
    expect(e.find((x) => x.id === 'codex')).toMatchObject({ disabled: true, reason: 'codex no está instalado', kind: 'terminal' });
    expect(e.find((x) => x.id === 'claude').reason).toBe('no se pudo leer `claude --version`');
    expect(newAgentEntries([{ id: 'gemini', available: false, disabled_reason: 'gemini no está instalado' }])[0]).toMatchObject({ disabled: true, reason: 'gemini no está instalado' });
  });
  it('sin lista todavía: Claude y Codex visibles', () => {
    expect(newAgentEntries(null).map((e) => e.id)).toEqual(['claude', 'codex']);
  });
});

describe('proveedor guardado por el host (660a0be: RoleCfg.provider y describe.agent)', () => {
  it('el host devuelve provider y agent codex: sin aviso de "todavía lanza con Claude Code"', async () => {
    const roles = ROLES.map((r) => (r.id === 'explorador' ? { ...r, agent: 'codex', model: 'gpt-6-sol', effort: null } : r));
    render(<RolesSettings roles={roles} settings={{ roles: { explorador: { provider: 'codex', model: 'gpt-6-sol', effort: '' } } }} providers={await providers()} onSave={vi.fn()} resolver={mockResolvePolicy} />);
    expect(screen.getByTitle('Proveedor del explorador').textContent).toContain('Codex');
    expect(screen.getByTitle('Modelo del explorador').textContent).toContain('GPT-6-Sol');
    expect(screen.queryByTestId('role-host-agent-explorador')).toBeNull();
    expect(document.body.textContent).not.toContain('todavía lanza este rol');
  });
  it('el host no devuelve provider (agent sigue en claude): el aviso se mantiene', async () => {
    render(<RolesSettings roles={ROLES} settings={{ roles: { explorador: { provider: 'codex', model: 'gpt-6-sol', effort: '' } } }} providers={await providers()} onSave={vi.fn()} resolver={mockResolvePolicy} />);
    expect(screen.getByTestId('role-host-agent-explorador').textContent).toContain('El host todavía lanza este rol con Claude Code');
  });
  it('Codex sin modelo (model null en describe): opción del config.toml, sin marcar sin verificar', async () => {
    const roles = ROLES.map((r) => (r.id === 'implementador' ? { ...r, agent: 'codex', model: null, effort: null } : r));
    render(<RolesSettings roles={roles} settings={{ roles: { implementador: { provider: 'codex', model: '', effort: '' } } }} providers={await providers()} onSave={vi.fn()} resolver={mockResolvePolicy} />);
    expect(screen.getByTitle('Modelo del implementador').textContent).toContain('Modelo de config.toml de Codex');
    expect(screen.queryByTestId('role-unverified-implementador')).toBeNull();
    expect(screen.queryByTestId('role-host-agent-implementador')).toBeNull();
  });
});

describe('avisos al guardar los roles (respuesta { ok, warnings: { <rol>: [..] } })', () => {
  const RESP = { ok: true, warnings: { explorador: ['Explorador: modelo haiku no verificado en claude (quedará unverified)'], revisor: ['Revisor: esfuerzo ultra no verificado en claude (quedará unverified)'] } };
  it('forma confirmada por rol: solo los roles con avisos', () => {
    expect(normalizeSaveWarnings(RESP)).toEqual({ flat: [], byRole: RESP.warnings });
    expect(normalizeSaveWarnings({ ok: true, warnings: {} })).toEqual({ flat: [], byRole: {} });
    expect(normalizeSaveWarnings({ ok: true, warnings: { explorador: ['a', 3, ''], revisor: [] } })).toEqual({ flat: [], byRole: { explorador: ['a'] } });
    expect(isSnapshotResponse(RESP)).toBe(false);
  });
  it('por rol en la UI: cada aviso bajo su rol y nada arriba', async () => {
    render(<RolesSettings roles={ROLES} settings={{ roles: {} }} providers={await providers()} onSave={vi.fn()} resolver={mockResolvePolicy} saveWarnings={normalizeSaveWarnings(RESP)} />);
    expect(within(screen.getByTestId('role-explorador')).getByTestId('role-save-warnings-explorador').textContent).toContain('modelo haiku no verificado');
    expect(screen.queryByTestId('role-save-warnings-implementador')).toBeNull();
    expect(screen.queryByTestId('roles-save-warnings')).toBeNull();
  });
  it('mock con la forma de roles::save_response (textos de agents.rs)', () => {
    const snap = { settings: {}, roles: [] };
    const r = mockRoleSaveWarnings({ roles: { explorador: { provider: 'claude', model: 'haiku', effort: '' }, implementador: { provider: 'codex', model: 'gpt-6-sol', effort: 'turbo' }, revisor: { model: 'opus', effort: 'high' } } }, snap);
    expect(r).toEqual({ ok: true, snapshot: snap, warnings: {
      explorador: ['modelo no verificado: la CLI no lo lista entre sus modelos (haiku)'],
      implementador: ['esfuerzo no verificado: la CLI no lo lista entre sus niveles (turbo)'],
    } });
  });
  it('snapshot de la respuesta: el de { ok, warnings, snapshot }, el viejo a secas, o null', () => {
    const snap = { settings: { enabled: true }, tasks: {} };
    expect(snapshotFromSaveResponse({ ok: true, warnings: {}, snapshot: snap })).toBe(snap);
    expect(snapshotFromSaveResponse(snap)).toBe(snap);
    expect(snapshotFromSaveResponse({ ok: true, warnings: {} })).toBeNull();
    expect(snapshotFromSaveResponse(null)).toBeNull();
    expect(normalizeSaveWarnings({ ok: true, warnings: { revisor: ['x'] }, snapshot: snap })).toEqual({ flat: [], byRole: { revisor: ['x'] } });
  });
  it('respaldo: lista plana arriba del bloque de roles', async () => {
    expect(normalizeSaveWarnings({ ok: true, warnings: ['x', null] })).toEqual({ flat: ['x'], byRole: {} });
    render(<RolesSettings roles={ROLES} settings={{ roles: {} }} providers={await providers()} onSave={vi.fn()} resolver={mockResolvePolicy}
      saveWarnings={normalizeSaveWarnings({ ok: true, warnings: ['Implementador: esfuerzo ultra no verificado en claude (quedará unverified)'] })} />);
    const top = screen.getByTestId('roles-save-warnings');
    expect(top.textContent).toContain('esfuerzo ultra');
    expect(top.compareDocumentPosition(screen.getByTestId('role-explorador')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('formas ausentes o raras y snapshot viejo: sin avisos', () => {
    for (const v of [undefined, null, {}, { ok: true }, { warnings: null }, { warnings: 'texto' }, 5]) expect(normalizeSaveWarnings(v)).toEqual({ flat: [], byRole: {} });
    expect(normalizeSaveWarnings({ settings: {}, runs: {} })).toEqual({ flat: [], byRole: {} });
    expect(isSnapshotResponse({ settings: {}, runs: {} })).toBe(true);
  });
});

describe('avisos de guardado por clave de rol del host (fallo: aviso del modo plan en la fila de Codex)', () => {
  const PLAN = 'en modo plan, Claude responde con Sonnet aunque pidas otro modelo';
  const ALL = [
    { id: 'explorador', label: 'Explorador', purpose: '', read_only: true, model: 'haiku', effort: '', agent: 'claude' },
    { id: 'implementador', label: 'Implementador', purpose: '', read_only: false, model: 'sonnet', effort: 'medium', agent: 'claude' },
    { id: 'revisor', label: 'Revisor', purpose: '', read_only: true, model: 'gpt-6-sol', effort: '', agent: 'codex' },
    { id: 'escalado', label: 'Escalado', purpose: '', read_only: false, model: 'opus', effort: 'high', agent: 'claude' },
    { id: 'adversario', label: 'Adversario', purpose: '', read_only: true, model: 'opus', effort: 'high', agent: 'claude' },
  ];
  const settings = { roles: {
    explorador: { provider: 'claude', model: 'haiku', effort: '' },
    implementador: { provider: 'claude', model: 'sonnet', effort: 'medium' },
    revisor: { provider: 'codex', model: 'gpt-6-sol', effort: '' },
    escalado: { provider: 'claude', model: 'opus', effort: 'high' },
    adversario: { provider: 'claude', model: 'opus', effort: 'high' },
  } };
  // Claves en otro orden que la lista de roles (y que las filas): se asignan por clave.
  const RESP = { ok: true, warnings: { adversario: ['aviso-adversario'], explorador: [PLAN], revisor: ['modelo no verificado: la CLI no lo lista entre sus modelos (gpt-6-sol)'] } };

  it('ids de roles iguales a los del host (roles.rs)', () => {
    expect(ALL.map((r) => r.id)).toEqual(['explorador', 'implementador', 'revisor', 'escalado', 'adversario']);
  });

  it('orden de claves barajado: cada aviso en su rol; el del modo plan (solo explorador/Claude) no sale en la fila de Codex', async () => {
    const sw = normalizeSaveWarnings(RESP, providersOfSettings(settings));
    render(<RolesSettings roles={[...ALL].reverse()} settings={settings} providers={await providers()} onSave={vi.fn()} resolver={mockResolvePolicy} saveWarnings={sw} />);
    expect(screen.getByTestId('role-save-warnings-explorador').textContent).toContain(PLAN);
    expect(screen.getByTestId('role-save-warnings-adversario').textContent).toBe('aviso-adversario');
    const codexRow = screen.getByTestId('role-revisor');
    expect(within(codexRow).getByTestId('role-save-warnings-revisor').textContent).toContain('gpt-6-sol');
    await waitFor(() => expect(within(codexRow).getByTestId('role-warnings-revisor')).toBeTruthy());
    expect(codexRow.textContent).not.toContain(PLAN);
    expect(screen.queryByTestId('role-save-warnings-implementador')).toBeNull();
    expect(screen.queryByTestId('role-save-warnings-escalado')).toBeNull();
  });

  it('la política de solo lectura de Codex se pide con provider codex y nunca muestra avisos solo de Claude', async () => {
    const resolver = vi.fn(async (a) => ({ ...(await mockResolvePolicy(a)), warnings: [...(await mockResolvePolicy(a)).warnings, PLAN] }));
    render(<RolesSettings roles={ALL} settings={settings} providers={await providers()} onSave={vi.fn()} resolver={resolver} />);
    await waitFor(() => expect(screen.getByTestId('role-warnings-revisor')).toBeTruthy());
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ provider: 'codex', role: 'revisor', profile: 'explorar' }));
    expect(screen.getByTestId('role-revisor').textContent).not.toContain(PLAN);
  });

  it('avisos calculados con otro proveedor (guardado fallido o pendiente) no se enseñan en la fila', () => {
    const sw = normalizeSaveWarnings({ warnings: { revisor: [PLAN, 'x'] } }, { revisor: 'claude' });
    expect(warningsForRole(sw, 'revisor', 'codex')).toEqual([]);
    expect(warningsForRole(sw, 'revisor', 'claude')).toEqual([PLAN, 'x']);
    // Sin saber con qué se calcularon: se muestran, pero sin los exclusivos de Claude en Codex.
    expect(warningsForRole(normalizeSaveWarnings({ warnings: { revisor: [PLAN, 'x'] } }), 'revisor', 'codex')).toEqual(['x']);
    expect(dropClaudeOnly([PLAN], 'claude')).toEqual([PLAN]);
    expect(providersOfSettings({ roles: { a: { model: 'x' }, b: { provider: 'codex' } } })).toEqual({ a: 'claude', b: 'codex' });
  });

  it('la fila muestra el proveedor que guardó el host, no el elegido sin guardar', async () => {
    const onSave = vi.fn();
    render(<RolesSettings roles={ALL} settings={settings} providers={await providers()} onSave={onSave} resolver={mockResolvePolicy}
      saveWarnings={normalizeSaveWarnings({ warnings: { explorador: [PLAN] } }, providersOfSettings(settings))} />);
    fireEvent.click(screen.getByTitle('Proveedor del explorador'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Codex'));
    // El host no devolvió el cambio: sigue en Claude, con el aviso de no guardado.
    expect(screen.getByTitle('Proveedor del explorador').textContent).toContain('Claude Code');
    expect(screen.getByTestId('role-host-agent-explorador')).toBeTruthy();
  });
});

describe('Codex con sandbox elevado (300abea)', async () => {
  const { MOCK_CODEX_ELEVATED, WARN_ELEVATED_RW, ELEVATED } = await import('./mockListProviders');
  const { normalizeProvider, blockedProfileReason } = await import('./providersContract');
  const { EffectivePolicyView } = await import('../policy/EffectivePolicyView');
  const elevatedList = async () => (await mockListProviders({ elevated: true })).map(normalizeProvider);

  it('normaliza sandbox_elevated, warnings y blocked_profiles (y valores por defecto en hosts viejos)', async () => {
    const codex = (await elevatedList()).find((p) => p.id === 'codex');
    expect(codex.sandbox_elevated).toBe(true);
    expect(codex.warnings).toEqual([WARN_ELEVATED_RW]);
    expect(codex.blocked_profiles).toEqual(MOCK_CODEX_ELEVATED.blocked_profiles);
    expect(blockedProfileReason(codex, 'explorar')).toBe(ELEVATED);
    expect(blockedProfileReason(codex, 'delegar_con_revision')).toBeNull();
    expect(normalizeProvider({ id: 'codex' })).toMatchObject({ sandbox_elevated: false, warnings: [], blocked_profiles: [] });
  });

  it('ajustes de roles: avisos del proveedor y perfiles bloqueados con motivo', async () => {
    render(<RolesSettings roles={[{ id: 'implementador', label: 'Implementador', purpose: '', read_only: false, model: 'sonnet', effort: '' }]}
      settings={{ roles: {} }} providers={await elevatedList()} onSave={vi.fn()} resolver={mockResolvePolicy} />);
    expect(screen.getByTestId('provider-warnings-codex').textContent).toContain(WARN_ELEVATED_RW);
    const b = screen.getByTestId('provider-blocked-codex-explorar');
    expect(b.getAttribute('aria-disabled')).toBe('true');
    expect(b.textContent).toContain(ELEVATED);
    expect(screen.getByTestId('provider-blocked-codex-proponer')).toBeTruthy();
    expect(screen.queryByTestId('provider-warnings-claude')).toBeNull();
  });

  it('+ Nuevo: aviso y perfiles bloqueados de Codex', async () => {
    render(<NewAgentItems providers={await elevatedList()} onPick={vi.fn()} />);
    expect(screen.getByTestId('newagent-warning-codex').textContent).toBe(WARN_ELEVATED_RW);
    expect(screen.getByTestId('newagent-blocked-codex-explorar').textContent).toContain(ELEVATED);
    expect(screen.queryByTestId('newagent-warning-claude')).toBeNull();
  });

  it('política: Explorar/Proponer de Codex deshabilitados con motivo; Delegar unverified exige confirmación', async () => {
    const onLaunch = vi.fn();
    const resolver = (a) => mockResolvePolicy(a, { windowsSandbox: 'elevated' });
    render(<EffectivePolicyView worktree="/wt" role="implementador" initialProvider="codex" initialProfile="delegar_con_revision"
      providers={await elevatedList()} resolver={resolver} onLaunch={onLaunch} />);
    const ex = screen.getByTestId('policy-profile-explorar');
    expect(ex.querySelector('input').disabled).toBe(true);
    expect(ex.textContent).toContain(ELEVATED);
    expect(screen.getByTestId('policy-profile-delegar_con_revision').querySelector('input').disabled).toBe(false);
    await waitFor(() => expect(screen.getAllByText(new RegExp(WARN_ELEVATED_RW)).length).toBeGreaterThan(0));
    const btn = screen.getByRole('button', { name: /lanzar/i });
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(btn);
    expect(onLaunch).toHaveBeenCalledWith(expect.objectContaining({ status: 'unverified', ack_unverified: true }));
  });

  it('mock de la política igual que agents::evaluate con elevated', async () => {
    const d = await mockResolvePolicy({ provider: 'codex', profile: 'delegar_con_revision', role: 'implementador', worktree: '/wt' }, { windowsSandbox: 'elevated' });
    expect(d.status).toBe('unverified');
    expect(d.reason).toBe(WARN_ELEVATED_RW);
    expect(d.warnings).toContain(WARN_ELEVATED_RW);
    const r = await mockResolvePolicy({ provider: 'codex', profile: 'explorar', role: 'explorador', worktree: '/wt' }, { windowsSandbox: 'elevated' });
    expect([r.status, r.reason]).toEqual(['blocked', ELEVATED]);
    const c = await mockResolvePolicy({ provider: 'claude', profile: 'delegar_con_revision', role: 'implementador', worktree: '/wt' }, { windowsSandbox: 'elevated' });
    expect(c.warnings).not.toContain(WARN_ELEVATED_RW);
    const n = await mockResolvePolicy({ provider: 'codex', profile: 'delegar_con_revision', role: 'implementador', worktree: '/wt' });
    expect(n.status).toBe('ok');
  });
});
