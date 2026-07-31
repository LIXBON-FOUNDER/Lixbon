// agentContext.js — presupuesto de la ventana de contexto del turno de agente.
// Espejo de apps/cli/lixbon_cli/context.py: mismo problema, misma solución.
//
// En modo agente el prompt no son solo los mensajes del chat: son también los
// resultados de cada herramienta. Un `read_file` aporta decenas de miles de
// caracteres, así que en pocos pasos el prompt supera el `num_ctx` que se le
// pide a Ollama. Y cuando eso pasa Ollama no falla: descarta el principio del
// prompt, que es justo donde van el system prompt y las definiciones de
// herramientas. El modelo se queda sin instrucciones, "piensa" el tiempo que
// tarda en reprocesar toda la ventana (decenas de segundos) y devuelve una
// respuesta vacía. El turno se acaba solo y el agente parece congelado.

// Fracción de la ventana reservada al PROMPT; el resto es para generar.
export const PROMPT_BUDGET_RATIO = 0.65;

// Conservador a propósito: el código y el JSON de las herramientas rinden peor
// que la prosa, y quedarse corto aquí es justo lo que causa el desbordamiento.
export const CHARS_PER_TOKEN = 3.2;

// Lo que un resultado de herramienta aporta al contexto del modelo. El usuario
// sigue viendo la salida completa en su fila del chat.
export const MAX_TOOL_OUTPUT_CHARS = 6000;

// Los resultados que ya no son del paso en curso valen mucho menos.
export const MAX_OLD_TOOL_OUTPUT_CHARS = 1200;

// Mensajes finales que nunca se podan (el paso actual y su contexto inmediato).
export const KEEP_RECENT = 6;

const PRUNE_NOTE = '[Nota del sistema: los pasos más antiguos de este turno se han '
  + 'recortado para no desbordar la ventana de contexto. Si necesitas algo de un '
  + 'archivo que ya leíste, vuelve a leerlo.]';

/** Tokens aproximados de una lista de mensajes (incluye el JSON de tool_calls). */
export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages || []) {
    chars += (m?.content || '').length;
    if (m?.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    chars += 16; // separadores del template
  }
  return Math.round(chars / CHARS_PER_TOKEN);
}

/** Coste de las definiciones de herramientas, que Ollama inyecta en el template. */
export function toolsTokens(tools) {
  if (!tools || !tools.length) return 0;
  return Math.round(JSON.stringify(tools).length / CHARS_PER_TOKEN);
}

/** Recorta por el MEDIO: en un read_file importa el principio y en un
    run_command importa el final (el error), así que se conservan ambos. */
export function clipToolOutput(text, limit = MAX_TOOL_OUTPUT_CHARS) {
  const value = text || '';
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.6);
  const tail = limit - head;
  const omitted = value.length - limit;
  return `${value.slice(0, head)}\n…[recortado: ${omitted} caracteres omitidos]…\n${value.slice(-tail)}`;
}

/** ¿Es el resultado de una herramienta? Cubre los dos protocolos: role="tool"
    (nativo) y el mensaje de usuario `TOOL_RESULT …` (texto). */
function isToolResult(msg) {
  if (msg?.role === 'tool') return true;
  return msg?.role === 'user' && (msg?.content || '').trimStart().startsWith('TOOL_RESULT');
}

/** Adelgaza el detalle de los resultados que ya no son recientes, conservando
    la estructura del turno (el modelo sigue viendo qué hizo y en qué orden). */
export function shrinkOldResults(messages, keepRecent = KEEP_RECENT,
                                 limit = MAX_OLD_TOOL_OUTPUT_CHARS) {
  if (messages.length <= keepRecent) return messages;
  const cut = messages.length - keepRecent;
  return messages.map((msg, i) => {
    if (i >= cut || !isToolResult(msg)) return msg;
    const content = msg.content || '';
    return content.length > limit ? { ...msg, content: clipToolOutput(content, limit) } : msg;
  });
}

/** Primer índice ≥ `from` que no deja huérfano un resultado de herramienta: un
    role="tool" suelto, sin el assistant que lo pidió, rompe el template. */
function safeStart(messages, from) {
  let i = from;
  while (i < messages.length && isToolResult(messages[i])) i += 1;
  return i;
}

/**
 * Recorta el historial para que quepa en el presupuesto.
 * Devuelve { messages, pruned }.
 *
 * De menos a más destructivo: recortar resultados antiguos → soltar los
 * mensajes más viejos conservando SIEMPRE la petición original → quedarse solo
 * con lo último. La petición original viaja siempre: sin ella el modelo olvida
 * qué se le pidió y responde cualquier cosa.
 */
export function fitHistory(messages, budgetTokens, keepRecent = KEEP_RECENT) {
  if (!budgetTokens || budgetTokens <= 0 || !messages?.length) {
    return { messages, pruned: false };
  }
  const working = shrinkOldResults(messages, keepRecent);
  if (estimateTokens(working) <= budgetTokens) {
    return { messages: working, pruned: working !== messages };
  }

  const first = working[0]?.role === 'user' ? working[0] : null;
  const head = first ? [first, { role: 'user', content: PRUNE_NOTE }] : [];
  const headTokens = estimateTokens(head);

  let start = first ? 1 : 0;
  while (start < working.length) {
    start = safeStart(working, start);
    const tail = working.slice(start);
    if (!tail.length) break;
    if (headTokens + estimateTokens(tail) <= budgetTokens) {
      return { messages: [...head, ...tail], pruned: true };
    }
    start += 1;
  }

  const last = working.length > keepRecent ? working.slice(-keepRecent) : working;
  const tail = last.slice(safeStart(last, 0));
  return {
    messages: tail.length ? [{ role: 'user', content: PRUNE_NOTE }, ...tail] : working,
    pruned: true,
  };
}

/** Tokens disponibles para el HISTORIAL, descontando system prompt y tools. */
export function promptBudget(contextWindow, tools, systemTokens = 0) {
  const total = Math.floor(Math.max(contextWindow || 0, 1) * PROMPT_BUDGET_RATIO);
  return Math.max(total - toolsTokens(tools) - systemTokens, 512);
}
