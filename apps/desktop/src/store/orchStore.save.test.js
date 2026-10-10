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
  it('respuesta { ok, warnings } por rol: guarda los avisos y vuelve a pedir el snapshot', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => (cmd === 'orch_settings_set'
      ? { ok: true, warnings: { explorador: ['Explorador: modelo gpt-6-sol no verificado en codex (quedará unverified)'] } }
      : SNAP));
    await useOrchStore.getState().saveSettings({ roles: SNAP.settings.roles });
    expect(invoke).toHaveBeenCalledWith('orch_settings_set', { settings: { enabled: true, roles: SNAP.settings.roles } });
    expect(invoke).toHaveBeenCalledWith('orch_snapshot');
    expect(useOrchStore.getState().saveWarnings.byRole.explorador).toHaveLength(1);
    expect(useOrchStore.getState().snap).toEqual(SNAP);
  });
  it('host anterior que devuelve el snapshot: se usa tal cual, sin avisos', async () => {
    vi.mocked(invoke).mockResolvedValue(SNAP);
    await useOrchStore.getState().saveSettings({});
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(useOrchStore.getState().snap).toEqual(SNAP);
    expect(useOrchStore.getState().saveWarnings).toEqual({ flat: [], byRole: {} });
  });
});
