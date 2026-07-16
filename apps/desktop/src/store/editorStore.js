// editorStore.js — pestañas del editor CodeMirror.
// Patrón: una única EditorView viva (registrada por CodeMirrorHost) y un
// EditorState por pestaña cacheado fuera de React (undo/scroll/selección
// sobreviven al cambio de pestaña sin re-crear el DOM del editor).

import { create } from 'zustand';
import { EditorState, EditorSelection, Compartment, countColumn } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { indentUnit } from '@codemirror/language';
import { indentMore, indentLess } from '@codemirror/commands';
import { unifiedMergeView } from '@codemirror/merge';
import { ask } from '@tauri-apps/plugin-dialog';

import { readFileContent, writeFileContent, statFile } from '../lib/tauri';
import { lixbonTheme, lixbonSyntax, lixbonThemeDark, lixbonSyntaxDark } from '../editor/lixbonTheme';
import { resolveLanguage } from '../editor/languages';
import { snippetSource } from '../editor/snippets';
import { ghostText as ghostTextExt } from '../editor/ghostText';
import { lintExtension, applyDiagnostics } from '../editor/lintExt';
import { lspExtensions } from '../editor/lspExt';

// ── Puente con los servidores de lenguaje (A1) ─────────────────────────
// lspStore importa este módulo: el import perezoso rompe el ciclo. Todas las
// llamadas son "dispara y olvida": si el LSP falla, el editor sigue igual.
let lspModule = null;
function withLsp(fn) {
  lspModule ??= import('./lspStore');
  lspModule.then(({ useLspStore }) => fn(useLspStore.getState())).catch(() => {});
}

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

/** Tab: inserta la indentación EN el cursor, no al principio de la línea.
    (`indentWithTab` de CodeMirror siempre re-indenta la línea entera, que es
    lo correcto con una selección de varias líneas pero no al teclear.) */
function insertTabAtCursor(view) {
  const { state } = view;

  // Con algo seleccionado sí se indentan las líneas del rango.
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore(view);

  const { tabSize, insertSpaces } = indentConfig;
  const changes = state.changeByRange((range) => {
    let insert = '\t';
    if (insertSpaces) {
      // Hasta la siguiente parada de tabulación, no siempre `tabSize` espacios.
      const line = state.doc.lineAt(range.head);
      const col = countColumn(state.sliceDoc(line.from, range.head), tabSize);
      insert = ' '.repeat(tabSize - (col % tabSize));
    }
    return {
      changes: { from: range.head, insert },
      range: EditorSelection.cursor(range.head + insert.length),
    };
  });

  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input.indent' }));
  return true;
}

const tabKeymap = { key: 'Tab', run: insertTabAtCursor, shift: indentLess };

// ── Fin de línea (LF / CRLF) ───────────────────────────────────────────
// CodeMirror serializa con "\n" salvo que se le diga otra cosa: sin esto, abrir
// y guardar un archivo CRLF lo reescribía entero a LF (y git lo veía como un
// cambio de todas las líneas). Se detecta al abrir y se conserva.
const eolCompartment = new Compartment();

function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

// ── Posición del cursor (para la barra de estado) ──────────────────────

function cursorFrom(state) {
  const sel = state.selection.main;
  const line = state.doc.lineAt(sel.head);
  return {
    line: line.number,
    col: sel.head - line.from + 1,
    selected: sel.to - sel.from,
  };
}

export function registerEditorView(view) {
  liveView = view;
}

export function getLiveView() {
  return liveView;
}

// ── Diff inline del agente (estilo Cursor) ──────────────────────────────
// Cuando el agente edita un archivo, se muestra el diff EN el editor (verde
// añadido / rojo eliminado) con Aceptar/Rechazar por bloque, vía
// @codemirror/merge. El compartment está vacío salvo cuando hay un diff activo.
const mergeCompartment = new Compartment();
// path -> contenido ORIGINAL (antes de la edición del agente), pendiente de
// pintar en cuanto la vista monte ese archivo (el montaje es asíncrono).
const pendingMerge = new Map();

