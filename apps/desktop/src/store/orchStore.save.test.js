import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useOrchStore } from './orchStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const SNAP = { settings: { enabled: true, roles: { explorador: { provider: 'codex', model: 'gpt-6-sol', effort: '' } } }, roles: [], tasks: {} };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_ORCH_MOCK', '');
  vi.mocked(invoke).mockReset();
  useOrchStore.setState({ snap: { settings: { enabled: true, roles: {} } }, saveWarnings: { flat: [], byRole: {} } });
});

describe('saveSettings', () => {
  const W = { explorador: ['modelo no verificado: la CLI no lo lista entre sus modelos (gpt-6-sol)'] };
  it('respuesta { ok, warnings, snapshot }: usa su snapshot y no vuelve a pedirlo', async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true, warnings: W, snapshot: SNAP });
    await useOrchStore.getState().saveSettings({ roles: SNAP.settings.roles });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('orch_settings_set', { settings: { enabled: true, roles: SNAP.settings.roles } });
    expect(useOrchStore.getState().snap).toBe(SNAP);
    expect(useOrchStore.getState().saveWarnings.byRole).toEqual(W);
  });
  it('sin snapshot en la respuesta: lo pide con orch_snapshot', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === 'orch_settings_set' ? { ok: true, warnings: W } : SNAP));
    await useOrchStore.getState().saveSettings({});
    expect(invoke).toHaveBeenCalledWith('orch_snapshot');
    expect(useOrchStore.getState().snap).toEqual(SNAP);
    expect(useOrchStore.getState().saveWarnings.byRole).toEqual(W);
  });
  it('host anterior que devuelve el snapshot a secas: se usa tal cual, sin avisos', async () => {
    vi.mocked(invoke).mockResolvedValue(SNAP);
    await useOrchStore.getState().saveSettings({});
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useOrchStore.getState().snap).toEqual(SNAP);
    expect(useOrchStore.getState().saveWarnings).toMatchObject({ flat: [], byRole: {} });
  });
  it('tareas con session_ref y attempt_started en el snapshot no rompen nada', async () => {
    const snap = { ...SNAP, tasks: { t1: { id: 't1', agent: 'codex', status: 'running', session_ref: 'rollout-2026-10-09.jsonl', attempt_started: 1_800_000_000_000 } } };
    vi.mocked(invoke).mockResolvedValue({ ok: true, warnings: {}, snapshot: snap });
    await useOrchStore.getState().saveSettings({});
    expect(useOrchStore.getState().snap.tasks.t1.session_ref).toBe('rollout-2026-10-09.jsonl');
  });
  it('guarda con qué proveedor por rol se calcularon los avisos; si falla el guardado, los limpia', async () => {
    vi.mocked(invoke).mockResolvedValue({ ok: true, warnings: W, snapshot: SNAP });
    await useOrchStore.getState().saveSettings({ roles: SNAP.settings.roles });
    expect(useOrchStore.getState().saveWarnings.providers).toEqual({ explorador: 'codex' });
    vi.mocked(invoke).mockRejectedValue('Explorador: el modelo haiku no es de codex');
    await useOrchStore.getState().saveSettings({ roles: { explorador: { provider: 'codex', model: 'haiku', effort: '' } } });
    expect(useOrchStore.getState().saveWarnings).toEqual({ flat: [], byRole: {} });
  });
});
