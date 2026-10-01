// remote.js — cliente de la sección Remote: consume los eventos de una sesión
// /remote (SSE del gateway) y los reduce a un transcript renderizable.
// El fetch de React Native no expone el cuerpo incremental, así que el SSE se
// lee con XMLHttpRequest en onprogress (mismo patrón que sse.js).
import { ApiException, extractDetail } from './api';

// ── SSE genérico (GET) ──────────────────────────────────────────────────────

export function openEventStream({ base, token, path, onEvent, onEnd, onError }) {
  const xhr = new XMLHttpRequest();
  let cancelled = false;
  let finished = false;
  let seen = 0;
  let buffer = '';

  const fail = (err) => {
    if (!cancelled && !finished) {
      finished = true;
      onError?.(err);
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
      if (!event.startsWith('data:')) continue; // keep-alives
      try {
        const obj = JSON.parse(event.slice(5).trim());
        if (obj && typeof obj === 'object') onEvent(obj);
      } catch {
        // frame malformado: se ignora
      }
    }
    if (isFinal && !cancelled && !finished) {
      finished = true;
      onEnd?.();
    }
  };

  xhr.open('GET', `${base}${path}`);
  xhr.setRequestHeader('Accept', 'text/event-stream');
  if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.timeout = 0;

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
  xhr.send();

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

// ── Reducer del transcript remoto ───────────────────────────────────────────
// items: [{ kind: 'user'|'assistant'|'tool'|'error', ... }]. La burbuja del
// asistente en streaming es siempre la última con kind 'assistant' y open:true.

export const initialRemoteState = {
  items: [],
  approvals: [], // [{ id, tool, summary, risk }]
  agentState: 'idle', // idle | thinking
  hostConnected: false,
  meta: null, // hello: { source, agent, title, workspace, machine, mode, model, commands, capabilities }
  background: [], // tareas que el agente dejó corriendo: [{ id, type, description, since }]
  files: null, // última búsqueda de @archivos: { query, items: [{ name, rel, path }] }
  // Orquestador del host: último snapshot y respuestas a peticiones puntuales.
  orch: null,
  orchDiff: {},
  orchTerm: {},
  orchAgents: null,
  orchError: null,
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
    if (m.role === 'user') items.push(withKey({ kind: 'user', text: m.content || '', images: m.images || 0, mentions: m.mentions || [] }));
    else if (m.role === 'assistant') items.push(withKey({ kind: 'assistant', text: m.content || '', open: false }));
    else if (m.role === 'tool') {
      items.push(withKey({ kind: 'tool', tool: m.tool || 'tool', summary: m.summary || '', label: m.label || '', result: m.content || '', error: m.ok === false, running: false }));
    } else if (m.role === 'error') items.push(withKey({ kind: 'error', text: m.content || '' }));
    else if (m.role === 'command') items.push(commandItem(m));
  }
  return items;
}

function commandItem(ev) {
  return withKey({
    kind: 'command',
    name: ev.name || '',
    args: ev.args || '',
    rows: Array.isArray(ev.rows) ? ev.rows : [],
    text: ev.text || '',
  });
}

function closeOpenAssistant(items, finalText, keepIfEmpty = false) {
  const idx = items.findLastIndex((it) => it.kind === 'assistant' && it.open);
  if (idx === -1) return items;
  const text = typeof finalText === 'string' ? finalText : items[idx].text;
  if (!text.trim() && !keepIfEmpty) {
    return [...items.slice(0, idx), ...items.slice(idx + 1)];
  }
  return items.map((it, i) => (i === idx ? { ...it, text, open: false } : it));
}

