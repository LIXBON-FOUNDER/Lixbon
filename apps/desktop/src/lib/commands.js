// commands.js — registro central de comandos del IDE.
// Un comando es { id, title, category?, keywords?, run, when? }.
// La paleta (Ctrl+Mayús+P), los atajos (keymap.js) y los menús lo ejecutan por id.
// Este módulo NO depende de stores ni de React: es el punto neutral que todo lo
// demás usa para registrar acciones (editor, git, IA, LSP, formateo…).

const registry = new Map(); // id -> command
const listeners = new Set(); // se notifican cuando cambia el conjunto

function emit() {
  for (const fn of listeners) fn();
}

/** Registra un comando. Devuelve una función para desregistrarlo. */
export function registerCommand(cmd) {
  if (!cmd || !cmd.id || typeof cmd.run !== 'function') {
    console.warn('[commands] comando inválido:', cmd);
    return () => {};
  }
  registry.set(cmd.id, cmd);
  emit();
  return () => {
    if (registry.get(cmd.id) === cmd) {
      registry.delete(cmd.id);
      emit();
    }
  };
}

/** Registra varios comandos de una vez. */
export function registerCommands(cmds) {
  const disposers = cmds.map(registerCommand);
  return () => disposers.forEach((d) => d());
}

export function getCommand(id) {
  return registry.get(id);
}

/** Todos los comandos visibles en la paleta (los que no están ocultos). */
export function allCommands() {
  return [...registry.values()].filter((c) => !c.hidden);
}

/** Ejecuta un comando por id. Devuelve true si existía (y su `when` pasó). */
export async function runCommand(id, ...args) {
  const cmd = registry.get(id);
  if (!cmd) {
    console.warn('[commands] comando desconocido:', id);
    return false;
  }
  if (cmd.when && !cmd.when()) return false;
  try {
    await cmd.run(...args);
  } catch (e) {
    console.error(`[commands] fallo ejecutando "${id}":`, e);
  }
  return true;
}

/** Suscripción para que la paleta se refresque si el conjunto cambia. */
export function onCommandsChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
