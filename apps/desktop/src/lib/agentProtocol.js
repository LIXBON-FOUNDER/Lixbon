// agentProtocol.js — parte PURA del modo agente (sin Tauri ni DOM):
// parseo de tool calls embebidos, limpieza de texto y diff barato.
// Espejo del protocolo del CLI (apps/cli/lixbon_cli/agent.py).

// Tope de pasos por turno. Es un cortafuegos contra bucles, NO un presupuesto
// de trabajo: leer varios archivos, editarlos, lanzar los tests y corregir se
// come 8 pasos enseguida, y el turno moría ahí borrando la burbuja vacía, sin
// decir nada. Ahora hay margen de sobra y, si se alcanza, se explica.
export const MAX_AGENT_STEPS = 40;

// Tandas de llamadas idénticas seguidas que se toleran: un modelo atascado
// repite la misma herramienta con los mismos argumentos indefinidamente.
export const MAX_REPEATED_CALLS = 3;
export const READ_ONLY_TOOLS = new Set([
  'list_files', 'read_file', 'search', 'search_codebase',
  'find_files', 'outline', 'fetch_url', 'web_search',
]);

// ── Seguridad de run_command (B4) ──────────────────────────────────────
// Prefijos de comandos considerados seguros: se ejecutan sin pedir aprobación
// aunque el auto-aplicado de archivos esté activo. Editable por el usuario
// (Ajustes → Agente). Solo aplica a comandos SIN encadenamiento/redirección.
// Fuera de la lista quedan a propósito los intérpretes directos (node, python,
// deno) y los instaladores (npm install, npx, pip): ejecutan código arbitrario
// que no es del proyecto, y con auto-run un prompt injection en un archivo
// leído por el agente bastaría para correr lo que quiera sin aprobación.
export const DEFAULT_CMD_ALLOWLIST = [
  'npm test', 'npm run', 'npm ci', 'pnpm test', 'pnpm run', 'yarn test', 'yarn run',
  'cargo build', 'cargo test', 'cargo check', 'cargo run', 'cargo clippy', 'cargo fmt',
  'pytest', 'ruff', 'black', 'mypy',
  'go build', 'go test', 'go run', 'go vet',
  'git status', 'git diff', 'git log', 'git branch', 'git rev-parse', 'git show',
  'ls', 'pwd', 'echo', 'cat', 'tsc', 'eslint', 'prettier', 'make',
];

