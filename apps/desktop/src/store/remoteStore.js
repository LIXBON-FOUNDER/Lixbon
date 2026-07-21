// remoteStore.js — host del control remoto (/remote) del IDE.
//
// La sesión del chat se vuelve controlable desde la app móvil / web: el IDE
// publica el transcript como eventos (POST por lotes) y consume comandos
// (prompt/interrupt/approve) por un SSE de larga duración. Todo corre en el
// webview con fetch: cero Rust nuevo.
//
// La instrumentación NO toca chatStore.send: este store se suscribe a los
// cambios de chatStore y deriva los eventos (deltas del asistente, filas de
// herramienta, aprobaciones) comparando estados.

import { create } from 'zustand';
import { useAppStore } from './appStore';
import { useChatStore } from './chatStore';
import { api } from '../lib/api';

const FLUSH_MS = 250;
const RESULT_CHARS = 600;
const SNAPSHOT_MSGS = 80;

// ── estado interno del canal (fuera de zustand: no es UI) ──────────────────
let buffer = [];              // eventos pendientes de POST
let flushTimer = null;
let readerAbort = null;       // AbortController del SSE de comandos
let unsubChat = null;
let prevMessages = [];
let prevStreaming = false;
let assistantOpen = false;    // hay una burbuja de asistente en streaming
let assistantSent = '';       // texto ya emitido de esa burbuja
let approvalSeq = 0;
let currentApprovalId = null;
let remotePromptQueue = [];   // prompts recibidos mientras había streaming
let nextPromptOrigin = null;  // marca el próximo user_msg como remoto

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function emit(type, fields = {}) {
  buffer.push({ type, ...fields });
}

function toolSummary(tool, args = {}) {
  if (tool === 'run_command') return String(args.command || '').slice(0, 200);
  if (tool === 'rename_file') return `${args.src || '?'} → ${args.dst || '?'}`;
  if (tool === 'search' || tool === 'search_codebase') {
    return `«${args.pattern || args.query || ''}» en ${args.path || '.'}`;
  }
  return String(args.path || args.pattern || '').slice(0, 200) || tool;
}

function mapSnapshot(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content || '' });
    else if (m.role === 'assistant' && (m.content || '').trim()) {
      out.push({ role: 'assistant', content: m.content });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool: m.tool, content: (m.content || '').slice(0, RESULT_CHARS), ok: m.ok !== false });
    } else if (m.role === 'error') {
      out.push({ role: 'error', content: m.content || '' });
    }
  }
  return out.slice(-SNAPSHOT_MSGS);
}

