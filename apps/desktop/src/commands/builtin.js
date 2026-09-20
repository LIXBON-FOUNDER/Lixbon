// builtin.js — registra los comandos base de Lixbon en el registro central.
// Se llama una vez al montar el AppShell. Cada comando lee el estado de los
// stores en el momento de ejecutarse (vía getState), así que registrarlos una
// sola vez es seguro.

import { registerCommands } from '../lib/commands';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useIndexStore } from '../store/indexStore';
import { useChatStore } from '../store/chatStore';
import { pickDirectory, createNewEntry, writeFileContent } from '../lib/tauri';

/** Markdown de una conversación completa (para /save): mismo criterio que
    apps/cli/lixbon_cli/app.py::cmd_save — un encabezado por turno, sin las
    filas de herramienta (esas quedan en el workspace, no en la bitácora). */
function conversationMarkdown(state) {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const lines = [`# Conversación Lixbon — ${state.conversationTitle || 'sin título'}`, '', `- Fecha: ${stamp}`, ''];
  for (const m of state.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = (m.content || '').trim();
    if (!content) continue;
    lines.push(m.role === 'user' ? '## Tú' : '## Lixbon', '', content, '');
  }
  return lines.join('\n');
}

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
    {
      id: 'chat.copyLast', title: 'Copiar la última respuesta',
      category: 'Chat', keywords: 'copy copiar clipboard portapapeles',
      run: () => {
        const messages = useChatStore.getState().messages;
        const last = [...messages].reverse().find((m) => m.role === 'assistant' && (m.content || '').trim());
        if (last) navigator.clipboard?.writeText(last.content);
      },
    },
    {
      id: 'chat.saveMarkdown', title: 'Guardar la conversación en Markdown',
      category: 'Chat', keywords: 'save guardar markdown bitacora exportar',
      run: async () => {
        const a = app();
        if (!a.workspaceRoot) return;
        const chat = useChatStore.getState();
        if (!chat.messages.length) return;
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').slice(0, 12);
        const name = `lixbon-${stamp}.md`;
        try {
          await createNewEntry(a.workspaceRoot, name, false);
        } catch (e) {
          if (!String(e).includes('Ya existe')) throw e;
        }
        const sep = a.workspaceRoot.includes('\\') ? '\\' : '/';
        await writeFileContent(`${a.workspaceRoot}${sep}${name}`, conversationMarkdown(chat));
        window.dispatchEvent(new CustomEvent('lixbon:fs-changed'));
      },
    },
    {
      id: 'chat.showHistory', title: 'Ver conversaciones anteriores',
      category: 'Chat', keywords: 'history historial conversaciones recientes',
      run: () => app().selectNav('chat'),
    },
    {
      id: 'chat.openWorkspace', title: 'Cambiar la carpeta de trabajo',
      category: 'Chat', keywords: 'workspace carpeta proyecto abrir folder',
      run: async () => {
        const selected = await pickDirectory({ title: 'Abrir carpeta de trabajo' });
        if (selected) await app().openWorkspace(selected);
      },
    },
    {
      id: 'chat.init', title: 'Generar LIXBON.md con el contexto del proyecto',
      category: 'Chat', keywords: 'init lixbon.md contexto proyecto',
      run: () => useChatStore.getState().send(
        'Analiza este proyecto y escribe un archivo LIXBON.md breve (máximo 60 líneas) que sirva de '
        + 'contexto permanente para un asistente de código: qué es el proyecto, stack y estructura, '
        + 'cómo se ejecuta y se prueba, y convenciones que haya que respetar.',
      ),
    },
    {
      id: 'settings.openAgent', title: 'Herramientas y permisos del agente',
      category: 'IA', keywords: 'tools allow herramientas permisos comandos',
      run: () => app().openModal('settings', 'agent'),
    },
    {
      id: 'settings.openAccount', title: 'Cuenta y sesión',
      category: 'Ver', keywords: 'login logout key cuenta sesion api key',
      run: () => app().openModal('settings', 'account'),
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
