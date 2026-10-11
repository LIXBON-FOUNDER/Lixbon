// El backend emite chunks OpenAI, comentarios «: keep-alive» y termina con
// «data: [DONE]».

import { FILE_PROMPT } from './archivos';

export async function streamChatCompletion({
  model, messages, conversationId, signal, onDelta, onReasoning, onSources, onFinish, onQuota, webSearch = false,
  system = FILE_PROMPT, source = undefined, think = undefined,
}) {
  // El chat web no manda system prompt propio; el de archivos es la única
  // instrucción fija (no se persiste: viaja en cada petición). Visuals pasa el suyo.
  const conSistema = messages[0]?.role === 'system' ? messages : [{ role: 'system', content: system }, ...messages];
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: conSistema,
      conversation_id: conversationId,
      stream: true,
      web_search: webSearch === 'off' ? false : (webSearch ? true : 'auto'),
      ...(source ? { source } : {}),
      ...(think !== undefined && think !== null ? { think } : {}),
    }),
    signal,
  });

  if (!res.ok) {
    let detail = `Error del servidor (${res.status})`;
    let quota = null;
    try {
      const body = await res.json();
      // Los 429/403 de cuota traen detail estructurado {code, message, ...}
      if (typeof body.detail === 'string') detail = body.detail;
      else if (body.detail?.message) detail = body.detail.message;
      if (/_quota_exhausted$/.test(body.detail?.code || '')) {
        quota = { state: 'exhausted', scope: body.detail.scope, reset_at: body.detail.reset_at, message: detail };
      }
    } catch { /* cuerpo no-JSON */ }
    throw Object.assign(new Error(detail), { quota });
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split('\n\n');
    buffer = events.pop(); // el último puede venir incompleto

    for (const event of events) {
      const line = event.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data);
        if (chunk.lixbon_sources && onSources) { onSources(chunk.lixbon_sources, chunk.lixbon_queries || []); continue; }
        if (chunk.lixbon_quota && onQuota) onQuota(chunk.lixbon_quota);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) onDelta(delta);
        const reasoning = choice?.delta?.reasoning_content;
        if (reasoning && onReasoning) onReasoning(reasoning);
        if (choice?.finish_reason && onFinish) onFinish(choice.finish_reason, chunk);
      } catch { /* chunk malformado: se ignora */ }
    }
  }
}
