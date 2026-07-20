// sse.js — streaming del chat (POST /v1/chat/completions con stream:true).
// Mismo protocolo que la web (lib/stream.js): chunks formato OpenAI,
// comentarios keep-alive y cierre con "data: [DONE]". El fetch de React
// Native no expone el cuerpo incremental, así que se usa XMLHttpRequest
// leyendo responseText en onprogress.
import { ApiException, extractDetail } from './api';

export function streamChatCompletion({
  base,
  token,
  model,
  messages,
  conversationId,
  webSearch,
  onDelta,
  onSources,
  onDone,
  onError,
}) {
  const xhr = new XMLHttpRequest();
  let cancelled = false;
  let finished = false;
  let seen = 0; // responseText ya procesado (el XHR lo acumula entero)
  let buffer = '';

  const finishOk = () => {
    if (!cancelled && !finished) {
      finished = true;
      onDone();
    }
  };
  const fail = (err) => {
    if (!cancelled && !finished) {
      finished = true;
      onError(err);
    }
  };

  const pump = (isFinal) => {
    const text = xhr.responseText || '';
    if (text.length > seen) {
      buffer += text.slice(seen);
      seen = text.length;
    }
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!event.startsWith('data:')) continue; // ignora keep-alives
      const data = event.slice(5).trim();
      if (data === '[DONE]') {
        finishOk();
        return;
      }
      try {
        const obj = JSON.parse(data);
        if (obj && Array.isArray(obj.lixbon_sources)) {
          onSources(obj.lixbon_sources);
          continue;
        }
        const delta = obj?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) onDelta(delta);
      } catch {
        // chunk malformado: se ignora
      }
    }
    if (isFinal) finishOk();
  };

  xhr.open('POST', `${base}/v1/chat/completions`);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.setRequestHeader('Accept', 'text/event-stream');
  if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.timeout = 0; // el stream puede estar minutos abierto

  xhr.onprogress = () => {
    if (!cancelled && xhr.status < 400) pump(false);
  };
  xhr.onload = () => {
    if (cancelled || finished) return;
    if (xhr.status >= 400) {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // cuerpo no JSON
      }
      fail(new ApiException(extractDetail(data, xhr.status), xhr.status));
      return;
    }
    pump(true);
  };
  xhr.onerror = () => fail(new ApiException('Se perdió la conexión con el servidor'));

  xhr.send(
    JSON.stringify({
      model,
      messages,
      conversation_id: conversationId,
      stream: true,
      web_search: webSearch,
      // Historial compartido con la web: misma cuenta, mismas conversaciones.
      source: 'web',
    }),
  );

  return {
    cancel() {
      cancelled = true;
      try {
        xhr.abort();
      } catch {
        // ya cerrado
      }
    },
  };
}
