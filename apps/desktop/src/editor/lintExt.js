// lintExt.js — integración con @codemirror/lint (A2). El gutter de lint va en el
// editor; los diagnósticos se empujan imperativamente (vienen de linters externos
// vía run_command, no de una fuente síncrona).
import { lintGutter, setDiagnostics } from '@codemirror/lint';

export const lintExtension = [lintGutter()];

function toOffset(doc, line, col) {
  const ln = Math.max(1, Math.min(line || 1, doc.lines));
  const l = doc.line(ln);
  return Math.min(l.from + Math.max(0, (col || 1) - 1), l.to);
}

/** Convierte diagnósticos {line,col,endLine,endCol,severity,message,source} a
    Diagnostic de CodeMirror y los aplica a la vista. */
export function applyDiagnostics(view, diags) {
  if (!view) return;
  const doc = view.state.doc;
  const cm = (diags || []).map((d) => {
    const from = toOffset(doc, d.line, d.col);
    let to = (d.endLine || d.endCol)
      ? toOffset(doc, d.endLine || d.line, d.endCol || d.col)
      : from + 1;
    if (to <= from) to = Math.min(from + 1, doc.length);
    return {
      from,
      to,
      severity: d.severity || 'warning',
      message: d.message || '',
      source: d.source,
    };
  });
  view.dispatch(setDiagnostics(view.state, cm));
}

export function clearDiagnostics(view) {
  if (view) view.dispatch(setDiagnostics(view.state, []));
}
