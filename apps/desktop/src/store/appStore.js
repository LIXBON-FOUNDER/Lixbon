import { create } from 'zustand';
import { loadSettings, saveSetting, DEFAULT_SERVER_URL } from '../lib/settings';
import { setIndentConfig, setAutoSaveConfig } from './editorStore';
import { setWorkspaceRoot } from '../lib/tauri';
import { useGitStore } from './gitStore';
import { detectVisionModel } from '../lib/vision';

// Aplica los ajustes de indentación persistidos al arrancar (antes de abrir archivos).
setIndentConfig(
  parseInt(localStorage.getItem('lixbon_tab_size') || '2', 10),
  (localStorage.getItem('lixbon_insert_spaces') ?? 'true') === 'true',
);
setAutoSaveConfig((localStorage.getItem('lixbon_auto_save') ?? 'true') === 'true');

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
  connectionStatus: 'disconnected', // 'connected' | 'disconnected' | 'connecting'

  // Carpeta de trabajo (canónica). '' = sin carpeta abierta.
  workspaceRoot: '',

  // Layout del IDE
  centerView: 'editor', // 'editor' | 'metrics' | 'settings'
  leftView: localStorage.getItem('lixbon_left_view') || 'explorer', // 'explorer' | 'search' | 'git' | 'extensions'
  quickOpen: false, // overlay Ctrl+P
  panels: JSON.parse(localStorage.getItem('lixbon_panels') || '{"explorer":true,"chat":true,"terminal":false}'),
  panelWidths: JSON.parse(localStorage.getItem('lixbon_panel_widths') || '{"explorer":260,"chat":360}'),
  panelHeights: JSON.parse(localStorage.getItem('lixbon_panel_heights') || '{"terminal":240}'),

  currentModel: localStorage.getItem('lixbon_current_model') || '',
  // Modelo de visión (sub-agente que describe imágenes para el modelo de texto).
  // '' = autodetectar de los modelos disponibles.
  visionModel: localStorage.getItem('lixbon_vision_model') || '',
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

  /** Fija la carpeta de trabajo (sandbox Rust incluido) y refresca Git.
      Devuelve la ruta canónica. */
  openWorkspace: async (path) => {
    const canonical = await setWorkspaceRoot(path);
    localStorage.setItem('lixbon_workspace_root', canonical);
    set({ workspaceRoot: canonical });
    useGitStore.getState().refresh();
    return canonical;
  },

  /** Al arrancar: reabre la última carpeta usada (el estado Rust no persiste). */
  restoreWorkspace: async () => {
    const saved = localStorage.getItem('lixbon_workspace_root');
    if (!saved || get().workspaceRoot) return;
    try {
      await get().openWorkspace(saved);
    } catch {
      localStorage.removeItem('lixbon_workspace_root'); // la carpeta ya no existe
    }
  },

  setAutoSave: (autoSave) => {
    localStorage.setItem('lixbon_auto_save', autoSave ? 'true' : 'false');
    setAutoSaveConfig(autoSave);
    set({ autoSave });
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

  /** Modelo de visión efectivo: el elegido, o autodetectado de la lista. */
  effectiveVisionModel: () => {
    const { visionModel, availableModels } = get();
    if (visionModel && availableModels.includes(visionModel)) return visionModel;
    return detectVisionModel(availableModels);
  },

  setLatency: (latency) => set({ latency }),

  logout: () => {
    saveSetting('apiKey', null);
    saveSetting('user', null);
    set({ user: null, apiKey: '' });
  },
}));
