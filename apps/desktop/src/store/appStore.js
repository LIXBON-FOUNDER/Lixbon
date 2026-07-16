import { create } from 'zustand';
import { loadSettings, saveSetting, DEFAULT_SERVER_URL } from '../lib/settings';
import { setIndentConfig, setAutoSaveConfig, useEditorStore } from './editorStore';
import { setWorkspaceRoot } from '../lib/tauri';
import { useGitStore } from './gitStore';
import { detectVisionModel, modelId } from '../lib/vision';
import { setGhostConfig } from '../editor/ghostText';
import { resetIndexCache } from '../lib/codebaseIndex';

// Aplica los ajustes de indentación persistidos al arrancar (antes de abrir archivos).
setIndentConfig(
  parseInt(localStorage.getItem('lixbon_tab_size') || '2', 10),
  (localStorage.getItem('lixbon_insert_spaces') ?? 'true') === 'true',
);
setAutoSaveConfig((localStorage.getItem('lixbon_auto_save') ?? 'true') === 'true');
// Autocompletado fantasma (B1): OFF por defecto (coste de VRAM/latencia).
setGhostConfig({ enabled: (localStorage.getItem('lixbon_ghost') ?? 'false') === 'true' });

export const useAppStore = create((set, get) => ({
  // Config persistida en plugin-store; se llena en hydrate()
  hydrated: false,
  serverUrl: DEFAULT_SERVER_URL,
  apiKey: '',
  user: null,

  editorFontSize: parseInt(
    localStorage.getItem('lixbon_editor_font_size') ||
    localStorage.getItem('lixbon_terminal_font_size') || '14',
    10
  ),
  tabSize: parseInt(localStorage.getItem('lixbon_tab_size') || '2', 10),
  insertSpaces: (localStorage.getItem('lixbon_insert_spaces') ?? 'true') === 'true',
  autoSave: (localStorage.getItem('lixbon_auto_save') ?? 'true') === 'true',
  formatOnSave: (localStorage.getItem('lixbon_format_on_save') ?? 'false') === 'true',
  connectionStatus: 'disconnected', // 'connected' | 'disconnected' | 'connecting'

  // Carpeta de trabajo (canónica). '' = sin carpeta abierta.
  workspaceRoot: '',
  // true cuando restoreWorkspace ya terminó (con carpeta o sin ella). El
  // terminal no debe abrir su PTY antes: heredaría el cwd equivocado.
  workspaceReady: false,
  // Carpetas abiertas recientemente (para la pantalla de bienvenida, D4).
  recentFolders: JSON.parse(localStorage.getItem('lixbon_recents') || '[]'),

  // Layout del IDE
  centerView: 'editor', // 'editor' | 'diff' — el centro es SIEMPRE el área de trabajo
  diffData: null, // { title, patch } para el visor de diff (Git)
  leftView: localStorage.getItem('lixbon_left_view') || 'explorer', // 'explorer' | 'search' | 'outline' | 'git' | 'extensions'
  // Ventana flotante sobre el área de trabajo: null | 'settings' | 'metrics'.
  // Ajustes y Consumo no son documentos: no deben ocupar el sitio del editor.
  modalView: null,
  modalSection: null, // categoría inicial de Ajustes (null = la última/por defecto)
  // Panel inferior (como el de VSCode): 'terminal' | 'problems'.
  // Su visibilidad sigue siendo panels.terminal (clave persistida desde antes).
  bottomView: localStorage.getItem('lixbon_bottom_view') || 'terminal',
  quickOpen: false, // overlay Ctrl+P
  commandPalette: false, // overlay Ctrl+Mayús+P
  inlineEditOpen: false, // widget de edición inline con IA (Ctrl+K)
  previewOpen: false, // vista previa Markdown/HTML junto al editor (D3)
  panels: JSON.parse(localStorage.getItem('lixbon_panels') || '{"explorer":true,"chat":true,"terminal":false}'),
  panelWidths: JSON.parse(localStorage.getItem('lixbon_panel_widths') || '{"explorer":260,"chat":360}'),
  panelHeights: JSON.parse(localStorage.getItem('lixbon_panel_heights') || '{"terminal":240}'),

  currentModel: localStorage.getItem('lixbon_current_model') || '',
  // Modelo de visión (sub-agente que describe imágenes para el modelo de texto).
  // '' = autodetectar de los modelos disponibles.
  visionModel: localStorage.getItem('lixbon_vision_model') || '',
  // Autocompletado fantasma (B1): activado y modelo (vacío = autodetectar coder).
  ghostText: (localStorage.getItem('lixbon_ghost') ?? 'false') === 'true',
  ghostModel: localStorage.getItem('lixbon_ghost_model') || '',
  // Modelo de embeddings para el índice del codebase (B3). '' = autodetectar.
  embedModel: localStorage.getItem('lixbon_embed_model') || '',
  // Inyectar contexto relevante del codebase (RAG) en el chat automáticamente.
  useCodebaseContext: (localStorage.getItem('lixbon_rag') ?? 'false') === 'true',
  // Ventana de contexto (num_ctx) que se pide a Ollama. Ollama usa 4096 por
  // defecto aunque el modelo soporte más; subirla evita truncar. Más = más VRAM.
  contextWindow: parseInt(localStorage.getItem('lixbon_context_window') || '8192', 10),
  availableModels: [],
  latency: 0,


  // Acciones
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const { serverUrl, apiKey, user } = await loadSettings();
      set({ serverUrl, apiKey, user, hydrated: true });
    } catch (e) {
      console.error('[store] Error hidratando configuración:', e);
      set({ hydrated: true }); // no bloquear la app: quedará en pantalla de auth
    }
  },

  setCenterView: (centerView) => set({ centerView }),

  /** Abre el visor de diff en el centro con un patch unified. */
  openDiff: (title, patch) => set({ diffData: { title, patch }, centerView: 'diff' }),

  /** Ventana flotante (Ajustes / Consumo): no desplaza el editor.
      `section` abre Ajustes directamente en esa categoría (barra de estado). */
  openModal: (modalView, section = null) => set({ modalView, modalSection: section }),
  closeModal: () => set({ modalView: null, modalSection: null }),

  /** Muestra `view` en el panel inferior; clic sobre la vista ya activa lo pliega. */
  openBottomPanel: (view) => {
    const { panels, bottomView } = get();
    if (panels.terminal && bottomView === view) {
      get().togglePanel('terminal');
      return;
    }
    get().showBottomPanel(view);
  },

  /** Igual que openBottomPanel pero sin plegar: lo usan Run/Build y Git, que
      siempre necesitan el terminal a la vista. */
  showBottomPanel: (view) => {
    localStorage.setItem('lixbon_bottom_view', view);
    set({ bottomView: view });
    if (!get().panels.terminal) get().togglePanel('terminal');
  },

  /** Muestra `view` en el panel izquierdo; clic sobre la vista ya activa lo pliega.
      (panels.explorer sigue siendo el flag de "panel izquierdo visible".) */
  openLeftPanel: (view) => {
    const { panels, leftView } = get();
    if (panels.explorer && leftView === view) {
      get().togglePanel('explorer');
      return;
    }
    localStorage.setItem('lixbon_left_view', view);
    set({ leftView: view });
    if (!panels.explorer) get().togglePanel('explorer');
  },

  setQuickOpen: (quickOpen) => set({ quickOpen }),

  setCommandPalette: (commandPalette) => set({ commandPalette }),

  setInlineEditOpen: (inlineEditOpen) => set({ inlineEditOpen }),

  setPreviewOpen: (previewOpen) => set({ previewOpen }),

  /** Fija la carpeta de trabajo (sandbox Rust incluido) y refresca Git.
      Devuelve la ruta canónica. */
  openWorkspace: async (path) => {
    const canonical = await setWorkspaceRoot(path);
    // Guardar la sesión de la carpeta previa antes de cambiar (bajo su propia raíz).
    const prevRoot = localStorage.getItem('lixbon_workspace_root');
    if (prevRoot && prevRoot !== canonical) useEditorStore.getState().persistSession();
    localStorage.setItem('lixbon_workspace_root', canonical);
    const recents = [canonical, ...get().recentFolders.filter((p) => p !== canonical)].slice(0, 8);
    localStorage.setItem('lixbon_recents', JSON.stringify(recents));
    set({ workspaceRoot: canonical, recentFolders: recents });
    resetIndexCache(); // el índice RAG es por-workspace
    // Los servidores de lenguaje se lanzan con una raíz fija: al cambiar de
    // carpeta hay que matarlos (el siguiente archivo abierto los relanza).
    import('./lspStore').then(({ useLspStore }) => useLspStore.getState().stopAll()).catch(() => {});
    useGitStore.getState().refresh();
    // Reabrir las pestañas guardadas de esta carpeta (cierra las de la anterior).
    await useEditorStore.getState().restoreSession(canonical);
    return canonical;
  },

  removeRecent: (path) => {
    const recents = get().recentFolders.filter((p) => p !== path);
    localStorage.setItem('lixbon_recents', JSON.stringify(recents));
    set({ recentFolders: recents });
  },

  /** Al arrancar: reabre la última carpeta usada (el estado Rust no persiste).
      Marca `workspaceReady` pase lo que pase: el terminal espera a esta señal
      para abrir su primera sesión, porque un PTY nace con el cwd que haya en ese
      momento y ya no se puede cambiar (si nace antes, cae en la carpeta del
      usuario y todo lo que se lance ahí — git, run, build — va a la carpeta
      equivocada). */
  restoreWorkspace: async () => {
    const saved = localStorage.getItem('lixbon_workspace_root');
    if (!saved || get().workspaceRoot) {
      set({ workspaceReady: true });
      return;
    }
    try {
      await get().openWorkspace(saved);
    } catch {
      localStorage.removeItem('lixbon_workspace_root'); // la carpeta ya no existe
    } finally {
      set({ workspaceReady: true });
    }
  },

  setAutoSave: (autoSave) => {
    localStorage.setItem('lixbon_auto_save', autoSave ? 'true' : 'false');
    setAutoSaveConfig(autoSave);
    set({ autoSave });
  },

  setFormatOnSave: (formatOnSave) => {
    localStorage.setItem('lixbon_format_on_save', formatOnSave ? 'true' : 'false');
    set({ formatOnSave });
  },

  togglePanel: (name) => {
    const panels = { ...get().panels, [name]: !get().panels[name] };
    localStorage.setItem('lixbon_panels', JSON.stringify(panels));
    set({ panels });
  },

  setPanelWidth: (name, width) => {
    const panelWidths = { ...get().panelWidths, [name]: width };
    localStorage.setItem('lixbon_panel_widths', JSON.stringify(panelWidths));
    set({ panelWidths });
  },

  setPanelHeight: (name, height) => {
    const panelHeights = { ...get().panelHeights, [name]: height };
    localStorage.setItem('lixbon_panel_heights', JSON.stringify(panelHeights));
    set({ panelHeights });
  },


  setServerUrl: (url) => {
    const normalized = url.trim().replace(/\/+$/, '');
    saveSetting('serverUrl', normalized);
    set({ serverUrl: normalized });
  },

  setEditorFontSize: (size) => {
    localStorage.setItem('lixbon_editor_font_size', size.toString());
    set({ editorFontSize: size });
  },

  setTabSize: (tabSize) => {
    localStorage.setItem('lixbon_tab_size', tabSize.toString());
    setIndentConfig(tabSize, get().insertSpaces);
    set({ tabSize });
  },

  setInsertSpaces: (insertSpaces) => {
    localStorage.setItem('lixbon_insert_spaces', insertSpaces ? 'true' : 'false');
    setIndentConfig(get().tabSize, insertSpaces);
    set({ insertSpaces });
  },

  setUser: (user) => {
    saveSetting('user', user);
    set({ user });
  },

  setApiKey: (apiKey) => {
    saveSetting('apiKey', apiKey);
    set({ apiKey });
  },

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

  setCurrentModel: (model) => {
    localStorage.setItem('lixbon_current_model', model);
    set({ currentModel: model });
  },

  setAvailableModels: (availableModels) => set({ availableModels }),

  setVisionModel: (model) => {
    localStorage.setItem('lixbon_vision_model', model || '');
    set({ visionModel: model || '' });
  },

  setGhostText: (ghostText) => {
    localStorage.setItem('lixbon_ghost', ghostText ? 'true' : 'false');
    setGhostConfig({ enabled: ghostText });
    set({ ghostText });
  },

  setGhostModel: (model) => {
    localStorage.setItem('lixbon_ghost_model', model || '');
    set({ ghostModel: model || '' });
  },

  /** Modelo del ghost text: el elegido, o autodetecta uno de código
      (id con "coder"/"code"), o cae al modelo de chat actual. */
  effectiveGhostModel: () => {
    const { ghostModel, availableModels, currentModel } = get();
    const ids = availableModels.map(modelId);
    if (ghostModel && ids.includes(ghostModel)) return ghostModel;
    const coder = ids.find((id) => /coder|code/i.test(id));
    return coder || currentModel;
  },

  setEmbedModel: (model) => {
    localStorage.setItem('lixbon_embed_model', model || '');
    set({ embedModel: model || '' });
  },

  setUseCodebaseContext: (v) => {
    localStorage.setItem('lixbon_rag', v ? 'true' : 'false');
    set({ useCodebaseContext: v });
  },

  /** Modelo de embeddings: el elegido, o autodetecta uno con "embed" en el id. */
  effectiveEmbedModel: () => {
    const { embedModel, availableModels } = get();
    const ids = availableModels.map(modelId);
    if (embedModel && ids.includes(embedModel)) return embedModel;
    return ids.find((id) => /embed/i.test(id)) || '';
  },

  setContextWindow: (n) => {
    const v = Math.max(2048, Math.min(131072, parseInt(n, 10) || 8192));
    localStorage.setItem('lixbon_context_window', String(v));
    set({ contextWindow: v });
  },

  /** Modelo de visión efectivo: el elegido, o autodetectado de la lista.
      availableModels trae objetos {id,…}, no strings — normalizar con modelId. */
  effectiveVisionModel: () => {
    const { visionModel, availableModels } = get();
    const ids = availableModels.map(modelId);
    if (visionModel && ids.includes(visionModel)) return visionModel;
    return detectVisionModel(availableModels);
  },

  setLatency: (latency) => set({ latency }),

  logout: () => {
    saveSetting('apiKey', null);
    saveSetting('user', null);
    set({ user: null, apiKey: '' });
  },
}));
