// inlineEdit.js — edición inline con IA (Ctrl+K). Manda el fragmento + la
// instrucción al modelo por el canal de chat EFÍMERO (no_persist) y devuelve el
// código reescrito, listo para reemplazar la selección con diff inline.

import { streamChatCompletion } from './stream';
import { useAppStore } from '../store/appStore';

const SYSTEM = `Eres un asistente de edición de código dentro de un IDE. Recibes un FRAGMENTO de código y una INSTRUCCIÓN de cambio. Devuelve ÚNICAMENTE el fragmento reescrito, listo para reemplazar al original. Reglas estrictas:
- NO añadas explicaciones ni texto fuera del código.
- NO envuelvas la respuesta en vallas markdown (\`\`\`).
- Conserva la indentación y el estilo del código original.
- Devuelve solo el código que sustituye al fragmento, ni más ni menos.`;

/** Quita una valla markdown ```lang … ``` que el modelo pudiera añadir. */
export function stripCodeFence(text) {
  const t = text.replace(/\r\n/g, '\n').trim();
  const fenced = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) return fenced[1];
  // Valla abierta sin cierre (respuesta truncada): quita solo la apertura.
  return t.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
}

/** Ejecuta la edición inline. `onDelta(acumulado)` para previsualizar el stream.
    Devuelve el código final ya limpio. Lanza si no hay modelo o falla la red. */
export async function runInlineEdit({ fileName, code, instruction, onDelta, signal }) {
  const { serverUrl, apiKey, currentModel, contextWindow } = useAppStore.getState();
  if (!currentModel) throw new Error('Elige un modelo primero.');

  const user =
    `Archivo: ${fileName}\n` +
    `Instrucción: ${instruction}\n\n` +
    `Fragmento a reescribir:\n${code}`;

  let out = '';
  await streamChatCompletion({
    serverUrl,
    apiKey,
    model: currentModel,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: user },
    ],
    conversationId: null,
    noPersist: true,
    numCtx: contextWindow,
    signal,
    onDelta: (d) => { out += d; if (onDelta) onDelta(out); },
  });

  return stripCodeFence(out);
}
