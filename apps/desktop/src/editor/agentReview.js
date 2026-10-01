// agentReview.js — marca en el editor lo que cambió el agente respecto al
// archivo antes de su primera edición: líneas nuevas resaltadas y las
// borradas encima, con Aceptar/Rechazar por bloque. Los botones avisan con
// un evento `lx-review` en view.dom; CodeEditor lo traduce a su callback.
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { diffHunks } from '../lib/lineDiff';

export const setBaseline = StateEffect.define();

class HunkWidget extends WidgetType {
  constructor(index, oldLines) { super(); this.index = index; this.oldLines = oldLines; }
  eq(o) { return o.index === this.index && o.oldLines.join('\n') === this.oldLines.join('\n'); }
  toDOM(view) {
    const box = document.createElement('div');
    box.className = 'cm-rv-hunk';
    if (this.oldLines.length) {
      const old = document.createElement('div');
      old.className = 'cm-rv-old';
      old.textContent = this.oldLines.join('\n');
      box.appendChild(old);
    }
    const bar = document.createElement('div');
    bar.className = 'cm-rv-bar';
    for (const [action, label] of [['accept', 'Aceptar'], ['reject', 'Rechazar']]) {
      const b = document.createElement('button');
      b.className = `cm-rv-btn cm-rv-btn--${action}`;
      b.textContent = label;
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = () => view.dom.dispatchEvent(new CustomEvent('lx-review', { detail: { action, index: this.index } }));
      bar.appendChild(b);
    }
    box.appendChild(bar);
    return box;
  }
  ignoreEvent() { return true; }
}

const addLine = Decoration.line({ class: 'cm-rv-add' });

function build(state, baseline) {
  if (baseline === undefined) return { hunks: [], deco: Decoration.none };
  const hunks = diffHunks(baseline ?? '', state.doc.toString());
  const doc = state.doc;
  const ranges = [];
  hunks.forEach((h, i) => {
    const at = h.newStart < doc.lines ? doc.line(h.newStart + 1).from : doc.length;
    ranges.push({ from: at, deco: Decoration.widget({ widget: new HunkWidget(i, h.oldLines), block: true, side: -1 }) });
    for (let k = 0; k < h.newLines.length; k++) {
      const n = h.newStart + k + 1;
      if (n <= doc.lines) ranges.push({ from: doc.line(n).from, deco: addLine });
    }
  });
  return { hunks, deco: Decoration.set(ranges.map((r) => r.deco.range(r.from)), true) };
}

const reviewField = StateField.define({
  create: () => ({ baseline: undefined, hunks: [], deco: Decoration.none }),
  update(value, tr) {
    let { baseline } = value;
    let changed = tr.docChanged;
    for (const e of tr.effects) if (e.is(setBaseline) && e.value !== baseline) { baseline = e.value; changed = true; }
    if (!changed) return value;
    return { baseline, ...build(tr.state, baseline) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export const agentReviewExtension = [reviewField];

export const reviewHunks = (view) => view.state.field(reviewField, false)?.hunks || [];
export const reviewBaseline = (view) => view.state.field(reviewField, false)?.baseline;
