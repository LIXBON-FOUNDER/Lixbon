import { describe, it, expect, vi, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { resolvePolicy } from './resolvePolicy';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const args = { provider: 'codex', profile: 'explorar', role: 'revisor', worktree: 'C:/wt/t1' };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(invoke).mockReset();
});

describe('resolvePolicy', () => {
  it('sin VITE_ORCH_MOCK usa el comando real orch_resolve_policy', async () => {
    vi.stubEnv('VITE_ORCH_MOCK', '');
    const real = { profile: 'explorar', provider: 'codex', argv: ['codex'], cli_version: '9.9.9', warnings: [], status: 'ok', reason: null };
    vi.mocked(invoke).mockResolvedValue(real);
    await expect(resolvePolicy(args)).resolves.toBe(real);
    expect(invoke).toHaveBeenCalledWith('orch_resolve_policy', args);
  });

  it('sin rol envía role vacío al comando real (consulta de flags)', async () => {
    vi.stubEnv('VITE_ORCH_MOCK', '');
    vi.mocked(invoke).mockResolvedValue({ status: 'ok', role: null });
    await resolvePolicy({ ...args, role: null });
    expect(invoke).toHaveBeenCalledWith('orch_resolve_policy', { ...args, role: '' });
  });

  it('con VITE_ORCH_MOCK distinto de "1" también usa el comando real', async () => {
    vi.stubEnv('VITE_ORCH_MOCK', 'true');
    vi.mocked(invoke).mockResolvedValue({ status: 'ok' });
    await resolvePolicy(args);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('con VITE_ORCH_MOCK=1 en desarrollo usa el mock y no llama al host', async () => {
    vi.stubEnv('VITE_ORCH_MOCK', '1');
    const p = await resolvePolicy({ ...args, role: null });
    expect(invoke).not.toHaveBeenCalled();
    expect(p.argv).toEqual(['codex', '--sandbox', 'read-only', '--ask-for-approval', 'never']);
  });
});
