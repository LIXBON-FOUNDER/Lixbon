import { create } from 'zustand';
import { loadSettings, saveSetting, DEFAULT_SERVER_URL } from '../lib/settings';

export const useAppStore = create((set, get) => ({
  // Config persistida en plugin-store; se llena en hydrate()
  hydrated: false,
  serverUrl: DEFAULT_SERVER_URL,
  apiKey: '',
  user: null,

  editorFontSize: parseInt(
    localStorage.getItem('folax_editor_font_size') ||
    localStorage.getItem('folax_terminal_font_size') || '14',
    10
  ),
  connectionStatus: 'disconnected', // 'connected' | 'disconnected' | 'connecting'

  // Layout del IDE
  centerView: 'editor', // 'editor' | 'metrics' | 'settings'
  panels: JSON.parse(localStorage.getItem('folax_panels') || '{"explorer":true,"chat":true}'),
  panelWidths: JSON.parse(localStorage.getItem('folax_panel_widths') || '{"explorer":260,"chat":360}'),

  currentModel: localStorage.getItem('folax_current_model') || '',
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
    localStorage.setItem('folax_panels', JSON.stringify(panels));
    set({ panels });
  },

  setPanelWidth: (name, width) => {
    const panelWidths = { ...get().panelWidths, [name]: width };
    localStorage.setItem('folax_panel_widths', JSON.stringify(panelWidths));
    set({ panelWidths });
  },


  setServerUrl: (url) => {
    const normalized = url.trim().replace(/\/+$/, '');
    saveSetting('serverUrl', normalized);
    set({ serverUrl: normalized });
  },

  setEditorFontSize: (size) => {
    localStorage.setItem('folax_editor_font_size', size.toString());
    set({ editorFontSize: size });
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
    localStorage.setItem('folax_current_model', model);
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
