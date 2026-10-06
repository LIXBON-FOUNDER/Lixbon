// slashCommands.js — entradas del menú "/" de la caja del chat: las acciones
// del IDE y, en una sesión de Claude Code, sus comandos y skills.
import { runCommand } from '../lib/commands';
import { claudeMenuEntries } from '../lib/claudeCommands';
import {
  IconFileCode, IconHammer, IconClip, IconTerminal, IconHistory, IconFolder, IconSun,
  IconGitCommit, IconChart, IconList, IconCheck, IconUser, IconPuzzle, IconGear, IconPlus,
} from '../components/Icons';

/** Comandos "/" del composer: acciones instantáneas, no texto para el modelo.
    Espejo de apps/cli/lixbon_cli/commands.py::COMMAND_SPECS — mismo nombre
    de comando para quien viene del CLI. Lo que allí es solo de terminal
    (doctor, ps, nodes, bar…) no tiene equivalente aquí y se omite. */
export const SLASH_COMMANDS = [
  { cmd: 'new', desc: 'Nueva conversación', Icon: IconPlus, run: () => runCommand('chat.newConversation') },
  { cmd: 'clear', desc: 'Vaciar el contexto y empezar de cero', Icon: IconPlus, run: () => runCommand('chat.newConversation') },
  { cmd: 'mode', desc: 'Modo: Agente, Plan o Preguntar', Icon: IconHammer, run: () => runCommand('chat.toggleAgentMenu') },
  { cmd: 'agent', desc: 'Modo Agente: edita y ejecuta', Icon: IconHammer, run: () => runCommand('chat.mode.agent') },
  { cmd: 'plan', desc: 'Modo Plan: investiga y propone antes de tocar nada', Icon: IconList, run: () => runCommand('chat.mode.plan') },
  { cmd: 'ask', desc: 'Modo Preguntar: solo lectura', Icon: IconUser, run: () => runCommand('chat.mode.ask') },
  { cmd: 'approve', desc: 'Auto-aprobar cambios del agente', Icon: IconCheck, run: () => runCommand('chat.toggleApprove') },
  { cmd: 'undo', desc: 'Revertir el último cambio', Icon: IconHistory, run: () => runCommand('chat.undoLast') },
  { cmd: 'diff', desc: 'Ver el último cambio', Icon: IconFolder, run: () => runCommand('chat.viewLastDiff') },
  { cmd: 'commit', desc: 'Confirmar cambios en Git', Icon: IconGitCommit, run: () => runCommand('git.open') },
  { cmd: 'model', desc: 'Cambiar de modelo', Icon: IconSun, run: () => runCommand('chat.focusModelPicker') },
  { cmd: 'usage', desc: 'Ver consumo de la cuenta', Icon: IconChart, run: () => runCommand('chat.openUsage') },
  { cmd: 'copy', desc: 'Copiar la última respuesta', Icon: IconClip, run: () => runCommand('chat.copyLast') },
  { cmd: 'save', desc: 'Exportar la conversación a Markdown', Icon: IconFileCode, run: () => runCommand('chat.saveMarkdown') },
  { cmd: 'history', desc: 'Ver conversaciones anteriores', Icon: IconHistory, run: () => runCommand('chat.showHistory') },
  { cmd: 'workspace', desc: 'Cambiar la carpeta de trabajo', Icon: IconFolder, run: () => runCommand('chat.openWorkspace') },
  { cmd: 'init', desc: 'Generar LIXBON.md con el contexto del proyecto', Icon: IconFileCode, run: () => runCommand('chat.init') },
  { cmd: 'tools', desc: 'Herramientas y permisos del agente', Icon: IconPuzzle, run: () => runCommand('settings.openAgent') },
  { cmd: 'allow', desc: 'Comandos que el agente ejecuta sin preguntar', Icon: IconPuzzle, run: () => runCommand('settings.openAgent') },
  { cmd: 'login', desc: 'Cuenta y sesión', Icon: IconUser, run: () => runCommand('settings.openAccount') },
  { cmd: 'logout', desc: 'Cuenta y sesión', Icon: IconUser, run: () => runCommand('settings.openAccount') },
  { cmd: 'key', desc: 'Cuenta y sesión', Icon: IconUser, run: () => runCommand('settings.openAccount') },
  { cmd: 'config', desc: 'Ajustes', Icon: IconGear, run: () => runCommand('workbench.openSettings') },
  { cmd: 'remote', desc: 'Control remoto por QR', Icon: IconTerminal, run: () => runCommand('remote.open') },
  { cmd: 'orquestar', desc: 'Este chat pasa a coordinar un equipo de agentes (experimental)', hint: '<objetivo>', Icon: IconPuzzle },
  { cmd: 'help', desc: 'Ver todos los comandos', Icon: IconList, run: () => runCommand('workbench.commandPalette') },
];