function mergeExtension(original) {
  return unifiedMergeView({
    original,
    mergeControls: true,       // botones Aceptar/Rechazar por bloque
    gutter: true,
    highlightChanges: true,
    syntaxHighlightDeletions: true,
  });
}

/** Primera línea (1-based) que difiere entre dos textos, para saltar allí. */
function firstChangedLine(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i + 1;
  }
  return Math.min(a.length, b.length) + 1;
}

/** La llama CodeMirrorHost tras montar un archivo: si tiene diff pendiente,
    lo pinta ahora (resuelve el timing del montaje asíncrono). */
export function applyPendingMerge(view, path) {
  const original = pendingMerge.get(path);
  if (original === undefined || !view) return;
  pendingMerge.delete(path);
  view.dispatch({ effects: mergeCompartment.reconfigure(mergeExtension(original)) });
  cacheState(path, view.state);
  const line = firstChangedLine(original, view.state.doc.toString());
  const ln = Math.min(Math.max(1, line), view.state.doc.lines);
  const pos = view.state.doc.line(ln).from;
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
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

// ── Sesión (pestañas abiertas por carpeta de trabajo) ──────────────────
// Se persisten en localStorage con clave por raíz. `restoring` silencia el
// autoguardado de sesión mientras se reabre (para no pisar lo guardado con un
// estado a medio construir).
let sessionRoot = localStorage.getItem('lixbon_workspace_root') || '';
let restoringSession = false;

export function setSessionRoot(root) {
  sessionRoot = root || '';
}

// ── Store ──────────────────────────────────────────────────────────────
export const useEditorStore = create((set, get) => ({
  tabs: [], // [{ path, name, dirty, eol }]
  activePath: null,
  docVersion: 0, // se incrementa en cada edición (para la vista previa en vivo)
  cursor: { line: 1, col: 1, selected: 0 }, // lo pinta la barra de estado

  openFile: async (path, name) => {
    const { tabs } = get();
    if (tabs.some((t) => t.path === path)) {
      get().setActive(path);
      return;
    }

    const content = await readFileContent(path); // el llamador maneja el error
    const language = await resolveLanguage(name); // lezer/legacy → TextMate → plano
    const eol = detectEol(content);
    // mtime al abrir = "versión" contra la que se detecta un cambio externo.
    const mtime = await statFile(path).catch(() => 0);

    const markDirty = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        get().markDirty(path);
        set({ docVersion: get().docVersion + 1 });
        // El servidor necesita ver el documento tal como está en el editor,
        // no como está en disco (changeDoc agrupa los cambios).
        const text = update.state.doc.toString();
        withLsp((lsp) => lsp.changeDoc(path, name, text));
      }
      if ((update.docChanged || update.selectionSet) && get().activePath === path) {
        set({ cursor: cursorFrom(update.state) });
      }
    });

    const state = EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        indentCompartment.of(indentExtension()),
        eolCompartment.of(EditorState.lineSeparator.of(eol)),
        mergeCompartment.of([]), // vacío salvo cuando el agente deja un diff
        keymap.of([
          tabKeymap,
          { key: 'Mod-s', run: () => { get().saveActive(); return true; } },
        ]),
        themeCompartment.of(themeExts),
        ...ghostTextExt, // autocompletado fantasma (inerte si está desactivado)
        ...lintExtension, // gutter de diagnósticos (A2)
        ...lspExtensions(path, name), // completado real, hover, F12 (A1)
        ...language,
        // Snippets de extensiones VSCode: fuente dinámica (consulta el
        // registro en cada query, sin reconfigurar estados al instalar).
        EditorState.languageData.of(() => [{ autocomplete: snippetSource(name) }]),
        markDirty,
      ],
    });

    stateCache.set(path, state);
    set({
      tabs: [...tabs, { path, name, dirty: false, eol, mtime }],
      activePath: path,
      cursor: cursorFrom(state),
    });

    // Arranca el servidor del lenguaje (si hay) y le abre el documento.
    withLsp((lsp) => lsp.openDoc(path, name, content));
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

  setActive: (path) => {
    const state = stateCache.get(path);
    set({ activePath: path, ...(state ? { cursor: cursorFrom(state) } : {}) });
    // El servidor pudo publicar diagnósticos de este archivo mientras estabas
    // en otra pestaña: repintarlos al volver (la vista monta en el próximo frame).
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab) return;
    withLsp((lsp) => {
      if (!lsp.clientFor(tab.name)) return; // sin LSP mandan ruff/eslint
      const diagnostics = lsp.diagnosticsFor(path);
      requestAnimationFrame(() => {
        if (get().activePath === path && liveView) applyDiagnostics(liveView, diagnostics);
      });
    });
  },

  /** El agente editó `path`: lo abre, salta al cambio y pinta el diff inline
      (verde/rojo con Aceptar/Rechazar). `oldContent` = contenido previo
      (cadena vacía para archivos nuevos → todo verde). */
  showAgentDiff: async (path, name, oldContent) => {
    pendingMerge.set(path, oldContent ?? '');
    await get().openFile(path, name);
    set({ activePath: path });
    // Si ya estaba montado y activo, el efecto de CodeMirrorHost no se dispara;
    // aplicarlo aquí. Si no, applyPendingMerge lo hará al montar.
    requestAnimationFrame(() => {
      if (liveView && get().activePath === path && pendingMerge.has(path)) {
        applyPendingMerge(liveView, path);
      }
    });
  },

  /** Quita el diff inline de un archivo (vuelve a edición normal). */
  clearAgentDiff: (path) => {
    pendingMerge.delete(path);
    const clear = (state) => state.update({ effects: mergeCompartment.reconfigure([]) }).state;
    if (liveView && get().activePath === path) {
      liveView.dispatch({ effects: mergeCompartment.reconfigure([]) });
      stateCache.set(path, liveView.state);
    } else {
      const st = stateCache.get(path);
      if (st) stateCache.set(path, clear(st));
    }
  },

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
    // sliceDoc (no doc.toString): respeta el fin de línea del archivo. Con
    // toString() un archivo CRLF se reescribía entero a LF al guardarlo.
    const content = state.sliceDoc();
    try {
      const newMtime = await writeFileContent(path, content, tab.mtime ?? null);
      if (isActive) stateCache.set(path, liveView.state);
      // Si el usuario siguió tecleando durante la escritura, sigue sucia.
      const unchanged = !isActive || liveView.state.doc === savedDoc || liveView.state.doc.eq(savedDoc);
      set({
        tabs: get().tabs.map((t) =>
          t.path === path ? { ...t, mtime: newMtime, dirty: unchanged ? false : t.dirty } : t
        ),
      });
      withLsp((lsp) => lsp.saveDoc(path, tab.name));
    } catch (e) {
      const msg = String(e?.message || e);
      // El archivo cambió en disco desde que se abrió: no pisar a ciegas.
      if (msg.startsWith('CONFLICT:')) {
        if (silent) {
          console.warn('[editor] Conflicto en disco; autoguardado pospuesto:', path);
          return; // se queda sucia; el guardado manual pedirá qué hacer
        }
        const overwrite = await ask(
          `"${tab.name}" cambió en disco desde que lo abriste.\n\n«Sobrescribir» guarda tu versión y descarta el cambio del disco.\n«Recargar» trae la versión del disco y descarta tus cambios sin guardar.`,
          { title: 'lixbon', kind: 'warning', okLabel: 'Sobrescribir', cancelLabel: 'Recargar del disco' }
        );
        if (overwrite) {
          try {
            const forcedMtime = await writeFileContent(path, content, null); // sin guardia
            set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, mtime: forcedMtime, dirty: false } : t)) });
            withLsp((lsp) => lsp.saveDoc(path, tab.name));
          } catch (e2) {
            alert('Error guardando el archivo: ' + e2);
          }
        } else {
          // Recargar: marcar limpia primero para que reloadFromDisk no la salte.
          set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, dirty: false } : t)) });
          await get().reloadFromDisk(path);
        }
        return;
      }
      if (silent) console.error('[editor] Autoguardado falló:', path, e);
      else alert('Error guardando el archivo: ' + e);
    }
  },

  saveActive: async () => {
    const { activePath } = get();
    if (!activePath) return;
    await get().saveTab(activePath);
    // Formatear al guardar (solo guardado manual; el autosave usa saveAll).
    if ((localStorage.getItem('lixbon_format_on_save') ?? 'false') === 'true') {
      const tab = get().tabs.find((t) => t.path === activePath);
      if (tab) {
        try {
          const { formatFile, canFormat } = await import('../lib/format');
          if (canFormat(tab.name)) await formatFile(activePath, tab.name);
        } catch { /* formateador ausente: no romper el guardado */ }
      }
    }
  },

  /** Cambia el fin de línea de una pestaña (LF ↔ CRLF) y la guarda. */
  setEol: async (path, eol) => {
    const tab = get().tabs.find((t) => t.path === path);
    if (!tab || tab.eol === eol) return;

    const effect = eolCompartment.reconfigure(EditorState.lineSeparator.of(eol));
    if (path === get().activePath && liveView) {
      liveView.dispatch({ effects: effect });
      stateCache.set(path, liveView.state);
    } else {
      const state = stateCache.get(path);
      if (state) stateCache.set(path, state.update({ effects: effect }).state);
    }

    // El texto no cambia (CodeMirror guarda las líneas, no los saltos): solo
    // cambia cómo se serializa. Hay que marcarla sucia para que se reescriba.
    set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, eol, dirty: true } : t)) });
    await get().saveTab(path, true);
  },

  saveAll: async (silent = false) => {
    const dirty = get().tabs.filter((t) => t.dirty);
    for (const t of dirty) await get().saveTab(t.path, silent);
  },

  /** Recarga desde disco una pestaña abierta (tras una edición externa,
      p. ej. el agente del chat). No toca pestañas cerradas ni las sucias
      que difieren solo por teclear (el contenido igual se ignora). */
  reloadFromDisk: async (path) => {
    const { tabs, activePath } = get();
    const tab = tabs.find((t) => t.path === path);
    if (!tab) return;
    let content;
    try {
      content = await readFileContent(path);
    } catch {
      return; // binario o ilegible: se deja como está
    }
    const isActive = path === activePath && liveView;
    if (isActive) {
      if (liveView.state.doc.toString() === content) return;
      liveView.dispatch({
        changes: { from: 0, to: liveView.state.doc.length, insert: content },
      });
      stateCache.set(path, liveView.state);
    } else {
      const state = stateCache.get(path);
      if (!state || state.doc.toString() === content) return;
      stateCache.set(
        path,
        state.update({ changes: { from: 0, to: state.doc.length, insert: content } }).state,
      );
    }
    // El dispatch de arriba dispara markDirty; el contenido ya está en disco
    const mtime = await statFile(path).catch(() => 0);
    set({ tabs: get().tabs.map((t) => (t.path === path ? { ...t, dirty: false, mtime } : t)) });
  },

  /** Reacciona a cambios externos en disco (file watcher). Recarga las pestañas
      NO sucias afectadas; las sucias se dejan intactas (no perder ediciones) y
      quedarán en conflicto al guardar. */
  onDiskChanged: (paths) => {
    if (!paths || !paths.length) return;
    const affected = new Set(paths);
    for (const t of get().tabs) {
      if (affected.has(t.path) && !t.dirty) get().reloadFromDisk(t.path);
    }
  },

  /** Guarda la sesión (pestañas abiertas + activa) de la carpeta actual. */
  persistSession: () => {
    if (restoringSession || !sessionRoot) return;
    const { tabs, activePath } = get();
    const data = { tabs: tabs.map((t) => ({ path: t.path, name: t.name })), active: activePath };
    try {
      localStorage.setItem(`lixbon_session_${sessionRoot}`, JSON.stringify(data));
    } catch { /* cuota de localStorage: sin persistencia de sesión, no es crítico */ }
  },

  /** Reabre las pestañas guardadas de `root` (arranque o cambio de carpeta).
      Cierra antes lo que hubiera de otra carpeta. Archivos ya inexistentes se
      omiten en silencio. */
  restoreSession: async (root) => {
    restoringSession = true;
    try {
      for (const t of get().tabs) stateCache.delete(t.path);
      set({ tabs: [], activePath: null });
      setSessionRoot(root);
      let data = null;
      try {
        data = JSON.parse(localStorage.getItem(`lixbon_session_${root}`) || 'null');
      } catch { data = null; }
      if (data && Array.isArray(data.tabs)) {
        for (const t of data.tabs) {
          try { await get().openFile(t.path, t.name); } catch { /* ya no existe */ }
        }
        if (data.active && get().tabs.some((t) => t.path === data.active)) {
          get().setActive(data.active);
        }
      }
    } finally {
      restoringSession = false;
      get().persistSession();
    }
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
    withLsp((lsp) => lsp.closeDoc(path, tab.name));
    const remaining = tabs.filter((t) => t.path !== path);
    const nextActive =
      activePath === path
        ? (remaining[remaining.length - 1]?.path ?? null)
        : activePath;
    set({ tabs: remaining, activePath: nextActive });
  },

  /** Cierra en bloque las pestañas LIMPIAS que cumplan `shouldClose` (las sucias
      se conservan para no perder cambios ni encadenar diálogos). */
  closeClean: (shouldClose) => {
    const { tabs, activePath } = get();
    const toClose = tabs.filter((t) => !t.dirty && shouldClose(t));
    if (toClose.length === 0) return;
    const closing = new Set(toClose.map((t) => t.path));
    for (const t of toClose) {
      stateCache.delete(t.path);
      withLsp((lsp) => lsp.closeDoc(t.path, t.name));
    }
    const remaining = tabs.filter((t) => !closing.has(t.path));
    const nextActive = closing.has(activePath)
      ? (remaining[remaining.length - 1]?.path ?? null)
      : activePath;
    set({ tabs: remaining, activePath: nextActive });
  },

  closeOthers: (path) => get().closeClean((t) => t.path !== path),

  closeToRight: (path) => {
    const idx = get().tabs.findIndex((t) => t.path === path);
    if (idx < 0) return;
    const right = new Set(get().tabs.slice(idx + 1).map((t) => t.path));
    get().closeClean((t) => right.has(t.path));
  },

  closeSaved: () => get().closeClean(() => true),

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

  /** Objetivo de una edición inline (Ctrl+K): rango, texto, coordenadas en
      pantalla y documento completo. Si no hay selección, toma la línea actual.
      Devuelve null si no hay editor vivo. */
  getEditTarget: () => {
    const { activePath, tabs } = get();
    if (!activePath || !liveView) return null;
    const sel = liveView.state.selection.main;
    let from = sel.from;
    let to = sel.to;
    if (from === to) {
      const line = liveView.state.doc.lineAt(from);
      from = line.from;
      to = line.to;
    }
    const tab = tabs.find((t) => t.path === activePath);
    return {
      from,
      to,
      name: tab?.name ?? activePath,
      text: liveView.state.sliceDoc(from, to),
      doc: liveView.state.doc.toString(),
      coords: liveView.coordsAtPos(from),
    };
  },

  /** Aplica una edición inline: reemplaza [from,to) por newText en la vista
      activa y pinta el diff inline (verde/rojo con Aceptar/Rechazar por bloque)
      contra `originalDoc`. Reutiliza el mismo mergeCompartment que el agente. */
  applyInlineEdit: (from, to, newText, originalDoc) => {
    if (!liveView) return;
    const path = get().activePath;
    liveView.dispatch({ changes: { from, to, insert: newText } });
    liveView.dispatch({ effects: mergeCompartment.reconfigure(mergeExtension(originalDoc)) });
    if (path) cacheState(path, liveView.state);
    liveView.dispatch({ effects: EditorView.scrollIntoView(from, { y: 'center' }) });
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
