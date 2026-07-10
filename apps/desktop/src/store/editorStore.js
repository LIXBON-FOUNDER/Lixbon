// editorStore.js — pestañas del editor CodeMirror.
// Patrón: una única EditorView viva (registrada por CodeMirrorHost) y un
// EditorState por pestaña cacheado fuera de React (undo/scroll/selección
// sobreviven al cambio de pestaña sin re-crear el DOM del editor).

import { create } from 'zustand';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { indentUnit } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import { ask } from '@tauri-apps/plugin-dialog';

import { readFileContent, writeFileContent } from '../lib/tauri';
import { lixbonTheme, lixbonSyntax, lixbonThemeDark, lixbonSyntaxDark } from '../editor/lixbonTheme';
import { languageFor } from '../editor/languages';

// ── Registro fuera de React ────────────────────────────────────────────
const stateCache = new Map(); // path -> EditorState
let liveView = null;

// Ajustes de indentación (los fija appStore vía setIndentConfig). Un compartment
// por EditorState permite reconfigurar el tabulador en vivo sin recrear la vista.
let indentConfig = { tabSize: 2, insertSpaces: true };
const indentCompartment = new Compartment();

// Tema del editor: lixbon (claro u oscuro según el modo de la app) por
// defecto, o un tema de VSCode instalado (extStore lo cambia vía
// setEditorThemeExts). El modo vive en <html data-theme> (lib/theme.js).
const themeCompartment = new Compartment();

function defaultThemeExts() {
  return document.documentElement.dataset.theme === 'dark'
    ? [lixbonThemeDark, lixbonSyntaxDark]
    : [lixbonTheme, lixbonSyntax];
}

let themeExts = defaultThemeExts();

/** exts = null vuelve al tema lixbon del modo actual. Reconfigura la vista
    viva y las cacheadas. */
export function setEditorThemeExts(exts) {
  themeExts = exts && exts.length ? exts : defaultThemeExts();
  if (liveView) {
    liveView.dispatch({ effects: themeCompartment.reconfigure(themeExts) });
  }
  for (const [path, state] of stateCache) {
    if (liveView && state === liveView.state) continue; // la viva ya está
    stateCache.set(
      path,
      state.update({ effects: themeCompartment.reconfigure(themeExts) }).state,
    );
  }
}

function indentExtension() {
  const unit = indentConfig.insertSpaces ? ' '.repeat(indentConfig.tabSize) : '\t';
  return [EditorState.tabSize.of(indentConfig.tabSize), indentUnit.of(unit)];
}

/** appStore llama a esto al cambiar tamaño de tab / espacios; reconfigura la vista viva. */
export function setIndentConfig(tabSize, insertSpaces) {
  indentConfig = { tabSize, insertSpaces };
  if (liveView) {
    liveView.dispatch({ effects: indentCompartment.reconfigure(indentExtension()) });
  }
}

export function registerEditorView(view) {
  liveView = view;
}

export function getLiveView() {
  return liveView;
}

// ── Autoguardado ───────────────────────────────────────────────────────
// Debounce único: 1 s después del último cambio se guardan todas las
// pestañas sucias (solo la activa puede ensuciarse, pero saveAll es barato).
const AUTOSAVE_MS = 1000;
let autoSaveEnabled = true;
let autoSaveTimer = null;

/** appStore fija esto al arrancar y cuando el usuario cambia el ajuste. */
export function setAutoSaveConfig(enabled) {
  autoSaveEnabled = enabled;
  if (enabled) {
    useEditorStore.getState().saveAll(true);
  } else if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
}

export function getCachedState(path) {
  return stateCache.get(path);
}

export function cacheState(path, state) {
  stateCache.set(path, state);
}