// En una sesión de Claude Code solo valen las acciones del IDE que tienen
// sentido para él (las que cambian lo que el IDE muestra: conversación nueva,
// modelo, modo); el resto de "/" son los comandos del propio Claude Code.
const CLAUDE_LOCAL = new Set(['new', 'clear', 'mode', 'plan', 'undo', 'diff', 'model', 'copy', 'save', 'history', 'workspace', 'remote', 'orquestar']);

export const GROUP_LABELS = { lixbon: 'Lixbon', claude: 'Claude Code', skill: 'Skills' };

// Comandos de la terminal de Claude Code que su modo -p no trae: los que tienen
// equivalente en el IDE lo abren; el resto los resuelve Lixbon con una tarjeta.
export const CLAUDE_ALIASES = [
  { cmd: 'resume', desc: 'Retomar una conversación anterior', Icon: IconHistory, run: () => runCommand('chat.showHistory') },
  { cmd: 'export', desc: 'Exportar la conversación a Markdown', Icon: IconFileCode, run: () => runCommand('chat.saveMarkdown') },
  { cmd: 'rewind', desc: 'Revertir el último cambio de Claude', Icon: IconHistory, run: () => runCommand('chat.undoLast') },
  { cmd: 'add-dir', desc: 'Cambiar la carpeta de trabajo', Icon: IconFolder, run: () => runCommand('chat.openWorkspace') },
  { cmd: 'login', desc: 'Cuenta y sesión', Icon: IconUser, run: () => runCommand('settings.openAccount') },
  { cmd: 'logout', desc: 'Cuenta y sesión', Icon: IconUser, run: () => runCommand('settings.openAccount') },
];

export const CLAUDE_IDE_CARDS = [
  { cmd: 'status', desc: 'Versión, cuenta, modelo, modo y MCP de esta sesión' },
  { cmd: 'cost', desc: 'Gasto de la sesión, contexto y cupo del plan' },
  { cmd: 'help', desc: 'Todos los comandos "/" disponibles' },
  { cmd: 'skills', desc: 'Skills instaladas y de dónde vienen' },
  { cmd: 'permissions', desc: 'Qué puede hacer Claude sin preguntar' },
  { cmd: 'memory', desc: 'Abrir o crear CLAUDE.md (memoria del proyecto y global)' },
  { cmd: 'hooks', desc: 'Hooks configurados en Claude Code' },
  { cmd: 'doctor', desc: 'Revisar instalación, cuenta, ajustes y MCP (sin gastar tokens)' },
];

export function claudeSlashCommands(commands = []) {
  const local = SLASH_COMMANDS.filter((c) => CLAUDE_LOCAL.has(c.cmd)).map((c) => ({ ...c, group: 'lixbon' }));
  local.push({ cmd: 'btw', desc: 'Pregunta al margen, sin interrumpir a Claude', hint: '<pregunta>', Icon: IconTerminal, claude: true, group: 'lixbon' });
  local.push(...CLAUDE_ALIASES.map((c) => ({ ...c, group: 'lixbon' })));
  const ide = CLAUDE_IDE_CARDS.map((c) => ({ ...c, Icon: IconTerminal, claude: true, direct: true, group: 'claude' }));
  const taken = new Set([...local, ...ide].map((c) => c.cmd));
  const remote = claudeMenuEntries(commands)
    .filter((c) => !taken.has(c.cmd))
    .map((c) => ({ ...c, Icon: c.group === 'skill' ? IconPuzzle : IconTerminal, claude: true }));
  const order = { lixbon: 0, claude: 1, skill: 2 };
  return [...local, ...[...ide, ...remote].sort((a, b) => order[a.group] - order[b.group])];
}
