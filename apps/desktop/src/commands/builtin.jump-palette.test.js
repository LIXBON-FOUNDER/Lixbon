import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerBuiltinCommands } from './builtin';
import { DEFAULT_KEYMAP, bindingConflict, chordForCommand, dispatchKeydown, getKeymap, resetBindings, setBinding } from '../lib/keymap';
import { allCommands, getCommand } from '../lib/commands';
import { useAppStore } from '../store/appStore';
import { useWorkbenchStore } from '../store/workbenchStore';

const JUMP = 'ade.jumpPalette';
const press = (init) => {
  const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
  return { event, consumed: dispatchKeydown(event) };
};
const jumpOpen = () => useWorkbenchStore.getState().jumpPaletteOpen;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeAll(() => registerBuiltinCommands());

beforeEach(() => {
  localStorage.clear();
  resetBindings();
  useWorkbenchStore.setState({ mode: 'editor', jumpPaletteOpen: false });
  useAppStore.setState({ quickOpen: false, commandPalette: false });
});
afterEach(() => resetBindings());

describe('Jump Palette · atajo configurable', () => {
  it('registra el comando y lo ofrece a la lista de atajos configurables', () => {
    expect(getCommand(JUMP)).toBeTruthy();
    expect(allCommands().some((command) => command.id === JUMP)).toBe(true);
    expect(chordForCommand(JUMP)).toBe('ctrl+alt+j');
  });

  it('su chord por defecto no colisiona con Quick Open, Ctrl+K ni la paleta de comandos', () => {
    const chord = chordForCommand(JUMP);
    expect(['ctrl+p', 'ctrl+k', 'ctrl+shift+p']).not.toContain(chord);
    expect(DEFAULT_KEYMAP['ctrl+p']).toBe('workbench.quickOpen');
    expect(DEFAULT_KEYMAP['ctrl+k']).toBe('workbench.focusSearch');
    expect(DEFAULT_KEYMAP['ctrl+shift+p']).toBe('workbench.commandPalette');
    // Ningún otro comando comparte el chord y el comando no tiene un segundo chord por defecto.
    expect(Object.entries(getKeymap()).filter(([, id]) => id === JUMP)).toEqual([[chord, JUMP]]);
  });

  it('Ctrl+Alt+J abre y cierra la paleta pasando al Orquestador; Ctrl+P y Ctrl+K siguen en su sitio', async () => {
    expect(press({ key: 'j', ctrlKey: true, altKey: true }).consumed).toBe(true);
    await flush();
    expect(useWorkbenchStore.getState().mode).toBe('orch');
    expect(jumpOpen()).toBe(true);

    press({ key: 'j', ctrlKey: true, altKey: true });
    await flush();
    expect(jumpOpen()).toBe(false);

    const quick = press({ key: 'p', ctrlKey: true });
    await flush();
    expect(quick.consumed).toBe(true);
    expect(useAppStore.getState().quickOpen).toBe(true);
    expect(jumpOpen()).toBe(false);

    useWorkbenchStore.setState({ searchOpen: false });
    press({ key: 'k', ctrlKey: true });
    await flush();
    expect(useWorkbenchStore.getState().searchOpen).toBe(true);
  });

  it('al abrirla cierra Quick Open y la paleta de comandos del IDE', async () => {
    useAppStore.setState({ quickOpen: true, commandPalette: true });
    press({ key: 'j', ctrlKey: true, altKey: true });
    await flush();
    expect(useAppStore.getState().quickOpen).toBe(false);
    expect(useAppStore.getState().commandPalette).toBe(false);
    expect(jumpOpen()).toBe(true);
  });

  it('salir del Orquestador la cierra para que no reaparezca al volver', async () => {
    press({ key: 'j', ctrlKey: true, altKey: true });
    await flush();
    useWorkbenchStore.getState().setMode('editor');
    expect(jumpOpen()).toBe(false);
  });

  it('se puede reasignar con el mismo mecanismo de overrides y deja libre el chord anterior', async () => {
    setBinding(JUMP, 'ctrl+shift+alt+k');
    expect(chordForCommand(JUMP)).toBe('ctrl+shift+alt+k');
    expect(press({ key: 'j', ctrlKey: true, altKey: true }).consumed).toBe(false);
    expect(jumpOpen()).toBe(false);

    expect(press({ key: 'K', ctrlKey: true, shiftKey: true, altKey: true }).consumed).toBe(true);
    await flush();
    expect(jumpOpen()).toBe(true);
  });
});

describe('Jump Palette · colisiones de atajos', () => {
  const keyToggleAgent = 'workbench.toggleAgent';

  it('rechaza reasignar Quick Open o la propia Jump Palette sin desalojar a su dueño', async () => {
    // Otro comando intenta quedarse Ctrl+P: se rechaza y Quick Open sigue abriéndose.
    expect(bindingConflict(keyToggleAgent, 'ctrl+p')).toBe('workbench.quickOpen');
    expect(setBinding(keyToggleAgent, 'ctrl+p')).toEqual({ ok: false, conflict: 'workbench.quickOpen' });
    expect(chordForCommand('workbench.quickOpen')).toBe('ctrl+p');
    expect(chordForCommand(keyToggleAgent)).toBe('ctrl+alt+b');
    expect(localStorage.getItem('lixbon_keymap_overrides')).toBeNull();
    press({ key: 'p', ctrlKey: true });
    await flush();
    expect(useAppStore.getState().quickOpen).toBe(true);

    // Otro comando intenta quedarse Ctrl+Alt+J: la Jump Palette lo conserva.
    expect(setBinding(keyToggleAgent, 'ctrl+alt+j')).toEqual({ ok: false, conflict: JUMP });
    expect(chordForCommand(JUMP)).toBe('ctrl+alt+j');
    expect(press({ key: 'j', ctrlKey: true, altKey: true }).consumed).toBe(true);
    await flush();
    expect(jumpOpen()).toBe(true);
  });

  it('la Jump Palette tampoco puede quitarle Ctrl+P ni Ctrl+K a sus comandos', () => {
    expect(setBinding(JUMP, 'ctrl+p')).toEqual({ ok: false, conflict: 'workbench.quickOpen' });
    expect(setBinding(JUMP, 'ctrl+k')).toEqual({ ok: false, conflict: 'workbench.focusSearch' });
    expect(chordForCommand(JUMP)).toBe('ctrl+alt+j');
    expect(chordForCommand('workbench.quickOpen')).toBe('ctrl+p');
  });

  it('permite volver a asignar el mismo chord a su comando y mover a uno libre', () => {
    expect(setBinding(JUMP, 'ctrl+alt+j')).toEqual({ ok: true, conflict: null });
    expect(bindingConflict(JUMP, 'ctrl+alt+j')).toBeNull();
    expect(setBinding(JUMP, 'ctrl+shift+alt+9').ok).toBe(true);
    // El chord que dejó libre ya puede usarse.
    expect(bindingConflict(keyToggleAgent, 'ctrl+alt+j')).toBeNull();
    expect(setBinding(keyToggleAgent, 'ctrl+alt+j').ok).toBe(true);
  });
});
