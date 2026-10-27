import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptCapabilities } from './AttemptCapabilities';
import { ProviderInspector } from './ProviderInspector';
import { PROBING, blocked, live, liveWith, provider } from './testFixtures/providerCapabilitiesFixtures';

// LXO-135 · inspector de proveedores y capacidades de un Attempt, con proveedores falsos: lo que se ve es lo que dice el Core.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const flush = async () => { await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); }); };
const session = (over = {}) => ({ id: 'ps-1', opened_by_attempt_id: 'a-1', binding: 'stream_json', bound: true, resumable: true, status: 'idle', ...over });

function answer(handler) {
  const calls = [];
  invoke.mockImplementation(async (_command, payload) => { calls.push(payload); return handler(payload); });
  return calls;
}
beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { cleanup(); invoke.mockReset(); vi.useRealTimers(); });

describe('ProviderInspector', () => {
  it('pinta una fila por proveedor y una columna por capability, con la matriz del Core tal cual', async () => {
    const calls = answer(() => live());
    render(<ProviderInspector />);
    await flush();
    const table = screen.getByTestId('provider-inspector-table');
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent)).toEqual([
      'Proveedor', 'Iniciar', 'Seguir la ejecución', 'Responder permisos', 'Interrumpir', 'Dirigir en curso', 'Reanudar sesión',
    ]);
    const rows = [...table.querySelectorAll('tbody tr[data-provider]')];
    expect(rows.map((r) => r.getAttribute('data-provider'))).toEqual(['fake-bloqueado', 'fake-completo', 'fake-parcial']);
    expect(calls[0]).toEqual({ query: 'provider_capabilities', args: {} });

    const parcial = table.querySelector('tr[data-provider="fake-parcial"]');
    expect(parcial.querySelector('td[data-capability="steer"]').getAttribute('data-state')).toBe('unsupported');
    expect(parcial.querySelector('td[data-capability="resume"]').getAttribute('data-state')).toBe('unavailable');
    expect(parcial.querySelector('td[data-capability="start"]').getAttribute('data-state')).toBe('available');
    expect(within(parcial).getByText('v1.2.3')).toBeTruthy();
  });

  it('«no ofrecida», «no disponible ahora» y «bloqueada por el entorno» se ven distintas y ninguna es un fallo', async () => {
    answer(() => live());
    render(<ProviderInspector />);
    await flush();
    const table = screen.getByTestId('provider-inspector-table');
    const chip = (provider, cap) => table.querySelector(`tr[data-provider="${provider}"] td[data-capability="${cap}"] .cap`);
    const unsupported = chip('fake-parcial', 'steer');
    const unavailable = chip('fake-parcial', 'resume');
    const envBlocked = chip('fake-bloqueado', 'start');
    const available = chip('fake-completo', 'start');
    const textos = [unsupported, unavailable, envBlocked, available].map((c) => c.textContent);
    expect(new Set(textos).size).toBe(4);
    // En la tabla la columna ya dice la capability: cada celda lleva glifo + estado corto (el largo va en el tooltip y la leyenda).
    expect(textos).toEqual(['–No ofrece', '!Ahora no', '⊘Bloqueada', '✓Sí']);
    const clases = [unsupported, unavailable, envBlocked, available].map((c) => [...c.classList].find((k) => k.startsWith('cap--') && k !== 'cap--compact'));
    expect(new Set(clases).size).toBe(4);
    for (const c of [unsupported, unavailable, envBlocked]) expect(c.getAttribute('data-enabled')).toBe('false');
    expect(available.getAttribute('data-enabled')).toBe('true');
    // El motivo viaja con cada chip y el bloqueo no se presenta como un intento fallido.
    expect(envBlocked.getAttribute('title')).toMatch(/No es un intento fallido/);
    // El bloqueo va en su propia fila, a todo el ancho de la tabla, y dice que no es un fallo.
    const envRow = screen.getByTestId('env-fake-bloqueado');
    expect(envRow.textContent).toMatch(/fake-bloqueado · Entorno bloqueado: no se encuentra la CLI.*No es un intento fallido/);
    expect(envRow.getAttribute('colspan')).toBe('7');
    expect(screen.getByTestId('provider-inspector-legend').textContent).toContain('Bloqueada por el entorno');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('el primer sondeo del Core se dice y no se inventan proveedores', async () => {
    answer(() => PROBING);
    render(<ProviderInspector />);
    await flush();
    expect(screen.getByTestId('inspector-empty').textContent).toMatch(/comprobando los proveedores/);
    expect(screen.queryByTestId('provider-inspector-table')).toBeNull();
  });

  it('un Core sin proveedores registrados, uno que no conoce la query y uno que falla se distinguen', async () => {
    answer(() => liveWith([]));
    const { unmount } = render(<ProviderInspector />);
    await flush();
    expect(screen.getByTestId('inspector-empty').textContent).toMatch(/no tiene proveedores registrados/);
    unmount();

    answer(() => { throw new Error('Comando desconocido: provider_capabilities'); });
    const second = render(<ProviderInspector />);
    await flush();
    expect(screen.getByTestId('inspector-unsupported')).toBeTruthy();
    second.unmount();

    answer(() => { throw new Error('boom'); });
    render(<ProviderInspector />);
    await flush();
    expect(screen.getByTestId('inspector-error').getAttribute('role')).toBe('alert');
    expect(screen.queryByTestId('provider-inspector-table')).toBeNull();
  });

  it('una respuesta inválida del Core no se pinta como proveedores', async () => {
    answer(() => ({ ...live(), providers: [{ id: 'x' }] }));
    render(<ProviderInspector />);
    await flush();
    expect(screen.queryByTestId('provider-inspector-table')).toBeNull();
    expect(screen.getByTestId('inspector-error')).toBeTruthy();
  });

  it('un proveedor nuevo aparece solo con que el Core lo registre y los cambios se ven sin reiniciar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let generation = 1;
    answer(() => (generation === 1
      ? liveWith([provider('uno')], { generation: 1 })
      : liveWith([provider('uno', { resume: 'unsupported' }), blocked('dos-nuevo')], { generation: 2 })));
    render(<ProviderInspector />);
    await flush();
    const table = () => screen.getByTestId('provider-inspector-table');
    expect([...table().querySelectorAll('tbody tr[data-provider]')].map((r) => r.getAttribute('data-provider'))).toEqual(['uno']);
    expect(table().querySelector('tr[data-provider="uno"] td[data-capability="resume"]').getAttribute('data-state')).toBe('available');

    generation = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
    await flush();
    expect([...table().querySelectorAll('tbody tr[data-provider]')].map((r) => r.getAttribute('data-provider'))).toEqual(['uno', 'dos-nuevo']);
    expect(table().querySelector('tr[data-provider="uno"] td[data-capability="resume"]').getAttribute('data-state')).toBe('unsupported');
    expect(table().querySelector('tr[data-provider="dos-nuevo"]').getAttribute('data-env')).toBe('blocked');
  });
});

