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

// `{` + cualquier espacio + `"tool"` (nuestro formato) o `"name"` (formato
// función de OpenAI, que emiten los modelos primados con tools, p.ej.
// qwen2.5-coder). Los modelos suelen indentar el JSON ({\n  "tool": …).
const TOOL_START_RE = /\{\s*"(tool|name)"/g;

/** Normaliza un objeto a {tool, args}. Acepta {tool,args} y {name,arguments}
    (formato función OpenAI). Devuelve null si no parece una llamada. */
function normalizeCall(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.tool) {
    return { tool: data.tool, args: data.args && typeof data.args === 'object' ? data.args : {} };
  }
  // {name, arguments}: solo si trae arguments (evita falsos positivos de
  // cualquier objeto con un campo "name").
  if (data.name && data.arguments !== undefined) {
    let a = data.arguments;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
    return { tool: data.name, args: a && typeof a === 'object' ? a : {} };
  }
  return null;
}

function iterToolCallSpans(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    TOOL_START_RE.lastIndex = i;
    const m = TOOL_START_RE.exec(text);
    if (!m) break;
    const start = m.index;
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
            const call = normalizeCall(parseLoose(text.slice(start, j + 1)));
            if (call) spans.push({ call, start, end: j + 1 });
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

/** Corta la salida donde el modelo empieza a fabricar resultados de
    herramientas ("TOOL_RESULT …"): los LLMs pequeños se contestan a sí
    mismos imitando el ejemplo del prompt, y todo lo posterior es alucinado. */
export function truncateFabricated(text) {
  const idx = text.indexOf('TOOL_RESULT');
  if (idx === -1) return text;
  const lineStart = text.lastIndexOf('\n', idx);
  return text.slice(0, lineStart === -1 ? idx : lineStart);
}

/** Prosa final mostrable: sin tool calls, sin TOOL_RESULT fabricados y sin
    las vallas de código vacías que quedan al extraer el JSON (```json```). */
export function cleanProse(text) {
  return stripToolCalls(truncateFabricated(text))
    .replace(/```[\w-]*\s*```/g, '')
    .trim();
}

/** Texto mostrable durante el streaming: sin JSON completo, a medias ni
    vallas huérfanas. */
export function displayableText(text) {
  let out = stripToolCalls(truncateFabricated(text));
  for (const needle of ['{"tool"', '{ "tool"']) {
    const idx = out.indexOf(needle);
    if (idx !== -1) out = out.slice(0, idx);
  }
  out = out.replace(/```[\w-]*\s*```/g, '');
  out = out.replace(/```[\w-]*\s*$/, ''); // valla abierta al final del stream
  return out;
}

/** Separa el razonamiento `<think>…</think>` del texto visible. Tolera el
    tag sin cerrar (streaming): lo que sigue a <think> es razonamiento. */
export function splitThinking(text) {
  let thinking = '';
  let visible = '';
  let rest = text;
  for (;;) {
    const open = rest.indexOf('<think>');
    if (open === -1) {
      visible += rest;
      break;
    }
    visible += rest.slice(0, open);
    const close = rest.indexOf('</think>', open + 7);
    if (close === -1) {
      thinking += rest.slice(open + 7);
      break;
    }
    thinking += rest.slice(open + 7, close) + '\n';
    rest = rest.slice(close + 8);
  }
  return { thinking: thinking.trim(), visible };
}

/** Reconstruye el historial que ve el modelo a partir de las burbujas del
    chat. En modo agente cada fila de herramienta vuelve como una llamada del
    asistente (su JSON) + su TOOL_RESULT, para que el modelo vea que aquí SÍ se
    usan herramientas — si no, aprende de su propia prosa a dejar de usarlas. */
export function buildModelHistory(messages, agentActive) {
  return messages.flatMap((m) => {
    if (m.role === 'user' && m.content) return [{ role: 'user', content: m.content }];
    if (m.role === 'assistant' && (m.content || '').trim()) {
      return [{ role: 'assistant', content: m.content }];
    }
    if (agentActive && m.role === 'tool') {
      const callJson = JSON.stringify({ tool: m.tool, args: m.args || {} });
      return [
        { role: 'assistant', content: callJson },
        { role: 'user', content: `TOOL_RESULT ${m.tool}: ${m.full || m.content || ''}` },
      ];
    }
    return [];
  });
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