export function remoteReducer(state, ev) {
  const seq = typeof ev.seq === 'number' ? ev.seq : state.lastSeq;
  if (typeof ev.seq === 'number' && ev.seq <= state.lastSeq && ev.type !== 'channel_status') {
    return state; // replay duplicado
  }
  const s = { ...state, lastSeq: Math.max(state.lastSeq, seq) };

  switch (ev.type) {
    case 'channel_status':
      return {
        ...s,
        hostConnected: !!ev.host_connected,
        session: ev.session || s.session,
        meta: ev.meta && Object.keys(ev.meta).length ? ev.meta : s.meta,
        orch: ev.orch || s.orch,
      };
    case 'orch':
      return { ...s, orch: ev };
    case 'orch_diff':
      return { ...s, orchDiff: { ...s.orchDiff, [ev.task]: ev } };
    case 'orch_term':
      return { ...s, orchTerm: { ...s.orchTerm, [ev.task]: ev } };
    case 'orch_agents':
      return { ...s, orchAgents: Array.isArray(ev.agents) ? ev.agents : [] };
    case 'orch_error':
      return { ...s, orchError: { message: ev.message || 'Error', action: ev.action, at: Date.now() } };
    case 'hello':
      return {
        ...s,
        meta: {
          source: ev.source,
          agent: ev.agent || null,
          title: ev.title,
          workspace: ev.workspace || null,
          machine: ev.machine,
          mode: ev.mode,
          model: ev.model,
          capabilities: Array.isArray(ev.capabilities) ? ev.capabilities : [],
          // El host publica los comandos que acepta; cada superficie tiene los
          // suyos, así que la app no los adivina (con un host viejo llega
          // undefined y se cae al catálogo por defecto).
          commands: Array.isArray(ev.commands) ? ev.commands : null,
        },
      };
    case 'snapshot':
      return { ...s, items: mapSnapshotMessages(ev.messages) };
    case 'user_msg':
      return {
        ...s,
        items: [
          ...closeOpenAssistant(s.items),
          withKey({ kind: 'user', text: ev.text || '', origin: ev.origin, images: ev.images || 0, mentions: ev.mentions || [] }),
        ],
      };
    case 'files':
      return { ...s, files: { query: ev.query || '', items: Array.isArray(ev.items) ? ev.items : [] } };
    case 'assistant_delta': {
      const items = [...s.items];
      const idx = items.findLastIndex((it) => it.kind === 'assistant' && it.open);
      if (idx === -1) items.push(withKey({ kind: 'assistant', text: ev.text || '', open: true }));
      else items[idx] = { ...items[idx], text: items[idx].text + (ev.text || '') };
      return { ...s, items };
    }
    case 'assistant_replace': {
      const items = [...s.items];
      const idx = items.findLastIndex((it) => it.kind === 'assistant' && it.open);
      if (idx === -1) items.push(withKey({ kind: 'assistant', text: ev.text || '', open: true }));
      else items[idx] = { ...items[idx], text: ev.text || '' };
      return { ...s, items };
    }
    case 'assistant_done': {
      // Al releer una sesión guardada no hay deltas (no se persisten), así que
      // no existe burbuja abierta que cerrar: el turno se crea aquí, ya cerrado.
      const idx = s.items.findLastIndex((it) => it.kind === 'assistant' && it.open);
      if (idx === -1) {
        const text = ev.text || '';
        return text.trim()
          ? { ...s, items: [...s.items, withKey({ kind: 'assistant', text, open: false })] }
          : s;
      }
      return { ...s, items: closeOpenAssistant(s.items, ev.text || '') };
    }
    case 'tool_use':
      return {
        ...s,
        items: [...closeOpenAssistant(s.items), withKey({
          kind: 'tool', tool: ev.tool || 'tool', summary: ev.summary || '', label: ev.label || '',
          readonly: !!ev.readonly, running: true, result: '', error: false,
        })],
      };
    case 'tool_result': {
      const items = [...s.items];
      const idx = items.findLastIndex((it) => it.kind === 'tool' && it.running && it.tool === ev.tool);
      const patch = { running: false, result: ev.result || '', error: !!ev.error };
      if (idx === -1) {
        items.push(withKey({ kind: 'tool', tool: ev.tool || 'tool', summary: '', ...patch }));
      } else {
        items[idx] = { ...items[idx], ...patch };
      }
      return { ...s, items };
    }
    case 'status':
      return { ...s, agentState: ev.state === 'thinking' ? 'thinking' : 'idle' };
    case 'approval_request':
      if (s.approvals.some((a) => a.id === ev.id)) return s;
      return { ...s, approvals: [...s.approvals, { id: ev.id, tool: ev.tool, summary: ev.summary || '', risk: ev.risk || 'edit' }] };
    case 'approval_resolved':
      return { ...s, approvals: s.approvals.filter((a) => a.id !== ev.id) };
    case 'notice':
      // Respuesta del host a un slash-command: no es del modelo, así que se
      // pinta como una nota del sistema y no como una burbuja del asistente.
      return { ...s, items: [...closeOpenAssistant(s.items), withKey({ kind: 'notice', text: ev.text || '' })] };
    case 'background':
      return { ...s, background: Array.isArray(ev.tasks) ? ev.tasks : [] };
    case 'command_result':
      return { ...s, items: [...closeOpenAssistant(s.items), commandItem(ev)] };
    case 'error':
      return { ...s, items: [...s.items, withKey({ kind: 'error', text: ev.message || 'Error' })] };
    case 'bye':
    case 'session_ended':
      return { ...s, ended: true, hostConnected: false, approvals: [], background: [] };
    default:
      return s;
  }
}

// findLastIndex no existe en motores JS viejos (Hermes moderno sí lo trae);
// polyfill defensivo por si el runtime no lo soporta.
if (!Array.prototype.findLastIndex) {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(Array.prototype, 'findLastIndex', {
    value(predicate) {
      for (let i = this.length - 1; i >= 0; i--) {
        if (predicate(this[i], i, this)) return i;
      }
      return -1;
    },
  });
}
