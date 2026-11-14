import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { AttemptDetail } from './AttemptDetail';
import { AttemptUsage } from './AttemptUsage';
import { coreModelFromState } from './useCoreModel';
import { CANONICAL, attemptDetail } from './testFixtures/coreModelFixtures';
import { attemptActivityPage } from './testFixtures/attemptActivityFixtures';
import { live } from './testFixtures/providerCapabilitiesFixtures';

// LXO-249 · El uso que el proveedor declaró, en el detalle del Attempt: ausencia explícita, nada de ceros inventados y la cuota de la cuenta aparte.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const V1 = coreModelFromState({ data: CANONICAL['core_model.v1.json'], error: null });
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }); };
afterEach(() => { cleanup(); invoke.mockReset(); });

const USAGE = {
  turns: 2, provider: 'claude', source: 'provider_declared',
  input_tokens: 1200, output_tokens: 340, cache_read_tokens: 9000, cache_creation_tokens: null, cost_usd: 0.0421,
  limits: [
    { id: 'five_hour', used_percent: 58, resets_at: 1_792_000_000 },
    { id: 'seven_day', used_percent: 91.5, resets_at: null },
  ],
};

describe('AttemptUsage (LXO-249)', () => {
  it('sin uso declarado lo dice, sin ceros ni tabla', () => {
    render(<AttemptUsage usage={null} />);
    expect(screen.getByTestId('attempt-usage-none').textContent).toMatch(/no declaró consumo/);
    expect(screen.queryByTestId('attempt-usage')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b0\b/);
  });

  it('con uso: tokens, coste y turnos; lo que ningún turno declaró sale «sin dato», no 0', () => {
    render(<AttemptUsage usage={USAGE} />);
    const dl = screen.getByTestId('attempt-usage');
    expect(within(dl).getByText('Origen').nextSibling.textContent).toBe('declarado por el proveedor · claude · 2 turnos');
    expect(within(dl).getByText('Tokens de entrada').nextSibling.textContent).toBe('1.200');
    expect(within(dl).getByText('Tokens de salida').nextSibling.textContent).toBe('340');
    expect(within(dl).getByText('Caché leída').nextSibling.textContent).toBe('9.000');
    expect(within(dl).getByText('Caché creada').nextSibling.textContent).toBe('sin dato');
    expect(within(dl).getByText('Coste').nextSibling.textContent).toBe('0.042 USD');
  });

  it('un proveedor que da tokens pero no coste deja el coste «sin dato»', () => {
    render(<AttemptUsage usage={{ ...USAGE, turns: 1, cost_usd: null, limits: null }} />);
    expect(within(screen.getByTestId('attempt-usage')).getByText('Coste').nextSibling.textContent).toBe('sin dato');
    expect(within(screen.getByTestId('attempt-usage')).getByText('Origen').nextSibling.textContent).toMatch(/· 1 turno$/);
  });

  it('la cuota va aparte, avisa que es de la cuenta, con hora absoluta y sin inventar el reinicio que falta', () => {
    render(<AttemptUsage usage={USAGE} />);
    const limits = screen.getByTestId('attempt-usage-limits');
    expect(limits.textContent).toMatch(/No es lo que gastó este intento/);
    const [five, week] = within(limits).getAllByRole('listitem');
    expect(five.textContent).toBe('Ventana de 5 horas: 58 % usado · reinicia 2026-10-14 17:46:40 UTC');
    expect(five.querySelector('time').getAttribute('dateTime')).toBe('2026-10-14T17:46:40.000Z');
    expect(week.textContent).toBe('Semana: 91.5 % usado · casi agotada · hora de reinicio desconocida');
    expect(week.querySelector('time')).toBeNull();
  });

  it('una cuota sin porcentaje dice «sin dato» y sin ventanas no pinta el bloque', () => {
    const { unmount } = render(<AttemptUsage usage={{ ...USAGE, limits: [{ id: 'five_hour', used_percent: null, resets_at: 1_792_000_000 }] }} />);
    expect(within(screen.getByTestId('attempt-usage-limits')).getByRole('listitem').textContent).toMatch(/Ventana de 5 horas: sin dato/);
    unmount();
    render(<AttemptUsage usage={{ ...USAGE, limits: [] }} />);
    expect(screen.queryByTestId('attempt-usage-limits')).toBeNull();
  });

  it('una forma inesperada no rompe la vista y todo se pinta como texto', () => {
    const { unmount } = render(<AttemptUsage usage="raro" />);
    expect(screen.getByTestId('attempt-usage-none').textContent).toBe('no disponible');
    unmount();
    render(<AttemptUsage usage={{ ...USAGE, provider: '<img src=x onerror=alert(1)>', limits: [{ id: '<b>x</b>', used_percent: 10, resets_at: 1 }, 'x', null] }} />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    expect(screen.getByTestId('attempt-usage-limits').textContent).toContain('<b>x</b>: 10 % usado');
  });

  it('el detalle del Attempt lo muestra, y con el fixture canónico (usage: null) lo dice', async () => {
    const handler = (extra) => (payload) => {
      if (payload.query === 'provider_capabilities') return live();
      if (payload.query === 'activity_list') return attemptActivityPage([]);
      return attemptDetail(extra);
    };
    invoke.mockImplementation(async (_c, payload) => handler({ usage: USAGE })(payload));
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    const root = screen.getByTestId('attempt-detail');
    expect(within(root).getByText('Consumo declarado')).toBeTruthy();
    expect(within(screen.getByTestId('attempt-usage')).getByText('Coste').nextSibling.textContent).toBe('0.042 USD');
    cleanup();
    invoke.mockImplementation(async (_c, payload) => handler({})(payload));
    render(<AttemptDetail attemptId="t3-a1" taskId="t3" coreModel={V1} />);
    await flush();
    expect(screen.getByTestId('attempt-usage-none')).toBeTruthy();
  });
});
