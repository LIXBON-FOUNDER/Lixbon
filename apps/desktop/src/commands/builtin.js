// builtin.js — registra los comandos base de Lixbon en el registro central.
// Se llama una vez al montar el AppShell. Cada comando lee el estado de los
// stores en el momento de ejecutarse (vía getState), así que registrarlos una
// sola vez es seguro.

import { registerCommands } from '../lib/commands';
import { useAppStore } from '../store/appStore';
import { useGitStore } from '../store/gitStore';
import { useIndexStore } from '../store/indexStore';
import { useChatStore, CHAT_MODES } from '../store/chatStore';
import { pickDirectory, openExternal, saveTextAs, revealInDir, readDir } from '../lib/tauri';
import { toast } from '../store/toastStore';
import { showConfirm } from '../lib/confirm';
import { githubSlug } from '../lib/githubSlug';
import { useWorkbenchStore } from '../store/workbenchStore';
import { useFileViewStore } from '../store/fileViewStore';
import { useTerminalStore } from '../store/terminalStore';
import { previewKind, viewOf } from '../lib/preview';
import { useProblemsStore } from '../store/problemsStore';
import { getActiveView } from '../editor/CodeEditor';
import { useTeamStore } from '../team/store/teamStore';
import { useMensajesStore } from '../team/store/mensajesStore';
import { invoke } from '@tauri-apps/api/core';
import { detectRunConfig } from '../lib/runConfigs';
import { undo, redo, selectAll } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';

const TOOL_VERB = { read_file: 'Leyó', write_file: 'Creó', edit_file: 'Editó', multi_edit: 'Editó', delete_file: 'Eliminó', rename_file: 'Renombró', run_command: 'Ejecutó', ask_user: 'Preguntó' };

/** Markdown de una conversación completa (para /save). Las herramientas van
    como una línea cada una, sin su salida. */
