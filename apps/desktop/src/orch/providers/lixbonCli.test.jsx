import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { normalizeProvider, providerLabel } from './providersContract';
import { newAgentEntries } from './newAgentEntries';
import { providerOptions, modelOptions } from './roleConfig';
import { RolesSettings } from './RolesSettings';
import { mockListProviders } from './mockListProviders';
import { mockResolvePolicy } from '../policy/mockResolvePolicy';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
afterEach(cleanup);

const LIXBON_CLI = {
  id: 'lixbon-cli', version: '2.3.0', available: true, disabled_reason: null, efforts: [], models_source: 'profiles',
  models: [{ id: 'qwen3:8b@ollama', label: 'ollama · qwen3:8b', verified: true }],
  sandbox_elevated: false, warnings: [], blocked_profiles: [],
};
const providers = async () => [...(await mockListProviders()).map(normalizeProvider), normalizeProvider(LIXBON_CLI)];
const role = { id: 'explorador', label: 'Explorador', purpose: '', read_only: true, model: 'haiku', effort: '' };

describe('Lixbon CLI como proveedor de un rol', () => {
  it('tiene etiqueta propia y no aparece en «+ Nuevo» (solo sirve como hijo)', async () => {
    expect(providerLabel('lixbon-cli')).toBe('Lixbon CLI');
    const ids = newAgentEntries(await providers()).map((e) => e.id);
    expect(ids).toEqual(['claude', 'codex']);
  });

  it('se ofrece en el selector de proveedor y sus modelos son los perfiles del CLI', async () => {
    const list = await providers();
    const option = providerOptions(list, 'explorar').find((o) => o.value === 'lixbon-cli');
    expect(option).toMatchObject({ label: 'Lixbon CLI', disabled: false });
    const models = modelOptions(list.find((p) => p.id === 'lixbon-cli'), 'qwen3:8b@ollama');
    expect(models).toEqual([{ value: 'qwen3:8b@ollama', label: 'ollama · qwen3:8b', verified: true }]);
  });

  it('un CLI sin worker sale deshabilitado con su motivo y no se puede elegir', async () => {
    const onSave = vi.fn();
    const old = normalizeProvider({ ...LIXBON_CLI, available: false, disabled_reason: 'esta versión del CLI no incluye `lixbon worker`: actualízala con `lixbon update`' });
    const list = [...(await mockListProviders()).map(normalizeProvider), old];
    render(<RolesSettings roles={[role]} settings={{ roles: {} }} providers={list} onSave={onSave} resolver={mockResolvePolicy} />);
    fireEvent.click(screen.getByTitle('Proveedor del explorador'));
    const opt = within(screen.getByRole('listbox')).getByText(/Lixbon CLI \(no disponible\)/).closest('li');
    expect(opt.className).toContain('is-disabled');
    expect(opt.textContent).toContain('lixbon update');
    fireEvent.click(opt);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('elegirlo en un rol guarda el proveedor y su primer perfil como modelo', async () => {
    const onSave = vi.fn();
    render(<RolesSettings roles={[role]} settings={{ roles: {} }} providers={await providers()} onSave={onSave} resolver={mockResolvePolicy} />);
    fireEvent.click(screen.getByTitle('Proveedor del explorador'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Lixbon CLI').closest('li'));
    expect(onSave).toHaveBeenCalledWith({ roles: { explorador: { provider: 'lixbon-cli', model: 'qwen3:8b@ollama', effort: '' } } });
  });
});
