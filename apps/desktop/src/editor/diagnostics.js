// diagnostics.js — problemas del comprobador del proyecto dentro del editor:
// la línea se tiñe y el mensaje aparece al final, atenuado.
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

export const setDiagnostics = StateEffect.define();

class MessageWidget extends WidgetType {
  constructor(text, severity) { super(); this.text = text; this.severity = severity; }
  eq(o) { return o.text === this.text && o.severity === this.severity; }
  toDOM() {
    const el = document.createElement('span');
    el.className = `cm-diag-msg cm-diag-msg--${this.severity}`;
    el.textContent = this.text;
    return el;
  }
}

function build(doc, list) {
  const ranges = [];
  const byLine = new Map();
  for (const d of list) {
    if (d.line < 1 || d.line > doc.lines) continue;
    const prev = byLine.get(d.line);
    if (!prev || (d.severity === 'error' && prev.severity !== 'error')) byLine.set(d.line, d);
  }
  for (const [n, d] of byLine) {
    const line = doc.line(n);
    const sev = d.severity === 'error' ? 'error' : 'warning';
    ranges.push(Decoration.line({ class: `cm-diag-line cm-diag-line--${sev}` }).range(line.from));
    ranges.push(Decoration.widget({ widget: new MessageWidget(d.message, sev), side: 1 }).range(line.to));
  }
  return Decoration.set(ranges, true);
}

const diagField = StateField.define({
  create: () => ({ list: [], deco: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setDiagnostics)) return { list: e.value, deco: build(tr.state.doc, e.value) };
    // Tras editar, los números de línea del comprobador ya no son fiables:
    // se mapean las marcas y se espera a la siguiente pasada.
    return tr.docChanged ? { ...value, deco: value.deco.map(tr.changes) } : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export const diagnosticsExtension = [diagField];
