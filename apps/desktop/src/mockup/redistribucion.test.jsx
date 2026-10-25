// redistribucion.test.jsx — 2.ª ronda (2026-10-24): composición del espacio sin perder funciones.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import React from 'react';
import AdeDesktop from './ade/AdeDesktop';
import SimPanel from './SimPanel';
import { useStore } from './store';

globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };
const st = () => useStore.getState();

beforeEach(() => { vi.useFakeTimers(); st().resetAll(); useStore.setState({ surface: 'ade', view: 'workspace' }); });
afterEach(() => { cleanup(); vi.runOnlyPendingTimers(); vi.useRealTimers(); });

describe('Attention: lista + detalle', () => {
  it('seleccionar una solicitud muestra su comando, alcance, política y decisión; Activity sigue aparte', () => {
    act(() => st().setView('attention'));
    render(<AdeDesktop live={false} />);
    const detail = screen.getByRole('region', { name: 'Selected request' });
    expect(within(detail).getByText(/curl -sL/)).toBeDefined(); // la de mayor riesgo va primero
    expect(within(detail).getByText('Scope if allowed')).toBeDefined();
    expect(within(detail).getByText('Policy')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /Run lint/ }));
    expect(within(detail).getByText('npm run lint')).toBeDefined();
    expect(within(detail).getByRole('button', { name: 'Allow for this Attempt' })).toBeDefined();
    expect(screen.getByLabelText('Activity')).toBeDefined(); // telemetría, fuera del detalle
    expect(within(detail).queryByLabelText('Activity')).toBeNull();
  });

  it('las solicitudes de alto riesgo nunca tienen casilla de lote ni «always»', () => {
    act(() => st().setView('attention'));
    const { container } = render(<AdeDesktop live={false} />);
    const high = [...container.querySelectorAll('.atx__row')].filter((r) => r.querySelector('.risk--high'));
    expect(high.length).toBeGreaterThan(0);
    high.forEach((r) => expect(r.querySelector('input[type=checkbox]')).toBeNull());
    const detail = screen.getByRole('region', { name: 'Selected request' });
    expect(within(detail).queryByRole('button', { name: 'Allow for this Attempt' })).toBeNull();
  });

  it('al resolver una solicitud el detalle pasa a la siguiente, no queda vacío', () => {
    act(() => st().setView('attention'));
    render(<AdeDesktop live={false} />);
    const detail = screen.getByRole('region', { name: 'Selected request' });
    fireEvent.click(within(detail).getByRole('button', { name: 'Deny' }));
    expect(within(detail).queryByText(/curl -sL/)).toBeNull();
    expect(detail.querySelector('.attn__t')).not.toBeNull();
  });

  it('↑/↓ recorren la lista', () => {
    act(() => st().setView('attention'));
    const { container } = render(<AdeDesktop live={false} />);
    const first = container.querySelector('.atx__open');
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(screen.getByRole('region', { name: 'Selected request' }).textContent).not.toMatch(/curl -sL/);
  });
});

describe('Proof Pack: jerarquía', () => {
  it('lo fallido y lo no verificado son inequívocos y la decisión conserva Attempt y revisión', () => {
    act(() => st().select('att_rt_b', 'proof'));
    render(<AdeDesktop live={false} />);
    expect(screen.getByRole('region', { name: 'Needs your review' })).toBeDefined();
    expect(screen.getAllByText(/✕ Failed/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\? Not verified/)).toBeDefined();
    const decide = screen.getByRole('complementary', { name: /Decision for Attempt B at c77d0be/ });
    expect(within(decide).getByRole('button', { name: /Accept @ c77d0be/ })).toBeDefined();
    expect(within(decide).getByRole('button', { name: 'Reject' })).toBeDefined();
    expect(within(decide).getByText(/check failing now/)).toBeDefined();
  });

  it('no se pierde evidencia: pruebas, seguridad, riesgos y detalle siguen presentes', () => {
    act(() => st().select('att_oa_b', 'proof'));
    const { container } = render(<AdeDesktop live={false} />);
    const t = container.querySelector('.ppx').textContent;
    for (const s of ['Unit tests', 'Secret scan', 'jose', 'e2e login', 'Not run', 'Touches token storage', 'Public signature', 'Keep refresh tokens', 'What the agent tried', 'Visual evidence', 'src/auth/token.ts']) expect(t).toContain(s);
  });
});

describe('Compare: resumen + exploración', () => {
  it('conserva todas las filas y acciones y deja explorar sin tocar el resumen', () => {
    act(() => st().select('att_oa_b', 'compare'));
    render(<AdeDesktop live={false} />);
    const summary = screen.getByRole('region', { name: 'Comparison summary' });
    for (const l of ['Files changed', 'Lines', 'Tests', 'Time', 'Usage', 'Warnings', 'Risks']) expect(within(summary).getByText(l)).toBeDefined();
    expect(within(summary).getAllByRole('button', { name: /^Choose / }).length).toBe(2);
    fireEvent.click(screen.getByRole('tab', { name: 'Evidence' }));
    expect(screen.getAllByRole('button', { name: /Proof Pack/ }).length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'Open diff' }).length).toBe(2);
    fireEvent.click(screen.getByRole('tab', { name: 'Risks' }));
    expect(screen.getByText(/Touches token storage/)).toBeDefined();
    expect(screen.getByRole('region', { name: 'Comparison summary' })).toBe(summary); // el resumen sigue montado
  });

  it('elegir desde la cabecera de la columna registra el ganador', () => {
    act(() => st().select('att_oa_b', 'compare'));
    render(<AdeDesktop live={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Choose B/ }));
    expect(st().choice.t_oauth).toBe('att_oa_b');
  });
});

