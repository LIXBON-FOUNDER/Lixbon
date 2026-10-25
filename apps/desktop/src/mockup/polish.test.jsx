// polish.test.jsx — refinamiento del ADE (2026-10-24): estados vacíos, datos extremos y etiquetas en frase.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import AdeDesktop from './ade/AdeDesktop';
import { useStore } from './store';

globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => { vi.useFakeTimers(); useStore.getState().resetAll(); useStore.setState({ surface: 'ade', view: 'workspace' }); });
afterEach(() => { cleanup(); vi.runOnlyPendingTimers(); vi.useRealTimers(); });

describe('ADE refinado', () => {
  it('una búsqueda sin resultados lo dice y ofrece salir (antes el sidebar quedaba en blanco)', () => {
    render(<AdeDesktop live={false} />);
    fireEvent.change(screen.getByLabelText('Search work'), { target: { value: 'zzzz-no-existe' } });
    expect(screen.getByText('No work matches')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.queryByText('No work matches')).toBeNull();
    expect(useStore.getState().filter.q).toBe('');
  });

  it('los datos del peor caso se renderizan sin romper y resetAll los deshace', () => {
    useStore.getState().worstCase();
    render(<AdeDesktop live={false} />);
    expect(screen.getAllByText(/Refactor_ProviderSessionAdapter/).length).toBeGreaterThan(0);
    cleanup();
    useStore.getState().resetAll();
    render(<AdeDesktop live={false} />);
    expect(screen.queryByText(/Refactor_ProviderSessionAdapter/)).toBeNull();
  });

  it('el momento del Attempt usa etiquetas en frase, no en mayúsculas', () => {
    render(<AdeDesktop live={false} />);
    expect(screen.getByText('Running · live attempt')).toBeDefined();
    expect(screen.queryByText('RUNNING · LIVE ATTEMPT')).toBeNull();
  });

  it('el contador de Attempts del sidebar es un número con título accesible', () => {
    render(<AdeDesktop live={false} />);
    expect(screen.getAllByTitle('2 attempts').length).toBeGreaterThan(0);
  });
});
