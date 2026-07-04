import { create } from 'zustand';

export const useAppStore = create((set, get) => ({
  serverUrl: localStorage.getItem('folax_server_url') || '',
  theme: localStorage.getItem('folax_theme') || 'dark',
  accentColor: localStorage.getItem('folax_accent_color') || '#7c3aed',
  terminalFontSize: parseInt(localStorage.getItem('folax_terminal_font_size') || '14', 10),
  terminalFontFamily: localStorage.getItem('folax_terminal_font_family') || 'JetBrains Mono',
  
  user: JSON.parse(localStorage.getItem('folax_user') || 'null'),
  apiKey: localStorage.getItem('folax_api_key') || '',
  connectionStatus: 'disconnected', // 'connected' | 'disconnected' | 'connecting'
  activeSection: 'terminal', // 'terminal' | 'metrics' | 'services' | 'commands' | 'settings'
  
  currentModel: localStorage.getItem('folax_current_model') || '',
  availableModels: [],
  latency: 0,
  messages: JSON.parse(localStorage.getItem('folax_chat_messages') || 'null') || [
    { role: 'system', content: 'Welcome to the Interactive CLI for FOLAX DTC. (TUI Mode)\nType /help to view the full list of available commands.', type: 'welcome' }
  ],
  
  // UI States para Layout OpenCode-like
  isWorkspaceVisible: localStorage.getItem('folax_workspace_visible') === 'true' || false,
  activeFile: null, // { path, name, content }

  // Acciones
  toggleWorkspace: () => {
    const newVal = !get().isWorkspaceVisible;
    localStorage.setItem('folax_workspace_visible', newVal.toString());
    set({ isWorkspaceVisible: newVal });
  },

  setActiveFile: (file) => set({ activeFile: file }),

  setMessages: (messages) => {
    localStorage.setItem('folax_chat_messages', JSON.stringify(messages));
    set({ messages });
  },
  
  addMessage: (msg) => {
    const updated = [...get().messages, msg];
    localStorage.setItem('folax_chat_messages', JSON.stringify(updated));
    set({ messages: updated });
  },

  setServerUrl: (url) => {
    // Normalizar URL (quitar barra al final)
    const normalized = url.trim().replace(/\/+$/, '');
    localStorage.setItem('folax_server_url', normalized);
    set({ serverUrl: normalized });
  },
  
  setTheme: (theme) => {
    localStorage.setItem('folax_theme', theme);
    set({ theme });
  },
  
  setAccentColor: (color) => {
    localStorage.setItem('folax_accent_color', color);
    set({ accentColor: color });
  },
  
  setTerminalFontSize: (size) => {
    localStorage.setItem('folax_terminal_font_size', size.toString());
    set({ terminalFontSize: size });
  },

  setTerminalFontFamily: (family) => {
    localStorage.setItem('folax_terminal_font_family', family);
    set({ terminalFontFamily: family });
  },
  
  setUser: (user) => {
    localStorage.setItem('folax_user', JSON.stringify(user));
    set({ user });
  },
  
  setApiKey: (apiKey) => {
    localStorage.setItem('folax_api_key', apiKey);
    set({ apiKey });
  },
  
  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  
  setActiveSection: (activeSection) => set({ activeSection }),
  
  setCurrentModel: (model) => {
    localStorage.setItem('folax_current_model', model);
    set({ currentModel: model });
  },
  
  setAvailableModels: (availableModels) => set({ availableModels }),
  setLatency: (latency) => set({ latency }),
  
  logout: () => {
    localStorage.removeItem('folax_api_key');
    localStorage.removeItem('folax_user');
    set({ user: null, apiKey: '' });
  }
}));
