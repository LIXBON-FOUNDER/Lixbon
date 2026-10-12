// remote.js — cliente de la sección Remote: consume los eventos de una sesión
// /remote (SSE del gateway) y los reduce a un transcript renderizable.
// El fetch de React Native no expone el cuerpo incremental, así que el SSE se
// lee con XMLHttpRequest en onprogress (mismo patrón que sse.js).
import { AppState } from 'react-native';

import { ApiException, extractDetail } from './api';

// ── SSE genérico (GET) ──────────────────────────────────────────────────────

// El gateway manda un ping cada 15 s. Al apagar la pantalla o cambiar de red
// Android deja el socket medio abierto sin avisar: sin bytes en 40 s el stream
// se da por muerto, o la app seguiría "en vivo" sin recibir nada.
const STREAM_IDLE_MS = 40000;

export function openEventStream({ base, token, path, onEvent, onEnd, onError }) {
  const xhr = new XMLHttpRequest();
  let cancelled = false;
  let finished = false;
  let seen = 0;
  let buffer = '';
  let idleTimer = null;

  const fail = (err) => {
    clearTimeout(idleTimer);
    if (!cancelled && !finished) {
      finished = true;
      onError?.(err);
    }
  };
  const kick = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try {
        xhr.abort();
      } catch {
        // ya cerrado
      }
      fail(new ApiException('El stream dejó de responder'));
    }, STREAM_IDLE_MS);
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
      clearTimeout(idleTimer);
      onEnd?.();
    }
  };

  xhr.open('GET', `${base}${path}`);
  xhr.setRequestHeader('Accept', 'text/event-stream');
  if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.timeout = 0;

  xhr.onprogress = () => {
    if (cancelled) return;
    kick();
    if (xhr.status < 400) pump(false);
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
  kick();

  return {
    cancel() {
      cancelled = true;
      clearTimeout(idleTimer);
      try {
        xhr.abort();
      } catch {
        // ya cerrado
      }
    },
  };
}

// Mantiene un stream SSE vivo: reconecta con backoff al caerse. En segundo
// plano no se corta (Android congela la app, pero el socket aguanta y al volver
// llega lo pendiente); solo se cierra si la app pasa BACKGROUND_KEEP_MS fuera.
// `connect({ ok, retry })` abre el stream; `ok()` marca que llegó algo y
// `retry(grow)` programa la reconexión.
const RETRY_MIN = 1500;
const RETRY_MAX = 20000;
const BACKGROUND_KEEP_MS = 5 * 60 * 1000;

export function keepStreamAlive(connect, { onResume } = {}) {
  let stream = null;
  let timer = null;
  let parked = null;
  let backoff = RETRY_MIN;
  let stopped = false;
  let closed = false;

  const close = () => {
    clearTimeout(timer);
    timer = null;
    stream?.cancel();
    stream = null;
  };
  const open = () => {
    if (stopped) return;
    close();
    closed = false;
    stream = connect({ ok, retry });
  };
  function ok() {
    backoff = RETRY_MIN;
  }
  function retry(grow = true) {
    if (stopped || closed) return;
    clearTimeout(timer);
    timer = setTimeout(open, backoff);
    if (grow) backoff = Math.min(backoff * 2, RETRY_MAX);
  }

  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'background') {
      clearTimeout(parked);
      parked = setTimeout(() => {
        closed = true;
        close();
      }, BACKGROUND_KEEP_MS);
    } else if (next === 'active') {
      clearTimeout(parked);
      if (closed) {
        backoff = RETRY_MIN;
        onResume?.();
        open();
      }
    }
  });
  open();

  return () => {
    stopped = true;
    clearTimeout(parked);
    sub.remove();
    close();
  };
}

// ── Reducer del transcript remoto ───────────────────────────────────────────
// items: [{ kind: 'user'|'assistant'|'thinking'|'tool'|'qa'|'end'|'notice'|
// 'command'|'compacted'|'error', ... }]. La burbuja del asistente en streaming
// es siempre la última con kind 'assistant' y open:true; el razonamiento en
// curso, el último 'thinking' con open:true. 'end' cierra un turno con lo que
// duró y si se interrumpió.

