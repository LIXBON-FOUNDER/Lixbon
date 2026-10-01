// remoteStore.js — host del control remoto (/remote) del IDE.
//
// La sesión del chat se vuelve controlable desde la app móvil / web: el IDE
// publica el transcript como eventos (POST por lotes) y consume comandos
// (prompt/interrupt/approve/files) por un SSE de larga duración. Todo corre en el
// webview con fetch: cero Rust nuevo.
//
// La instrumentación NO toca chatStore.send: este store se suscribe a los
// cambios de chatStore y deriva los eventos (deltas del asistente, filas de
// herramienta, aprobaciones) comparando estados.

import { describeTool } from '../lib/toolText';
import { create } from 'zustand';
import { useAppStore } from './appStore';
import { useChatStore } from './chatStore';
import { api } from '../lib/api';
import { runCommand } from '../lib/commands';
import { listFiles } from '../lib/tauri';
import { fuzzyScore } from '../lib/fuzzy';
import { claudeMenuEntries, parseSlash } from '../lib/claudeCommands';
import { CLAUDE_IDE_CARDS } from '../chat/slashCommands';
import { remoteCard } from '../lib/remoteCards';
import { startOrchBridge, stopOrchBridge, handleOrchAction, republishOrch, prepareRemoteOrchestrate } from '../lib/remoteOrch';

const FLUSH_MS = 250;
const RESULT_CHARS = 600;
const SNAPSHOT_MSGS = 80;
const MACHINE = 'Lixbon IDE';
// Lo que el móvil puede mandar con un prompt; un host sin esto solo recibe texto.
const CAPABILITIES = ['attachments', 'images', 'mentions', 'files', 'orch'];
const FILE_RESULTS = 30;
const FILES_TTL_MS = 30_000;
const AGENT_LABEL = { lixbon: 'Lixbon', claude: 'Claude Code' };

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
// El próximo user_msg viene del móvil: sus imágenes y menciones se toman del
// comando, porque con imágenes el chat publica el mensaje antes de completarlo.
let nextRemotePrompt = null;
let lastHelloKey = '';
let filesCache = { at: 0, list: [] };
// Las tarjetas de comando entran reemplazando la burbuja del turno, sin cambiar
// la longitud del chat: se reconocen por identidad.
let sentCards = new WeakSet();
let prevSide = null;
let prevBtw = null;
let prevBackground = null;

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
    if (m.role === 'user') out.push({ role: 'user', content: m.content || '', images: m.images?.length || 0, mentions: m.mentions || [] });
    else if (m.role === 'assistant' && (m.content || '').trim()) {
      out.push({ role: 'assistant', content: m.content });
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool: m.tool, label: describeTool(m), summary: toolSummary(m.tool, m.args), content: (m.content || '').slice(0, RESULT_CHARS), ok: m.ok !== false });
    } else if (m.role === 'error') {
      out.push({ role: 'error', content: m.content || '' });
    } else if (m.role === 'cmd') {
      out.push({ role: 'command', ...remoteCard(m, helpCommands()) });
    }
  }
  return out.slice(-SNAPSHOT_MSGS);
}

const folderName = (root) => (root ? root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '');

function agentOf(chat) {
  return chat.engine === 'claude' ? 'claude' : 'lixbon';
}

// Desde el teléfono solo valen los comandos del IDE que cambian el estado de
// la sesión; los que abren paneles no tendrían dónde verse.
function lixbonCommands() {
  return [
    { name: 'new', description: 'Nueva conversación', run: () => runCommand('chat.newConversation') },
    { name: 'agent', description: 'Modo Agente: edita y ejecuta', run: () => runCommand('chat.mode.agent') },
    { name: 'plan', description: 'Modo Plan: investiga y propone antes de tocar nada', run: () => runCommand('chat.mode.plan') },
    { name: 'ask', description: 'Modo Preguntar: solo lectura', run: () => runCommand('chat.mode.ask') },
    { name: 'approve', description: 'Auto-aprobar cambios del agente', run: () => runCommand('chat.toggleApprove') },
    { name: 'undo', description: 'Revertir el último cambio', run: () => runCommand('chat.undoLast') },
    { name: 'status', description: 'Estado de la sesión', notice: statusText },
    { name: 'help', description: 'Comandos disponibles', notice: helpText },
  ];
}

