// keymap.js — mapa atajo→comando y normalización de eventos de teclado.
// El "chord" canónico es: modificadores en orden `ctrl+shift+alt` + tecla en
// minúscula (p. ej. `ctrl+shift+p`, `ctrl+tab`). En macOS ⌘ se trata como ctrl.
// Los atajos personalizables (M5/D5) sobrescribirán DEFAULT_KEYMAP vía loadKeymap().

import { runCommand } from './commands';

// Atajos por defecto. Mantiene paridad con los que ya existían en AppShell y
// añade la paleta de comandos. `ñ` cubre el teclado español (backtick físico).
export const DEFAULT_KEYMAP = {
  'ctrl+shift+p': 'workbench.commandPalette',
  'ctrl+p': 'workbench.quickOpen',
  'ctrl+s': 'editor.save',
  'ctrl+shift+s': 'editor.saveAll',
  'ctrl+w': 'editor.closeTab',
  'ctrl+tab': 'editor.nextTab',
  'ctrl+shift+tab': 'editor.prevTab',
  'ctrl+k': 'editor.inlineEdit',
  'shift+alt+f': 'editor.format',
  'ctrl+shift+f': 'workbench.findInFiles',
  'ctrl+`': 'workbench.toggleTerminal',
  'ctrl+ñ': 'workbench.toggleTerminal',
  'ctrl+b': 'workbench.toggleExplorer',
};

let activeKeymap = { ...DEFAULT_KEYMAP };

const OVERRIDE_KEY = 'lixbon_keymap_overrides';

function readOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || '{}') || {}; }
  catch { return {}; }
}

/** Reconstruye el keymap activo: DEFAULT + overrides (chord→cmd, o chord→null
    para desvincular). Sin argumento lee los overrides persistidos. */
export function loadKeymap(overrides) {
  const ov = overrides || readOverrides();
  activeKeymap = { ...DEFAULT_KEYMAP };
  for (const [chord, cmd] of Object.entries(ov)) {
    if (cmd === null) delete activeKeymap[chord];
    else activeKeymap[chord] = cmd;
  }
}

export function getKeymap() {
  return activeKeymap;
}

/** Asigna `chord` al comando `commandId` (desvinculando su chord anterior). */
export function setBinding(commandId, chord) {
  const ov = readOverrides();
  const oldChord = chordForCommand(commandId);
  if (oldChord && oldChord !== chord) ov[oldChord] = null; // libera el anterior
  ov[chord] = commandId;
  localStorage.setItem(OVERRIDE_KEY, JSON.stringify(ov));
  loadKeymap(ov);
}

/** Restaura todos los atajos por defecto. */
export function resetBindings() {
  localStorage.removeItem(OVERRIDE_KEY);
  loadKeymap({});
}

/** Primer atajo asignado a un comando (para mostrarlo en la paleta). */
export function chordForCommand(id) {
  for (const [chord, cmdId] of Object.entries(activeKeymap)) {
    if (cmdId === id) return chord;
  }
  return '';
}

/** Convierte un KeyboardEvent en su chord canónico, o null si es solo un modificador. */
export function chordFromEvent(e) {
  const key = e.key;
  if (key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta') return null;
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(key.length === 1 ? key.toLowerCase() : key.toLowerCase());
  return parts.join('+');
}

/** Formatea un chord para mostrarlo (Ctrl+Shift+P). */
export function prettyChord(chord) {
  if (!chord) return '';
  return chord
    .split('+')
    .map((p) => {
      if (p === 'ctrl') return 'Ctrl';
      if (p === 'shift') return 'Shift';
      if (p === 'alt') return 'Alt';
      if (p === 'tab') return 'Tab';
      return p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1);
    })
    .join('+');
}

/** Despacha un keydown global a través del keymap. Solo interviene en chords con
    ctrl/meta para no interferir con el tecleo normal ni con CodeMirror.
    Devuelve true si consumió el evento. */
export function dispatchKeydown(e) {
  // Solo chords con un modificador "de comando" (ctrl/meta/alt): no interferir
  // con el tecleo normal. Alt permite atajos como Shift+Alt+F (formatear).
  if (!(e.ctrlKey || e.metaKey || e.altKey)) return false;
  const chord = chordFromEvent(e);
  if (!chord) return false;
  const id = activeKeymap[chord];
  if (!id) return false;
  e.preventDefault();
  runCommand(id);
  return true;
}

// Aplica los overrides persistidos al cargar el módulo.
loadKeymap();
