import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args) => invoke(...args) }));

const cargar = async () => {
  vi.resetModules();
  return import('./session');
};

const enSegundos = (s) => Math.floor(Date.now() / 1000) + s;

describe('session', () => {
  beforeEach(() => invoke.mockReset());

  it('tras iniciar sesión usa el access sin preguntar a Rust mientras no esté por caducar', async () => {
    const s = await cargar();
    invoke.mockResolvedValue(undefined);
    await s.iniciarSesion('https://lixbon.com', { access_token: 'lixbon_at_1', refresh_token: 'lixbon_rt_1', expires_in: 1800 });
    expect(invoke).toHaveBeenCalledWith('auth_session_start', {
      servidor: 'https://lixbon.com', access: 'lixbon_at_1', refresh: 'lixbon_rt_1', expiresIn: 1800,
    });
    invoke.mockClear();
    expect(await s.tokenVigente()).toBe('lixbon_at_1');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('cerca de caducar pide a Rust el access renovado', async () => {
    const s = await cargar();
    invoke.mockResolvedValueOnce({ token: 'lixbon_at_1', expira: enSegundos(60) });
    expect(await s.tokenVigente()).toBe('lixbon_at_1');
    invoke.mockResolvedValueOnce({ token: 'lixbon_at_2', expira: enSegundos(1800) });
    expect(await s.tokenVigente()).toBe('lixbon_at_2');
    expect(invoke).toHaveBeenLastCalledWith('auth_token', { stale: null });
  });

  it('un 401 fuerza la renovación pasando el access rechazado', async () => {
    const s = await cargar();
    invoke.mockResolvedValueOnce({ token: 'lixbon_at_1', expira: enSegundos(1800) });
    await s.tokenVigente();
    invoke.mockResolvedValueOnce({ token: 'lixbon_at_2', expira: enSegundos(1800) });
    expect(await s.tokenVigente('lixbon_at_1')).toBe('lixbon_at_2');
    expect(invoke).toHaveBeenLastCalledWith('auth_token', { stale: 'lixbon_at_1' });
  });

  it('sin sesión de dispositivo devuelve null (API key o sin login)', async () => {
    const s = await cargar();
    invoke.mockResolvedValueOnce(null);
    expect(await s.tokenVigente()).toBeNull();
  });

  it('un refresh rechazado se convierte en SesionCaducada', async () => {
    const s = await cargar();
    invoke.mockRejectedValueOnce('session_expired');
    await expect(s.tokenVigente()).rejects.toBeInstanceOf(s.SesionCaducada);
  });

  it('cerrar sesión olvida la caché y avisa a Rust', async () => {
    const s = await cargar();
    invoke.mockResolvedValue(undefined);
    await s.iniciarSesion('https://lixbon.com', { access_token: 'a', refresh_token: 'r', expires_in: 1800 });
    await s.cerrarSesion();
    expect(invoke).toHaveBeenLastCalledWith('auth_logout');
    invoke.mockResolvedValueOnce(null);
    expect(await s.tokenVigente()).toBeNull();
  });
});
