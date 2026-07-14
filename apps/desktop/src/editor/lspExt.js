// lspExt.js — funciones de lenguaje del editor servidas por LSP:
// autocompletado real, hover e ir a definición. Los diagnósticos NO están aquí:
// el servidor los empuja solo (publishDiagnostics) y los reparte lspStore.
//
// El store de LSP depende de editorStore, que carga este módulo: por eso el
// acceso al store es con import() perezoso.
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, hoverTooltip } from '@codemirror/view';
import { posToLsp, lspToPos, uriToPath } from '../lib/lspClient';

async function lspFor(fileName) {
  const { useLspStore } = await import('../store/lspStore');
  const store = useLspStore.getState();
  return store.enabled ? store.clientFor(fileName) : null;
}

async function activeTab() {
  const { useEditorStore } = await import('../store/editorStore');
  const ed = useEditorStore.getState();
  const tab = ed.tabs.find((t) => t.path === ed.activePath);
  return tab || null;
}

// ── Autocompletado ──────────────────────────────────────────────────────

const KIND = {
  2: 'method', 3: 'function', 4: 'function', 5: 'property', 6: 'variable',
  7: 'class', 8: 'interface', 9: 'namespace', 10: 'property', 12: 'variable',
  13: 'enum', 14: 'keyword', 15: 'text', 17: 'text', 20: 'enum',
  21: 'constant', 22: 'class', 23: 'variable', 24: 'keyword', 25: 'type',
};

function docText(documentation) {
  if (!documentation) return '';
  return typeof documentation === 'string' ? documentation : documentation.value || '';
}

function toCompletion(item) {
  // Declaramos snippetSupport:false, pero si un servidor manda igualmente un
  // snippet (`${1:x}`) es mejor insertar la etiqueta que un texto con marcas.
  const isSnippet = item.insertTextFormat === 2;
  const insert = isSnippet
    ? item.label
    : (item.textEdit?.newText ?? item.insertText ?? item.label);

  return {
    label: item.label,
    type: KIND[item.kind] || 'variable',
    detail: item.detail || undefined,
    info: docText(item.documentation) || undefined,
    apply: insert === item.label ? undefined : insert,
  };
}

/** Fuente de autocompletado para un archivo. Se enchufa por languageData, igual
    que los snippets, para no reconfigurar el estado al arrancar el servidor. */
export function lspCompletionSource(path, fileName) {
  return async (context) => {
    const client = await lspFor(fileName);
    if (!client) return null;

    const word = context.matchBefore(/[\w$]*/);
    const trigger = context.matchBefore(/[.:>@]$/); // miembros, rutas, decoradores
    const typing = word && word.from !== word.to;
    if (!context.explicit && !trigger && !typing) return null;

    let res;
    try {
      res = await client.completion(path, posToLsp(context.state, context.pos));
    } catch {
      return null; // el servidor no respondió: no romper el editor
    }
    if (context.aborted) return null;

    const items = Array.isArray(res) ? res : (res?.items || []);
    if (!items.length) return null;

    return {
      from: word ? word.from : context.pos,
      options: items.slice(0, 200).map(toCompletion),
      validFor: /^[\w$]*$/,
    };
  };
}

// ── Hover ───────────────────────────────────────────────────────────────

function hoverText(contents) {
  if (!contents) return '';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join('\n\n');
  if (contents.value) return contents.value; // MarkupContent | MarkedString
  return '';
}

export const lspHover = hoverTooltip(async (view, pos) => {
  const tab = await activeTab();
  if (!tab) return null;
  const client = await lspFor(tab.name);
  if (!client) return null;

  let res;
  try {
    res = await client.hover(tab.path, posToLsp(view.state, pos));
  } catch {
    return null;
  }

  const text = hoverText(res?.contents).trim();
  if (!text) return null;

  const from = res.range ? lspToPos(view.state, res.range.start) : pos;
  const to = res.range ? lspToPos(view.state, res.range.end) : pos;

  return {
    pos: from,
    end: to,
    above: true,
    create: () => {
      const dom = document.createElement('div');
      dom.className = 'cm-lsp-hover';
      // textContent, no innerHTML: el servidor manda markdown, no HTML de fiar.
      dom.textContent = text;
      return { dom };
    },
  };
});

// ── Ir a definición ─────────────────────────────────────────────────────

/** Primer destino de una respuesta de definition (Location | Location[] |
    LocationLink[]), normalizado a {path, line}. */
function firstTarget(res) {
  const first = Array.isArray(res) ? res[0] : res;
  if (!first) return null;
  const uri = first.uri ?? first.targetUri;
  const range = first.range ?? first.targetSelectionRange ?? first.targetRange;
  if (!uri) return null;
  return { path: uriToPath(uri), line: (range?.start?.line ?? 0) + 1 };
}

export async function gotoDefinition() {
  const tab = await activeTab();
  if (!tab) return false;
  const client = await lspFor(tab.name);
  if (!client) return false;

  const { useEditorStore, getLiveView } = await import('../store/editorStore');
  const view = getLiveView();
  if (!view) return false;

  let res;
  try {
    res = await client.definition(tab.path, posToLsp(view.state, view.state.selection.main.head));
  } catch {
    return false;
  }

  const target = firstTarget(res);
  if (!target) return false;

  const name = target.path.split(/[\\/]/).pop() || target.path;
  await useEditorStore.getState().openFileAtLine(target.path, name, target.line);
  return true;
}

const definitionKeymap = keymap.of([
  { key: 'F12', run: () => { gotoDefinition(); return true; } },
  { key: 'Mod-F12', run: () => { gotoDefinition(); return true; } },
]);

const hoverTheme = EditorView.baseTheme({
  '.cm-lsp-hover': {
    padding: '8px 10px',
    maxWidth: '520px',
    maxHeight: '320px',
    overflow: 'auto',
    whiteSpace: 'pre-wrap',
    fontFamily: 'var(--font-mono)',
    fontSize: '12.5px',
    lineHeight: '1.5',
  },
});

/** Extensiones LSP de una pestaña. Inertes si no hay servidor para el archivo. */
export function lspExtensions(path, fileName) {
  return [
    EditorState.languageData.of(() => [{ autocomplete: lspCompletionSource(path, fileName) }]),
    lspHover,
    definitionKeymap,
    hoverTheme,
  ];
}