// Claude Code resuelve sus "/" él mismo: basta con mandarlos como texto.
function claudeCommands(chat) {
  const local = [
    { name: 'new', description: 'Nueva conversación', run: () => runCommand('chat.newConversation') },
    { name: 'undo', description: 'Revertir el último cambio de Claude', run: () => runCommand('chat.undoLast') },
  ];
  const cards = CLAUDE_IDE_CARDS.map((c) => ({ name: c.cmd, description: c.desc, group: 'claude' }));
  const taken = new Set([...local, ...cards].map((c) => c.name));
  const catalog = claudeMenuEntries(chat.ccCommands || [])
    .filter((c) => !taken.has(c.cmd))
    .map((c) => ({ name: c.cmd, args: c.hint || '', description: c.desc, group: c.group }));
  return [...local.map((c) => ({ ...c, group: 'lixbon' })), ...cards, ...catalog];
}

const ORCH_COMMAND = { name: 'orquestar', args: '<objetivo>', description: 'Coordina un equipo de agentes para un objetivo', group: 'orch' };

function commandsOf(chat) {
  const list = agentOf(chat) === 'claude' ? claudeCommands(chat) : lixbonCommands().map((c) => ({ ...c, group: 'lixbon' }));
  return list.some((c) => c.name === 'orquestar') ? list : [ORCH_COMMAND, ...list];
}

function helloFields() {
  const chat = useChatStore.getState();
  const app = useAppStore.getState();
  const agent = agentOf(chat);
  const workspace = folderName(app.workspaceRoot);
  return {
    source: 'ide',
    agent,
    title: chat.conversationTitle || workspace || AGENT_LABEL[agent],
    workspace,
    machine: MACHINE,
    mode: agent === 'claude' ? chat.ccMode || 'default' : chat.chatMode === 'agent' ? 'agent' : chat.chatMode || 'ask',
    model: agent === 'claude' ? chat.ccModel || 'default' : app.currentModel,
    commands: commandsOf(chat).map(({ name, args = '', description, group }) => ({ name, args, description, group })),
    capabilities: CAPABILITIES,
  };
}

function emitHello(force = false) {
  const hello = helloFields();
  const key = [hello.agent, hello.title, hello.workspace, hello.mode, hello.model, hello.commands.length].join('|');
  if (!force && key === lastHelloKey) return;
  lastHelloKey = key;
  emit('hello', hello);
}

function statusText() {
  const h = helloFields();
  const chat = useChatStore.getState();
  return [
    `${AGENT_LABEL[h.agent]} · ${h.workspace || 'sin carpeta'}`,
    `Modo: ${h.mode} · Modelo: ${h.model || '—'}`,
    `${chat.messages.filter((m) => m.role === 'user').length} mensajes · ${chat.streaming ? 'trabajando' : 'en espera'}`,
  ].join('\n');
}

