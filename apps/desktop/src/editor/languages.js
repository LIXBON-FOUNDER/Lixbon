// languages.js — mapa extensión de archivo → soporte de lenguaje CodeMirror 6.
// Imports estáticos: 7 lenguajes cubren el grueso del uso; el bundle lo tolera.

import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';

const BY_EXT = {
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ typescript: true, jsx: true }),
  py: () => python(),
  html: () => html(),
  htm: () => html(),
  vue: () => html(),
  svelte: () => html(),
  css: () => css(),
  scss: () => css(),
  less: () => css(),
  json: () => json(),
  md: () => markdown(),
  markdown: () => markdown(),
  rs: () => rust(),
};

/** Devuelve la extensión de lenguaje para un nombre de archivo, o [] si no hay. */
export function languageFor(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const factory = BY_EXT[ext];
  return factory ? [factory()] : [];
}

/** Etiqueta de lenguaje para bloques markdown del chat (```lang). */
export function languageLabel(fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const labels = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    ts: 'typescript', tsx: 'tsx', py: 'python', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less', json: 'json', md: 'markdown',
    rs: 'rust', toml: 'toml', yml: 'yaml', yaml: 'yaml', sh: 'bash',
    sql: 'sql', vue: 'vue', svelte: 'svelte',
  };
  return labels[ext] || ext || '';
}
