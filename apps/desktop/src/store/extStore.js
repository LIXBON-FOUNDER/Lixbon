// extStore.js — extensiones de VSCode (soporte declarativo, vía Open VSX).
// El .vsix lo descarga y desempaqueta Rust (ext_install), que devuelve un
// manifest con TODO lo declarativo: temas de color, gramáticas TextMate,
// snippets, temas de iconos y lenguajes. Aquí vive la lista de instaladas
// (localStorage), el tema de color activo y el tema de iconos activo.
import { create } from 'zustand';
import { extSearch, extInstall, extUninstall, extReadTheme } from '../lib/tauri';
import { setEditorThemeExts } from './editorStore';
import { buildVsCodeTheme, appColorsFromTheme } from '../editor/vsTheme';

const INSTALLED_KEY = 'lixbon_extensions';
const THEME_KEY = 'lixbon_editor_theme';
const ICON_KEY = 'lixbon_icon_theme';

// Tokens del shell que un tema puede sobreescribir (base.css los define).
const APP_COLOR_KEYS = ['--bg', '--bg-secondary', '--ink', '--ink-soft', '--border', '--border-soft'];

/** Aplica (o retira, con null) los colores de workbench del tema a toda la app. */
function setAppColors(map) {
  const root = document.documentElement.style;
  for (const key of APP_COLOR_KEYS) {
    if (map && map[key]) root.setProperty(key, map[key]);
    else root.removeProperty(key);
  }
}

/** Convierte y aplica un tema completo (editor + shell). */
function applyThemeJson(themeJson, dark) {
  setEditorThemeExts(buildVsCodeTheme(themeJson, dark));
  setAppColors(appColorsFromTheme(themeJson, dark));
}

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export const useExtStore = create((set, get) => ({
  // Manifests de instaladas. Las instalaciones previas a la v0.6 solo traen
  // {id, display_name, themes}; el resto de campos se tratan como [] al leer.
  installed: readJson(INSTALLED_KEY, []),
  activeTheme: readJson(THEME_KEY, null), // {extId, label, file, dark} | null
  activeIconTheme: readJson(ICON_KEY, null), // {extId, id, label, path} | null
  results: [],
  searching: false,
  installing: null, // id de la extensión en descarga
  error: '',

  search: async (query) => {
    const q = query.trim();
    if (!q) {
      set({ results: [], error: '' });
      return;
    }
    set({ searching: true, error: '' });
    try {
      const body = JSON.parse(await extSearch(q));
      set({ results: body.extensions || [], searching: false });
    } catch (e) {
      set({ searching: false, results: [], error: String(e) });
    }
  },

  install: async (result) => {
    const id = `${result.namespace}.${result.name}`;
    const url = result.files?.download;
    if (!url) {
      set({ error: 'La extensión no tiene archivo de descarga.' });
      return;
    }
    set({ installing: id, error: '' });
    try {
      const info = await extInstall(url, id);
      const installed = [...get().installed.filter((e) => e.id !== info.id), info];
      localStorage.setItem(INSTALLED_KEY, JSON.stringify(installed));
      set({ installed, installing: null });
    } catch (e) {
      set({ installing: null, error: String(e) });
    }
  },

  uninstall: async (id) => {
    try {
      await extUninstall(id);
    } catch {
      /* la carpeta ya no existía */
    }
    const installed = get().installed.filter((e) => e.id !== id);
    localStorage.setItem(INSTALLED_KEY, JSON.stringify(installed));
    if (get().activeTheme?.extId === id) get().resetTheme();
    if (get().activeIconTheme?.extId === id) get().resetIconTheme();
    set({ installed });
  },

  applyIconTheme: (extId, iconTheme) => {
    const sel = { extId, id: iconTheme.id, label: iconTheme.label, path: iconTheme.path };
    localStorage.setItem(ICON_KEY, JSON.stringify(sel));
    set({ activeIconTheme: sel });
  },

  resetIconTheme: () => {
    localStorage.removeItem(ICON_KEY);
    set({ activeIconTheme: null });
  },

  applyTheme: async (extId, theme) => {
    try {
      const raw = await extReadTheme(extId, theme.file);
      applyThemeJson(JSON.parse(raw), theme.dark);
      const sel = { extId, label: theme.label, file: theme.file, dark: theme.dark };
      localStorage.setItem(THEME_KEY, JSON.stringify(sel));
      set({ activeTheme: sel, error: '' });
    } catch (e) {
      set({ error: 'No se pudo aplicar el tema: ' + e });
    }
  },

  resetTheme: () => {
    setEditorThemeExts(null);
    setAppColors(null);
    localStorage.removeItem(THEME_KEY);
    set({ activeTheme: null });
  },

  /** Al arrancar: re-aplica el tema persistido (si su archivo sigue ahí). */
  hydrateTheme: async () => {
    const sel = get().activeTheme;
    if (!sel) return;
    try {
      const raw = await extReadTheme(sel.extId, sel.file);
      applyThemeJson(JSON.parse(raw), sel.dark);
    } catch {
      get().resetTheme();
    }
  },
}));

// ── Selectores derivados (para el editor: gramáticas, snippets, lenguajes) ──

/** Todas las gramáticas TextMate instaladas: [{extId, scopeName, language, path, embedded}] */
export function installedGrammars() {
  return useExtStore.getState().installed.flatMap((e) =>
    (e.grammars || []).map((g) => ({ extId: e.id, scopeName: g.scope_name, language: g.language, path: g.path, embedded: g.embedded })),
  );
}

/** Declaraciones de lenguaje aportadas por extensiones:
    [{extId, id, extensions: ['.ex'], filenames, aliases}] */
export function installedLanguages() {
  return useExtStore.getState().installed.flatMap((e) =>
    (e.languages || []).map((l) => ({ extId: e.id, ...l })),
  );
}

/** Snippets instalados agrupados por id de lenguaje VSCode: {lang: [{extId, path}]} */
export function installedSnippets() {
  const byLang = {};
  for (const e of useExtStore.getState().installed) {
    for (const s of e.snippets || []) {
      (byLang[s.language] ||= []).push({ extId: e.id, path: s.path });
    }
  }
  return byLang;
}
