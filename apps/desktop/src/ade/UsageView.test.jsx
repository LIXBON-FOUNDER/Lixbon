import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { UsageView } from './UsageView';
import { CANONICAL_REPORT, LOADING, NOW, PROVIDERS, live, report } from './testFixtures/usageFixtures';

// LXO-206 · la vista de Usage: lo que el Core informa, con la frescura a la vista y lo desconocido sin convertirse en cero.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const flush = async () => { await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }); };
beforeEach(() => { vi.useRealTimers(); });
afterEach(() => { cleanup(); invoke.mockReset(); vi.useRealTimers(); });

function answer(handler) {
  const calls = [];
  invoke.mockImplementation(async (_command, payload) => { calls.push(payload); return handler(payload); });
  return calls;
}
async function show(response, props = {}) {
  const calls = answer(() => response);
  render(<UsageView now={NOW} {...props} />);
  await flush();
  return calls;
}
const card = (id) => screen.getByTestId(`usage-card-${id}`);

describe('UsageView', () => {
  it('pinta el informe canónico: una tarjeta por proveedor, sin ningún total, y solo lee del Core', async () => {
    const calls = await show(live());
    expect(calls[0]).toEqual({ query: 'usage_report', args: {} });
    expect(calls.every((c) => c.query === 'usage_report')).toBe(true); // la interfaz no llama a ningún proveedor
    const cards = within(screen.getByRole('list', { name: 'Uso por proveedor' })).getAllByRole('listitem', { hidden: false }).filter((li) => li.hasAttribute('data-provider'));
    expect(cards.map((c) => c.getAttribute('data-provider'))).toEqual(['codex', 'claude', 'otro', 'minimo']);
    expect(cards.map((c) => c.getAttribute('data-status'))).toEqual(['fresh', 'fresh', 'unknown', 'unsupported']);
    expect(screen.getByTestId('usage-view').textContent).toMatch(/no se suman ni se comparan/);
    expect(screen.getByTestId('usage-view').textContent).toMatch(/no de un modelo/);
    expect(screen.getByTestId('usage-view').textContent).not.toMatch(/\bTotal\b/);
  });

  it('completo y al día: ventanas con su porcentaje, reinicio, plan, créditos, modelos y frescura visible', async () => {
    await show(live());
    const codex = card('codex');
    expect(within(codex).getByText('Ventana principal (5 h)')).toBeTruthy();
    expect(within(codex).getAllByText(/12 % usado/)).toHaveLength(1);
    expect(within(codex).getAllByText('se reinicia en 1 h 0 min').length).toBeGreaterThanOrEqual(1);
    const bar = within(codex).getAllByRole('progressbar')[0];
    expect(bar.getAttribute('aria-valuenow')).toBe('12');
    expect(bar.getAttribute('aria-label')).toBe('Ventana principal (5 h): 12 % usado');
    expect(screen.getByTestId('usage-fresh-codex').textContent).toMatch(/Observado hace unos segundos · consulta al proveedor · cuenta e7cbf1f7 · plan plus/);
    expect(screen.getByTestId('usage-credits-codex').textContent).toMatch(/con créditos · saldo 42 \(en la unidad del proveedor, no son dólares\)/);
    const models = screen.getByTestId('usage-models');
    expect(within(models).getByText('m1')).toBeTruthy();
    expect(models.textContent).toMatch(/0\.500 USD/);
    expect(models.textContent).toMatch(/sin dato/); // la caché que el proveedor no dio
  });

  it('lo que el proveedor no dio es «sin dato» y NO una barra a cero', async () => {
    await show(live(report([PROVIDERS.sinPorcentaje(), PROVIDERS.conModelos('multi')])));
    const claude = card('claude');
    const w = claude.querySelector('[data-window="five_hour"]');
    expect(w.getAttribute('data-known')).toBe('false');
    expect(w.textContent).toContain('sin dato');
    expect(w.textContent).not.toMatch(/0 %/);
    expect(w.querySelector('[role="progressbar"]')).toBeNull();
    expect(w.querySelector('.usage-bar--unknown')).toBeTruthy();
    expect(w.textContent).toMatch(/se reinicia en 1 h 30 min/);
    expect(screen.getByTestId('usage-fresh-claude').textContent).toMatch(/lo último que dijo durante una ejecución/);

    // Un modelo sin ningún dato muestra «sin dato» en cada celda; uno con ceros reales muestra 0.
    const filas = card('multi').querySelectorAll('tbody tr');
    expect(filas[2].textContent).toBe('modelo-csin datosin datosin datosin datosin dato');
    expect(filas[1].textContent).toContain('0');
    expect(filas[1].textContent).toContain('0.000 USD');
  });

  it('casi agotada y límite alcanzado se dicen con texto, y un cero real sí se muestra como 0', async () => {
    await show(live(report([PROVIDERS.alLimite()])));
    expect(screen.getByTestId('usage-limit-codex').textContent).toMatch(/Límite alcanzado/);
    const primaria = card('codex').querySelector('[data-window="primary"]');
    expect(primaria.textContent).toMatch(/96\.5 % usado · casi agotada/);
    expect(primaria.querySelector('.usage-bar__fill--high')).toBeTruthy();
    const semana = card('codex').querySelector('[data-window="secondary"]');
    expect(semana.textContent).toMatch(/0 % usado/);
    expect(semana.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('0');
  });

  it('stale por un fallo, sin datos, sin uso y bloqueado se distinguen, cada uno con su explicación, y ninguno es un fallo', async () => {
    await show(live(report([PROVIDERS.antiguoPorFallo(), PROVIDERS.sinDatos(), PROVIDERS.bloqueado(), { provider: 'minimo', status: 'unsupported', support: PROVIDERS.sinDatos().support }])));
    expect(card('codex').getAttribute('data-status')).toBe('stale');
    expect(screen.getByTestId('usage-headline-codex').textContent).toBe('No se pudo actualizar: El proveedor pide iniciar sesión. Se muestra el último dato.');
    expect(screen.getByTestId('usage-fresh-codex').textContent).toMatch(/hace 1 h/);
    expect(card('codex').querySelector('[data-window="primary"]').textContent).toMatch(/40 % usado/); // el dato anterior se conserva
    expect(screen.getByTestId('usage-headline-otro').textContent).toMatch(/Sin datos de uso: El proveedor limita las consultas/);
    expect(within(card('otro')).queryAllByRole('progressbar')).toHaveLength(0);
    expect(screen.getByTestId('usage-headline-bloqueado').textContent).toMatch(/No es un fallo del proveedor/);
    expect(screen.getByTestId('usage-headline-minimo').textContent).toMatch(/No es un fallo: el proveedor no lo ofrece/);
    const badges = [...document.querySelectorAll('.usage-badge')].map((b) => b.textContent.trim());
    expect(new Set(badges).size).toBe(badges.length);
    // Un fallo de uso no es un error de la pantalla: ni alertas ni tono de peligro.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('.usage-card--danger, .usage-badge--danger')).toBeNull();
  });

  it('cada proveedor dice qué informa y qué no, campo por campo', async () => {
    await show(live());
    const lista = screen.getByTestId('usage-support-claude');
    expect(lista.querySelector('[data-field="windows"]').getAttribute('data-state')).toBe('available');
    expect(lista.querySelector('[data-field="tokens"]').textContent).toBe('Tokens: no se informa');
    expect(screen.getByTestId('usage-support-codex').querySelector('[data-field="cost"]').textContent).toBe('Coste: se informa');
  });

  it('filtros por proveedor, cuenta y modelo, sacados del propio informe', async () => {
    await show(live(report([PROVIDERS.conModelos('uno', 'aaaabbbb'), PROVIDERS.conModelos('dos', 'ccccdddd'), PROVIDERS.sinDatos()])));
    expect(screen.getByTestId('usage-filters')).toBeTruthy();
    const ids = () => [...document.querySelectorAll('[data-provider]')].map((c) => c.getAttribute('data-provider'));
    expect(ids()).toEqual(['uno', 'dos', 'otro']);
    fireEvent.change(screen.getByTestId('usage-filter-provider'), { target: { value: 'dos' } });
    expect(ids()).toEqual(['dos']);
    fireEvent.change(screen.getByTestId('usage-filter-provider'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('usage-filter-account'), { target: { value: 'aaaabbbb' } });
    expect(ids()).toEqual(['uno']);
    fireEvent.change(screen.getByTestId('usage-filter-account'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('usage-filter-model'), { target: { value: 'modelo-a' } });
    expect(ids()).toEqual(['uno', 'dos']);
    expect(card('uno').querySelectorAll('tbody tr')).toHaveLength(1);
    fireEvent.change(screen.getByTestId('usage-filter-provider'), { target: { value: 'otro' } });
    expect(screen.getByTestId('usage-no-match').textContent).toMatch(/Ningún proveedor coincide/);
  });

  it('con un solo proveedor no hay filtros que no sirven para nada', async () => {
    await show(live(report([PROVIDERS.alLimite()])));
    expect(screen.queryByTestId('usage-filters')).toBeNull();
  });

  it('el primer sondeo del Core se dice, no se inventa un informe y el botón no deja pedir otro', async () => {
    await show(LOADING);
    expect(screen.getByTestId('usage-loading').textContent).toMatch(/El Core está consultando/);
    expect(document.querySelector('[data-provider]')).toBeNull();
    expect(screen.getByTestId('usage-refresh').disabled).toBe(true);
    expect(screen.getByTestId('usage-refresh').textContent).toBe('Consultando…');
  });

  it('un Core sin proveedores, uno que no conoce la query y uno que falla se distinguen', async () => {
    await show(live(report([])));
    expect(screen.getByTestId('usage-empty')).toBeTruthy();
    cleanup();
    invoke.mockReset();
    await show(null, { });
    // (una respuesta vacía no es del contrato: error)
    expect(screen.getByTestId('usage-error')).toBeTruthy();
    cleanup();
    invoke.mockReset();
    answer(() => { throw new Error('Comando desconocido: usage_report'); });
    render(<UsageView now={NOW} />);
    await flush();
    expect(screen.getByTestId('usage-unsupported')).toBeTruthy();
    expect(screen.getByTestId('usage-refresh').disabled).toBe(true);
  });

  it('una respuesta que no cumple el contrato no se pinta como uso', async () => {
    const mala = live();
    mala.report.providers[0].snapshot.windows[0].used_percent = 150;
    await show(mala);
    expect(document.querySelector('[data-provider]')).toBeNull();
    expect(screen.getByTestId('usage-error')).toBeTruthy();
  });

  it('el refresco manual pide refresh al Core y avisa si se atendió con el dato guardado', async () => {
    const throttled = live();
    throttled.report.providers[0].throttled = true;
    let n = 0;
    const calls = answer((p) => (p.args.refresh ? (n += 1, throttled) : live()));
    render(<UsageView now={NOW} />);
    await flush();
    expect(screen.queryByTestId('usage-throttled-codex')).toBeNull();
    fireEvent.click(screen.getByTestId('usage-refresh'));
    await flush();
    expect(calls.some((c) => c.args.refresh === true)).toBe(true);
    expect(n).toBe(1);
    // La lectura siguiente trae el dato; el aviso de «dato guardado» sale cuando el Core lo marca.
    answer(() => throttled);
    fireEvent.click(screen.getByTestId('usage-refresh'));
    await flush();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await flush();
    expect(screen.getByTestId('usage-throttled-codex').textContent).toMatch(/dato guardado/);
  });

  it('si el refresco manual falla se dice y la pantalla sigue con el último informe', async () => {
    answer((p) => { if (p.args.refresh) throw new Error('boom'); return live(); });
    render(<UsageView now={NOW} />);
    await flush();
    fireEvent.click(screen.getByTestId('usage-refresh'));
    await flush();
    expect(screen.getByTestId('usage-refresh-error').getAttribute('role')).toBe('alert');
    expect(card('codex')).toBeTruthy();
  });

  it('se actualiza solo con la lectura periódica y la edad del dato se recalcula', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let fase = 0;
    answer(() => (fase === 0 ? live(report([PROVIDERS.alLimite()])) : live(report([{ ...PROVIDERS.alLimite(), snapshot: { ...PROVIDERS.alLimite().snapshot, windows: [{ id: 'primary', minutes: 300, used_percent: 50, resets_at: NOW / 1000 + 600 }] } }]))));
    render(<UsageView now={NOW} />);
    await flush();
    expect(card('codex').querySelector('[data-window="primary"]').textContent).toMatch(/96\.5/);
    fase = 1;
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    await flush();
    expect(card('codex').querySelector('[data-window="primary"]').textContent).toMatch(/50 % usado/);
  });

  it('no consulta nada si no está activa', async () => {
    const calls = answer(() => live());
    render(<UsageView now={NOW} active={false} />);
    await flush();
    expect(calls).toEqual([]);
  });

  it('accesibilidad: sección con nombre, región anunciada, barras con valor, tabla con título y estados con texto y glifo', async () => {
    await show(live(report([PROVIDERS.alLimite(), PROVIDERS.conModelos('multi'), PROVIDERS.sinDatos(), PROVIDERS.bloqueado()])));
    const root = screen.getByTestId('usage-view');
    expect(root.getAttribute('aria-labelledby')).toBeTruthy();
    expect(root.querySelector(`#${root.getAttribute('aria-labelledby')}`).textContent).toBe('Uso de los proveedores');
    expect(root.querySelector('[aria-live="polite"]')).toBeTruthy();
    for (const bar of root.querySelectorAll('[role="progressbar"]')) {
      expect(bar.getAttribute('aria-label').length).toBeGreaterThan(5);
      expect(bar.getAttribute('aria-valuemin')).toBe('0');
      expect(bar.getAttribute('aria-valuemax')).toBe('100');
    }
    expect(root.querySelector('table caption').textContent).toBe('Uso por modelo');
    for (const th of root.querySelectorAll('tbody th')) expect(th.getAttribute('scope')).toBe('row');
    for (const b of root.querySelectorAll('.usage-badge')) {
      expect(b.textContent.trim().length).toBeGreaterThan(3);
      expect(b.querySelector('[aria-hidden="true"]')).toBeTruthy();
    }
    expect(screen.getByLabelText('Proveedor')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Actualizar' })).toBeTruthy();
    expect(root.querySelectorAll('h4').length).toBe(4);
  });

  it('ni una credencial ni un identificador de cuenta: la cuenta es solo la huella que manda el Core', async () => {
    await show(live());
    const texto = screen.getByTestId('usage-view').textContent;
    expect(texto).toContain('e7cbf1f7'); // la huella de 8 hex
    // «Tokens» es la columna de uso, no una credencial: se buscan las formas de una credencial.
    for (const prohibido of ['@', 'secret', 'api_key', 'bearer', 'sk-', 'ghp_']) expect(texto.toLowerCase()).not.toContain(prohibido);
    expect(CANONICAL_REPORT.providers[0].snapshot.account).toMatch(/^[0-9a-f]{8}$/);
  });
});
