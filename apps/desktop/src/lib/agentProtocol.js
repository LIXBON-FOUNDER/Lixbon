// agentProtocol.js — parte PURA del modo agente (sin Tauri ni DOM):
// parseo de tool calls embebidos, limpieza de texto y diff barato.
// Espejo del protocolo del CLI (apps/cli/lixbon_cli/agent.py).

export const MAX_AGENT_STEPS = 8;
export const READ_ONLY_TOOLS = new Set(['list_files', 'read_file', 'search']);

/** Normaliza la ruta relativa que dio el modelo; rechaza absolutas y '..'. */
export function normalizeRel(rel) {
  const clean = String(rel ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!clean || clean === '.') return '';
  if (/^[a-zA-Z]:/.test(clean) || clean.split('/').includes('..')) {
    throw new Error(`Ruta fuera del workspace: ${rel}`);
  }
  return clean;
}

/** JSON.parse tolerante: escapa saltos de línea reales dentro de strings
    (JSON inválido pero frecuente en LLMs pequeños). */
function parseLoose(candidate) {
  try {
    return JSON.parse(candidate);
  } catch { /* segundo intento abajo */ }
  let out = '';
  let inString = false;
  let escapeNext = false;
  for (const ch of candidate) {
    if (escapeNext) {
      out += ch;
      escapeNext = false;
    } else if (ch === '\\' && inString) {
      out += ch;
      escapeNext = true;
    } else if (ch === '"') {
      inString = !inString;
      out += ch;
    } else if (inString && (ch === '\n' || ch === '\r' || ch === '\t')) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : '\\t';
    } else {
      out += ch;
    }
  }
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function iterToolCallSpans(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    const plain = text.indexOf('{"tool"', i);
    const spaced = text.indexOf('{ "tool"', i);
    let start = plain;
    if (start === -1 || (spaced !== -1 && spaced < start)) start = spaced;
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escapeNext = false;
    let closed = false;
    let j = start;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === '\\' && inString) {
        escapeNext = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            const data = parseLoose(text.slice(start, j + 1));
            if (data && typeof data === 'object' && data.tool) {
              if (!data.args || typeof data.args !== 'object') data.args = {};
              spans.push({ call: data, start, end: j + 1 });
            }
            i = j + 1;
            closed = true;
            break;
          }
        }
      }
    }
    if (!closed) break; // JSON sin cerrar (stream a medias): se deja
  }
  return spans;
}

export function extractToolCalls(text) {
  return iterToolCallSpans(text).map((s) => s.call);
}

export function stripToolCalls(text) {
  const spans = iterToolCallSpans(text);
  for (let k = spans.length - 1; k >= 0; k--) {
    text = text.slice(0, spans[k].start) + text.slice(spans[k].end);
  }
  return text;
}

/** Texto mostrable durante el streaming: sin JSON completo ni JSON a medias. */
export function displayableText(text) {
  let out = stripToolCalls(text);
  for (const needle of ['{"tool"', '{ "tool"']) {
    const idx = out.indexOf(needle);
    if (idx !== -1) out = out.slice(0, idx);
  }
  return out;
}

/** Diff barato por líneas: recorta prefijo/sufijo comunes y cuenta el resto. */
export function diffCounts(oldText, newText) {
  const a = oldText ? oldText.split('\n') : [];
  const b = newText ? newText.split('\n') : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removedLines = a.slice(start, endA);
  const addedLines = b.slice(start, endB);
  return {
    added: addedLines.length,
    removed: removedLines.length,
    sampleOld: removedLines.slice(0, 10),
    sampleNew: addedLines.slice(0, 10),
  };
}
