// workbenchStore.js — distribución del IDE: modo activo (Agente, Editor,
// Diseño, Git), qué paneles están abiertos, sus tamaños y cuál tiene el foco.
import { create } from 'zustand';

const read = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const write = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
};

export const MODES = ['agent', 'editor', 'design', 'git'];

export const SIZE_LIMITS = {
  side: [180, 480],
  agent: [320, 720],
  terminal: [110, 560],
  sessions: [200, 360],
  changes: [280, 560],
  inspector: [240, 420],
};

const DEFAULT_SIZES = { side: 240, agent: 400, terminal: 190, sessions: 248, changes: 360, inspector: 300 };

// Paneles laterales de los modos que no son el editor (el editor usa
// sideOpen/agentOpen). Git no tiene panel derecho.
const DEFAULT_MODE_PANELS = { agent: { left: true, right: true }, design: { left: true, right: true }, git: { left: true } };

/** { left, right } del modo activo; right = undefined si el modo no lo tiene. */
export const selectSidePanels = (s) => (s.mode === 'editor'
  ? { left: s.sideOpen, right: s.agentOpen }
  : s.modePanels[s.mode]);

export const useWorkbenchStore = create((set, get) => ({
  mode: read('lx_mode', 'editor'),
  sideOpen: read('lx_side_open', true),
  sideView: read('lx_side_view', 'files'), // 'files' | 'search' | 'extensions'
  agentOpen: read('lx_agent_open', true),
  rightView: read('lx_right_view', 'agent'), // 'agent' | 'team'
  modePanels: { ...DEFAULT_MODE_PANELS, ...read('lx_mode_panels', {}) },
  sizes: { ...DEFAULT_SIZES, ...read('lx_sizes', {}) },
  // Panel con foco: se eleva un peldaño. No se persiste.
  focus: 'agent',
  // Buscador de la barra de título (icono ↔ campo abierto).
  searchOpen: false,
  // Texto que el panel de búsqueda recoge al montarse (viene de la barra superior).
  pendingSearch: '',
  // Página a pantalla completa sobre los modos (hoy solo Ajustes).
  page: null,
  settingsSection: 'profile',

  dockTab: 'terminal', // 'terminal' | 'problems' | 'output'
  setDockTab: (dockTab) => set({ dockTab }),

  editor: { fontSize: 13, tabSize: 2, wordWrap: false, ...read('lx_editor', {}) },

  design: { url: 'http://localhost:3000', device: 'mobile', landscape: false, zoom: 'fit', ...read('lx_design', {}) },

  openSettings: (section) => set({ page: 'settings', settingsSection: section || get().settingsSection }),
  closePage: () => set({ page: null }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),

  setMode: (mode) => {
    if (!MODES.includes(mode)) return;
    write('lx_mode', mode);
    set({ page: null, mode, focus: mode === 'agent' ? 'chat' : mode === 'design' ? 'canvas' : mode === 'git' ? 'diff' : get().focus });
  },

  setFocus: (focus) => { if (get().focus !== focus) set({ focus }); },

  toggleModePanel: (side) => {
    const { mode, modePanels } = get();
    const cur = modePanels[mode];
    if (!cur || cur[side] === undefined) return;
    const next = { ...modePanels, [mode]: { ...cur, [side]: !cur[side] } };
    write('lx_mode_panels', next);
    set({ modePanels: next });
  },

  toggleSide: () => {
    if (get().mode !== 'editor') { get().toggleModePanel('left'); return; }
    const sideOpen = !get().sideOpen;
    write('lx_side_open', sideOpen);
    set({ sideOpen });
  },

  showSide: (view) => {
    write('lx_side_view', view);
    write('lx_side_open', true);
    set({ sideView: view, sideOpen: true, focus: 'side' });
  },

  setRightView: (rightView) => {
    write('lx_right_view', rightView);
    write('lx_agent_open', true);
    set({ rightView, agentOpen: true, focus: 'agent' });
  },

  toggleAgent: () => {
    if (get().mode !== 'editor') { get().toggleModePanel('right'); return; }
    const agentOpen = !get().agentOpen;
    write('lx_agent_open', agentOpen);
    set({ agentOpen, focus: agentOpen ? 'agent' : get().focus });
  },

  setSize: (key, value) => {
    const [min, max] = SIZE_LIMITS[key] || [0, 4000];
    const sizes = { ...get().sizes, [key]: Math.round(Math.min(max, Math.max(min, value))) };
    set({ sizes });
  },
  persistSizes: () => write('lx_sizes', get().sizes),

  setSearchOpen: (searchOpen) => set({ searchOpen }),
  searchInProject: (text) => {
    set({ pendingSearch: text });
    get().setMode('editor');
    get().showSide('search');
  },
  takePendingSearch: () => {
    const text = get().pendingSearch;
    if (text) set({ pendingSearch: '' });
    return text;
  },

  setEditorOption: (key, value) => {
    const editor = { ...get().editor, [key]: value };
    write('lx_editor', editor);
    set({ editor });
  },

  setDesign: (patch) => {
    const design = { ...get().design, ...patch };
    write('lx_design', design);
    set({ design });
  },
}));
