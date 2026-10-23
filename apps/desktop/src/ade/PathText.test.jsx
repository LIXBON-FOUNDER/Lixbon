import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PathText } from './PathText';

// LXO-120: una ruta es TEXTO, nunca enlace. Nombre corto visible, completa solo en el tooltip,
// y "Copiar ruta" confirma (o dice que fallo) por una region aria-live polite.
const ROOT = 'C:\\repos\\lixbon';
const FULL = 'C:\\repos\\lixbon\\apps\\desktop\\src\\ade\\PathText.jsx';
const SHORT = 'apps/desktop/src/ade/PathText.jsx';
const realClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function setClipboard(writeText) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}
const flush = async () => { await act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); }); };

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  if (realClipboard) Object.defineProperty(navigator, 'clipboard', realClipboard);
  else delete navigator.clipboard;
});

describe('PathText (LXO-120)', () => {
  it('muestra la ruta corta relativa al repo como texto, sin <a> ni href', () => {
    const { container } = render(<PathText path={FULL} repoRoot={ROOT} />);
    const code = container.querySelector('code');
    expect(code.textContent).toBe(SHORT);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('la ruta completa solo aparece en el tooltip', () => {
    const { container } = render(<PathText path={FULL} repoRoot={ROOT} />);
    expect(container.querySelector('code').getAttribute('title')).toBe(FULL);
    expect(container.textContent).not.toContain(FULL);
  });

  it('al copiar con exito anuncia "Ruta copiada" en una region aria-live polite', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    render(<PathText path={FULL} repoRoot={ROOT} />);
    const live = screen.getByTestId('path-copy-feedback');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('');
    fireEvent.click(screen.getByRole('button', { name: `Copiar ruta: ${SHORT}` }));
    await flush();
    expect(writeText).toHaveBeenCalledWith(FULL);
    expect(live.textContent).toBe('Ruta copiada');
  });

  it('si el portapapeles falla anuncia "No se pudo copiar la ruta"', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('denegado')));
    render(<PathText path={FULL} repoRoot={ROOT} />);
    fireEvent.click(screen.getByRole('button', { name: `Copiar ruta: ${SHORT}` }));
    await flush();
    const live = screen.getByTestId('path-copy-feedback');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toBe('No se pudo copiar la ruta');
  });
});