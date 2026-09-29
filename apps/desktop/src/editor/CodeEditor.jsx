// CodeEditor.jsx — una sola instancia de CodeMirror que intercambia el
// EditorState de cada pestaña: así cada archivo conserva su historial de
// deshacer, selección y scroll al cambiar de pestaña.
import { useEffect, useRef } from 'react';
import { Annotation, Compartment, EditorState, Prec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightActiveLine,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching, foldGutter, foldKeymap, indentUnit } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { lixbonTheme, lixbonHighlight } from './cmTheme';
import { loadLanguage } from './languages';
import { inlineEditExtension } from './inlineState';
import { agentReviewExtension, setBaseline, reviewBaseline } from './agentReview';
import { diagnosticsExtension, setDiagnostics } from './diagnostics';

const states = new Map();
export const forgetEditorState = (path) => states.delete(path);

let activeView = null;
export const getActiveView = () => activeView;

const External = Annotation.define();
const langC = new Compartment();
const tabC = new Compartment();
const wrapC = new Compartment();
const sizeC = new Compartment();

const tabExt = (n) => [EditorState.tabSize.of(n), indentUnit.of(' '.repeat(n))];
const sizeExt = (px) => EditorView.theme({ '&': { fontSize: `${px}px` } });

function applyOptions(view, o) {
  view.dispatch({
    effects: [
      tabC.reconfigure(tabExt(o.tabSize)),
      wrapC.reconfigure(o.wordWrap ? EditorView.lineWrapping : []),
      sizeC.reconfigure(sizeExt(o.fontSize)),
    ],
  });
}

export function CodeEditor({ path, content, options, reveal, baseline, diagnostics, onChange, onSave, onCursor, onInlineEdit, onReview }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const pathRef = useRef(null);
  const cbs = useRef({});
  cbs.current = { onChange, onSave, onCursor, onInlineEdit, onReview };

  const makeState = (doc) => EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({ openText: '▾', closedText: '▸' }),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      Prec.highest(keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { cbs.current.onSave?.(); return true; } },
        { key: 'Mod-i', preventDefault: true, run: () => { cbs.current.onInlineEdit?.(); return true; } },
        { key: 'Mod-Enter', run: (v) => reviewBaseline(v) !== undefined && (cbs.current.onReview?.('acceptAll'), true) },
        { key: 'Mod-Shift-Backspace', run: (v) => reviewBaseline(v) !== undefined && (cbs.current.onReview?.('rejectAll'), true) },
        { key: 'Alt-ArrowDown', run: (v) => reviewBaseline(v) !== undefined && (cbs.current.onReview?.('next'), true) },
        { key: 'Alt-ArrowUp', run: (v) => reviewBaseline(v) !== undefined && (cbs.current.onReview?.('prev'), true) },
      ])),
      inlineEditExtension,
      agentReviewExtension,
      diagnosticsExtension,
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
      lixbonTheme,
      lixbonHighlight,
      langC.of([]),
      tabC.of(tabExt(options.tabSize)),
      wrapC.of(options.wordWrap ? EditorView.lineWrapping : []),
      sizeC.of(sizeExt(options.fontSize)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !u.transactions.some((tr) => tr.annotation(External))) {
          cbs.current.onChange?.(u.state.doc.toString());
        }
        if (u.selectionSet || u.docChanged) {
          const sel = u.state.selection.main;
          const line = u.state.doc.lineAt(sel.head);
          cbs.current.onCursor?.({ line: line.number, col: sel.head - line.from + 1, selected: Math.abs(sel.to - sel.from) });
        }
      }),
    ],
  });

  useEffect(() => {
    viewRef.current = new EditorView({ parent: hostRef.current, state: EditorState.create({ doc: '' }) });
    activeView = viewRef.current;
    const onReviewEvent = (e) => cbs.current.onReview?.(e.detail.action, e.detail.index);
    viewRef.current.dom.addEventListener('lx-review', onReviewEvent);
    return () => {
      activeView = null;
      if (pathRef.current) states.set(pathRef.current, viewRef.current.state);
      viewRef.current.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !path) return undefined;
    if (pathRef.current && pathRef.current !== path) states.set(pathRef.current, view.state);
    pathRef.current = path;
    view.setState(states.get(path) || makeState(content));
    applyOptions(view, options);
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    cbs.current.onCursor?.({ line: line.number, col: head - line.from + 1, selected: 0 });
    let alive = true;
    loadLanguage(path).then((lang) => {
      if (alive && pathRef.current === path && viewRef.current) {
        viewRef.current.dispatch({ effects: langC.reconfigure(lang || []) });
      }
    });
    view.focus();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && path) view.dispatch({ effects: setBaseline.of(baseline) });
  }, [path, baseline]);

  useEffect(() => {
    const view = viewRef.current;
    if (view && path) view.dispatch({ effects: setDiagnostics.of(diagnostics || []) });
  }, [path, diagnostics]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !reveal || reveal.path !== path) return;
    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(1, reveal.line), doc.lines));
    view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    view.focus();
  }, [reveal, path]);

  // Recarga desde disco (agente, git, editor externo): se reemplaza el
  // documento sin avisar al store, que ya tiene ese contenido.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc.toString();
    if (doc !== content) {
      view.dispatch({ changes: { from: 0, to: doc.length, insert: content }, annotations: External.of(true) });
    }
  }, [content]);

  useEffect(() => {
    if (viewRef.current) applyOptions(viewRef.current, options);
  }, [options.fontSize, options.tabSize, options.wordWrap]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div className="code-editor" ref={hostRef} />;
}
