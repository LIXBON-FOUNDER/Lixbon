// ghostText.js — autocompletado fantasma estilo Copilot (B1) para CodeMirror 6.
// Un ViewPlugin pide la completación FIM (debounce) al teclear y la muestra como
// texto atenuado tras el cursor; Tab la acepta, Esc la descarta. La extensión es
// inerte cuando el ajuste está desactivado (no pide nada), así que puede estar
// siempre montada sin coste.

import { StateField, StateEffect, Prec } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, ViewPlugin, keymap } from '@codemirror/view';
import { buildFimContext, requestFimCompletion } from '../lib/fim';

// ── Config (la fija appStore) ───────────────────────────────────────────
let config = { enabled: false, delay: 350 };
export function setGhostConfig(next) {
  config = { ...config, ...next };
}

// ── Estado de la sugerencia visible ─────────────────────────────────────
const setGhost = StateEffect.define(); // { from, text } | null

class GhostWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(other) { return other.text === this.text; }
  toDOM() {
    const wrap = document.createElement('span');
    wrap.className = 'cm-ghost-text';
    this.text.split('\n').forEach((line, i) => {
      if (i) wrap.appendChild(document.createElement('br'));
      wrap.appendChild(document.createTextNode(line));
    });
    return wrap;
  }
  get estimatedHeight() { return -1; }
  ignoreEvent() { return true; }
}

const ghostField = StateField.define({
  create() { return { text: null, from: 0, deco: Decoration.none }; },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhost)) {
        if (!e.value || !e.value.text) return { text: null, from: 0, deco: Decoration.none };
        const { from, text } = e.value;
        const deco = Decoration.set([
          Decoration.widget({ widget: new GhostWidget(text), side: 1 }).range(from),
        ]);
        return { text, from, deco };
      }
    }
    // Cualquier edición o movimiento del cursor invalida la sugerencia visible.
    if (value.text != null && (tr.docChanged || tr.selection)) {
      return { text: null, from: 0, deco: Decoration.none };
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** Acepta la sugerencia (la inserta). Devuelve false si no hay ninguna. */
function acceptGhost(view) {
  const s = view.state.field(ghostField, false);
  if (!s || s.text == null) return false;
  view.dispatch({
    changes: { from: s.from, insert: s.text },
    selection: { anchor: s.from + s.text.length },
    effects: setGhost.of(null),
    userEvent: 'input.complete',
  });
  return true;
}

function dismissGhost(view) {
  const s = view.state.field(ghostField, false);
  if (!s || s.text == null) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
}

// ── ViewPlugin: pide la completación con debounce ───────────────────────
const ghostPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.view = view;
      this.timer = null;
      this.controller = null;
    }

    update(update) {
      // Solo al teclear (docChanged); mover el cursor no dispara peticiones (coste).
      if (update.docChanged && config.enabled) this.schedule();
      else if (update.docChanged || update.selectionSet) this.cancel();
    }

    schedule() {
      this.cancel();
      const sel = this.view.state.selection.main;
      if (!sel.empty) return; // no sugerir sobre una selección
      this.timer = setTimeout(() => this.fetch(), config.delay);
    }

    async fetch() {
      const view = this.view;
      const pos = view.state.selection.main.head;
      const { prefix, suffix } = buildFimContext(view.state, pos);
      if (!prefix.trim()) return;
      this.controller = new AbortController();
      const text = await requestFimCompletion({ prefix, suffix, signal: this.controller.signal });
      // Descartar si el cursor se movió mientras esperábamos.
      if (!text || view.state.selection.main.head !== pos) return;
      view.dispatch({ effects: setGhost.of({ from: pos, text }) });
    }

    cancel() {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      if (this.controller) { this.controller.abort(); this.controller = null; }
    }

    destroy() { this.cancel(); }
  }
);

// Tab acepta (si hay sugerencia; si no, cae al siguiente handler = indentar);
// Esc la descarta. Prec.highest para ganar al keymap de indentación.
const ghostKeymap = Prec.highest(
  keymap.of([
    { key: 'Tab', run: acceptGhost },
    { key: 'Escape', run: dismissGhost },
  ])
);

export const ghostText = [ghostField, ghostPlugin, ghostKeymap];