// Encadenamiento, subshell o redirección: `cmd && rm -rf`, `a | b`, `$(...)`,
// `> archivo`. Con cualquiera de estos, NUNCA se auto-permite (siempre aprueba).
const CMD_CHAIN_RE = /[;&|`]|\$\(|>|<|\r|\n/;

// Aunque el usuario amplíe su allowlist, estos patrones SIEMPRE piden
// aprobación: ejecutan código externo/arbitrario (npx, curl→sh, flags de
// evaluación tipo `node -e` / `python -c` / `powershell -Command`) o instalan
// paquetes nuevos (cuyos scripts postinstall corren al instalar), o borran.
const CMD_NEVER_AUTO_RE = new RegExp(
  '(^|\\s)(npx|dlx|curl|wget|rm|del|rmdir|rd|mklink|format)(\\s|$)'
  + '|(^|\\s)--?eval(\\s|=|$)'
  + '|(^|\\s)-(c|e|command|encodedcommand)(\\s|$)'
  + '|(^|\\s)(npm|pnpm|yarn|pip|pip3|cargo|gem|composer)\\s+(install|i|add|uninstall|remove)(\\s|$)',
  'i',
);

/** ¿Es un comando que exige aprobación SIEMPRE, incluso con auto-run activo? */
export function isNeverAutoCommand(command) {
  const cmd = String(command ?? '').trim();
  return !cmd || CMD_CHAIN_RE.test(cmd) || CMD_NEVER_AUTO_RE.test(cmd);
}

/** ¿El comando puede ejecutarse sin aprobación según la allowlist? */
export function isAllowedCommand(command, allowlist = DEFAULT_CMD_ALLOWLIST) {
  const cmd = String(command ?? '').trim();
  if (!cmd || CMD_CHAIN_RE.test(cmd) || CMD_NEVER_AUTO_RE.test(cmd)) return false;
  const lower = cmd.toLowerCase();
  return allowlist.some((p) => {
    const pref = String(p).trim().toLowerCase();
    return pref && (lower === pref || lower.startsWith(pref + ' '));
  });
}

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

// `{` + cualquier espacio + `"tool"` (nuestro formato) o `"name"` (formato
// función de OpenAI, que emiten los modelos primados con tools, p.ej.
// qwen2.5-coder). Los modelos suelen indentar el JSON ({\n  "tool": …).
const TOOL_START_RE = /\{\s*"(tool|name)"/g;

/** Escanea el objeto JSON candidato que empieza en `start` (debe ser '{').
    Toggle simple de comillas (JSON bien formado): funciona para la inmensa
    mayoría de las llamadas. Devuelve el índice tras el '}' de cierre, o -1
    si no cierra en el texto. */
function scanBalanced(text, start) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let j = start; j < text.length; j++) {
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
        if (depth === 0) return j + 1;
      }
    }
  }
  return -1;
}

/** JSON.parse tolerante: solo escapa saltos de línea reales dentro de
    strings (JSON inválido pero frecuente en LLMs pequeños). No intenta
    arreglar comillas sueltas: eso lo hace repairBySchema, que conoce la
    forma exacta de cada herramienta y no se confunde con el propio JSON
    (o CSS) que vaya dentro de un valor largo. */
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

// Campos de `args` por herramienta, en el orden del system prompt. Solo se
// usa para reparar llamadas con JSON roto (ver repairBySchema); espejo del
// switch de executeToolCall en agent.js.
const TOOL_ARG_KEYS = {
  list_files: ['path'],
  find_files: ['pattern'],
  outline: ['path'],
  read_file: ['path', 'start_line', 'end_line'],
  write_file: ['path', 'content'],
  edit_file: ['path', 'old_text', 'new_text', 'all'],
  insert_at_line: ['path', 'line', 'content'],
  append_file: ['path', 'content'],
  mkdir: ['path'],
  search: ['pattern'],
  search_codebase: ['query'],
  delete_file: ['path'],
  rename_file: ['src', 'dst'],
  run_command: ['command', 'timeout'],
  fetch_url: ['url'],
  web_search: ['query', 'limit'],
  // multi_edit queda fuera: `edits` es un array anidado, no un campo de texto
  // plano — cae al escaneo genérico (scanBalanced + parseLoose).
};

function unescapeBasic(s) {
  return s.replace(/\\(["\\/nrt])/g, (_, c) => (
    { '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t' }[c]
  ));
}

/** Repara {"tool":"...","args":{...}} campo a campo cuando el modelo dejó
    comillas o backslashes sin escapar DENTRO de un valor largo (el caso
    típico: CSS/HTML con `font-family: "Segoe UI"` metido tal cual en el
    `content` de un write_file). El conteo de llaves genérico no puede
    distinguir esas comillas de las que de verdad cierran el string —el CSS
    trae sus propias llaves y comillas—, así que en vez de adivinar se busca,
    para cada campo, el siguiente delimitador que SÍ conocemos: el nombre
    literal de otra clave de esta misma herramienta (`,"content":`) o el
    cierre del objeto (`"}`). Null si `tool` no es de los nuestros o el JSON
    no sigue esta forma exacta — así el llamador cae al escaneo genérico. */
function repairBySchema(text, start) {
  const head = /^\{\s*"tool"\s*:\s*"([^"]*)"\s*,\s*"args"\s*:\s*\{/.exec(text.slice(start, start + 200));
  if (!head) return null;
  const tool = head[1];
  const keys = TOOL_ARG_KEYS[tool];
  if (!keys) return null;
  let i = start + head[0].length;
  const args = {};
  const remaining = new Set(keys);
  for (;;) {
    while (i < text.length && /[\s,]/.test(text[i])) i++;
    if (text[i] === '}') { i++; break; }
    const keyM = /^"([a-zA-Z_]+)"\s*:\s*/.exec(text.slice(i));
    if (!keyM || !remaining.has(keyM[1])) return null;
    const key = keyM[1];
    i += keyM[0].length;
    remaining.delete(key);
    if (text[i] === '"') {
      i += 1; // dentro del valor string
      const otherKeys = [...remaining].map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const stopRe = otherKeys.length
        ? new RegExp(`"\\s*,\\s*"(?:${otherKeys.join('|')})"\\s*:|"\\s*\\}`)
        : /"\s*\}/;
      const rest = text.slice(i);
      const stopM = stopRe.exec(rest);
      if (!stopM) return null; // el valor sigue abierto: streaming a medias
      args[key] = unescapeBasic(rest.slice(0, stopM.index));
      i += stopM.index + 1;
    } else {
      const valM = /^(true|false|null|-?\d+(?:\.\d+)?)/.exec(text.slice(i));
      if (!valM) return null;
      args[key] = JSON.parse(valM[0]);
      i += valM[0].length;
    }
  }
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '}') return null;
  return { call: { tool, args }, end: i + 1 };
}

