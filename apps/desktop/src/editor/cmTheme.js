// cmTheme.js — tema de CodeMirror alineado con los tokens del IDE.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const PALETTES = {
  dark: {
    comment: '#5E5E59',
    keyword: '#E59AD6',
    string: '#F2C98A',
    fn: '#8EC5FF',
    type: '#C3B4FF',
    number: '#F5D98A',
    tag: '#93DDA3',
    invalid: '#F08C7C',
    accentRgb: '198, 214, 110',
    searchRgb: '232, 200, 114',
  },
  light: {
    comment: '#8A8A82',
    keyword: '#A12E8C',
    string: '#8A5A00',
    fn: '#1F5FB0',
    type: '#6B3FC4',
    number: '#9A6A00',
    tag: '#2A7A3E',
    invalid: '#B3362B',
    accentRgb: '110, 130, 20',
    searchRgb: '200, 150, 0',
  },
};

const C = {
  ink: 'var(--ink)',
  body: 'var(--ink-body)',
  muted: 'var(--ink-50)',
  faint: 'var(--ink-faint)',
};

const buildTheme = (mode) => {
  const P = PALETTES[mode];
  return EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'transparent', color: C.ink },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
    '.cm-content': { caretColor: C.ink, padding: '6px 0 40vh' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: C.ink, borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: `rgba(${P.accentRgb}, 0.2) !important`,
    },
    '.cm-activeLine': { backgroundColor: 'rgba(var(--ink-rgb), 0.03)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: C.faint, border: 'none', paddingLeft: '10px' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 14px 0 6px', minWidth: '40px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: C.ink },
    '.cm-foldGutter .cm-gutterElement': { color: C.faint, transition: 'color .15s ease' },
    '.cm-foldGutter .cm-gutterElement:hover': { color: C.ink },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--surface-4)', color: C.muted, border: 'none', borderRadius: '7px', padding: '0 6px' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: `rgba(${P.accentRgb}, 0.18)`, outline: 'none' },
    '.cm-searchMatch': { backgroundColor: `rgba(${P.searchRgb}, 0.22)`, borderRadius: '2px' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: `rgba(${P.searchRgb}, 0.42)` },
    '.cm-selectionMatch': { backgroundColor: 'rgba(var(--ink-rgb), 0.07)' },
    '.cm-tooltip': { backgroundColor: 'var(--surface-4)', color: C.ink, border: 'none', borderRadius: '7px', overflow: 'hidden' },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '260px', padding: '4px' },
    '.cm-tooltip-autocomplete > ul > li': { borderRadius: '5px', padding: '3px 8px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--surface-6)', color: C.ink },
    '.cm-completionIcon': { opacity: 0.6 },
    '.cm-panels': { backgroundColor: 'var(--surface-2)', color: C.ink, border: 'none' },
    '.cm-panels.cm-panels-top': { borderBottom: 'none' },
    '.cm-panel.cm-search': { padding: '8px 12px', fontFamily: 'var(--font-ui)', fontSize: '12.5px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': {
      backgroundColor: 'var(--surface-4)', color: C.ink, border: 'none', borderRadius: '7px', padding: '4px 8px', fontFamily: 'inherit',
    },
    '.cm-panel.cm-search button:hover': { backgroundColor: 'var(--surface-5)' },
    '.cm-panel.cm-search label': { color: C.muted },
    '.cm-button': { backgroundImage: 'none' },
    '.cm-textfield': { border: 'none' },
  },
  { dark: mode === 'dark' },
  );
};

const buildHighlight = (mode) => {
  const P = PALETTES[mode];
  return syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: P.keyword },
    { tag: [t.string, t.special(t.string), t.regexp], color: P.string },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: P.fn },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: P.type },
    { tag: [t.number, t.bool, t.null, t.atom], color: P.number },
    { tag: [t.variableName, t.definition(t.variableName)], color: C.ink },
    { tag: [t.propertyName, t.attributeValue], color: C.body },
    { tag: [t.attributeName], color: P.type },
    { tag: [t.tagName, t.angleBracket], color: P.tag },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: P.comment, fontStyle: 'italic' },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: C.muted },
    { tag: [t.heading], color: C.ink, fontWeight: '600' },
    { tag: [t.link, t.url], color: P.fn, textDecoration: 'underline' },
    { tag: [t.emphasis], fontStyle: 'italic' },
    { tag: [t.strong], fontWeight: '600' },
    { tag: [t.invalid], color: P.invalid },
  ]),
  );
};

const THEMES = {
  dark: [buildTheme('dark'), buildHighlight('dark')],
  light: [buildTheme('light'), buildHighlight('light')],
};

export const cmThemeFor = (mode) => THEMES[mode];
