// lixbonTheme.js — temas claro y oscuro de CodeMirror 6 con los tokens lixbon.
// Paleta contenida: tinta + acentos tierra/oliva derivados de la identidad
// (nada de arcoíris de sintaxis; jerarquía por peso y pocos matices).
// El fondo usa var(--bg): el modo (data-theme) ya pinta la superficie correcta.

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const ink = '#171717';
const inkSoft = 'rgba(23, 23, 23, 0.55)';
const olive = '#5f7a1f';   // strings — pariente oscuro del accent #d9e64a
const earth = '#a8551a';   // números y constantes — pariente del Pro #CE7F25
const pine = '#2f6b5e';    // tipos y clases
const slate = '#3a4a63';   // variables — pariente frío/tinta, contenido
const prop = '#4a6b62';    // propiedades — variante clara del pino
const danger = '#c0392b';

export const lixbonTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--bg)',
      color: ink,
      fontSize: 'var(--editor-font-size)',
    },
    '.cm-content': {
      fontFamily: 'var(--font-mono)',
      caretColor: ink,
      padding: '12px 0',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: ink },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(217, 230, 74, 0.45)',
    },
    '.cm-selectionBackground': {
      backgroundColor: 'rgba(217, 230, 74, 0.28)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(23, 23, 23, 0.035)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: ink,
    },
    '.cm-gutters': {
      backgroundColor: 'var(--bg)',
      color: 'rgba(23, 23, 23, 0.35)',
      borderRight: '1px solid var(--border-soft)',
      fontFamily: 'var(--font-mono)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 16px' },
    '.cm-foldGutter': { color: 'rgba(23, 23, 23, 0.35)' },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(217, 230, 74, 0.5)',
      outline: 'none',
    },
    '.cm-searchMatch': { backgroundColor: 'rgba(206, 127, 37, 0.25)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(206, 127, 37, 0.45)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--bg)',
      border: '1px solid var(--border-soft)',
      borderRadius: '10px',
      fontFamily: 'var(--font-ui)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'var(--bg-secondary)',
      color: ink,
    },
    '.cm-panels': {
      backgroundColor: 'var(--bg-secondary)',
      color: ink,
      borderTop: '1px solid var(--border-soft)',
      fontFamily: 'var(--font-ui)',
    },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: false }
);

const lixbonHighlight = HighlightStyle.define([
  { tag: t.comment, color: inkSoft, fontStyle: 'italic' },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: ink, fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.regexp], color: olive },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName)], color: earth },
  { tag: [t.typeName, t.className, t.namespace], color: pine },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: ink, fontWeight: '500' },
  { tag: [t.variableName, t.definition(t.variableName), t.local(t.variableName)], color: slate },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: prop },
  { tag: [t.labelName, t.macroName], color: slate },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'rgba(23, 23, 23, 0.7)' },
  { tag: [t.meta, t.processingInstruction], color: inkSoft },
  { tag: t.tagName, color: pine },
  { tag: t.attributeName, color: earth },
  { tag: t.heading, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.link, color: olive, textDecoration: 'underline' },
  { tag: t.invalid, color: danger },
]);

export const lixbonSyntax = syntaxHighlighting(lixbonHighlight);

// ── Variante oscura (paleta "Modo oscuro": cremas + olivo sobre #1A1913) ──

const dInk = '#F3F0E2';
const dInkSoft = 'rgba(243, 240, 226, 0.55)';
const dOlive = '#A9B86E';  // strings — accent del modo oscuro
const dEarth = '#D89B62';  // números y constantes
const dPine = '#7FB8A4';   // tipos y clases
const dSlate = '#9FB0CC';  // variables
const dProp = '#8FB0A3';   // propiedades
const dDanger = '#E0685A';

export const lixbonThemeDark = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--bg)',
      color: dInk,
      fontSize: 'var(--editor-font-size)',
    },
    '.cm-content': {
      fontFamily: 'var(--font-mono)',
      caretColor: dInk,
      padding: '12px 0',
    },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: dInk },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(169, 184, 110, 0.32)',
    },
    '.cm-selectionBackground': {
      backgroundColor: 'rgba(169, 184, 110, 0.2)',
    },
    '.cm-activeLine': { backgroundColor: 'rgba(243, 240, 226, 0.04)' },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: dInk,
    },
    '.cm-gutters': {
      backgroundColor: 'var(--bg)',
      color: 'rgba(243, 240, 226, 0.32)',
      borderRight: '1px solid var(--border-soft)',
      fontFamily: 'var(--font-mono)',
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 16px' },
    '.cm-foldGutter': { color: 'rgba(243, 240, 226, 0.32)' },
    '.cm-matchingBracket': {
      backgroundColor: 'rgba(169, 184, 110, 0.32)',
      outline: 'none',
    },
    '.cm-searchMatch': { backgroundColor: 'rgba(216, 155, 98, 0.28)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'rgba(216, 155, 98, 0.5)' },
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-secondary)',
      border: '1px solid var(--border-soft)',
      borderRadius: '10px',
      fontFamily: 'var(--font-ui)',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: 'rgba(169, 184, 110, 0.16)',
      color: dInk,
    },
    '.cm-panels': {
      backgroundColor: 'var(--bg-secondary)',
      color: dInk,
      borderTop: '1px solid var(--border-soft)',
      fontFamily: 'var(--font-ui)',
    },
    '&.cm-focused': { outline: 'none' },
  },
  { dark: true }
);

const lixbonHighlightDark = HighlightStyle.define([
  { tag: t.comment, color: dInkSoft, fontStyle: 'italic' },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword], color: dInk, fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.regexp], color: dOlive },
  { tag: [t.number, t.bool, t.null, t.atom, t.constant(t.variableName)], color: dEarth },
  { tag: [t.typeName, t.className, t.namespace], color: dPine },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: dInk, fontWeight: '500' },
  { tag: [t.variableName, t.definition(t.variableName), t.local(t.variableName)], color: dSlate },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: dProp },
  { tag: [t.labelName, t.macroName], color: dSlate },
  { tag: [t.operator, t.punctuation, t.bracket], color: 'rgba(243, 240, 226, 0.65)' },
  { tag: [t.meta, t.processingInstruction], color: dInkSoft },
  { tag: t.tagName, color: dPine },
  { tag: t.attributeName, color: dEarth },
  { tag: t.heading, fontWeight: '600' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.link, color: dOlive, textDecoration: 'underline' },
  { tag: t.invalid, color: dDanger },
]);

export const lixbonSyntaxDark = syntaxHighlighting(lixbonHighlightDark);