export const initialRemoteState = {
  items: [],
  approvals: [], // [{ id, tool, summary, risk, path, adds, dels, diff }]
  choices: [], // selectores del host: [{ id, title, body, options: [{ label, value, description, badge }] }]
  agentState: 'idle', // idle | thinking
  // Qué hace el agente ahora: compacting (Claude Code), reasoning, writing,
  // tool (con activityLabel) o working; busySince, cuándo empezó el turno.
  activity: null,
  activityLabel: '',
  activityTool: '',
  busySince: null,
  hostConnected: false,
  meta: null, // hello: { source, agent, title, workspace, machine, mode, model, commands, capabilities }
  background: [], // tareas que el agente dejó corriendo: [{ id, type, description, since }]
  files: null, // última búsqueda de @archivos: { query, items: [{ name, rel, path }] }
  // Ventana de contexto del host: { pct, tokens, window, files, system, auto }.
  context: null,
  // Compactación en curso: { phase, pct, messages, before, estimate, since }.
  compact: null,
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
    else if (m.role === 'assistant') {
      items.push(withKey({ kind: 'assistant', text: m.content || '', open: false }));
      if (m.final) items.push(endItem(m));
    } else if (m.role === 'thinking') items.push(withKey({ kind: 'thinking', text: m.content || '', ms: num(m.ms), open: false }));
    else if (m.role === 'tool') {
      items.push(withKey({
        kind: 'tool', id: m.id || '', tool: m.tool || 'tool', summary: m.summary || '', label: m.label || '', readonly: !!m.readonly,
        result: m.content || '', error: m.ok === false, running: !!m.pending, ...changeOf(m), ...resultOf(m),
      }));
    } else if (m.role === 'qa') items.push(withKey({ kind: 'qa', question: m.question || '', answer: m.content || '' }));
    else if (m.role === 'compacted') items.push(compactedItem({ ...m, summary: m.content }));
    else if (m.role === 'error') items.push(withKey({ kind: 'error', text: m.content || '' }));
    else if (m.role === 'notice') items.push(withKey({ kind: 'notice', text: m.content || '' }));
    else if (m.role === 'command') items.push(commandItem(m));
  }
  return items;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const endItem = (ev) => withKey({ kind: 'end', ms: num(ev.ms), interrupted: !!ev.interrupted });

const compactedItem = (ev) => withKey({ kind: 'compacted', before: num(ev.before), after: num(ev.after), summary: ev.summary || '' });

// Lo que el host cuenta de una herramienta al terminar: duración, código de
// salida, la medida («212 líneas») y las filas de una búsqueda.
function resultOf(ev) {
  const out = {};
  if (num(ev.ms) !== null) out.ms = ev.ms;
  if (num(ev.exit) !== null) out.exit = ev.exit;
  if (typeof ev.meta === 'string' && ev.meta) out.meta = ev.meta;
  if (Array.isArray(ev.lines)) out.lines = ev.lines.filter((l) => typeof l === 'string');
  return out;
}

const OUTPUT_KEEP = 60;

function appendOutput(prev, text) {
  const lines = `${prev || ''}${text || ''}`.split('\n');
  return lines.slice(-OUTPUT_KEEP - 1).join('\n');
}

function commandItem(ev) {
  return withKey({
    kind: 'command',
    name: ev.name || '',
    args: ev.args || '',
    rows: Array.isArray(ev.rows) ? ev.rows : [],
    text: ev.text || '',
    diff: !!ev.diff,
  });
}

// Una edición del agente: ruta, líneas añadidas/borradas y el diff con +/-.
function changeOf(ev) {
  const out = {};
  if (typeof ev.diff === 'string' && ev.diff) out.diff = ev.diff;
  if (typeof ev.adds === 'number') out.adds = ev.adds;
  if (typeof ev.dels === 'number') out.dels = ev.dels;
  if (typeof ev.path === 'string' && ev.path) out.path = ev.path;
  if (Array.isArray(ev.rows)) out.rows = ev.rows.filter((r) => Array.isArray(r) && r.length >= 3);
  return out;
}