function conversationMarkdown(state) {
  const stamp = new Date().toLocaleString();
  const lines = [`# ${state.conversationTitle || 'Conversación con Lixbon'}`, '', `_Exportada el ${stamp}_`, ''];
  let inTools = false;
  for (const m of state.messages) {
    if (m.role === 'tool') {
      const target = m.args?.command || m.args?.path || m.args?.src || m.args?.query || '';
      lines.push(`- ${TOOL_VERB[m.tool] || m.tool}${target ? ` \`${target}\`` : ''}${m.ok === false ? ' (falló)' : ''}`);
      inTools = true;
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const content = (m.content || '').trim();
    if (!content) continue;
    if (inTools) { lines.push(''); inTools = false; }
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
  const wb = () => useWorkbenchStore.getState();
  const tabs = () => useFileViewStore.getState();
  const inEditor = () => { if (wb().mode !== 'editor') wb().setMode('editor'); };

  // Menú Editar: actúa sobre el editor de código abierto; en un campo de
  // texto normal se cae al comando nativo del navegador.
  const onEditor = (cmd, fallback) => () => {
    const view = getActiveView();
    if (view && wb().mode === 'editor') { view.focus(); cmd(view); return; }
    if (fallback) document.execCommand(fallback);
  };
  const newFile = (type) => () => {
    if (!app().workspaceRoot) return;
    inEditor();
    wb().showSide('files');
    setTimeout(() => window.dispatchEvent(new CustomEvent('lixbon:explorer-create', { detail: { type } })), 60);
  };
  const runProject = (kind) => async () => {
    const root = app().workspaceRoot;
    if (!root) return;
    const config = detectRunConfig(await readDir(root).catch(() => []));
    const cmd = config?.[kind];
    if (!cmd) { toast(kind === 'build' ? 'No sé cómo compilar este proyecto.' : 'No sé cómo ejecutar este proyecto.'); return; }
    inEditor();
    wb().setDockTab('terminal');
    app().showTerminal();
    useTerminalStore.getState().runCommand(cmd);
  };
  const setPreview = (mode) => () => {
    const s = tabs();
    const tab = s.tabs.find((t) => t.path === s.activePath);
    if (!tab || tab.virtual || !previewKind(tab.path)) { toast('Este archivo no tiene vista previa.'); return; }
    inEditor();
    const current = viewOf(tab, s.views, false);
    s.setView(tab.path, mode === 'split' ? (current === 'split' ? 'code' : 'split') : (current === 'preview' ? 'code' : 'preview'));
  };
  // Manda la selección del editor a la conversación abierta en el panel de Team,
  // como bloque de código con su ruta y líneas.
  const shareSelection = () => {
    const view = getActiveView();
    const path = tabs().activePath;
    const team = useTeamStore.getState();
    if (!view || !path) { toast('Abre un archivo y selecciona el código que quieres compartir.'); return; }
    if (team.sesion !== 'ok' || !team.canalId) {
      wb().setRightView('team');
      toast('Elige una conversación en el panel de Team y vuelve a intentarlo.');
      return;
    }
    const { from, to } = view.state.selection.main;
    const doc = view.state.doc;
    const desde = doc.lineAt(from).number;
    const hasta = doc.lineAt(to).number;
    const code = from === to ? doc.line(desde).text : doc.sliceString(from, to);
    const root = app().workspaceRoot;
    const rel = root && path.startsWith(root) ? path.slice(root.length + 1).replace(/\\/g, '/') : path.split(/[\\/]/).pop();
    const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1] || '';
    const lineas = desde === hasta ? `${desde}` : `${desde}-${hasta}`;
    const fence = '```';
    useMensajesStore.getState().enviar(team.canalId, `\`${rel}:${lineas}\`\n${fence}${ext}\n${code}\n${fence}`, team.usuario?.id);
    wb().setRightView('team');
    toast(`Enviado a ${team.canalActivo()?.nombre ? `#${team.canalActivo().nombre}` : 'la conversación'}.`);
  };
  const openDock = (tab) => () => { inEditor(); wb().setDockTab(tab); app().showTerminal(); };

  registerCommands([
    { id: 'file.newFile', title: 'Nuevo archivo', category: 'Archivo', keywords: 'nuevo archivo crear file', run: newFile('file') },
    { id: 'file.newFolder', title: 'Nueva carpeta', category: 'Archivo', keywords: 'nueva carpeta crear folder', run: newFile('dir') },
    { id: 'edit.undo', title: 'Deshacer', category: 'Editar', keywords: 'undo deshacer', run: onEditor(undo, 'undo') },
    { id: 'edit.redo', title: 'Rehacer', category: 'Editar', keywords: 'redo rehacer', run: onEditor(redo, 'redo') },
    { id: 'edit.selectAll', title: 'Seleccionar todo', category: 'Editar', keywords: 'select all seleccionar', run: onEditor(selectAll, 'selectAll') },
    { id: 'edit.find', title: 'Buscar en el archivo', category: 'Editar', keywords: 'find buscar archivo', run: onEditor(openSearchPanel) },
    { id: 'terminal.new', title: 'Nuevo terminal', category: 'Terminal', keywords: 'terminal nuevo shell', run: () => { openDock('terminal')(); useTerminalStore.getState().addSession(); } },
    { id: 'terminal.run', title: 'Ejecutar el proyecto', category: 'Terminal', keywords: 'run ejecutar dev start', run: runProject('run') },
    { id: 'terminal.build', title: 'Compilar el proyecto', category: 'Terminal', keywords: 'build compilar', run: runProject('build') },
    { id: 'terminal.check', title: 'Comprobar problemas', category: 'Terminal', keywords: 'check problemas tsc cargo ruff lint', run: () => { openDock('problems')(); useProblemsStore.getState().run(); } },
    { id: 'view.problems', title: 'Problemas', category: 'Ver', keywords: 'problemas errores warnings', run: openDock('problems') },
    { id: 'view.output', title: 'Salida', category: 'Ver', keywords: 'salida output log', run: openDock('output') },
    { id: 'team.open', title: 'Abrir Lixbon Team', category: 'Team', keywords: 'team equipo chat canales', run: () => invoke('team_abrir').catch(() => {}) },
    { id: 'team.dock', title: 'Lixbon Team en el panel derecho', category: 'Team', keywords: 'team equipo chat acoplar panel', run: () => { inEditor(); wb().setRightView('team'); } },
    { id: 'team.shareSelection', title: 'Enviar la selección a Team', category: 'Team', keywords: 'team compartir codigo seleccion enviar chat', run: shareSelection },
    { id: 'editor.togglePreview', title: 'Alternar vista previa', category: 'Ver', keywords: 'markdown md html svg vista previa preview visual', run: setPreview('toggle') },
    { id: 'editor.splitPreview', title: 'Vista previa al lado', category: 'Ver', keywords: 'markdown md html vista previa dividido split', run: setPreview('split') },
    { id: 'help.keybindings', title: 'Atajos de teclado', category: 'Ayuda', keywords: 'atajos teclado keybindings shortcuts', run: () => wb().openSettings('keys') },
    { id: 'help.docs', title: 'Documentación', category: 'Ayuda', keywords: 'docs documentacion ayuda', run: () => openExternal('https://lixbon.com/docs') },
    { id: 'help.downloads', title: 'Descargas y novedades', category: 'Ayuda', keywords: 'version descargas novedades changelog', run: () => openExternal('https://lixbon.com/apps') },
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
      id: 'workbench.toggleExplorer', title: 'Mostrar u ocultar la barra lateral',
      category: 'Ver', keywords: 'archivos explorer sidebar barra lateral',
      run: () => { if (wb().mode !== 'editor') { inEditor(); wb().showSide('files'); } else wb().toggleSide(); },
    },
    {
      id: 'workbench.showFiles', title: 'Archivos',
      category: 'Ver', keywords: 'archivos explorer arbol',
      run: () => { inEditor(); wb().showSide('files'); },
    },
    {
      id: 'workbench.search', title: 'Buscar en el proyecto',
      category: 'Ver', keywords: 'buscar search reemplazar replace grep semantica',
      run: () => { inEditor(); wb().showSide('search'); },
    },
    {
      id: 'workbench.focusSearch', title: 'Buscar archivos, código o comandos',
      category: 'Ver', keywords: 'buscador barra superior',
      run: () => wb().setSearchOpen(true),
    },
    {
      id: 'workbench.toggleAgent', title: 'Mostrar u ocultar el panel del agente',
      category: 'Ver', keywords: 'agente panel derecho chat',
      run: () => { inEditor(); wb().toggleAgent(); },
    },
    {
      id: 'workbench.toggleTerminal', title: 'Alternar terminal',
      category: 'Ver', keywords: 'terminal consola shell',
      run: () => {
        if (wb().mode !== 'editor') { inEditor(); app().showTerminal(); } else app().toggleTerminal();
      },
    },
    { id: 'mode.agent', title: 'Modo Agente', category: 'Ver', keywords: 'agente chat pantalla completa', run: () => wb().setMode('agent') },
    { id: 'mode.editor', title: 'Modo Editor', category: 'Ver', keywords: 'editor codigo', run: () => wb().setMode('editor') },
    { id: 'mode.design', title: 'Modo Diseño', category: 'Ver', keywords: 'diseno vista previa emulador movil responsive', run: () => wb().setMode('design') },
    { id: 'mode.git', title: 'Modo Git', category: 'Ver', keywords: 'git cambios commit github', run: () => wb().setMode('git') },

    // ── Archivos ────────────────────────────────────────────────────────
    {
      id: 'file.save', title: 'Guardar', category: 'Archivo', keywords: 'guardar save',
      when: () => !!tabs().activePath,
      run: () => tabs().save(),
    },
    {
      id: 'file.saveAll', title: 'Guardar todo', category: 'Archivo', keywords: 'guardar todo save all',
      run: () => tabs().saveAll(),
    },
    {
      id: 'file.close', title: 'Cerrar pestaña', category: 'Archivo', keywords: 'cerrar pestana close tab',
      when: () => wb().mode === 'editor' && !!tabs().activePath,
      run: () => tabs().close(tabs().activePath),
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
      id: 'chat.toggleAgentMenu', title: 'Modo y opciones del agente',
      category: 'Chat', keywords: 'mode modo agente auto aplicar run comandos',
      run: () => window.dispatchEvent(new CustomEvent('lixbon:toggle-agent-menu')),
    },
    {
      id: 'chat.cycleMode', title: 'Alternar modo del chat (Agente → Plan → Preguntar)',
      category: 'Chat', keywords: 'mode modo plan ask preguntar agente alternar',
      run: () => useChatStore.getState().cycleChatMode(),
    },
    ...CHAT_MODES.map((m) => ({
      id: `chat.mode.${m.id}`, title: `Modo ${m.label}`,
      category: 'Chat', keywords: `mode modo ${m.id} ${m.label}`,
      run: () => useChatStore.getState().setChatMode(m.id),
    })),
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
      id: 'chat.saveMarkdown', title: 'Exportar la conversación a Markdown',
      category: 'Chat', keywords: 'save guardar markdown bitacora exportar',
      run: async () => {
        const chat = useChatStore.getState();
        if (!chat.messages.some((m) => m.role === 'user' || m.role === 'assistant')) {
          toast('No hay nada que exportar todavía.');
          return;
        }
        const slug = (chat.conversationTitle || 'conversacion').toLowerCase()
          .normalize('NFD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
        try {
          const path = await saveTextAs(`${slug || 'conversacion'}.md`, conversationMarkdown(chat));
          if (!path) return;
          toast(`Guardada en ${path}`, { action: { label: 'Mostrar', run: () => revealInDir(path).catch(() => {}) }, ms: 6000 });
          window.dispatchEvent(new CustomEvent('lixbon:fs-changed'));
        } catch (e) {
          toast(`No se pudo exportar: ${e?.message || e}`, { tone: 'danger' });
        }
      },
    },
    {
      id: 'chat.showHistory', title: 'Ver conversaciones anteriores',
      category: 'Chat', keywords: 'history historial conversaciones recientes',
      run: () => wb().setMode('agent'),
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
    {
      id: 'git.createBranch', title: 'Git: crear rama…', category: 'Git',
      keywords: 'git branch nueva rama checkout',
      run: async () => {
        const { choice, value } = await showConfirm({
          title: 'Crear rama',
          message: `Se crea a partir de ${git().branch || 'la rama actual'} y pasas a ella.`,
          input: { placeholder: 'feat/nombre-de-la-rama', value: '' },
          options: [{ id: 'ok', label: 'Crear', kind: 'primary' }, { id: 'cancel', label: 'Cancelar' }],
        });
        if (choice === 'ok' && value?.trim()) await git().checkout(value.trim(), true);
      },
    },
    {
      id: 'git.stash', title: 'Git: guardar cambios en stash', category: 'Git',
      keywords: 'git stash guardar', run: () => git().stash('push'),
    },
    {
      id: 'git.stashPop', title: 'Git: recuperar el último stash', category: 'Git',
      keywords: 'git stash pop recuperar', run: () => git().stash('pop'),
    },
    {
      id: 'git.generateMessage', title: 'Git: generar mensaje de commit', category: 'Git',
      keywords: 'git commit mensaje ia agente',
      run: () => { useWorkbenchStore.getState().setMode('git'); git().generateMessage(); },
    },
    {
      id: 'github.openPr', title: 'GitHub: abrir pull request de esta rama', category: 'GitHub',
      keywords: 'github pr pull request crear comparar',
      run: () => {
        const { remoteUrl, branch } = git();
        const slug = githubSlug(remoteUrl || '');
        if (slug && branch) openExternal(`https://github.com/${slug}/compare/${encodeURIComponent(branch)}?expand=1`);
      },
    },
  ]);
}
