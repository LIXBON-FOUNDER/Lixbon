// cmTheme.js — tema de CodeMirror alineado con los tokens del IDE.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const C = {
  ink: '#ECECE8',
  body: '#DCDCD6',
  muted: '#85857F',
  faint: '#44443F',
  comment: '#5E5E59',
  keyword: '#E59AD6',
  string: '#F2C98A',
  fn: '#8EC5FF',
  type: '#C3B4FF',
  number: '#F5D98A',
  tag: '#93DDA3',
  accent: '#C6D66E',
};

export const lixbonTheme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'transparent', color: C.ink },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
    '.cm-content': { caretColor: C.ink, padding: '6px 0 40vh' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: C.ink, borderLeftWidth: '2px' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(198, 214, 110, 0.2) !important',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(242, 242, 238, 0.03)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: C.faint, border: 'none', paddingLeft: '10px' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 14px 0 6px', minWidth: '40px' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: C.ink },
    '.cm-foldGutter .cm-gutterElement': { color: C.faint, transition: 'color .15s ease' },
    '.cm-foldGutter .cm-gutterElement:hover': { color: C.ink },
    '.cm-foldPlaceholder': { backgroundColor: '#222222', color: C.muted, border: 'none', borderRadius: '7px', padding: '0 6px' },
    '&.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(198, 214, 110, 0.18)', outline: 'none' },
    '.cm-searchMatch': { backgroundColor: 'rgba(232, 200, 114, 0.22)', borderRadius: '2px' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(232, 200, 114, 0.42)' },
    '.cm-selectionMatch': { backgroundColor: 'rgba(242, 242, 238, 0.07)' },
    '.cm-tooltip': { backgroundColor: '#222222', color: C.ink, border: 'none', borderRadius: '7px', overflow: 'hidden' },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '260px', padding: '4px' },
    '.cm-tooltip-autocomplete > ul > li': { borderRadius: '5px', padding: '3px 8px' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: '#333330', color: C.ink },
    '.cm-completionIcon': { opacity: 0.6 },
    '.cm-panels': { backgroundColor: '#161616', color: C.ink, border: 'none' },
    '.cm-panels.cm-panels-top': { borderBottom: 'none' },
    '.cm-panel.cm-search': { padding: '8px 12px', fontFamily: 'var(--font-ui)', fontSize: '12.5px' },
    '.cm-panel.cm-search input, .cm-panel.cm-search button': {
      backgroundColor: '#222222', color: C.ink, border: 'none', borderRadius: '7px', padding: '4px 8px', fontFamily: 'inherit',
    },
    '.cm-panel.cm-search button:hover': { backgroundColor: '#2A2A2A' },
    '.cm-panel.cm-search label': { color: C.muted },
    '.cm-button': { backgroundImage: 'none' },
    '.cm-textfield': { border: 'none' },
  },
  { dark: true },
);

export const lixbonHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier], color: C.keyword },
    { tag: [t.string, t.special(t.string), t.regexp], color: C.string },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: C.fn },
    { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: C.type },
    { tag: [t.number, t.bool, t.null, t.atom], color: C.number },
    { tag: [t.variableName, t.definition(t.variableName)], color: C.ink },
    { tag: [t.propertyName, t.attributeValue], color: C.body },
    { tag: [t.attributeName], color: C.type },
    { tag: [t.tagName, t.angleBracket], color: C.tag },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: C.comment, fontStyle: 'italic' },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: C.muted },
    { tag: [t.heading], color: C.ink, fontWeight: '600' },
    { tag: [t.link, t.url], color: C.fn, textDecoration: 'underline' },
    { tag: [t.emphasis], fontStyle: 'italic' },
    { tag: [t.strong], fontWeight: '600' },
    { tag: [t.invalid], color: '#F08C7C' },
  ]),
);
