// workbenchStore.js — distribución del IDE: modo activo (Agente, Editor,
// Diseño, Git), qué paneles están abiertos, sus tamaños y cuál tiene el foco.
import { create } from 'zustand';
import { isCompact } from '../lib/frameSize';

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

export const MODES = ['agent', 'editor', 'design', 'git', 'orch'];

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
// sideOpen/agentOpen). Todos tienen izquierdo y derecho: el derecho es el
// agente (en Agente son los cambios), siempre en el mismo sitio.
const DEFAULT_MODE_PANELS = {
  agent: { left: true, right: true },
  design: { left: true, right: true },
  git: { left: true, right: true },
  orch: { left: true, right: true, adeLeft: true, adeRight: true },
};

// Lo guardado se mezcla modo a modo: quien guardó { left } en Git antes de que
// existiera el panel derecho no se queda sin él.
const mergePanels = (saved) => Object.fromEntries(
  Object.entries(DEFAULT_MODE_PANELS).map(([mode, def]) => [mode, { ...def, ...(saved?.[mode] || {}) }]),
);

/** { left, right } del modo/vista activa; right = undefined si no tiene panel derecho. */
export const selectSidePanels = (s) => {
  if (s.mode === 'editor') return { left: s.sideOpen, right: s.agentOpen };
  const panels = s.modePanels[s.mode];
  if (s.mode === 'orch' && s.orchView === 'ade') {
    return { left: panels?.adeLeft ?? true, right: panels?.adeRight ?? true };
  }
  return panels;
};

/** El cajón del botón derecho es independiente entre Ejecuciones y ADE. */
export const selectRightDrawer = (s) => (s.mode === 'orch' && s.orchView === 'ade' ? s.adeDrawer : s.drawer);

const readOrchView = () => (read('lx_orch_view', 'executions') === 'ade' ? 'ade' : 'executions');

export const useWorkbenchStore = create((set, get) => ({
  mode: read('lx_mode', 'editor'),
  // Preferencia de presentación interna; nunca cambia las selecciones operativas.
  orchView: readOrchView(),
  adeDrawer: false,
  sideOpen: read('lx_side_open', true),
  sideView: read('lx_side_view', 'files'), // 'files' | 'search' | 'extensions'
  agentOpen: read('lx_agent_open', true),
  rightView: read('lx_right_view', 'agent'), // 'agent' | 'team'
  modePanels: mergePanels(read('lx_mode_panels', {})),
  sizes: { ...DEFAULT_SIZES, ...read('lx_sizes', {}) },
  // Panel con foco: se eleva un peldaño. No se persiste.
  focus: 'agent',
  // Buscador de la barra de título (icono ↔ campo abierto).
  searchOpen: false,
  // Texto que el panel de búsqueda recoge al montarse (viene de la barra superior).
  pendingSearch: '',
  // Ajustes: ventana centrada sobre el modo activo (page === 'settings').
  page: null,
  // Panel derecho como cajón cuando la ventana es estrecha (no se persiste).
  drawer: false,
  settingsSection: 'profile',

  dockTab: 'terminal', // 'terminal' | 'problems' | 'output'
  setDockTab: (dockTab) => set({ dockTab }),

  editor: { fontSize: 13, tabSize: 2, wordWrap: false, ...read('lx_editor', {}) },

  commitMsg: { engine: 'lixbon', lang: 'es', ...read('lx_commitmsg', {}) },

  design: { url: 'http://localhost:3000', device: 'mobile', landscape: false, zoom: 'fit', ...read('lx_design', {}) },

  openSettings: (section) => set({ page: 'settings', settingsSection: section || get().settingsSection }),
  closePage: () => set({ page: null }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),

  closeDrawer: () => set({ drawer: false }),
  toggleDrawer: () => set({ drawer: !get().drawer }),
  closeAdeDrawer: () => set({ adeDrawer: false }),
  toggleAdeDrawer: () => set({ adeDrawer: !get().adeDrawer }),

  setOrchView: (orchView) => {
    if (orchView !== 'executions' && orchView !== 'ade') return;
    write('lx_orch_view', orchView);
    set({ orchView });
  },

  setMode: (mode) => {
    if (!MODES.includes(mode)) return;
    write('lx_mode', mode);
    set({ page: null, drawer: false, adeDrawer: false, mode, focus: mode === 'agent' ? 'chat' : mode === 'design' ? 'canvas' : mode === 'git' ? 'diff' : mode === 'orch' ? 'orchmain' : get().focus });
  },

  setFocus: (focus) => { if (get().focus !== focus) set({ focus }); },

  toggleModePanel: (side) => {
    const { mode, modePanels, orchView } = get();
    if (side === 'right' && isCompact()) {
      if (mode === 'orch' && orchView === 'ade') get().toggleAdeDrawer();
      else get().toggleDrawer();
      return;
    }
    const cur = modePanels[mode];
    const key = mode === 'orch' && orchView === 'ade' ? `ade${side[0].toUpperCase()}${side.slice(1)}` : side;
    if (!cur || cur[key] === undefined) return;
    const next = { ...modePanels, [mode]: { ...cur, [key]: !cur[key] } };
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
    if (isCompact()) {
      if (get().mode === 'orch' && get().orchView === 'ade') get().toggleAdeDrawer();
      else get().toggleDrawer();
      return;
    }
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

  setCommitMsgOption: (key, value) => {
    const commitMsg = { ...get().commitMsg, [key]: value };
    write('lx_commitmsg', commitMsg);
    set({ commitMsg });
  },

  setDesign: (patch) => {
    const design = { ...get().design, ...patch };
    write('lx_design', design);
    set({ design });
  },
}));
