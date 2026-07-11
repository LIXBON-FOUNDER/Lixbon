// jsonc.js — limpieza mínima de JSONC (comentarios y comas finales) para los
// archivos de extensiones VSCode (snippets, icon themes) que no pasan por la
// re-serialización de Rust. Respeta strings y escapes.

export function stripJsonc(src) {
  const s = String(src).replace(/^﻿/, '');
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && s[i + 1] === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  // comas finales antes de } o ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

export function parseJsonc(src) {
  return JSON.parse(stripJsonc(src));
}