function closeOpenThinking(items) {
  const idx = items.findLastIndex((it) => it.kind === 'thinking' && it.open);
  if (idx === -1) return items;
  return items.map((it, i) => (i === idx ? { ...it, open: false, ms: it.ms ?? Date.now() - it.since } : it));
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
  // channel_status llega primero al (re)conectar con el seq más alto del canal:
  // si avanzara lastSeq, el replay de lo perdido que viene detrás se
  // descartaría entero como duplicado.
  const status = ev.type === 'channel_status';
  if (!status && typeof ev.seq === 'number' && ev.seq <= state.lastSeq) {
    return state; // replay duplicado
  }
  const s = status || typeof ev.seq !== 'number' ? state : { ...state, lastSeq: ev.seq };

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
    case 'local_user':
      // Lo escrito en el móvil se pinta al instante; el user_msg del host lo
      // sustituye cuando el agente lo toma (si estaba ocupado, queda en cola).
      return { ...s, items: [...s.items, withKey({ kind: 'user', text: ev.text, images: ev.images || 0, mentions: ev.mentions || [], local: ev.local, sent: false })] };
    case 'local_user_sent':
      return { ...s, items: s.items.map((it) => (it.local === ev.local ? { ...it, sent: true } : it)) };
    case 'local_user_failed':
      return { ...s, items: s.items.filter((it) => it.local !== ev.local) };
    case 'user_msg': {
      const real = withKey({ kind: 'user', text: ev.text || '', origin: ev.origin, images: ev.images || 0, mentions: ev.mentions || [] });
      const idx = ev.origin === 'remote' ? s.items.findIndex((it) => it.local && it.text.trim() === (ev.text || '').trim()) : -1;
      if (idx !== -1) {
        const rest = s.items.filter((_, i) => i !== idx);
        return { ...s, items: [...closeOpenAssistant(rest), real] };
      }
      return { ...s, items: [...closeOpenAssistant(s.items), real] };
    }
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
      const base = closeOpenThinking(s.items);
      const idx = base.findLastIndex((it) => it.kind === 'assistant' && it.open);
      const text = ev.text || '';
      let items;
      if (idx === -1) items = text.trim() ? [...base, withKey({ kind: 'assistant', text, open: false })] : base;
      else items = closeOpenAssistant(base, text);
      return { ...s, items: [...items, endItem(ev)] };
    }
    case 'reasoning_delta': {
      const items = [...s.items];
      const idx = items.findLastIndex((it) => it.kind === 'thinking' && it.open);
      if (idx === -1) items.push(withKey({ kind: 'thinking', text: ev.text || '', open: true, since: Date.now(), ms: null }));
      else items[idx] = { ...items[idx], text: items[idx].text + (ev.text || '') };
      return { ...s, items };
    }
    case 'reasoning': {
      const items = [...s.items];
      const idx = items.findLastIndex((it) => it.kind === 'thinking' && it.open);
      const done = { text: ev.text || '', ms: num(ev.ms), open: false };
      if (idx === -1) items.push(withKey({ kind: 'thinking', ...done }));
      else items[idx] = { ...items[idx], ...done };
      return { ...s, items };
    }
    case 'tool_use':
      return {
        ...s,
        items: [...closeOpenAssistant(closeOpenThinking(s.items)), withKey({
          kind: 'tool', id: ev.id || '', tool: ev.tool || 'tool', summary: ev.summary || '', label: ev.label || '',
          readonly: !!ev.readonly, running: true, result: '', error: false, since: Date.now(), ...changeOf(ev),
        })],
      };
    case 'tool_output': {
      const idx = s.items.findLastIndex((it) => it.kind === 'tool' && it.id === ev.id);
      if (idx === -1) return s;
      const items = [...s.items];
      items[idx] = { ...items[idx], output: appendOutput(items[idx].output, ev.text) };
      return { ...s, items };
    }
    case 'tool_result': {
      const items = [...s.items];
      const idx = ev.id
        ? items.findLastIndex((it) => it.kind === 'tool' && it.id === ev.id)
        : items.findLastIndex((it) => it.kind === 'tool' && it.running && it.tool === ev.tool);
      const patch = { running: false, result: ev.result || '', error: !!ev.error, ...changeOf(ev), ...resultOf(ev) };
      if (idx === -1) {
        items.push(withKey({ kind: 'tool', tool: ev.tool || 'tool', summary: '', ...patch }));
      } else {
        items[idx] = { ...items[idx], ...patch };
      }
      return { ...s, items };
    }
    case 'question_answered':
      return { ...s, items: [...s.items, withKey({ kind: 'qa', question: ev.question || '', answer: ev.answer || '' })] };
    case 'context':
      return num(ev.pct) === null ? s : { ...s, context: { pct: ev.pct, tokens: num(ev.tokens), window: num(ev.window), files: num(ev.files) || 0, system: num(ev.system) || 0, auto: num(ev.auto) } };
    case 'compact':
      if (ev.phase === 'start') {
        return { ...s, compact: { pct: 10, messages: num(ev.messages), before: num(ev.before), estimate: num(ev.estimate), since: Date.now() } };
      }
      if (ev.phase === 'progress' && s.compact) return { ...s, compact: { ...s.compact, pct: num(ev.pct) ?? s.compact.pct } };
      if (ev.phase === 'failed') {
        return { ...s, compact: null, items: [...s.items, withKey({ kind: 'error', text: `No se pudo compactar: ${ev.message || 'el modelo no devolvió resumen'}` })] };
      }
      return s;
    case 'compacted':
      return { ...s, compact: null, items: [...closeOpenAssistant(s.items), compactedItem(ev)] };
    case 'status': {
      const busy = ev.state === 'thinking';
      return {
        ...s,
        agentState: busy ? 'thinking' : 'idle',
        activity: busy ? ev.activity || null : null,
        activityLabel: busy ? ev.label || '' : '',
        activityTool: busy ? ev.tool || '' : '',
        busySince: busy ? s.busySince || Date.now() : null,
      };
    }
    case 'approval_request':
      if (s.approvals.some((a) => a.id === ev.id)) return s;
      return { ...s, approvals: [...s.approvals, { id: ev.id, tool: ev.tool, summary: ev.summary || '', risk: ev.risk || 'edit', ...changeOf(ev) }] };
    case 'approval_resolved':
      return { ...s, approvals: s.approvals.filter((a) => a.id !== ev.id) };
    case 'choice_request':
      if (s.choices.some((x) => x.id === ev.id)) return s;
      return {
        ...s,
        choices: [
          ...s.choices,
          {
            id: ev.id, title: ev.title || 'Elige una opción', body: ev.body || '', options: Array.isArray(ev.options) ? ev.options : [],
            question: ev.kind === 'question', free: !!ev.free,
          },
        ],
      };
    case 'choice_resolved':
      return { ...s, choices: s.choices.filter((x) => x.id !== ev.id) };
    case 'notice':
      // Respuesta del host a un slash-command: no es del modelo, así que se
      // pinta como una nota del sistema y no como una burbuja del asistente.
      return { ...s, items: [...closeOpenAssistant(s.items), withKey({ kind: 'notice', text: ev.text || '' })] };
    case 'background':
      return { ...s, background: Array.isArray(ev.tasks) ? ev.tasks : [] };
    case 'command_result':
      // Un host que cuenta el compact por eventos deja constancia con el
      // separador del hilo; la tarjeta del comando lo repetiría.
      if (ev.name === 'compact' && s.meta?.capabilities?.includes('compact')) return s;
      return { ...s, items: [...closeOpenAssistant(s.items), commandItem(ev)] };
    case 'error':
      return { ...s, items: [...closeOpenThinking(s.items), withKey({ kind: 'error', text: ev.message || 'Error' })] };
    case 'bye':
    case 'session_ended':
      return { ...s, ended: true, hostConnected: false, approvals: [], choices: [], background: [], compact: null };
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