describe('AttemptCapabilities', () => {
  it('muestra las seis capacidades del proveedor del Attempt y por qué falta cada una que falta', async () => {
    answer(() => live());
    render(<AttemptCapabilities providerId="fake-parcial" session={session()} />);
    await flush();
    const block = screen.getByTestId('attempt-capabilities');
    const items = within(block).getAllByRole('listitem');
    // «Reanudar sesión» no se repite en la lista: lo dice la línea de reanudación, que une proveedor y sesión.
    expect(items.map((i) => i.getAttribute('data-capability'))).toEqual(['start', 'events', 'answer', 'interrupt', 'steer']);
    expect(block.querySelector('li[data-capability="steer"]').textContent).toMatch(/no ofrece «Dirigir en curso»/);
    expect(block.querySelectorAll('li[data-capability="resume"]')).toHaveLength(0);
    expect(screen.getByTestId('caps-resume').textContent).toMatch(/no está disponible ahora: .*reanudar/i);
    // Las disponibles no repiten explicaciones.
    expect(block.querySelector('li[data-capability="start"] .cap-list__why')).toBeNull();
  });

  it('resume badge: el proveedor lo ofrece y la sesión sirve → Reanudable; sin sesión o proveedor sin resume → no', async () => {
    answer(() => live());
    const { rerender } = render(<AttemptCapabilities providerId="fake-completo" session={session()} />);
    await flush();
    expect(screen.getByTestId('caps-resume').getAttribute('data-kind')).toBe('resumable');
    expect(screen.getByTestId('caps-resume').textContent).toContain('Reanudable');

    rerender(<AttemptCapabilities providerId="fake-completo" session={null} />);
    await flush();
    expect(screen.getByTestId('caps-resume').getAttribute('data-kind')).toBe('no_session');

    rerender(<AttemptCapabilities providerId="fake-parcial" session={session()} />);
    await flush();
    expect(screen.getByTestId('caps-resume').getAttribute('data-kind')).toBe('unavailable');
    expect(screen.getByTestId('caps-resume').textContent).not.toContain('Reanudable');
  });

  it('un entorno bloqueado se explica como bloqueo del entorno, no como intento fallido', async () => {
    answer(() => live());
    render(<AttemptCapabilities providerId="fake-bloqueado" session={session()} />);
    await flush();
    const note = screen.getByTestId('caps-env-blocked');
    expect(note.textContent).toMatch(/Entorno bloqueado:/);
    expect(note.textContent).toMatch(/no un intento fallido/);
    const block = screen.getByTestId('attempt-capabilities');
    const items = block.querySelectorAll('li[data-capability]');
    expect(items).toHaveLength(5);
    for (const li of items) {
      expect(li.querySelector('.cap').getAttribute('data-state')).toBe('environment_blocked');
      expect(li.querySelector('.cap').getAttribute('data-enabled')).toBe('false');
      // El aviso de arriba lo explica una sola vez: la capability no repite el motivo.
      expect(li.querySelector('.cap-list__why')).toBeNull();
    }
    expect(screen.getByTestId('caps-resume').getAttribute('data-kind')).toBe('environment_blocked');
  });

  it('un proveedor que el Core no informa no se deduce por su nombre: sin información y nada habilitado', async () => {
    answer(() => live());
    render(<AttemptCapabilities providerId="claude" session={session()} />);
    await flush();
    expect(screen.getByTestId('attempt-capabilities').getAttribute('data-provider-known')).toBe('false');
    expect(screen.getByTestId('caps-provider-unknown').textContent).toMatch(/no informa de «claude»/);
    for (const chip of screen.getByTestId('attempt-capabilities').querySelectorAll('li .cap')) {
      expect(chip.getAttribute('data-state')).toBe('unknown');
      expect(chip.getAttribute('data-enabled')).toBe('false');
    }
    expect(screen.getByTestId('caps-resume').getAttribute('data-kind')).toBe('unknown');
  });

  it('sin respuesta del Core o con un Core viejo no se habilita nada y se dice', async () => {
    answer(() => { throw new Error('Acción no permitida para esta identidad: ForbiddenAction'); });
    const { unmount } = render(<AttemptCapabilities providerId="fake-completo" />);
    await flush();
    expect(screen.getByTestId('caps-unsupported').textContent).toMatch(/no se habilita ninguna acción/);
    unmount();

    answer(() => { throw new Error('boom'); });
    render(<AttemptCapabilities providerId="fake-completo" />);
    await flush();
    expect(screen.getByTestId('caps-error').textContent).toMatch(/no se habilita ninguna acción/);
    expect(screen.queryByTestId('attempt-capabilities')).toBeNull();
  });

  it('no consulta nada si el intento no dice su proveedor ni si no está activo', async () => {
    const calls = answer(() => live());
    render(<AttemptCapabilities providerId={null} />);
    await flush();
    expect(screen.getByText(/no dice con qué proveedor/)).toBeTruthy();
    cleanup();
    render(<AttemptCapabilities providerId="fake-completo" active={false} />);
    await flush();
    expect(calls).toEqual([]);
  });
});
