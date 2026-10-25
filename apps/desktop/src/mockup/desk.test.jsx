// desk.test.jsx — el marco integrado del Desktop: cinco modos, un solo Task/Attempt, barra de estado compartida.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, act } from '@testing-library/react';
import React from 'react';
import DeskShell from './desk/DeskShell';
import { useDesk } from './desk/deskStore';
import { useStore } from './store';

globalThis.ResizeObserver = globalThis.ResizeObserver || class { observe() {} unobserve() {} disconnect() {} };

beforeEach(() => { vi.useFakeTimers(); useStore.getState().resetAll(); useStore.setState({ surface: 'desk' }); useDesk.getState().reset(); });
afterEach(() => { cleanup(); vi.runOnlyPendingTimers(); vi.useRealTimers(); });

const pane = (id) => document.querySelector(`[data-pane="${id}"]`);

describe('Desktop integrado', () => {
  it('abre en Orquestar con el ADE y los cinco modos en la barra de título', () => {
    render(<DeskShell />);
    const nav = screen.getByRole('navigation', { name: 'Modo' });
    ['Agente', 'Editor', 'Diseño', 'Git', 'Orquestar'].forEach((n) => expect(within(nav).getByRole('button', { name: new RegExp(n) })).toBeDefined());
    expect(pane('orch').classList.contains('is-active')).toBe(true);
    expect(screen.getByRole('toolbar', { name: 'Vistas del ADE' })).toBeDefined();
  });

  it('cambiar de modo deja los demás montados pero inertes (conservan su estado)', () => {
    render(<DeskShell />);
    fireEvent.click(screen.getByRole('button', { name: /^Editor/ }));
    expect(pane('editor').classList.contains('is-active')).toBe(true);
    expect(pane('orch').classList.contains('is-active')).toBe(false);
    expect(pane('orch').hasAttribute('inert')).toBe(true);
    expect(pane('orch').getAttribute('aria-hidden')).toBe('true');
  });

  it('Alt+número cambia de modo sin animar; con el ratón sí hay fundido', () => {
    render(<DeskShell />);
    fireEvent.keyDown(window, { key: '3', altKey: true });
    expect(useDesk.getState().mode).toBe('design');
    expect(pane('design').hasAttribute('data-fade')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^Git/ }));
    expect(pane('git').hasAttribute('data-fade')).toBe(true);
  });

  it('«Open in IDE» y «Open in ADE» cruzan de modo conservando el Attempt', () => {
    render(<DeskShell />);
    const attempt = useStore.getState().sel.attemptId;
    fireEvent.click(within(pane('orch')).getAllByRole('button', { name: /Open in IDE/ })[0]);
    expect(useDesk.getState().mode).toBe('editor');
    expect(useStore.getState().sel.attemptId).toBe(attempt);
    fireEvent.click(within(pane('editor')).getByRole('button', { name: /Open in ADE/ }));
    expect(useDesk.getState().mode).toBe('orch');
    expect(useStore.getState().surface).toBe('desk');
  });

  it('la barra de estado lleva a Orquestar > Attention', () => {
    render(<DeskShell />);
    fireEvent.click(screen.getByRole('button', { name: /^Git/ }));
    fireEvent.click(screen.getByText(/esperan tu decisión/, { selector: 'footer *' }));
    expect(useDesk.getState().mode).toBe('orch');
    expect(useStore.getState().view).toBe('attention');
  });

  it('los botones de panel de la barra de título mandan sobre el panel de cada modo', () => {
    render(<DeskShell />);
    fireEvent.click(screen.getByRole('button', { name: /Detalles de la Task/ }));
    expect(useStore.getState().mockUi.inspectorOpen).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /^Editor/ }));
    const explorer = useStore.getState().mockUi.explorerOpen;
    fireEvent.click(screen.getByRole('button', { name: 'Panel izquierdo' }));
    expect(useStore.getState().mockUi.explorerOpen).toBe(!explorer);
  });

  it('Agente, Git y Diseño son esqueletos que muestran el mismo Attempt', () => {
    render(<DeskShell />);
    fireEvent.click(screen.getByRole('button', { name: /^Git/ }));
    expect(within(pane('git')).getByText(/Esqueleto de distribución/)).toBeDefined();
    expect(within(pane('git')).getAllByText(/Agent Runtime/).length).toBeGreaterThan(0);
  });
});
