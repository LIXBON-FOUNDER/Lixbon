// remote.js — cliente del control remoto (/remote) en la web: SSE por fetch
// (permite from_seq y reconexión controlada) y reducer del transcript.
// Mismo protocolo y reducción que la app móvil (apps/mobile/src/remote.js).

export function openEventStream({ path, signal, onEvent }) {
  // Devuelve una promesa que termina cuando el stream se corta (el llamador
  // decide reconectar). La auth es la cookie de sesión (same-origin): el
  // acceso remoto siempre exige al dueño autenticado.
  return (async () => {
    const res = await fetch(path, {
      credentials: 'include',
      signal,
    });
    if (!res.ok || !res.body) {
      const err = new Error(`SSE ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const obj = JSON.parse(line.slice(5).trim());
          if (obj && typeof obj === 'object') onEvent(obj);
        } catch { /* frame malformado */ }
      }
    }
  })();
}

// ── Reducer del transcript remoto ───────────────────────────────────────────

export const initialRemoteState = {
  items: [],
  approvals: [],
  agentState: 'idle',
  hostConnected: false,
  meta: null,
  session: null,
  ended: false,
  lastSeq: 0,
};

let nextKey = 1;
const withKey = (item) => ({ key: `r${nextKey++}`, ...item });

function mapSnapshotMessages(messages) {
  const items = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') items.push(withKey({ kind: 'user', text: m.content || '' }));
    else if (m.role === 'assistant') items.push(withKey({ kind: 'assistant', text: m.content || '', open: false }));
    else if (m.role === 'tool') {
      items.push(withKey({
        kind: 'tool', tool: m.tool || 'tool', summary: '',
        result: m.content || '', error: m.ok === false, running: false,
      }));
    } else if (m.role === 'error') items.push(withKey({ kind: 'error', text: m.content || '' }));
  }
  return items;
}

const lastIdx = (items, pred) => {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i])) return i;
  return -1;
};

function closeOpenAssistant(items, finalText) {
  const idx = lastIdx(items, (it) => it.kind === 'assistant' && it.open);
  if (idx === -1) return items;
  const text = typeof finalText === 'string' ? finalText : items[idx].text;
  if (!text.trim()) return [...items.slice(0, idx), ...items.slice(idx + 1)];
  return items.map((it, i) => (i === idx ? { ...it, text, open: false } : it));
}

export function remoteReducer(state, ev) {
  const seq = typeof ev.seq === 'number' ? ev.seq : state.lastSeq;
  if (typeof ev.seq === 'number' && ev.seq <= state.lastSeq && ev.type !== 'channel_status') {
    return state;
  }
  const s = { ...state, lastSeq: Math.max(state.lastSeq, seq) };

  switch (ev.type) {
    case 'channel_status':
      return {
        ...s,
        hostConnected: !!ev.host_connected,
        session: ev.session || s.session,
        meta: ev.meta && Object.keys(ev.meta).length ? ev.meta : s.meta,
      };
    case 'hello':
      return { ...s, meta: { source: ev.source, title: ev.title, machine: ev.machine, mode: ev.mode, model: ev.model } };
    case 'snapshot':
      return { ...s, items: mapSnapshotMessages(ev.messages) };
    case 'user_msg':
      return { ...s, items: [...closeOpenAssistant(s.items), withKey({ kind: 'user', text: ev.text || '', origin: ev.origin })] };
    case 'assistant_delta': {
      const items = [...s.items];
      const idx = lastIdx(items, (it) => it.kind === 'assistant' && it.open);
      if (idx === -1) items.push(withKey({ kind: 'assistant', text: ev.text || '', open: true }));
      else items[idx] = { ...items[idx], text: items[idx].text + (ev.text || '') };
      return { ...s, items };
    }
    case 'assistant_replace': {
      const items = [...s.items];
      const idx = lastIdx(items, (it) => it.kind === 'assistant' && it.open);
      if (idx === -1) items.push(withKey({ kind: 'assistant', text: ev.text || '', open: true }));
      else items[idx] = { ...items[idx], text: ev.text || '' };
      return { ...s, items };
    }
    case 'assistant_done':
      return { ...s, items: closeOpenAssistant(s.items, ev.text || '') };
    case 'tool_use':
      return {
        ...s,
        items: [...closeOpenAssistant(s.items), withKey({
          kind: 'tool', tool: ev.tool || 'tool', summary: ev.summary || '',
          readonly: !!ev.readonly, running: true, result: '', error: false,
        })],
      };
    case 'tool_result': {
      const items = [...s.items];
      const idx = lastIdx(items, (it) => it.kind === 'tool' && it.running && it.tool === ev.tool);
      const patch = { running: false, result: ev.result || '', error: !!ev.error };
      if (idx === -1) items.push(withKey({ kind: 'tool', tool: ev.tool || 'tool', summary: '', ...patch }));
      else items[idx] = { ...items[idx], ...patch };
      return { ...s, items };
    }
    case 'status':
      return { ...s, agentState: ev.state === 'thinking' ? 'thinking' : 'idle' };
    case 'approval_request':
      if (s.approvals.some((a) => a.id === ev.id)) return s;
      return { ...s, approvals: [...s.approvals, { id: ev.id, tool: ev.tool, summary: ev.summary || '', risk: ev.risk || 'edit' }] };
    case 'approval_resolved':
      return { ...s, approvals: s.approvals.filter((a) => a.id !== ev.id) };
    case 'error':
      return { ...s, items: [...s.items, withKey({ kind: 'error', text: ev.message || 'Error' })] };
    case 'bye':
    case 'session_ended':
      return { ...s, ended: true, hostConnected: false, approvals: [] };
    default:
      return s;
  }
}