export const useRemoteStore = create((set, get) => ({
  active: false,
  starting: false,
  session: null,   // { id, title, machine, ... }
  shareUrl: '',
  qrSvg: '',       // objectURL del QR (SVG del gateway)
  error: null,

  /** Crea la sesión remota y arranca el canal. */
  start: async () => {
    if (get().active || get().starting) return;
    set({ starting: true, error: null });
    const app = useAppStore.getState();
    const root = app.workspaceRoot || '';
    const title = root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : 'IDE';
    try {
      const res = await api.post('/api/remote/sessions', {
        source: 'ide',
        title,
        machine: 'Lixbon IDE',
      });
      const session = res.session;
      set({ active: true, starting: false, session, shareUrl: res.share_url });
      get()._loadQr(res.share_url);
      startChannel(session.id);
    } catch (err) {
      set({ starting: false, error: err?.message || String(err) });
    }
  },

  /** Termina la sesión (revoca el link) y limpia el canal. */
  stop: async () => {
    const { session, active } = get();
    stopChannel();
    set({ active: false, session: null, shareUrl: '', qrSvg: '', error: null });
    if (active && session) {
      try { await api.delete(`/api/remote/sessions/${session.id}`); } catch { /* ya cerrada */ }
    }
  },

  /** La sesión terminó desde fuera (móvil/web o expiración). */
  _endedRemotely: () => {
    stopChannel();
    set({ active: false, session: null, shareUrl: '', qrSvg: '', error: null });
  },

  // El QR llega como SVG y se inyecta en un <img> como data: URI. NO vale
  // URL.createObjectURL: la CSP del webview (tauri.conf.json) no lista `blob:`
  // en img-src, así que la imagen quedaba rota con el link ya visible.
  _loadQr: async (shareUrl) => {
    try {
      const { serverUrl, apiKey } = useAppStore.getState();
      const res = await fetch(
        `${serverUrl}/api/remote/qr?fmt=svg&scale=5&data=${encodeURIComponent(shareUrl)}`,
        { headers: { Authorization: `Bearer ${apiKey}` } },
      );
      if (!res.ok) return;
      const svg = await res.text();
      set({ qrSvg: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
    } catch { /* sin QR: el link sigue disponible */ }
  },
}));

// ── canal ───────────────────────────────────────────────────────────────────

function startChannel(sessionId) {
  const chat = useChatStore.getState();
  const app = useAppStore.getState();
  buffer = [];
  prevMessages = chat.messages;
  prevStreaming = chat.streaming;
  assistantOpen = false;
  assistantSent = '';
  remotePromptQueue = [];
  nextPromptOrigin = null;

  emit('hello', {
    source: 'ide',
    title: useRemoteStore.getState().session?.title || 'IDE',
    machine: 'Lixbon IDE',
    mode: chat.agentMode ? 'agent' : 'ask',
    model: app.currentModel,
  });
  emit('snapshot', { messages: mapSnapshot(chat.messages) });
  emit('status', { state: chat.streaming ? 'thinking' : 'idle' });
  if (chat.pendingApproval) announceApproval(chat.pendingApproval);

  unsubChat = useChatStore.subscribe(onChatChange);
  flushTimer = setInterval(flushEvents, FLUSH_MS);
  readCommands(sessionId);
}

function stopChannel() {
  if (unsubChat) { unsubChat(); unsubChat = null; }
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
  if (readerAbort) { readerAbort.abort(); readerAbort = null; }
  buffer = [];
  remotePromptQueue = [];
  currentApprovalId = null;
}

async function flushEvents() {
  if (!buffer.length) return;
  const { session, active } = useRemoteStore.getState();
  if (!active || !session) return;
  const batch = buffer;
  buffer = [];
  try {
    await api.post(`/api/remote/sessions/${session.id}/events`, { events: batch });
  } catch (err) {
    const msg = String(err?.message || '');
    if (/no encontrada|terminó|410|404/i.test(msg)) {
      useRemoteStore.getState()._endedRemotely();
      return;
    }
    // Fallo transitorio: devolver el lote al frente (con tope defensivo)
    buffer = batch.concat(buffer).slice(-2000);
  }
}

// ── derivación de eventos desde chatStore ──────────────────────────────────

function onChatChange(state) {
  const msgs = state.messages;
  const prev = prevMessages;

  if (msgs !== prev) {
    if (msgs.length < prev.length || (msgs.length && prev.length && msgs[0] !== prev[0])) {
      // Reset o limpieza de burbujas (nueva conversación, carga de historial…):
      // resincronizar con un snapshot completo en lugar de derivar deltas.
      closeAssistant(prev);
      emit('snapshot', { messages: mapSnapshot(msgs) });
    } else {
      for (let i = prev.length; i < msgs.length; i++) announceNew(msgs[i]);
      // Delta de la burbuja de asistente en streaming (siempre la última)
      const last = msgs[msgs.length - 1];
      if (assistantOpen && last?.role === 'assistant') {
        const text = last.content || '';
        if (text !== assistantSent) {
          if (text.startsWith(assistantSent)) {
            emit('assistant_delta', { text: text.slice(assistantSent.length) });
          } else {
            emit('assistant_replace', { text });
          }
          assistantSent = text;
        }
      }
    }
    prevMessages = msgs;
  }

  if (state.streaming !== prevStreaming) {
    prevStreaming = state.streaming;
    if (!state.streaming) {
      closeAssistant(msgs);
      emit('status', { state: 'idle' });
      // Prompts que llegaron del móvil mientras el agente trabajaba
      if (remotePromptQueue.length) {
        const text = remotePromptQueue.shift();
        setTimeout(() => sendRemotePrompt(text), 50);
      }
    } else {
      emit('status', { state: 'thinking' });
    }
  }

  if (state.pendingApproval && currentApprovalId === null) {
    announceApproval(state.pendingApproval);
  } else if (!state.pendingApproval && currentApprovalId !== null) {
    emit('approval_resolved', { id: currentApprovalId });
    currentApprovalId = null;
  }
}

function announceNew(m) {
  if (m.role === 'user') {
    emit('user_msg', { text: m.content || '', origin: nextPromptOrigin || 'local' });
    nextPromptOrigin = null;
  } else if (m.role === 'assistant') {
    closeAssistant(prevMessages);
    assistantOpen = true;
    assistantSent = m.content || '';
    if (assistantSent) emit('assistant_delta', { text: assistantSent });
  } else if (m.role === 'tool') {
    emit('tool_use', { tool: m.tool, summary: toolSummary(m.tool, m.args), readonly: false });
    emit('tool_result', {
      tool: m.tool,
      result: (m.content || '').slice(0, RESULT_CHARS),
      error: m.ok === false,
    });
  } else if (m.role === 'error') {
    emit('error', { message: m.content || '' });
  }
}

function closeAssistant(msgs) {
  if (!assistantOpen) return;
  const last = [...msgs].reverse().find((m) => m.role === 'assistant');
  emit('assistant_done', { text: (last?.content ?? assistantSent) || '' });
  assistantOpen = false;
  assistantSent = '';
}

function announceApproval(pending) {
  currentApprovalId = `ide-${++approvalSeq}`;
  emit('approval_request', {
    id: currentApprovalId,
    tool: pending.tool,
    summary: toolSummary(pending.tool, pending.args),
    risk: pending.tool === 'run_command' ? 'command' : 'edit',
  });
}

// ── comandos entrantes ──────────────────────────────────────────────────────

function sendRemotePrompt(text) {
  const chat = useChatStore.getState();
  if (chat.streaming) { remotePromptQueue.push(text); return; }
  nextPromptOrigin = 'remote';
  chat.send(text);
}

function handleCommand(cmd) {
  const chat = useChatStore.getState();
  switch (cmd.type) {
    case 'prompt': {
      const text = (cmd.text || '').trim();
      if (text) sendRemotePrompt(text);
      break;
    }
    case 'interrupt':
      remotePromptQueue = [];
      chat.stop();
      break;
    case 'approve':
      if (cmd.id && cmd.id === currentApprovalId && chat.pendingApproval) {
        chat.resolveApproval(cmd.decision === 'allow' ? 'yes' : 'no');
      }
      break;
    case 'request_snapshot':
      emit('snapshot', { messages: mapSnapshot(chat.messages) });
      break;
    case 'bye':
      useRemoteStore.getState()._endedRemotely();
      break;
    default:
      break;
  }
}

async function readCommands(sessionId) {
  let backoff = 2000;
  for (;;) {
    const { active, session } = useRemoteStore.getState();
    if (!active || session?.id !== sessionId) return;
    try {
      readerAbort = new AbortController();
      const { serverUrl, apiKey } = useAppStore.getState();
      const res = await fetch(`${serverUrl}/api/remote/sessions/${sessionId}/commands`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: readerAbort.signal,
      });
      if (res.status === 404 || res.status === 410) {
        useRemoteStore.getState()._endedRemotely();
        return;
      }
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      backoff = 2000;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          try { handleCommand(JSON.parse(line.slice(5).trim())); } catch { /* frame malformado */ }
        }
      }
    } catch {
      if (!useRemoteStore.getState().active) return;
    }
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
}