// ── Store ──────────────────────────────────────────────────────────────
export const useEditorStore = create((set, get) => ({
  tabs: [], // [{ path, name, dirty }]
  activePath: null,

  openFile: async (path, name) => {
    const { tabs } = get();
    if (tabs.some((t) => t.path === path)) {
      set({ activePath: path });
      return;
    }

    const content = await readFileContent(path); // el llamador maneja el error

    const markDirty = EditorView.updateListener.of((update) => {
      if (update.docChanged) get().markDirty(path);
    });

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        indentCompartment.of(indentExtension()),
        keymap.of([
          indentWithTab,
          { key: 'Mod-s', run: () => { get().saveActive(); return true; } },
        ]),
        themeCompartment.of(themeExts),
        ...languageFor(name),
        markDirty,
      ],
    });

    stateCache.set(path, state);
    set({ tabs: [...tabs, { path, name, dirty: false }], activePath: path });
  },

  markDirty: (path) => {
    const { tabs } = get();
    if (tabs.find((t) => t.path === path && !t.dirty)) {
      set({ tabs: tabs.map((t) => (t.path === path ? { ...t, dirty: true } : t)) });
    }
    if (autoSaveEnabled) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => get().saveAll(true), AUTOSAVE_MS);
    }
  },

  setActive: (path) => set({ activePath: path }),

  /** Abre un archivo y coloca el cursor en `line` (búsqueda global / Quick Open). */
  openFileAtLine: async (path, name, line) => {
    await get().openFile(path, name);
    // La vista monta el estado en el próximo frame (CodeMirrorHost)
    requestAnimationFrame(() => {
      if (!liveView || get().activePath !== path) return;
      const doc = liveView.state.doc;
      const ln = Math.min(Math.max(1, line), doc.lines);
      const pos = doc.line(ln).from;
      liveView.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      liveView.focus();
    });
  },

  /** Guarda una pestaña (la activa desde la vista viva; el resto desde el caché).
      Con silent=true (autoguardado) los errores van a consola, no a un alert. */
  saveTab: async (path, silent = false) => {
    const { activePath } = get();
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab || !tab.dirty) return;

    const isActive = path === activePath && liveView;
    const state = isActive ? liveView.state : stateCache.get(path);
    if (!state) return;

    const savedDoc = state.doc;
    try {
      await writeFileContent(path, savedDoc.toString());
      if (isActive) stateCache.set(path, liveView.state);
      // Si el usuario siguió tecleando durante la escritura, sigue sucia.
      const unchanged = !isActive || liveView.state.doc === savedDoc || liveView.state.doc.eq(savedDoc);
      if (unchanged) {
        set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, dirty: false } : t)) });
      }
    } catch (e) {
      if (silent) console.error('[editor] Autoguardado falló:', path, e);
      else alert('Error guardando el archivo: ' + e);
    }
  },

  saveActive: async () => {
    const { activePath } = get();
    if (activePath) await get().saveTab(activePath);
  },

  saveAll: async (silent = false) => {
    const dirty = get().tabs.filter((t) => t.dirty);
    for (const t of dirty) await get().saveTab(t.path, silent);
  },

  /** Tras renombrar en disco (archivo o carpeta): remapea pestañas y caché. */
  remapPaths: (oldPath, newPath) => {
    const mapPath = (p) => {
      if (p === oldPath) return newPath;
      if (p.startsWith(oldPath + '\\') || p.startsWith(oldPath + '/')) {
        return newPath + p.slice(oldPath.length);
      }
      return null;
    };
    const { tabs, activePath } = get();
    for (const t of tabs) {
      const next = mapPath(t.path);
      if (next && stateCache.has(t.path)) {
        stateCache.set(next, stateCache.get(t.path));
        stateCache.delete(t.path);
      }
    }
    set({
      tabs: tabs.map((t) => {
        const next = mapPath(t.path);
        if (!next) return t;
        return { ...t, path: next, name: next.split(/[\\/]/).pop() || t.name };
      }),
      activePath: activePath ? (mapPath(activePath) || activePath) : activePath,
    });
  },

  /** Cierra sin preguntar las pestañas en `path` o debajo (tras eliminar en disco). */
  closeUnder: (path) => {
    const isUnder = (p) =>
      p === path || p.startsWith(path + '\\') || p.startsWith(path + '/');
    const { tabs, activePath } = get();
    const remaining = tabs.filter((t) => !isUnder(t.path));
    if (remaining.length === tabs.length) return;
    for (const t of tabs) if (isUnder(t.path)) stateCache.delete(t.path);
    const nextActive = remaining.some((t) => t.path === activePath)
      ? activePath
      : (remaining[remaining.length - 1]?.path ?? null);
    set({ tabs: remaining, activePath: nextActive });
  },

  closeTab: async (path) => {
    const { tabs, activePath } = get();
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return;

    if (tab.dirty) {
      const discard = await ask(
        `${tab.name} tiene cambios sin guardar. ¿Cerrar de todos modos?`,
        { title: 'lixbon', kind: 'warning', okLabel: 'Cerrar sin guardar', cancelLabel: 'Cancelar' }
      );
      if (!discard) return;
    }

    stateCache.delete(path);
    const remaining = tabs.filter((t) => t.path !== path);
    const nextActive =
      activePath === path
        ? (remaining[remaining.length - 1]?.path ?? null)
        : activePath;
    set({ tabs: remaining, activePath: nextActive });
  },

  cycleTab: (dir = 1) => {
    const { tabs, activePath } = get();
    if (tabs.length < 2) return;
    const idx = tabs.findIndex((t) => t.path === activePath);
    const next = tabs[(idx + dir + tabs.length) % tabs.length];
    set({ activePath: next.path });
  },

  /** Inserta texto en la posición del cursor del editor activo (lo usa el chat). */
  insertAtCursor: (text) => {
    const { activePath } = get();
    if (!activePath || !liveView) return false;
    liveView.dispatch(liveView.state.replaceSelection(text));
    liveView.focus();
    return true;
  },

  /** Contenido y selección del editor activo (contexto para el chat). */
  getActiveContext: () => {
    const { activePath, tabs } = get();
    if (!activePath || !liveView) return null;
    const tab = tabs.find((t) => t.path === activePath);
    const sel = liveView.state.selection.main;
    return {
      path: activePath,
      name: tab?.name ?? activePath,
      content: liveView.state.doc.toString(),
      selection: sel.empty ? '' : liveView.state.sliceDoc(sel.from, sel.to),
    };
  },
}));
