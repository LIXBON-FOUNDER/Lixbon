// snippets.js — snippets de extensiones VSCode como fuente de autocompletado
// de CodeMirror. Fuente única y dinámica: consulta el registro de extensiones
// en cada query, así los snippets recién instalados aplican a las pestañas ya
// abiertas sin reconfigurar estados.

import { snippetCompletion } from '@codemirror/autocomplete';
import { extReadFile } from '../lib/tauri';
import { installedLanguages, installedSnippets } from '../store/extStore';
import { parseJsonc } from './jsonc';

// Extensión de archivo → id de lenguaje de VSCode (los snippets se declaran
// contra estos ids). Las extensiones instaladas pueden aportar más lenguajes.
const EXT_TO_VSCODE_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  ts: 'typescript', tsx: 'typescriptreact', py: 'python', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less', json: 'json', jsonc: 'jsonc',
  md: 'markdown', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  java: 'java', go: 'go', php: 'php', sql: 'sql', xml: 'xml', yaml: 'yaml',
  yml: 'yaml', sh: 'shellscript', bash: 'shellscript', ps1: 'powershell',
  rb: 'ruby', lua: 'lua', kt: 'kotlin', kts: 'kotlin', cs: 'csharp',
  swift: 'swift', dart: 'dart', scala: 'scala', r: 'r', pl: 'perl',
  hs: 'haskell', jl: 'julia', clj: 'clojure', erl: 'erlang', vue: 'vue',
  svelte: 'svelte', toml: 'toml', dockerfile: 'dockerfile',
};

/** Id de lenguaje VSCode para un archivo (extensiones instaladas primero). */
export function vscodeLangIdFor(fileName) {
  const lower = (fileName || '').toLowerCase();
  for (const l of installedLanguages()) {
    if ((l.filenames || []).some((f) => String(f).toLowerCase() === lower)) return l.id;
    if ((l.extensions || []).some((e) => lower.endsWith(String(e).toLowerCase()))) return l.id;
  }
  if (lower === 'dockerfile') return 'dockerfile';
  const ext = lower.includes('.') ? lower.split('.').pop() : '';
  return EXT_TO_VSCODE_LANG[ext] || null;
}

/** Body de snippet VSCode → sintaxis de snippet de CodeMirror. */
function toCmSnippet(body) {
  const text = Array.isArray(body) ? body.join('\n') : String(body ?? '');
  return text
    // ${1|uno,dos|} → ${1:uno} (CM no tiene choices)
    .replace(/\$\{(\d+)\|([^|}]*)[^}]*\}/g, (_, n, choices) => `\${${n}:${choices.split(',')[0]}}`)
    // variables ($TM_FILENAME, ${TM_SELECTED_TEXT:x}…) → fuera
    .replace(/\$\{[A-Z_]+(?::([^}]*))?\}/g, '$1')
    .replace(/\$[A-Z_]+/g, '')
    // $0 (tabstop final) → campo vacío final
    .replace(/\$0/g, '${}')
    // $1 → ${1}
    .replace(/\$(\d+)/g, (_, n) => `\${${n}}`);
}

// Caché por archivo de snippets: `${extId}:${path}` → [Completion]
const cache = new Map();

async function completionsFor(lang) {
  const files = installedSnippets()[lang] || [];
  const out = [];
  for (const f of files) {
    const key = `${f.extId}:${f.path}`;
    if (!cache.has(key)) {
      try {
        const json = parseJsonc(await extReadFile(f.extId, f.path));
        const comps = [];
        for (const [name, def] of Object.entries(json)) {
          if (!def || typeof def !== 'object') continue;
          const prefixes = Array.isArray(def.prefix) ? def.prefix : [def.prefix || name];
          const snip = toCmSnippet(def.body);
          if (!snip) continue;
          for (const p of prefixes) {
            if (!p) continue;
            comps.push(snippetCompletion(snip, {
              label: String(p),
              detail: name,
              type: 'snippet',
              info: def.description ? String(def.description) : undefined,
            }));
          }
        }
        cache.set(key, comps);
      } catch {
        cache.set(key, []);
      }
    }
    out.push(...cache.get(key));
  }
  return out;
}

/** Fuente de autocompletado para un archivo. Se registra vía languageData
    en openFile; convive con el autocompletado del lenguaje (basicSetup). */
export function snippetSource(fileName) {
  return async (context) => {
    const word = context.matchBefore(/[\w$]+/);
    if (!word && !context.explicit) return null;
    const lang = vscodeLangIdFor(fileName);
    if (!lang) return null;
    const options = await completionsFor(lang);
    if (!options.length) return null;
    return {
      from: word ? word.from : context.pos,
      options,
      validFor: /^[\w$]*$/,
    };
  };
}
