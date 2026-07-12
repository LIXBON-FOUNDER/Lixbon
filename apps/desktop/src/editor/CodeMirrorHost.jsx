// CodeMirrorHost.jsx — monta UNA EditorView y le intercambia el EditorState
// según la pestaña activa (el estado por pestaña vive en editorStore).
import { useEffect, useRef } from 'react';
import { EditorView } from '@codemirror/view';
import {
  useEditorStore,
  registerEditorView,
  getCachedState,
  cacheState,
  applyPendingMerge,
} from '../store/editorStore';

export function CodeMirrorHost() {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const shownPathRef = useRef(null);
  const activePath = useEditorStore((s) => s.activePath);

  // Crear la vista una sola vez
  useEffect(() => {
    const view = new EditorView({ parent: hostRef.current });
    viewRef.current = view;
    registerEditorView(view);
    return () => {
      registerEditorView(null);
      view.destroy();
    };
  }, []);

  // Cambiar de pestaña: preservar el estado saliente y montar el entrante
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // Preservar el estado saliente, salvo que la pestaña se haya cerrado
    if (
      shownPathRef.current &&
      shownPathRef.current !== activePath &&
      getCachedState(shownPathRef.current)
    ) {
      cacheState(shownPathRef.current, view.state);
    }

    if (activePath) {
      const next = getCachedState(activePath);
      if (next && view.state !== next) {
        view.setState(next);
      }
      view.focus();
      applyPendingMerge(view, activePath); // diff inline del agente, si lo hay
    }
    shownPathRef.current = activePath;
  }, [activePath]);

  return <div className="cm-host" ref={hostRef} />;
}