function helpText() {
  return commandsOf(useChatStore.getState())
    .map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''} — ${c.description}`)
    .join('\n');
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
    const hello = helloFields();
    try {
      const res = await api.post('/api/remote/sessions', {
        source: 'ide',
        title: hello.title,
        machine: MACHINE,
        agent: hello.agent,
        workspace: hello.workspace,
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
  buffer = [];
  prevMessages = chat.messages;
  prevStreaming = chat.streaming;
  assistantOpen = false;
  assistantSent = '';
  remotePromptQueue = [];
  nextRemotePrompt = null;
  lastHelloKey = '';
  filesCache = { at: 0, list: [] };
  sentCards = new WeakSet(chat.messages.filter((m) => m.role === 'cmd'));
  prevSide = chat.ccSide;
  prevBtw = chat.ccBtw;
  prevBackground = chat.ccBackground || [];

  emitHello(true);
  emit('snapshot', { messages: mapSnapshot(chat.messages) });
  emit('status', { state: chat.streaming ? 'thinking' : 'idle' });
  if (chat.pendingApproval) announceApproval(chat.pendingApproval);
  if (prevBackground.length) emitBackground(prevBackground);

  unsubChat = useChatStore.subscribe(onChatChange);
  startOrchBridge(emit);
  flushTimer = setInterval(flushEvents, FLUSH_MS);
  readCommands(sessionId);
}

function stopChannel() {
  if (unsubChat) { unsubChat(); unsubChat = null; }
  stopOrchBridge();
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
      msgs.forEach((m) => m.role === 'cmd' && sentCards.add(m));
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
    announceCards(msgs);
  }

  if (state.streaming !== prevStreaming) {
    prevStreaming = state.streaming;
    if (!state.streaming) {
      closeAssistant(msgs);
      emit('status', { state: 'idle' });
      // Prompts que llegaron del móvil mientras el agente trabajaba
      if (remotePromptQueue.length) {
        const next = remotePromptQueue.shift();
        setTimeout(() => sendRemotePrompt(next), 50);
      }
    } else {
      emit('status', { state: 'thinking' });
    }
  }

  announceSidePanels(state);
  if ((state.ccBackground || []) !== prevBackground) {
    prevBackground = state.ccBackground || [];
    emitBackground(prevBackground);
  }

  // Cambio de pestaña (otra sesión, quizá de otro agente), de título o de
  // modo: el móvil tiene que enterarse para rotular la sesión y sus comandos.
  emitHello();

  if (state.pendingApproval && currentApprovalId === null) {
    announceApproval(state.pendingApproval);
  } else if (!state.pendingApproval && currentApprovalId !== null) {
    emit('approval_resolved', { id: currentApprovalId });
    currentApprovalId = null;
  }
}

function announceNew(m) {
  if (m.role === 'user') {
    emit('user_msg', {
      text: m.content || '',
      origin: nextRemotePrompt ? 'remote' : 'local',
      images: nextRemotePrompt?.images ?? (Array.isArray(m.images) ? m.images.length : 0),
      mentions: nextRemotePrompt?.mentions ?? (Array.isArray(m.mentions) ? m.mentions : []),
    });
    nextRemotePrompt = null;
  } else if (m.role === 'assistant') {
    closeAssistant(prevMessages);
    assistantOpen = true;
    assistantSent = m.content || '';
    if (assistantSent) emit('assistant_delta', { text: assistantSent });
  } else if (m.role === 'tool') {
    emit('tool_use', { tool: m.tool, summary: toolSummary(m.tool, m.args), label: describeTool(m), readonly: false });
    emit('tool_result', {
      tool: m.tool,
      result: (m.content || '').slice(0, RESULT_CHARS),
      error: m.ok === false,
    });
  } else if (m.role === 'error') {
    emit('error', { message: m.content || '' });
  }
}

function announceCards(msgs) {
  for (const m of msgs.slice(-4)) {
    if (m.role !== 'cmd' || sentCards.has(m)) continue;
    sentCards.add(m);
    if (assistantOpen && m === msgs[msgs.length - 1]) {
      emit('assistant_done', { text: '' });
      assistantOpen = false;
      assistantSent = '';
    }
    emit('command_result', remoteCard(m, helpCommands()));
  }
}

// Con Claude trabajando, los "/" de lectura y /btw se responden en paneles
// aparte del IDE que no pasan por los mensajes.
function announceSidePanels(state) {
  const side = state.ccSide;
  if (side && side !== prevSide && !side.loading) {
    if (side.card && !sentCards.has(side.card)) {
      sentCards.add(side.card);
      emit('command_result', remoteCard(side.card, helpCommands()));
    } else if (side.error) {
      emit('error', { message: `/${side.name}: ${side.error}` });
    }
  }
  prevSide = side;
  const btw = state.ccBtw;
  if (btw && btw !== prevBtw && !btw.loading && prevBtw?.loading) {
    if (btw.answer) emit('command_result', { name: 'btw', args: btw.question, rows: [], text: btw.answer });
    else if (btw.error) emit('error', { message: `/btw: ${btw.error}` });
  }
  prevBtw = btw;
}

function emitBackground(tasks) {
  emit('background', { tasks: tasks.map(({ id, type, description, since }) => ({ id, type, description, since })) });
}

function helpCommands() {
  return commandsOf(useChatStore.getState()).map(({ name, args = '', description }) => ({ name: args ? `${name} ${args}` : name, description }));
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

function runRemoteSlash(slash, chat) {
  const entry = commandsOf(chat).find((c) => c.name === slash.name);
  if (!entry || (!entry.run && !entry.notice)) return false;
  if (entry.run) {
    entry.run();
    emit('notice', { text: `/${entry.name} · ${entry.description}` });
  } else {
    emit('notice', { text: entry.notice() });
  }
  return true;
}

function sendRemotePrompt(item) {
  const chat = useChatStore.getState();
  // Claude Code encola él solo lo que llega mientras trabaja; Lixbon no.
  if (chat.streaming && agentOf(chat) !== 'claude') { remotePromptQueue.push(item); return; }
  const text = (item.text || '').trim();
  const attachments = Array.isArray(item.attachments) ? item.attachments : [];
  const orch = attachments.length === 0 && /^\/orquestar(?:\s+([\s\S]+))?$/i.exec(text);
  if (orch) {
    // El chat de la sesión pasa a ser el coordinador, como en el IDE.
    prepareRemoteOrchestrate(orch[1]).then((problem) => {
      if (problem) { emit('notice', { text: problem }); return; }
      const now = useChatStore.getState();
      if (agentOf(now) !== 'claude' && now.chatMode !== 'agent') now.setChatMode('agent');
      nextRemotePrompt = { images: 0, mentions: [] };
      useChatStore.getState().send(text, null, [], []);
    });
    return;
  }
  const slash = attachments.length === 0 && parseSlash(text);
  if (slash && runRemoteSlash(slash, chat)) return;

  const docs = attachments.filter((a) => a.kind === 'doc');
  const images = attachments
    .filter((a) => a.kind === 'image' && a.base64)
    .map((a) => ({ name: a.name, base64: a.base64, dataUrl: `data:${a.mime || 'image/jpeg'};base64,${a.base64}` }));
  let message = text;
  if (docs.length) {
    const context = docs.map((d) => `--- Documento adjunto: ${d.name} ---\n${d.text}`).join('\n\n');
    message = `${context}\n\n---\n\n${text || 'Analiza este documento.'}`;
  }
  const mentions = Array.isArray(item.mentions) ? item.mentions : [];
  nextRemotePrompt = { images: images.length, mentions: mentions.map((m) => m.name) };
  chat.send(message, null, images, mentions);
}

async function searchFiles(query) {
  if (Date.now() - filesCache.at > FILES_TTL_MS) {
    filesCache = { at: Date.now(), list: await listFiles().catch(() => []) };
  }
  const q = String(query || '').toLowerCase();
  const pool = filesCache.list;
  const found = q
    ? pool
      .map((f) => ({ f, s: fuzzyScore(f.rel || f.name, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.f)
    : pool;
  emit('files', {
    query: String(query || ''),
    items: found.slice(0, FILE_RESULTS).map((f) => ({ name: f.name, rel: f.rel || f.name, path: f.path })),
  });
}

function handleCommand(cmd) {
  const chat = useChatStore.getState();
  switch (cmd.type) {
    case 'prompt':
      if ((cmd.text || '').trim() || cmd.attachments?.length) sendRemotePrompt(cmd);
      break;
    case 'files':
      searchFiles(cmd.query);
      break;
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
      emitHello(true);
      emit('snapshot', { messages: mapSnapshot(chat.messages) });
      republishOrch();
      break;
    case 'orch':
      handleOrchAction(cmd.action, cmd.args || {});
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