/** Localiza el final de la llamada que empieza en `start` (debe apuntar a
    su '{'). Primero intenta la reparación consciente del esquema (robusta
    ante comillas/llaves sin escapar en valores largos); si no aplica, cae al
    escaneo genérico de llaves + parseLoose. Null si el JSON sigue abierto. */
function findToolCallEnd(text, start) {
  const fixed = repairBySchema(text, start);
  if (fixed) return fixed;
  const end = scanBalanced(text, start);
  return end === -1 ? null : { call: normalizeCall(parseLoose(text.slice(start, end))), end };
}

/** Encuentra los objetos con forma de tool-call en el texto. Se incluyen
    también los que cierran pero cuyo JSON no se pudo interpretar (`call:
    null`): un intento de llamada roto NUNCA debe mostrarse crudo en el chat,
    aunque no se pueda ejecutar — stripToolCalls los quita a todos, y solo
    extractToolCalls filtra los válidos. */
function iterToolCallSpans(text) {
  const spans = [];
  let i = 0;
  while (i < text.length) {
    TOOL_START_RE.lastIndex = i;
    const m = TOOL_START_RE.exec(text);
    if (!m) break;
    const start = m.index;
    const found = findToolCallEnd(text, start);
    if (!found) break; // JSON sin cerrar (stream a medias): se deja
    spans.push({ call: found.call, start, end: found.end });
    i = found.end;
  }
  return spans;
}

export function extractToolCalls(text) {
  return iterToolCallSpans(text).filter((s) => s.call).map((s) => s.call);
}

export function stripToolCalls(text) {
  const spans = iterToolCallSpans(text);
  for (let k = spans.length - 1; k >= 0; k--) {
    text = text.slice(0, spans[k].start) + text.slice(spans[k].end);
  }
  return text;
}

/** ¿Hubo un intento de tool-call cuyo JSON no se pudo interpretar (comillas
    o escapes rotos)? Sirve para pedirle al modelo que lo repita en vez de
    terminar el turno en silencio como si no hubiera pasado nada. */
export function hasInvalidCall(text) {
  return iterToolCallSpans(text).some((s) => !s.call);
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

/** Corta un tool-call JSON iniciado pero SIN CERRAR al final del texto
    (salida truncada por límite de tokens al reescribir un archivo grande):
    evita que el JSON crudo se filtre al chat. Solo mira el ÚLTIMO inicio. */
export function cutUnclosedCall(text) {
  TOOL_START_RE.lastIndex = 0;
  let m;
  let lastStart = -1;
  while ((m = TOOL_START_RE.exec(text)) !== null) lastStart = m.index;
  if (lastStart === -1) return text;
  return findToolCallEnd(text, lastStart) ? text : text.slice(0, lastStart);
}

/** ¿El texto termina con un tool-call truncado (iniciado sin cerrar)? */
export function hasUnclosedCall(text) {
  return cutUnclosedCall(text).length < text.length;
}

/** Prosa final mostrable: sin tool calls (completos ni truncados), sin
    TOOL_RESULT fabricados y sin las vallas de código vacías. */
export function cleanProse(text) {
  return cutUnclosedCall(stripToolCalls(truncateFabricated(text)))
    .replace(/```[\w-]*\s*```/g, '')
    .replace(/```[\w-]*\s*$/, '')
    .trim();
}

/** Texto mostrable durante el streaming: sin JSON completo, a medias ni
    vallas huérfanas. */
export function displayableText(text) {
  let out = cutUnclosedCall(stripToolCalls(truncateFabricated(text)));
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
