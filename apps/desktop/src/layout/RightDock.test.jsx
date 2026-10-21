import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RightDock } from './RightDock';

const frame = vi.hoisted(() => ({ compact: true }));
vi.mock('../lib/frameSize', () => ({ useIsCompact: () => frame.compact }));
beforeEach(() => { frame.compact = true; });
afterEach(cleanup);

function Probe({ onMount, onUnmount }) {
  useEffect(() => {
    onMount();
    return onUnmount;
  }, [onMount, onUnmount]);
  return <button type="button" data-testid="agent-content">Conversación</button>;
}

describe('RightDock compacto', () => {
  it('conserva AgentPanel montado y el mismo nodo al ocultar ADE', () => {
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    const props = { open: true, id: 'agent', drawerOpen: true, keepMountedWhenHidden: true };
    const { rerender } = render(<RightDock {...props}><Probe onMount={onMount} onUnmount={onUnmount} /></RightDock>);
    const original = screen.getByTestId('agent-content');

    rerender(<RightDock {...props} visible={false}><Probe onMount={onMount} onUnmount={onUnmount} /></RightDock>);
    expect(screen.queryByTestId('agent-content')).toBe(original);
    expect(onUnmount).not.toHaveBeenCalled();

    rerender(<RightDock {...props} visible><Probe onMount={onMount} onUnmount={onUnmount} /></RightDock>);
    expect(screen.getByTestId('agent-content')).toBe(original);
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(onUnmount).not.toHaveBeenCalled();
  });

  it('no monta AgentPanel oculto si nunca estuvo abierto en modo compacto', () => {
    const onMount = vi.fn();
    const onUnmount = vi.fn();
    render(<RightDock open visible={false} drawerOpen={false} keepMountedWhenHidden>
      <Probe onMount={onMount} onUnmount={onUnmount} />
    </RightDock>);

    expect(screen.queryByTestId('agent-content')).toBeNull();
    expect(onMount).not.toHaveBeenCalled();
  });

  it('retiene el ancho del panel al ocultar una composición abierta', () => {
    frame.compact = false;
    const { container } = render(<RightDock open visible={false} keepMountedWhenHidden>
      <div>AgentPanel</div>
    </RightDock>);

    expect(container.querySelector('.collapse').classList.contains('is-open')).toBe(true);
    frame.compact = true;
  });

  it('cierra solo el cajón de ADE con Escape cuando está visible', () => {
    const onCloseDrawer = vi.fn();
    render(<RightDock open drawerOpen onCloseDrawer={onCloseDrawer}>
      <div>Inspector</div>
    </RightDock>);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCloseDrawer).toHaveBeenCalledTimes(1);
  });
});
