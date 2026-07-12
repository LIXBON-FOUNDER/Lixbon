// outline.js — extractor ligero de símbolos por regex (A3). No sustituye a un
// LSP (eso es A1), pero da un esquema útil sin dependencias para los lenguajes
// más comunes. Cada patrón captura el nombre en el grupo 1.

const RULES = {
  js: [
    { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z0-9_$]+)/ },
    { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/ },
    { kind: 'function', re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(?[^)]*\)?\s*=>/ },
    { kind: 'method', re: /^\s*(?:public|private|protected|static|async|get|set|\s)*\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/ },
  ],
  py: [
    { kind: 'class', re: /^\s*class\s+([A-Za-z0-9_]+)/ },
    { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)/ },
  ],
  rust: [
    { kind: 'struct', re: /^\s*(?:pub\s+)?struct\s+([A-Za-z0-9_]+)/ },
    { kind: 'enum', re: /^\s*(?:pub\s+)?enum\s+([A-Za-z0-9_]+)/ },
    { kind: 'trait', re: /^\s*(?:pub\s+)?trait\s+([A-Za-z0-9_]+)/ },
    { kind: 'impl', re: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z0-9_:<>]+)/ },
    { kind: 'function', re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/ },
  ],
  go: [
    { kind: 'struct', re: /^\s*type\s+([A-Za-z0-9_]+)\s+struct/ },
    { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/ },
  ],
  java: [
    { kind: 'class', re: /^\s*(?:public|private|protected|final|abstract|\s)*class\s+([A-Za-z0-9_]+)/ },
    { kind: 'method', re: /^\s*(?:public|private|protected|static|final|\s)+[A-Za-z0-9_<>\[\]]+\s+([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{?/ },
  ],
};

const EXT_LANG = {
  js: 'js', jsx: 'js', ts: 'js', tsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', rs: 'rust', go: 'go', java: 'java', kt: 'java', c: 'java', cpp: 'java', cs: 'java',
};

function langOf(name) {
  const base = (name || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return EXT_LANG[ext] || '';
}

/** Devuelve [{name, kind, line}] del contenido. [] si no hay reglas para el lenguaje. */
export function extractSymbols(name, content) {
  const lang = langOf(name);
  const rules = RULES[lang];
  if (!rules || !content) return [];
  const out = [];
  const lines = content.split('\n');
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('//') || line.trim().startsWith('#')) continue;
    for (const { kind, re } of rules) {
      const m = line.match(re);
      if (m && m[1]) {
        const key = `${i}:${m[1]}`;
        if (seen.has(key)) break;
        seen.add(key);
        // Filtra palabras clave que colarían por el patrón de método.
        if (/^(if|for|while|switch|catch|return|function|class|const|let|var)$/.test(m[1])) break;
        out.push({ name: m[1], kind, line: i + 1 });
        break;
      }
    }
  }
  return out;
}

export function hasOutline(name) {
  return !!RULES[langOf(name)];
}
