import { create } from 'zustand';
import { loadSettings, saveSetting, DEFAULT_SERVER_URL } from '../lib/settings';
import { setWorkspaceRoot } from '../lib/tauri';
import { useGitStore } from './gitStore';
import { modelId } from '../lib/vision';
import { fetchModelRoles, normalizeModel } from '../lib/modelRoles';
import { fetchMe } from '../lib/account';
import { useWorkbenchStore } from './workbenchStore';

// Si el catálogo aún no llegó: la que usaba el IDE antes (solo para medir).
const DEFAULT_CONTEXT_WINDOW = 8192;

function catalogEntry(catalog, model) {
  const want = normalizeModel(model);
  return want ? (catalog || []).find((m) => typeof m === 'object' && normalizeModel(modelId(m)) === want) : null;
}

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
  // Ventana de contexto, visión, embeddings y tool-calling los decide lixbon
  // (gateway y catálogo), no el usuario: ver effective*() más abajo.
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
      // El perfil persistido lleva el plan de cuando se inició sesión: se
      // relee siempre (también repara la sesión sin perfil guardado) sin
      // bloquear el arranque.
      if (apiKey) get().refreshUser();
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

  refreshUser: async () => {
    const { serverUrl, apiKey } = get();
    if (!apiKey) return;
    try {
      get().setUser(await fetchMe(serverUrl, apiKey));
    } catch { /* sesión inválida o sin red: se verá al primer request real */ }
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

  /** ¿El modelo ve imágenes? Solo se descarta si el catálogo dice que no;
      sin datos se le mandan igual (los modelos que usamos son multimodales). */
  supportsImages: (model = get().currentModel) => {
    const caps = catalogEntry(get().availableModels, model)?.capabilities;
    return !Array.isArray(caps) || caps.length === 0 || caps.includes('vision');
  },

  /** Ventana de contexto del modelo actual: la que el gateway le aplica
      (`num_ctx` de /v1/models, fijado por nosotros por modelo o rol). El IDE no
      la pide: solo la usa para medir y podar el historial. */
  effectiveContextWindow: (model = get().currentModel) => {
    const entry = catalogEntry(get().availableModels, model);
    const n = Number(entry?.num_ctx || entry?.context_length);
    return n > 0 ? n : DEFAULT_CONTEXT_WINDOW;
  },

  /** Tool-calling nativo solo si el modelo declara la capacidad «tools»; si no
      se sabe, el protocolo de texto, que funciona con cualquiera. */
  supportsNativeTools: (model = get().currentModel) => {
    const caps = catalogEntry(get().availableModels, model)?.capabilities;
    return Array.isArray(caps) && caps.includes('tools');
  },

  setLatency: (latency) => set({ latency }),

  logout: () => {
    saveSetting('apiKey', null);
    saveSetting('user', null);
    set({ user: null, apiKey: '' });
  },
}));
