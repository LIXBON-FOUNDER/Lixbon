// languages.js — mapa extensión de archivo → soporte de lenguaje CodeMirror 6.
// Imports estáticos: cubren el grueso del uso; el bundle lo tolera. Los lenguajes
// menos comunes (toml, ini, shell, dockerfile) vienen de @codemirror/legacy-modes.

import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { rust } from '@codemirror/lang-rust';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { go } from '@codemirror/lang-go';
import { php } from '@codemirror/lang-php';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { StreamLanguage } from '@codemirror/language';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { properties } from '@codemirror/legacy-modes/mode/properties';

const stream = (mode) => StreamLanguage.define(mode);

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
  jsonc: () => json(),
  md: () => markdown(),
  markdown: () => markdown(),
  rs: () => rust(),
  c: () => cpp(),
  h: () => cpp(),
  cpp: () => cpp(),
  cc: () => cpp(),
  cxx: () => cpp(),
  hpp: () => cpp(),
  hh: () => cpp(),
  java: () => java(),
  go: () => go(),
  php: () => php(),
  sql: () => sql(),
  xml: () => xml(),
  svg: () => xml(),
  yaml: () => yaml(),
  yml: () => yaml(),
  toml: () => stream(toml),
  sh: () => stream(shell),
  bash: () => stream(shell),
  zsh: () => stream(shell),
  dockerfile: () => stream(dockerFile),
  ini: () => stream(properties),
  conf: () => stream(properties),
  env: () => stream(properties),
};

// Archivos sin extensión reconocidos por nombre exacto (minúsculas).
const BY_NAME = {
  dockerfile: () => stream(dockerFile),
  makefile: () => stream(shell),
  '.env': () => stream(properties),
  '.gitignore': () => stream(properties),
};

/** Devuelve la extensión de lenguaje para un nombre de archivo, o [] si no hay. */
export function languageFor(fileName) {
  const lower = (fileName || '').toLowerCase();
  const byName = BY_NAME[lower];
  if (byName) return [byName()];
  const ext = lower.split('.').pop() || '';
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
    rs: 'rust', toml: 'toml', yml: 'yaml', yaml: 'yaml', sh: 'bash', bash: 'bash',
    sql: 'sql', vue: 'vue', svelte: 'svelte', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp',
    hpp: 'cpp', java: 'java', go: 'go', php: 'php', xml: 'xml', ini: 'ini',
    dockerfile: 'dockerfile',
  };
  return labels[ext] || ext || '';
}
