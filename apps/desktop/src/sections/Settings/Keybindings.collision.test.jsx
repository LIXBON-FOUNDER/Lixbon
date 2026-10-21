import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Keybindings } from './Keybindings';
import { registerBuiltinCommands } from '../../commands/builtin';
import { chordForCommand, resetBindings } from '../../lib/keymap';

beforeAll(() => registerBuiltinCommands());
beforeEach(() => {
  localStorage.clear();
  resetBindings();
});
afterEach(() => {
  cleanup();
  resetBindings();
});

const chordButton = (title) => screen.getByText(title).closest('.keys__row').querySelector('button');
const record = (title, init) => {
  fireEvent.click(chordButton(title));
  fireEvent.keyDown(window, { cancelable: true, ...init });
};

describe('Ajustes · Atajos de teclado · colisiones', () => {
  it('avisa y no cambia nada al intentar quitarle Ctrl+P a Quick Open', () => {
    render(<Keybindings />);
    record('Ir a Project, Task o Attention…', { key: 'p', ctrlKey: true });

    expect(screen.getByRole('alert').textContent).toContain('Ctrl+P ya está asignado a');
    expect(chordForCommand('ade.jumpPalette')).toBe('ctrl+alt+j');
    expect(chordForCommand('workbench.quickOpen')).toBe('ctrl+p');
    expect(chordButton('Ir a Project, Task o Attention…').textContent).toBe('Ctrl+Alt+J');
  });

  it('protege Ctrl+Alt+J de otros comandos y retira el aviso al reasignar a un chord libre', () => {
    render(<Keybindings />);
    record('Nueva conversación', { key: 'j', ctrlKey: true, altKey: true });
    expect(screen.getByRole('alert').textContent).toContain('Ctrl+Alt+J ya está asignado a «Ir a Project, Task o Attention…»');
    expect(chordForCommand('chat.newConversation')).toBe('ctrl+n');

    record('Nueva conversación', { key: 'u', ctrlKey: true, altKey: true });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(chordForCommand('chat.newConversation')).toBe('ctrl+alt+u');
  });
});
