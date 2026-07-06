// stream.js — cliente SSE del chat (POST /v1/chat/completions con stream:true).
// El backend emite chunks en formato OpenAI, comentarios ": keep-alive" y
// termina con "data: [DONE]". La cookie de sesión autentica (F4).

export async function streamChatCompletion({ model, messages, conversationId, signal, onDelta, onSources, webSearch = false }) {
  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      conversation_id: conversationId,
      stream: true,
      web_search: webSearch,
    }),
    signal,
  });

  if (!res.ok) {
    let detail = `Error del servidor (${res.status})`;
    try {
      const body = await res.json();
      // F5: los 429/403 de cuota traen detail estructurado {code, message, ...}
      if (typeof body.detail === 'string') detail = body.detail;
      else if (body.detail?.message) detail = body.detail.message;
    } catch { /* cuerpo no-JSON */ }
    throw new Error(detail);
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
      if (!line.startsWith('data:')) continue; // ignora keep-alives
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const chunk = JSON.parse(data);
        if (chunk.lixbon_sources && onSources) { onSources(chunk.lixbon_sources); continue; }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch { /* chunk malformado: se ignora */ }
    }
  }
}
