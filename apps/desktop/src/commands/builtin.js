// builtin.js — registra los comandos base del IDE en el registro central.
// Se llama una vez al montar el AppShell. Cada comando lee el estado de los
// stores en el momento de ejecutarse (vía getState), así que registrarlos una
// sola vez es seguro. Las fases futuras (git avanzado, LSP, IA) registran sus
// propios comandos desde sus módulos.

import { registerCommands } from '../lib/commands';
import { useAppStore } from '../store/appStore';
import { useEditorStore } from '../store/editorStore';
import { useGitStore } from '../store/gitStore';
import { useIndexStore } from '../store/indexStore';
import { useProblemsStore } from '../store/problemsStore';
import { formatFile } from '../lib/format';
import { gotoDefinition } from '../editor/lspExt';

let registered = false;

export function registerBuiltinCommands() {
  if (registered) return;
  registered = true;

  const app = () => useAppStore.getState();
  const editor = () => useEditorStore.getState();
  const git = () => useGitStore.getState();
  const hasTab = () => !!editor().activePath;

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
      id: 'workbench.toggleExplorer', title: 'Explorador',
      category: 'Ver', keywords: 'archivos explorer sidebar',
      run: () => app().openLeftPanel('explorer'),
    },
    {
      id: 'workbench.findInFiles', title: 'Buscar en archivos',
      category: 'Ver', keywords: 'search grep buscar',
      run: () => app().openLeftPanel('search'),
    },
    {
      id: 'workbench.showOutline', title: 'Esquema (símbolos)',
      category: 'Ver', keywords: 'outline esquema simbolos symbols',
      run: () => app().openLeftPanel('outline'),
    },
    {
      id: 'problems.show', title: 'Problemas: analizar archivo',
      category: 'Ver', keywords: 'problemas linter errores lint ruff eslint',
      run: () => { app().showBottomPanel('problems'); useProblemsStore.getState().run(); },
    },
    {
      id: 'workbench.toggleTerminal', title: 'Alternar terminal',
      category: 'Ver', keywords: 'terminal consola shell',
      run: () => app().openBottomPanel('terminal'),
    },
    {
      id: 'workbench.toggleChat', title: 'Alternar panel de chat',
      category: 'Ver', keywords: 'chat agente ia asistente',
      run: () => app().togglePanel('chat'),
    },
    {
      id: 'workbench.showExtensions', title: 'Extensiones',
      category: 'Ver', keywords: 'temas extensiones vscode',
      run: () => app().openLeftPanel('extensions'),
    },
    {
      id: 'workbench.showMetrics', title: 'Consumo del plan',
      category: 'Ver', keywords: 'metricas consumo uso tokens',
      run: () => app().openModal('metrics'),
    },
    {
      id: 'workbench.openSettings', title: 'Ajustes',
      category: 'Ver', keywords: 'ajustes settings preferencias config',
      run: () => app().openModal('settings'),
    },

    // ── Editor ──────────────────────────────────────────────────────────
    {
      id: 'editor.save', title: 'Guardar', category: 'Archivo',
      keywords: 'save guardar', when: hasTab,
      run: () => editor().saveActive(),
    },
    {
      id: 'editor.saveAll', title: 'Guardar todo', category: 'Archivo',
      keywords: 'save all guardar todo',
      run: () => editor().saveAll(),
    },
    {
      id: 'editor.closeTab', title: 'Cerrar pestaña', category: 'Archivo',
      keywords: 'close cerrar pestaña', when: hasTab,
      run: () => { const p = editor().activePath; if (p) editor().closeTab(p); },
    },
    {
      id: 'editor.inlineEdit', title: 'IA: editar selección', category: 'IA',
      keywords: 'ia edicion inline reescribir ctrl+k ai edit', when: hasTab,
      run: () => app().setInlineEditOpen(true),
    },
    {
      id: 'codebase.buildIndex', title: 'IA: (re)construir índice del codebase',
      category: 'IA', keywords: 'rag indice embeddings codebase semantico',
      run: () => useIndexStore.getState().build(),
    },
    {
      id: 'editor.togglePreview', title: 'Vista previa (Markdown/HTML)', category: 'Ver',
      keywords: 'preview vista previa markdown html', when: hasTab,
      run: () => app().setPreviewOpen(!app().previewOpen),
    },
    {
      id: 'editor.format', title: 'Formatear documento', category: 'Editor',
      keywords: 'format formatear prettier black rustfmt gofmt', when: hasTab,
      run: async () => {
        const ed = editor();
        const tab = ed.tabs.find((t) => t.path === ed.activePath);
        if (!tab) return;
        const res = await formatFile(tab.path, tab.name);
        if (!res.ok) alert('Formatear: ' + res.error);
      },
    },
    {
      id: 'editor.gotoDefinition', title: 'Ir a definición', category: 'Editor',
      keywords: 'definicion definition lsp f12 saltar', when: hasTab,
      run: async () => {
        const ok = await gotoDefinition();
        if (!ok) alert('No hay definición aquí (o el servidor de lenguaje no está activo).');
      },
    },
    {
      id: 'editor.nextTab', title: 'Pestaña siguiente', category: 'Editor',
      keywords: 'next tab siguiente', run: () => editor().cycleTab(1),
    },
    {
      id: 'editor.prevTab', title: 'Pestaña anterior', category: 'Editor',
      keywords: 'prev tab anterior', run: () => editor().cycleTab(-1),
    },

    // ── Git ─────────────────────────────────────────────────────────────
    {
      id: 'git.open', title: 'Git: control de código',
      category: 'Git', keywords: 'git source control cambios',
      run: () => app().openLeftPanel('git'),
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
