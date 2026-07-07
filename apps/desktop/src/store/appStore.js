import { create } from 'zustand';
import { loadSettings, saveSetting, DEFAULT_SERVER_URL } from '../lib/settings';
import { setIndentConfig } from './editorStore';

// Aplica los ajustes de indentación persistidos al arrancar (antes de abrir archivos).
setIndentConfig(
  parseInt(localStorage.getItem('lixbon_tab_size') || '2', 10),
  (localStorage.getItem('lixbon_insert_spaces') ?? 'true') === 'true',
);

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
  connectionStatus: 'disconnected', // 'connected' | 'disconnected' | 'connecting'

  // Layout del IDE
  centerView: 'editor', // 'editor' | 'metrics' | 'settings' | 'git'
  panels: JSON.parse(localStorage.getItem('lixbon_panels') || '{"explorer":true,"chat":true,"terminal":false}'),
  panelWidths: JSON.parse(localStorage.getItem('lixbon_panel_widths') || '{"explorer":260,"chat":360}'),
  panelHeights: JSON.parse(localStorage.getItem('lixbon_panel_heights') || '{"terminal":240}'),

  currentModel: localStorage.getItem('lixbon_current_model') || '',
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
  setLatency: (latency) => set({ latency }),

  logout: () => {
    saveSetting('apiKey', null);
    saveSetting('user', null);
    set({ user: null, apiKey: '' });
  },
}));