describe('Workspace e Inspector', () => {
  it('el selector «Preview» ya no está en la cabecera: vive en Simulate', () => {
    const { container } = render(<AdeDesktop live={false} />);
    expect(container.querySelector('.ade-preview')).toBeNull();
    cleanup();
    render(<SimPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Simulate/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Decision' }));
    expect(st().sel.attemptId).toBe('att_mr_a');
  });

  it('la petición pendiente aparece una sola vez (la banda ya no la repite)', () => {
    act(() => st().previewState('att_mr_a'));
    render(<AdeDesktop live={false} />);
    expect(screen.getAllByText('npm run lint')).toHaveLength(1);
  });

  it('la tira de Attempts vive en la cabecera y sigue seleccionando', () => {
    act(() => st().select('att_oa_a'));
    const { container } = render(<AdeDesktop live={false} />);
    expect(container.querySelector('.tw__head .astrip')).not.toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: /Codex Sol/ }));
    expect(st().sel.attemptId).toBe('att_oa_b');
  });

  it('el inspector se cierra desde su cabecera y el objetivo no se duplica mientras está abierto', () => {
    const { container } = render(<AdeDesktop live={false} />);
    expect(container.querySelector('.tw__obj')).not.toBeNull();
    act(() => st().setMockUi({ inspectorOpen: true }));
    expect(container.querySelector('.tw__obj')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(st().mockUi.inspectorOpen).toBe(false);
  });
});

describe('Usage, Decision y Hosts (3.ª ronda)', () => {
  it('Usage aprovecha el espacio con el gasto por Attempt, ordenado, con total', () => {
    act(() => st().setView('usage'));
    render(<AdeDesktop live={false} />);
    const t = screen.getByRole('region', { name: 'Spend per Attempt' });
    const rows = t.querySelectorAll('tbody tr');
    expect(rows.length).toBe(st().attempts.length);
    const costs = [...rows].map((r) => Number(r.lastElementChild.textContent.replace('$', '')));
    expect([...costs].sort((a, b) => b - a)).toEqual(costs);
    expect(t.querySelector('tfoot').textContent).toMatch(/Total/);
    fireEvent.click(within(rows[0]).getByRole('button'));
    expect(st().sel.attemptId).toBe([...st().attempts].sort((a, b) => b.cost - a.cost)[0].id);
  });

  it('el Attempt en decisión tiene Actividad y la banda no repite el riesgo de la tarjeta', () => {
    act(() => st().previewState('att_mr_a'));
    const { container } = render(<AdeDesktop live={false} />);
    expect(container.querySelector('.tl__scroll').textContent).toMatch(/waiting for your decision/);
    expect(container.querySelector('.ade-moment__facts')).toBeNull();
    expect(screen.getAllByText('Not in this Task’s allowlist')).toHaveLength(1);
  });

  it('Hosts: «Archive» es un botón con forma de botón', () => {
    act(() => st().setView('hosts'));
    render(<AdeDesktop live={false} />);
    screen.getAllByRole('button', { name: 'Archive' }).forEach((b) => expect(b.className).toMatch(/btn--ghost/));
  });
});

describe('Movimiento (4.ª ronda)', () => {
  it('el inspector sale con animación, conserva su columna mientras sale y se desmonta a los 140 ms', () => {
    act(() => st().setMockUi({ inspectorOpen: true }));
    const { container } = render(<AdeDesktop live={false} />);
    expect(container.querySelector('.ade__body').className).toMatch(/has-insp/);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    const insp = container.querySelector('.insp');
    expect(insp.className).toMatch(/is-leaving/);
    expect(insp.hasAttribute('inert')).toBe(true);                       // no recibe foco ni clics mientras sale
    expect(container.querySelector('.ade__body').className).toMatch(/has-insp/);
    act(() => { vi.advanceTimersByTime(150); });
    expect(container.querySelector('.insp')).toBeNull();
    expect(container.querySelector('.ade__body').className).not.toMatch(/has-insp/);
  });

  it('reabrir mientras sale cancela la salida', () => {
    act(() => st().setMockUi({ inspectorOpen: true }));
    const { container } = render(<AdeDesktop live={false} />);
    act(() => st().setMockUi({ inspectorOpen: false }));
    act(() => { vi.advanceTimersByTime(60); });
    act(() => st().setMockUi({ inspectorOpen: true }));
    act(() => { vi.advanceTimersByTime(300); });
    expect(container.querySelector('.insp')).not.toBeNull();
    expect(container.querySelector('.insp').className).not.toMatch(/is-leaving/);
  });

  it('cada vista va en su envoltorio (lleva su propia entrada) y el origen de entrada se marca', () => {
    const { container } = render(<AdeDesktop live={false} />);
    expect(container.querySelector('.ade__main > .ade__view > .tw')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'x' });
    expect(document.documentElement.dataset.input).toBe('kbd');
    fireEvent.pointerDown(window);
    expect(document.documentElement.dataset.input).toBe('ptr');
  });
});

describe('Sidebar', () => {
  it('la marca de Attention aparece en la hoja y en el padre solo si está plegado', () => {
    const { container } = render(<AdeDesktop live={false} />);
    const proj = container.querySelector('.sb-proj');
    expect(proj.querySelector('.attn-flag')).toBeNull(); // abierto: sin marca duplicada
    expect(container.querySelectorAll('.sb-row .attn-flag').length).toBeGreaterThan(0);
    fireEvent.click(proj);
    expect(container.querySelector('.sb-proj .attn-flag')).not.toBeNull(); // plegado: el aviso no se pierde
  });
});
