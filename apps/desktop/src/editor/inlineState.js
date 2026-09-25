// inlineState.js — estado de CodeMirror para la edición en línea (Ctrl+I): el
// texto nuevo queda resaltado y el original se muestra encima, tachado, hasta
// aceptar o rechazar. Aplicar y revertir son transacciones normales, así que
// Ctrl+Z también funciona.
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';

const setInline = StateEffect.define();

class OriginalWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return other.text === this.text; }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-inline-old';
    el.textContent = this.text;
    return el;
  }
  ignoreEvent() { return true; }
}

const inlineField = StateField.define({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setInline)) return e.value;
    if (!value || !tr.docChanged) return value;
    return { ...value, from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => {
    if (!v) return Decoration.none;
    const ranges = [];
    if (v.original) ranges.push(Decoration.widget({ widget: new OriginalWidget(v.original), block: true, side: -1 }).range(v.from));
    if (v.to > v.from) ranges.push(Decoration.mark({ class: 'cm-inline-new' }).range(v.from, v.to));
    return Decoration.set(ranges, true);
  }),
});

export const inlineEditExtension = [inlineField];

export const getInline = (view) => view.state.field(inlineField, false);

/** Rango a reescribir: la selección, o la línea del cursor si no hay. */
export function inlineTarget(view) {
  const { state } = view;
  const sel = state.selection.main;
  const from = state.doc.lineAt(sel.from).from;
  const to = sel.empty ? state.doc.lineAt(sel.to).to : sel.to;
  return { from: sel.empty ? from : sel.from, to, text: state.sliceDoc(sel.empty ? from : sel.from, to) };
}

export function applyInline(view, from, to, text) {
  const original = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: text },
    effects: setInline.of({ from, to: from + text.length, original }),
    scrollIntoView: true,
  });
}

export function acceptInline(view) {
  view.dispatch({ effects: setInline.of(null) });
}

export function rejectInline(view) {
  const v = getInline(view);
  if (!v) return;
  view.dispatch({ changes: { from: v.from, to: v.to, insert: v.original }, effects: setInline.of(null) });
}
