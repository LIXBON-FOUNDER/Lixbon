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
import { csharp, kotlin, scala, dart, objectiveC } from '@codemirror/legacy-modes/mode/clike';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { r } from '@codemirror/legacy-modes/mode/r';
import { swift } from '@codemirror/legacy-modes/mode/swift';
import { haskell } from '@codemirror/legacy-modes/mode/haskell';
import { julia } from '@codemirror/legacy-modes/mode/julia';
import { groovy } from '@codemirror/legacy-modes/mode/groovy';
import { clojure } from '@codemirror/legacy-modes/mode/clojure';
import { erlang } from '@codemirror/legacy-modes/mode/erlang';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { cmake } from '@codemirror/legacy-modes/mode/cmake';
import { pascal } from '@codemirror/legacy-modes/mode/pascal';
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf';

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
  cs: () => stream(csharp),
  kt: () => stream(kotlin),
  kts: () => stream(kotlin),
  scala: () => stream(scala),
  sbt: () => stream(scala),
  dart: () => stream(dart),
  m: () => stream(objectiveC),
  rb: () => stream(ruby),
  lua: () => stream(lua),
  pl: () => stream(perl),
  pm: () => stream(perl),
  r: () => stream(r),
  swift: () => stream(swift),
  hs: () => stream(haskell),
  jl: () => stream(julia),
  groovy: () => stream(groovy),
  gradle: () => stream(groovy),
  clj: () => stream(clojure),
  cljs: () => stream(clojure),
  edn: () => stream(clojure),
  erl: () => stream(erlang),
  hrl: () => stream(erlang),
  ps1: () => stream(powerShell),
  psm1: () => stream(powerShell),
  psd1: () => stream(powerShell),
  cmake: () => stream(cmake),
  pas: () => stream(pascal),
  proto: () => stream(protobuf),
};

// Archivos sin extensión reconocidos por nombre exacto (minúsculas).
const BY_NAME = {
  dockerfile: () => stream(dockerFile),
  makefile: () => stream(shell),
  'cmakelists.txt': () => stream(cmake),
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

/** Resolución completa: 1º lezer/legacy (mejor calidad, sin WASM); 2º gramática
    TextMate de una extensión instalada; 3º texto plano. Nunca lanza. */
export async function resolveLanguage(fileName) {
  const builtin = languageFor(fileName);
  if (builtin.length) return builtin;
  try {
    const { textmateLanguageFor } = await import('./textmate');
    return await textmateLanguageFor(fileName);
  } catch (e) {
    console.warn('[editor] Resaltado TextMate no disponible:', e);
    return [];
  }
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
    dockerfile: 'dockerfile', cs: 'csharp', kt: 'kotlin', kts: 'kotlin',
    scala: 'scala', dart: 'dart', m: 'objectivec', rb: 'ruby', lua: 'lua',
    pl: 'perl', r: 'r', swift: 'swift', hs: 'haskell', jl: 'julia',
    groovy: 'groovy', gradle: 'groovy', clj: 'clojure', erl: 'erlang',
    ps1: 'powershell', cmake: 'cmake', pas: 'pascal', proto: 'protobuf',
  };
  return labels[ext] || ext || '';
}
