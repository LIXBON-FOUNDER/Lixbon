// problemsStore.js — diagnósticos del archivo activo (A2). Ejecuta el linter y
// empuja los resultados al editor (subrayados) y al panel de Problemas.
import { create } from 'zustand';
import { runLinter, hasLinter } from '../lib/linters';
import { applyDiagnostics, clearDiagnostics } from '../editor/lintExt';
import { useEditorStore, getLiveView } from './editorStore';

export const useProblemsStore = create((set) => ({
  diagnostics: [],
  running: false,
  error: '',
  path: '',
  name: '',

  run: async () => {
    const ed = useEditorStore.getState();
    const path = ed.activePath;
    const tab = ed.tabs.find((t) => t.path === path);
    if (!tab) { set({ diagnostics: [], path: '', name: '', error: 'No hay archivo activo.' }); return; }
    if (!hasLinter(tab.name)) {
      set({ diagnostics: [], path, name: tab.name, error: `No hay linter para ${tab.name}.` });
      clearDiagnostics(getLiveView());
      return;
    }
    set({ running: true, error: '' });
    const res = await runLinter(path, tab.name);
    if (!res.ok) {
      set({ running: false, error: res.error, diagnostics: [], path, name: tab.name });
      clearDiagnostics(getLiveView());
      return;
    }
    set({ diagnostics: res.diagnostics, running: false, path, name: tab.name, error: '' });
    applyDiagnostics(getLiveView(), res.diagnostics);
  },

  clear: () => { set({ diagnostics: [], path: '', name: '' }); clearDiagnostics(getLiveView()); },
}));
