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
import { lixbonTheme, lixbonSyntax } from '../editor/lixbonTheme';
import { languageFor } from '../editor/languages';

// ── Registro fuera de React ────────────────────────────────────────────
const stateCache = new Map(); // path -> EditorState
let liveView = null;

// Ajustes de indentación (los fija appStore vía setIndentConfig). Un compartment
// por EditorState permite reconfigurar el tabulador en vivo sin recrear la vista.
let indentConfig = { tabSize: 2, insertSpaces: true };
const indentCompartment = new Compartment();

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
        lixbonTheme,
        lixbonSyntax,
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
  },

  setActive: (path) => set({ activePath: path }),

  saveActive: async () => {
    const { activePath, tabs } = get();
    if (!activePath || !liveView) return;
    try {
      await writeFileContent(activePath, liveView.state.doc.toString());
      stateCache.set(activePath, liveView.state);
      set({ tabs: tabs.map((t) => (t.path === activePath ? { ...t, dirty: false } : t)) });
    } catch (e) {
      alert('Error guardando el archivo: ' + e);
    }
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
