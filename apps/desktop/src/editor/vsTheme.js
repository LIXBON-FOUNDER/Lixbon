// vsTheme.js — convierte un tema de color de VSCode (JSON) en extensiones de
// CodeMirror: colores del editor (colors.*) + resaltado de sintaxis mapeando
// scopes TextMate a tags de lezer. Es una conversión aproximada pero cubre
// los scopes que usan prácticamente todos los temas.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

// Scope TextMate representativo → tags de lezer que pintan lo mismo.
// El orden no importa: para cada objetivo se busca la regla más específica.
const SCOPE_TO_TAGS = [
  ['comment', [t.comment, t.lineComment, t.blockComment]],
  ['string', [t.string, t.special(t.string)]],
  ['constant.numeric', [t.number, t.integer, t.float]],
  ['constant.language', [t.bool, t.null, t.atom]],
  ['constant.character.escape', [t.escape]],
  ['keyword.operator', [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator, t.updateOperator]],
  ['keyword', [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword]],
  ['storage.type', [t.definitionKeyword]],
  ['entity.name.function', [t.function(t.variableName), t.function(t.propertyName)]],
  ['entity.name.type', [t.typeName]],
  ['entity.name.class', [t.className]],
  ['variable.other.property', [t.propertyName]],
  ['variable', [t.variableName, t.definition(t.variableName)]],
  ['entity.name.tag', [t.tagName]],
  ['entity.other.attribute-name', [t.attributeName]],
  ['punctuation', [t.punctuation, t.separator, t.bracket]],
  ['markup.heading', [t.heading]],
  ['markup.bold', [t.strong]],
  ['markup.italic', [t.emphasis]],
  ['markup.underline.link', [t.link, t.url]],
  ['invalid', [t.invalid]],
];

/** Settings de la regla cuyo scope sea el prefijo más largo del objetivo
    (semántica de especificidad de TextMate, simplificada). */
function findSettings(tokenColors, target) {
  let best = null;
  let bestLen = 0;
  for (const rule of tokenColors) {
    if (!rule || !rule.settings) continue;
    const scopes = Array.isArray(rule.scope)
      ? rule.scope
      : String(rule.scope || '').split(',');
    for (const rawScope of scopes) {
      // En selectores descendentes ("meta.def entity.name") manda el último término
      const scope = rawScope.trim().split(' ').pop();
      if (!scope) continue;
      if (target === scope || target.startsWith(scope + '.')) {
        if (scope.length > bestLen) {
          bestLen = scope.length;
          best = rule.settings;
        }
      }
    }
  }
  return best;
}

/**
 * themeJson: contenido del JSON del tema. darkHint: uiTheme != 'vs'.
 * Devuelve un array de extensiones de CodeMirror listo para un Compartment.
 */
export function buildVsCodeTheme(themeJson, darkHint = true) {
  const colors = themeJson.colors || {};
  const tokenColors = Array.isArray(themeJson.tokenColors) ? themeJson.tokenColors : [];
  const dark = themeJson.type
    ? themeJson.type === 'dark' || themeJson.type === 'hcDark'
    : !!darkHint;

  const bg = colors['editor.background'] || (dark ? '#1e1e1e' : '#ffffff');
  const fg = colors['editor.foreground'] || (dark ? '#d4d4d4' : '#333333');
  const caret = colors['editorCursor.foreground'] || fg;
  const selection = colors['editor.selectionBackground'] || (dark ? '#264f78' : '#add6ff');
  const lineHl = colors['editor.lineHighlightBackground'] || 'transparent';
  const gutterBg = colors['editorGutter.background'] || bg;
  const gutterFg = colors['editorLineNumber.foreground'] || (dark ? '#858585' : '#999999');
  const gutterActive = colors['editorLineNumber.activeForeground'] || fg;

  const editorTheme = EditorView.theme(
    {
      '&': { backgroundColor: bg, color: fg },
      '.cm-content': { caretColor: caret },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: caret },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground':
        { backgroundColor: selection },
      '.cm-activeLine': { backgroundColor: lineHl },
      '.cm-gutters': { backgroundColor: gutterBg, color: gutterFg, border: 'none' },
      '.cm-activeLineGutter': { backgroundColor: lineHl, color: gutterActive },
      '.cm-panels': { backgroundColor: bg, color: fg },
      '.cm-tooltip': { backgroundColor: bg, color: fg, border: '1px solid rgba(128,128,128,0.35)' },
      '.cm-matchingBracket': { outline: '1px solid rgba(128,128,128,0.6)' },
    },
    { dark },
  );

  const styles = [];
  for (const [scope, tags] of SCOPE_TO_TAGS) {
    const s = findSettings(tokenColors, scope);
    if (!s) continue;
    const spec = { tag: tags };
    if (s.foreground) spec.color = s.foreground;
    if (typeof s.fontStyle === 'string') {
      if (s.fontStyle.includes('italic')) spec.fontStyle = 'italic';
      if (s.fontStyle.includes('bold')) spec.fontWeight = 'bold';
      if (s.fontStyle.includes('underline')) spec.textDecoration = 'underline';
    }
    if (spec.color || spec.fontStyle || spec.fontWeight || spec.textDecoration) {
      styles.push(spec);
    }
  }

  return styles.length
    ? [editorTheme, syntaxHighlighting(HighlightStyle.define(styles))]
    : [editorTheme];
}
