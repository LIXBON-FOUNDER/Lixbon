// stream.js — cliente SSE del chat (POST /v1/chat/completions con stream:true).
// Adaptación de apps/web/src/lib/stream.js: URL absoluta del gateway y
// Authorization: Bearer <apiKey> en lugar de la cookie de sesión.
// Usa el fetch del WebView (necesario para res.body.getReader(); plugin-http no sirve).

/** Convierte el detail estructurado de cuota (F5) en un mensaje en español. */
export function quotaMessage(detail) {
  if (!detail || typeof detail === 'string') return detail || null;
  const { code, message, reset_at: resetAt } = detail;
  const when = resetAt
    ? new Date(resetAt).toLocaleString('es', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : null;
  switch (code) {
    case 'messages_quota':
      return `Alcanzaste el límite de mensajes de tu plan.${when ? ` Se restablece el ${when}.` : ''}`;
    case 'tokens_quota':
      return `Alcanzaste el límite de tokens de tu plan.${when ? ` Se restablece el ${when}.` : ''}`;
    case 'model_not_allowed':
      return 'Tu plan no incluye este modelo. Elige otro o mejora tu plan en la web.';
    default:
      return message || null;
  }
}

export async function streamChatCompletion({
  serverUrl,
  apiKey,
  model,
  messages,
  conversationId,
  signal,
  onDelta,
  onSources,
  webSearch = false,
}) {
  const res = await fetch(`${serverUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
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
      else if (body.detail) detail = quotaMessage(body.detail) || detail;
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
        if (chunk.folax_sources && onSources) { onSources(chunk.folax_sources); continue; }
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) onDelta(delta);
      } catch { /* chunk malformado: se ignora */ }
    }
  }
}
