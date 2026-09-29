// vscodeImport.js — trae del VS Code (o Cursor) del usuario lo que tiene
// equivalente aquí: tamaño de fuente, tabulación, ajuste de línea, shell del
// terminal y los atajos de los comandos que existen en lixbon.
import { invoke } from '@tauri-apps/api/core';
import { setBinding } from './keymap';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useTerminalStore } from '../store/terminalStore';

const COMMANDS = {
  'workbench.action.showCommands': 'workbench.commandPalette',
  'workbench.action.quickOpen': 'workbench.quickOpen',
  'workbench.action.terminal.toggleTerminal': 'workbench.toggleTerminal',
  'workbench.action.toggleSidebarVisibility': 'workbench.toggleExplorer',
  'workbench.view.explorer': 'workbench.showFiles',
  'workbench.action.findInFiles': 'workbench.search',
  'workbench.view.search': 'workbench.search',
  'workbench.view.extensions': 'workbench.showExtensions',
  'workbench.view.scm': 'git.open',
  'workbench.action.files.save': 'file.save',
  'workbench.action.files.saveAll': 'file.saveAll',
  'workbench.action.closeActiveEditor': 'file.close',
  'workbench.action.openSettings': 'workbench.openSettings',
};

const SHELLS = { powershell: 'powershell', 'windows powershell': 'powershell', 'command prompt': 'cmd', 'git bash': 'bash', bash: 'bash', zsh: 'zsh' };

/** "shift+cmd+p" (VS Code) → "ctrl+shift+p" (orden y nombres de keymap.js). */
function toChord(key) {
  const parts = key.toLowerCase().split('+');
  const main = parts.pop();
  const has = (m) => parts.includes(m);
  return [(has('ctrl') || has('cmd') || has('meta')) && 'ctrl', has('shift') && 'shift', has('alt') && 'alt', main].filter(Boolean).join('+');
}

/** JSON con comentarios y comas finales, como los settings de VS Code. */
export function parseJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

async function read(name) {
  try {
    const text = await invoke('vscode_user_file', { name });
    return text ? parseJsonc(text) : null;
  } catch {
    return null;
  }
}

/** ¿Hay un VS Code con ajustes que importar? */
export async function hasVsCode() {
  return !!(await read('settings.json')) || !!(await read('keybindings.json'));
}

/** Aplica lo importable y devuelve qué se trajo (para contárselo al usuario). */
export async function importVsCode() {
  const done = [];
  const settings = await read('settings.json');
  if (settings) {
    const wb = useWorkbenchStore.getState();
    const size = Number(settings['editor.fontSize']);
    if (size) { wb.setEditorOption('fontSize', Math.max(10, Math.min(22, Math.round(size)))); done.push(`fuente ${size}`); }
    const tab = Number(settings['editor.tabSize']);
    if (tab) { const t = [2, 4, 8].reduce((a, b) => (Math.abs(b - tab) < Math.abs(a - tab) ? b : a)); wb.setEditorOption('tabSize', t); done.push(`tabulación ${t}`); }
    const wrap = settings['editor.wordWrap'];
    if (wrap) { wb.setEditorOption('wordWrap', wrap !== 'off'); done.push(`ajuste de línea ${wrap !== 'off' ? 'activado' : 'desactivado'}`); }
    const profile = settings['terminal.integrated.defaultProfile.windows'] || settings['terminal.integrated.defaultProfile.osx'] || settings['terminal.integrated.defaultProfile.linux'];
    const shell = profile && SHELLS[String(profile).toLowerCase()];
    if (shell) { useTerminalStore.getState().setDefaultShell(shell); done.push(`terminal ${profile}`); }
  }
  const keys = await read('keybindings.json');
  if (Array.isArray(keys)) {
    let n = 0;
    for (const k of keys) {
      const target = COMMANDS[k?.command];
      if (!target || !k.key || k.key.includes(' ')) continue; // sin acordes de dos pasos
      setBinding(target, toChord(k.key));
      n++;
    }
    if (n) done.push(`${n} ${n === 1 ? 'atajo' : 'atajos'}`);
  }
  return done;
}
