// lixbonTheme.js — temas claro y oscuro de CodeMirror 6 con los tokens lixbon.
// Sintaxis con paleta rica (cada familia de token tiene su color propio) sobre
// el chrome del IDE. Contraste AA sobre los fondos claro (#fff) y oscuro (#1A1913).
// El fondo usa var(--bg): el modo (data-theme) ya pinta la superficie correcta.

import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const ink = '#171717';
const inkSoft = 'rgba(23, 23, 23, 0.55)';
// Paleta clara (familia One Light, ajustada a la identidad lixbon)
const lComment = '#8b9096';
const lKeyword = '#a626a4';   // keywords — magenta
const lFunc = '#3861d6';      // funciones — azul
const lType = '#b78307';      // tipos y clases — dorado
const lString = '#50a14f';    // strings — verde
const lNumber = '#b76201';    // números y constantes — naranja
const lVar = '#e45649';       // variables y tags — coral
const lProp = '#c05a3d';      // propiedades
const lOper = '#0184bc';      // operadores, regexp y escapes — cian
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
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: lComment, fontStyle: 'italic' },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: lKeyword, fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.character, t.docString], color: lString },
  { tag: [t.regexp, t.escape], color: lOper },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit], color: lNumber },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: lNumber },
  { tag: [t.typeName, t.className, t.namespace, t.annotation], color: lType },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: lFunc, fontWeight: '500' },
  { tag: [t.variableName, t.definition(t.variableName)], color: lVar },
  { tag: [t.local(t.variableName), t.special(t.variableName)], color: lProp, fontStyle: 'italic' },
  { tag: t.self, color: lKeyword, fontStyle: 'italic' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: lProp },
  { tag: t.labelName, color: lNumber },
  { tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator, t.updateOperator, t.derefOperator], color: lOper },
  { tag: [t.punctuation, t.separator, t.bracket], color: 'rgba(23, 23, 23, 0.62)' },
  { tag: [t.meta, t.processingInstruction, t.documentMeta], color: inkSoft },
  { tag: t.tagName, color: lVar },
  { tag: [t.attributeName, t.attributeValue], color: lNumber },
  { tag: t.heading, color: lKeyword, fontWeight: '650' },
  { tag: t.quote, color: lString, fontStyle: 'italic' },
  { tag: t.monospace, color: lProp },
  { tag: t.inserted, color: lString },
  { tag: t.deleted, color: lVar },
  { tag: t.changed, color: lNumber },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: [t.link, t.url], color: lFunc, textDecoration: 'underline' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: danger },
]);

export const lixbonSyntax = syntaxHighlighting(lixbonHighlight);

// ── Variante oscura (paleta "Modo oscuro": cremas + olivo sobre #1A1913) ──

const dInk = '#F3F0E2';
const dInkSoft = 'rgba(243, 240, 226, 0.55)';
// Paleta oscura (familia One Dark, ajustada al fondo crema-oscuro #1A1913)
const dComment = '#8a8574';
const dKeyword = '#c678dd';   // keywords — lila
const dFunc = '#61afef';      // funciones — azul
const dType = '#e5c07b';      // tipos y clases — dorado
const dString = '#98c379';    // strings — verde
const dNumber = '#d19a66';    // números y constantes — naranja
const dVar = '#e06c75';       // variables y tags — coral
const dProp = '#d8985f';      // propiedades
const dOper = '#56b6c2';      // operadores, regexp y escapes — cian
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
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: dComment, fontStyle: 'italic' },
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: dKeyword, fontWeight: '600' },
  { tag: [t.string, t.special(t.string), t.character, t.docString], color: dString },
  { tag: [t.regexp, t.escape], color: dOper },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit], color: dNumber },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: dNumber },
  { tag: [t.typeName, t.className, t.namespace, t.annotation], color: dType },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: dFunc, fontWeight: '500' },
  { tag: [t.variableName, t.definition(t.variableName)], color: dVar },
  { tag: [t.local(t.variableName), t.special(t.variableName)], color: dProp, fontStyle: 'italic' },
  { tag: t.self, color: dKeyword, fontStyle: 'italic' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: dProp },
  { tag: t.labelName, color: dNumber },
  { tag: [t.operator, t.arithmeticOperator, t.logicOperator, t.compareOperator, t.updateOperator, t.derefOperator], color: dOper },
  { tag: [t.punctuation, t.separator, t.bracket], color: 'rgba(243, 240, 226, 0.6)' },
  { tag: [t.meta, t.processingInstruction, t.documentMeta], color: dInkSoft },
  { tag: t.tagName, color: dVar },
  { tag: [t.attributeName, t.attributeValue], color: dNumber },
  { tag: t.heading, color: dKeyword, fontWeight: '650' },
  { tag: t.quote, color: dString, fontStyle: 'italic' },
  { tag: t.monospace, color: dProp },
  { tag: t.inserted, color: dString },
  { tag: t.deleted, color: dVar },
  { tag: t.changed, color: dNumber },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: [t.link, t.url], color: dFunc, textDecoration: 'underline' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.invalid, color: dDanger },
]);

export const lixbonSyntaxDark = syntaxHighlighting(lixbonHighlightDark);
