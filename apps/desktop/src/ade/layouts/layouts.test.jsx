import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, cleanup, waitFor, render, act } from '@testing-library/react';
import { modeForWidth, BREAKPOINTS, LAYOUT_MODES } from './layoutMode';
import { renderApp } from '../testing/renderApp';
import { AdeApp } from '../screens/AdeApp';
import { makeClient, fixedNow } from '../testing/helpers';
import { createCoreAdeClient } from '../client/CoreAdeClient';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
// Estas pruebas recorren pantallas completas: bajo carga de toda la suite necesitan más de 5 s.
vi.setConfig({ testTimeout: 20000 });
afterEach(() => { cleanup(); vi.restoreAllMocks(); delete globalThis.ResizeObserver; });

describe('modos de maquetación', () => {
  it('los umbrales: amplio ≥ 1100, estrecho ≥ 640, móvil por debajo', () => {
    expect(BREAKPOINTS).toEqual({ wide: 1100, narrow: 640 });
    expect([1920, 1100].map(modeForWidth)).toEqual(['wide', 'wide']);
    expect([1099, 800, 640].map(modeForWidth)).toEqual(['narrow', 'narrow', 'narrow']);
    expect([639, 375, 320].map(modeForWidth)).toEqual(['mobile', 'mobile', 'mobile']);
    expect(modeForWidth(0)).toBe('wide'); // sin medida (jsdom, oculto): no se esconde nada
    expect([...LAYOUT_MODES]).toEqual(['wide', 'narrow', 'mobile']);
  });

  it('el modo forzado fija el atributo del contenedor', async () => {
    for (const mode of LAYOUT_MODES) {
      const { unmount } = renderApp({ mode });
      expect(screen.getByTestId('ade-root').dataset.adeMode).toBe(mode);
      unmount();
    }
  });

  describe('detección por el ancho del CONTENEDOR (no de la ventana)', () => {
    let ancho = 1300;
    let avisar;
    beforeEach(() => {
      globalThis.ResizeObserver = class {
        constructor(cb) { avisar = cb; }
        observe() { avisar(); }
        disconnect() {}
      };
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: ancho, height: 800, top: 0, left: 0, right: ancho, bottom: 800 }));
    });

    it('cambia de modo cuando cambia el tamaño del contenedor', async () => {
      ancho = 1300;
      render(<AdeApp client={makeClient()} now={fixedNow} />);
      await waitFor(() => expect(screen.getByTestId('ade-root').dataset.adeMode).toBe('wide'));
      ancho = 800;
      act(() => avisar());
      await waitFor(() => expect(screen.getByTestId('ade-root').dataset.adeMode).toBe('narrow'));
      ancho = 375;
      act(() => avisar());
      await waitFor(() => expect(screen.getByTestId('ade-root').dataset.adeMode).toBe('mobile'));
      expect(await screen.findByTestId('mobile-console')).toBeTruthy();
    });
  });

  it('la navegación se adapta: etiquetas en amplio, solo iconos en estrecho, barra inferior en móvil', async () => {
    const { unmount } = renderApp({ mode: 'mobile' });
    const nav = screen.getByRole('navigation', { name: 'Navegación del ADE' });
    expect(nav.querySelectorAll('a')).toHaveLength(4); // sin «Agentes» en el móvil
    expect(nav.querySelector('[title="Agentes"]')).toBeNull();
    unmount();
    renderApp({ mode: 'wide' });
    expect(screen.getByRole('navigation', { name: 'Navegación del ADE' }).querySelectorAll('a')).toHaveLength(5);
  });
});

describe('AdeApp con el CoreAdeClient sin implementar (el punto de sustitución)', () => {
  it('no se rompe: cada sección muestra su error, con el slice que falta, y la navegación sigue viva', async () => {
    render(<AdeApp client={createCoreAdeClient()} now={fixedNow} mode="wide" />);
    const alertas = await screen.findAllByRole('alert');
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThanOrEqual(3));
    expect(alertas.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/no está implementado/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('core_not_implemented').length).toBeGreaterThan(0);
    expect(screen.getByRole('navigation', { name: 'Navegación del ADE' })).toBeTruthy();
    expect(screen.getByText('Sin conexión con el Core')).toBeTruthy();
  });

  it('con el Core sin implementar todas las acciones de decisión salen no disponibles, nunca simuladas', async () => {
    const { unmount } = render(<AdeApp client={createCoreAdeClient()} now={fixedNow} mode="wide" initialRoute={{ screen: 'settings' }} />);
    const matriz = await screen.findByTestId('capability-matrix');
    await waitFor(() => expect(matriz.querySelectorAll('[data-availability="unavailable"]').length).toBeGreaterThan(0));
    expect(matriz.querySelector('[data-availability="simulated"]')).toBeNull();
    expect(matriz.querySelector('[data-availability="available"]')).toBeNull();
    unmount();
  });
});
