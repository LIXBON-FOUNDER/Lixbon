// builtin.js — registra los comandos base de Lixbon en el registro central.
// Se llama una vez al montar el AppShell. Cada comando lee el estado de los
// stores en el momento de ejecutarse (vía getState), así que registrarlos una
// sola vez es seguro.

import { registerCommands } from '../lib/commands';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useIndexStore } from '../store/indexStore';
import { useChatStore } from '../store/chatStore';

/** Última fila de herramienta con snapshot sin revertir (para /undo). */
function findLastRevertable(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'tool' && m.snapshot && m.ok !== false && !m.reverted) return i;
  }
  return -1;
}

/** Última fila de herramienta con un diff con contenido (para /diff). */
function findLastDiffable(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const c = m.change;
    if (m.role === 'tool' && c && (c.sampleOld?.length > 0 || c.sampleNew?.length > 0)) return i;
  }
  return -1;
}

let registered = false;

export function registerBuiltinCommands() {
  if (registered) return;
  registered = true;

  const app = () => useAppStore.getState();
  const git = () => useGitStore.getState();

  registerCommands([
    // ── Vistas / paneles ────────────────────────────────────────────────
    {
      id: 'workbench.commandPalette', title: 'Mostrar todos los comandos',
      category: 'Ver', keywords: 'paleta command palette',
      run: () => { const a = app(); a.setQuickOpen(false); a.setCommandPalette(!a.commandPalette); },
    },
    {
      id: 'workbench.quickOpen', title: 'Ir a archivo…',
      category: 'Ver', keywords: 'quick open buscar archivo',
      run: () => { const a = app(); a.setCommandPalette(false); a.setQuickOpen(true); },
    },
    {
      id: 'chat.newConversation', title: 'Nueva conversación',
      category: 'Chat', keywords: 'nuevo chat conversacion agente',
      run: () => useChatStore.getState().newConversation(),
    },
    {
      id: 'workbench.toggleExplorer', title: 'Archivos',
      category: 'Ver', keywords: 'archivos explorer sidebar',
      run: () => app().selectNav('explorer'),
    },
    {
      id: 'workbench.toggleTerminal', title: 'Alternar terminal',
      category: 'Ver', keywords: 'terminal consola shell',
      run: () => app().toggleTerminal(),
    },
    {
      id: 'workbench.showExtensions', title: 'Extensiones',
      category: 'Ver', keywords: 'extensiones capacidades agente linter',
      run: () => app().selectNav('extensions'),
    },
    {
      id: 'remote.open', title: 'Control remoto (/remote)',
      category: 'IA', keywords: 'remote remoto movil telefono qr controlar',
      run: () => app().openModal('remote'),
    },
    {
      id: 'workbench.openSettings', title: 'Ajustes',
      category: 'Ver', keywords: 'ajustes settings preferencias config',
      run: () => app().openModal('settings'),
    },
    {
      id: 'codebase.buildIndex', title: 'IA: (re)construir índice del codebase',
      category: 'IA', keywords: 'rag indice embeddings codebase semantico',
      run: () => useIndexStore.getState().build(),
    },

    // ── Chat (comandos "/") ─────────────────────────────────────────────
    {
      id: 'chat.undoLast', title: 'Revertir el último cambio',
      category: 'Chat', keywords: 'undo deshacer revertir cambio',
      run: () => {
        const chat = useChatStore.getState();
        const idx = findLastRevertable(chat.messages);
        if (idx >= 0) chat.revertTool(idx);
      },
    },
    {
      id: 'chat.focusModelPicker', title: 'Cambiar de modelo',
      category: 'Chat', keywords: 'modelo model cambiar elegir',
      run: () => window.dispatchEvent(new CustomEvent('lixbon:focus-model-picker')),
    },
    {
      id: 'chat.viewLastDiff', title: 'Ver el último cambio',
      category: 'Chat', keywords: 'diff ver cambio archivo',
      run: () => {
        const chat = useChatStore.getState();
        const idx = findLastDiffable(chat.messages);
        if (idx < 0) return;
        const change = chat.messages[idx].change;
        const patch = [
          `--- ${change.path}`, `+++ ${change.path}`,
          ...change.sampleOld.map((l) => `-${l}`),
          ...change.sampleNew.map((l) => `+${l}`),
        ].join('\n');
        app().openDiff(change.path, patch);
      },
    },
    {
      id: 'chat.toggleAgentMenu', title: 'Opciones del agente (modo, auto-aplicar, auto-run)',
      category: 'Chat', keywords: 'mode modo agente auto aplicar run comandos',
      run: () => window.dispatchEvent(new CustomEvent('lixbon:toggle-agent-menu')),
    },
    {
      id: 'chat.toggleApprove', title: 'Auto-aprobar cambios del agente',
      category: 'Chat', keywords: 'approve aprobar auto aplicar',
      run: () => { const c = useChatStore.getState(); c.setAutoApprove(!c.autoApprove); },
    },
    {
      id: 'chat.openUsage', title: 'Ver consumo de la cuenta',
      category: 'Chat', keywords: 'usage uso consumo cuenta tokens',
      run: () => window.dispatchEvent(new CustomEvent('lixbon:open-usage')),
    },

    // ── Git ─────────────────────────────────────────────────────────────
    {
      id: 'git.open', title: 'Git: control de código',
      category: 'Git', keywords: 'git source control cambios',
      run: () => app().selectNav('git'),
    },
    {
      id: 'git.refresh', title: 'Git: actualizar estado',
      category: 'Git', keywords: 'git refresh status',
      run: () => git().refresh(),
    },
    {
      id: 'git.stageAll', title: 'Git: preparar todos los cambios',
      category: 'Git', keywords: 'git stage add all',
      run: () => git().stageAll(),
    },
    {
      id: 'git.pull', title: 'Git: pull', category: 'Git',
      keywords: 'git pull', run: () => git().pull(),
    },
    {
      id: 'git.push', title: 'Git: push', category: 'Git',
      keywords: 'git push', run: () => git().push(),
    },
    {
      id: 'git.fetch', title: 'Git: fetch', category: 'Git',
      keywords: 'git fetch', run: () => git().fetch(),
    },
  ]);
}
