import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ComposerQuota, quotaOf, quotaTitle } from './ComposerQuota';
import { useClaudeUsage } from '../store/claudeSession';
import { useAppStore } from '../store/appStore';

// El compositor tiene un sitio para la cuota del plan de Claude: sesión y semana, con clic hacia «Uso y límites».
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 60;

afterEach(() => {
  cleanup();
  useClaudeUsage.setState({ session: null, week: null });
});

describe('ComposerQuota', () => {
  it('muestra el porcentaje de la sesión y dice sesión y semana en el título', () => {
    useClaudeUsage.setState({ session: { percent: 42, resetAt: FUTURE }, week: { percent: 7, resetAt: FUTURE } });
    render(<ComposerQuota />);
    const button = screen.getByTestId('composer-quota');
    expect(button.textContent).toBe('42%');
    expect(button.title).toContain('sesión 42%');
    expect(button.title).toContain('semana 7%');
    expect(button.getAttribute('aria-label')).toBe(button.title);
  });

  it('sin datos no inventa un número: guion y explicación, pero el sitio sigue ahí', () => {
    useClaudeUsage.setState({ session: null, week: null });
    render(<ComposerQuota />);
    const button = screen.getByTestId('composer-quota');
    expect(button.textContent).toBe('—');
    expect(button.title).toMatch(/aún sin datos/);
    expect(button.title).toMatch(/\/usage/);
  });

  it('sin sesión informada usa la semana; una ventana ya vencida cuenta 0%', () => {
    expect(quotaOf({ session: null, week: { percent: 61, resetAt: FUTURE } })).toEqual({ session: null, week: 61 });
    expect(quotaOf({ session: { percent: 88, resetAt: PAST }, week: null })).toEqual({ session: 0, week: null });
    expect(quotaTitle({ session: null, week: 61 })).toContain('sesión sin datos · semana 61%');
    useClaudeUsage.setState({ session: null, week: { percent: 61, resetAt: FUTURE } });
    render(<ComposerQuota />);
    expect(screen.getByTestId('composer-quota').textContent).toBe('61%');
  });

  it('acota a 0–100', () => {
    expect(quotaOf({ session: { percent: 180, resetAt: FUTURE }, week: { percent: -5, resetAt: FUTURE } })).toEqual({ session: 100, week: 0 });
  });

  it('un clic abre Uso y límites en Ajustes', () => {
    const openModal = vi.fn();
    const previous = useAppStore.getState().openModal;
    useAppStore.setState({ openModal });
    try {
      render(<ComposerQuota />);
      fireEvent.click(screen.getByTestId('composer-quota'));
      expect(openModal).toHaveBeenCalledWith('settings', 'usage');
    } finally {
      useAppStore.setState({ openModal: previous });
    }
  });
});
