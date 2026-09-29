import { create } from 'zustand';
import { loadSettings, saveSetting, DEFAULT_SERVER_URL } from '../lib/settings';
import { setWorkspaceRoot } from '../lib/tauri';
import { useGitStore } from './gitStore';
import { detectVisionModel, modelId } from '../lib/vision';
import { fetchModelRoles, roleModel } from '../lib/modelRoles';
import { resetIndexCache } from '../lib/codebaseIndex';
import { fetchMe } from '../lib/account';
import { useWorkbenchStore } from './workbenchStore';

export const useAppStore = create((set, get) => ({
  // Config persistida en plugin-store; se llena en hydrate()
  hydrated: false,
  serverUrl: DEFAULT_SERVER_URL,
  apiKey: '',
  user: null,

  connectionStatus: 'disconnected', // 'connected' | 'disconnected' | 'connecting'

  // Carpeta de trabajo (canónica). '' = sin carpeta abierta.
  workspaceRoot: '',
  // true cuando restoreWorkspace ya terminó (con carpeta o sin ella). El
  // terminal no debe abrir su PTY antes: heredaría el cwd equivocado.
  workspaceReady: false,
  // Carpetas abiertas recientemente (para la pantalla de bienvenida, D4).
  recentFolders: JSON.parse(localStorage.getItem('lixbon_recents') || '[]'),

  diffData: null, // { title, patch } para el visor de diff (Git)
  // Ventana flotante: null | 'settings' | 'remote' | 'diff'.
  modalView: null,
  modalSection: null, // categoría inicial de Ajustes (null = la última/por defecto)
  quickOpen: false, // overlay Ctrl+P (ir a archivo)
  commandPalette: false, // overlay Ctrl+Mayús+P
  panels: JSON.parse(localStorage.getItem('lixbon_panels') || '{"terminal":false}'),
  panelHeights: JSON.parse(localStorage.getItem('lixbon_panel_heights') || '{"terminal":240}'),

  currentModel: (localStorage.getItem('lixbon_current_model') || '').replace(/^error:.*/, ''),
  // Modelo de visión (sub-agente que describe imágenes para el modelo de texto).
  // '' = autodetectar de los modelos disponibles.
  visionModel: localStorage.getItem('lixbon_vision_model') || '',
  // Modelo de embeddings para el índice del codebase (B3). '' = autodetectar.
  embedModel: localStorage.getItem('lixbon_embed_model') || '',
  // Inyectar contexto relevante del codebase (RAG) en el chat automáticamente.
  useCodebaseContext: (localStorage.getItem('lixbon_rag') ?? 'false') === 'true',
  // Ventana de contexto (num_ctx) que se pide a Ollama. Ollama usa 4096 por
  // defecto aunque el modelo soporte más; subirla evita truncar. Más = más VRAM.
  contextWindow: parseInt(localStorage.getItem('lixbon_context_window') || '8192', 10),
  availableModels: [],
  // Mapa rol→modelo que resuelve el gateway (GET /api/model-roles).
  // NO se persiste: es verdad del servidor, y cachearla haría que el IDE
  // siguiera creyendo en un modelo que el admin ya reasignó. null = todavía no
  // se sabe (o gateway antiguo sin el endpoint) ⇒ se usan los heurísticos.
  modelRoles: null,
  latency: 0,


  // Acciones
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const { serverUrl, apiKey, user } = await loadSettings();
      set({ serverUrl, apiKey, user, hydrated: true });
      // La sesión (apiKey) y el perfil (user) se guardan por separado: si uno
      // quedó sin el otro (login viejo, borrado parcial…), el sidebar se
      // queda sin tarjeta de cuenta aunque la app arranque bien. Se repara
      // solo, sin bloquear el arranque.
      if (apiKey && !user) {
        fetchMe(serverUrl, apiKey)
          .then((fresh) => { get().setUser(fresh); })
          .catch(() => {}); // sesión inválida: se verá al primer request real
      }
    } catch (e) {
      console.error('[store] Error hidratando configuración:', e);
      set({ hydrated: true }); // no bloquear la app: quedará en pantalla de auth
    }
  },

  /** Abre el visor de diff como ventana flotante con un patch unified. */
  openDiff: (title, patch, meta = null) => set({ diffData: { title, patch, meta }, modalView: 'diff', modalSection: null }),

  /** Ventana flotante (Ajustes / Consumo / Diff / Control remoto).
      `section` abre Ajustes directamente en esa categoría. */
  openModal: (modalView, section = null) => {
    if (modalView === 'settings') {
      const legacy = { account: 'profile', appearance: 'editor', index: 'editor', advanced: 'editor' };
      useWorkbenchStore.getState().openSettings(legacy[section] || section);
      return;
    }
    set({ modalView, modalSection: section });
  },
  closeModal: () => set({ modalView: null, modalSection: null }),

  /** Muestra u oculta la Terminal (único panel del dock inferior). */
  toggleTerminal: () => get().togglePanel('terminal'),
  showTerminal: () => { if (!get().panels.terminal) get().togglePanel('terminal'); },

  /** Nombres heredados de la navegación (chat/explorer/git/extensions)
      traducidos a los modos y paneles del workbench. */
  selectNav: (view) => {
    const wb = useWorkbenchStore.getState();
    if (view === 'chat') wb.setMode('agent');
    else if (view === 'git') wb.setMode('git');
    else {
      wb.setMode('editor');
      wb.showSide(view === 'extensions' ? 'extensions' : view === 'search' ? 'search' : 'files');
    }
  },

  toggleSidebar: () => useWorkbenchStore.getState().toggleSide(),

  setQuickOpen: (quickOpen) => set({ quickOpen }),

  setCommandPalette: (commandPalette) => set({ commandPalette }),

  /** Fija la carpeta de trabajo (sandbox Rust incluido) y refresca Git.
      Devuelve la ruta canónica. */
  openWorkspace: async (path) => {
    const canonical = await setWorkspaceRoot(path);
    localStorage.setItem('lixbon_workspace_root', canonical);
    const recents = [canonical, ...get().recentFolders.filter((p) => p !== canonical)].slice(0, 8);
    localStorage.setItem('lixbon_recents', JSON.stringify(recents));
    set({ workspaceRoot: canonical, recentFolders: recents });
    resetIndexCache(); // el índice RAG es por-workspace
    useGitStore.getState().refresh();
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

  togglePanel: (name) => {
    const panels = { ...get().panels, [name]: !get().panels[name] };
    localStorage.setItem('lixbon_panels', JSON.stringify(panels));
    set({ panels });
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

  setModelRoles: (modelRoles) => set({ modelRoles }),

  /** Carga el mapa rol→modelo del gateway. Silencioso: si no está disponible
      queda en null y cada effective*Model() cae a su heurístico. */
  loadModelRoles: async () => {
    const roles = await fetchModelRoles();
    if (roles) set({ modelRoles: roles });
    return roles;
  },

  setVisionModel: (model) => {
    localStorage.setItem('lixbon_vision_model', model || '');
    set({ visionModel: model || '' });
  },

  setEmbedModel: (model) => {
    localStorage.setItem('lixbon_embed_model', model || '');
    set({ embedModel: model || '' });
  },

  setUseCodebaseContext: (v) => {
    localStorage.setItem('lixbon_rag', v ? 'true' : 'false');
    set({ useCodebaseContext: v });
  },

  /** Modelo de embeddings: el elegido a mano, el del rol `embed`, o heurístico. */
  effectiveEmbedModel: () => {
    const { embedModel, availableModels, modelRoles } = get();
    const ids = availableModels.map(modelId);
    if (embedModel && ids.includes(embedModel)) return embedModel;
    if (modelRoles) return roleModel(modelRoles, 'embed');
    return ids.find((id) => /embed/i.test(id)) || '';
  },

  setContextWindow: (n) => {
    const v = Math.max(2048, Math.min(131072, parseInt(n, 10) || 8192));
    localStorage.setItem('lixbon_context_window', String(v));
    set({ contextWindow: v });
  },

  /** Modelo de visión efectivo: el elegido a mano, el del rol `vision`, o
      autodetectado de la lista (por capability, y solo si no, por nombre).
      availableModels trae objetos {id,…}, no strings — normalizar con modelId. */
  effectiveVisionModel: () => {
    const { visionModel, availableModels, modelRoles } = get();
    const ids = availableModels.map(modelId);
    if (visionModel && ids.includes(visionModel)) return visionModel;
    if (modelRoles) return roleModel(modelRoles, 'vision');
    return detectVisionModel(availableModels);
  },

  setLatency: (latency) => set({ latency }),

  logout: () => {
    saveSetting('apiKey', null);
    saveSetting('user', null);
    set({ user: null, apiKey: '' });
  },
}));
