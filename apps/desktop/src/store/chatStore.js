// chatStore.js — estado del chat del IDE.
// Los mensajes viven en memoria; el historial persistente está en el backend
// (tabla conversations), así que no se duplica en localStorage.
//
// Modo agente: el modelo puede crear/editar/eliminar archivos del workspace
// pidiendo herramientas con JSON embebido (protocolo compartido con el CLI,
// ver lib/agent.js). Cada cambio pide aprobación salvo "Aplicar todo".

import { create } from 'zustand';
import { useAppStore } from './appStore';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';
import {
  MAX_AGENT_STEPS,
  READ_ONLY_TOOLS,
  buildAgentSystemPrompt,
  captureSnapshot,
  cleanProse,
  computeChangePreview,
  displayableText,
  executeToolCall,
  extractToolCalls,
  revertSnapshot,
  splitThinking,
  truncateFabricated,
} from '../lib/agent';
import { useEditorStore } from './editorStore';

let abortController = null;

export const useChatStore = create((set, get) => ({
  messages: [], // { role: 'user'|'assistant'|'error'|'tool', content, sources?, tool?, args?, ok?, change? }
  conversationId: null,
  streaming: false,
  view: 'chat', // 'chat' | 'history'
  agentMode: (localStorage.getItem('lixbon_agent_mode') ?? 'true') === 'true',
  // Por defecto el agente escribe directo (petición del diseño); en Ajustes
  // se puede exigir aprobación por cambio.
  autoApprove: (localStorage.getItem('lixbon_agent_auto') ?? 'true') === 'true',
  pendingApproval: null, // { tool, args, change, resolve }

  setView: (view) => set({ view }),

  setAgentMode: (agentMode) => {
    localStorage.setItem('lixbon_agent_mode', agentMode ? 'true' : 'false');
    set({ agentMode });
  },

  setAutoApprove: (autoApprove) => {
    localStorage.setItem('lixbon_agent_auto', autoApprove ? 'true' : 'false');
    set({ autoApprove });
  },

  resolveApproval: (decision) => {
    const pending = get().pendingApproval;
    if (!pending) return;
    set({ pendingApproval: null });
    pending.resolve(decision);
  },

  newConversation: () => {
    get().stop();
    set({ messages: [], conversationId: null, view: 'chat' });
  },

  loadConversation: async (id) => {
    get().stop();
    const res = await api.get(`/api/conversations/${id}/messages`);
    const messages = (res.messages || []).map((m) => {
      // Los TOOL_RESULT del modo agente quedan persistidos como mensajes de
      // usuario; al recargar se muestran como filas de herramienta discretas.
      if (m.role !== 'assistant' && (m.content || '').startsWith('TOOL_RESULT ')) {
        const firstLine = m.content.split('\n')[0];
        return {
          role: 'tool',
          tool: firstLine.split(' ')[1]?.replace(/:$/, '') || 'tool',
          content: firstLine.replace(/^TOOL_RESULT \S+ /, '').slice(0, 160),
          ok: !firstLine.includes('[ERROR]'),
        };
      }
      if (m.role === 'assistant') {
        const { thinking, visible } = splitThinking(m.content || '');
        return { role: 'assistant', content: cleanProse(visible) || m.content, thinking };
      }
      return { role: 'user', content: m.content };
    });
    set({ conversationId: id, messages, view: 'chat' });
  },

  stop: () => {
    const pending = get().pendingApproval;
    if (pending) {
      set({ pendingApproval: null });
      pending.resolve('no');
    }
    if (abortController) {
      abortController.abort();
      abortController = null;
    }
    set({ streaming: false });
  },

  /**
   * Envía un mensaje. `context` opcional: { name, path, code, language }
   * — se antepone como bloque de código al mensaje que ve el modelo,
   * pero en la UI solo se muestra el chip.
   */
  send: async (text, context = null) => {
    const { messages, conversationId, streaming, agentMode } = get();
    if (streaming || !text.trim()) return;

    const { serverUrl, apiKey, currentModel, workspaceRoot } = useAppStore.getState();
    if (!currentModel) {
      set({ messages: [...messages, { role: 'error', content: 'No hay ningún modelo disponible. Comprueba la conexión con el servidor.' }] });
      return;
    }

    let modelText = text.trim();
    if (context?.code) {
      modelText =
        `Contexto — archivo \`${context.path}\`:\n\n` +
        '```' + (context.language || '') + '\n' + context.code + '\n```\n\n' +
        modelText;
    }

    // El backend acepta ids de conversación generados por el cliente
    const convId = conversationId || crypto.randomUUID();
    const agentActive = agentMode && !!workspaceRoot;

    const userMsg = { role: 'user', content: text.trim(), context: context ? { name: context.name, selection: context.isSelection } : null };
    const history = [...messages, userMsg];
    set({ messages: [...history, { role: 'assistant', content: '', sources: null }], streaming: true, conversationId: convId });

    // Historial que ve el modelo: sin burbujas de error ni filas de
    // herramienta, y con el contexto de código incorporado al último mensaje
    const modelMessages = [
      ...history.slice(0, -1)
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
        .map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: modelText },
    ];
    if (agentActive) {
      // El archivo abierto le da al modelo el referente de "este archivo"
      const activePath = useEditorStore.getState().activePath || '';
      const activeRel = activePath.startsWith(workspaceRoot)
        ? activePath.slice(workspaceRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
        : '';
      modelMessages.unshift({ role: 'system', content: await buildAgentSystemPrompt(workspaceRoot, activeRel) });
    }

    abortController = new AbortController();
    const signal = abortController.signal;

    const patchLast = (patch) => {
      const msgs = get().messages;
      const last = msgs[msgs.length - 1];
      set({ messages: [...msgs.slice(0, -1), { ...last, ...patch }] });
    };
    const pushMsg = (msg) => set({ messages: [...get().messages, msg] });

    // Un solo recordatorio por turno: si el modelo "sugiere" código en vez de
    // aplicarlo (vicio de los modelos chicos), se le exige usar la herramienta.
    let nudged = false;

    try {
      for (let step = 0; step < MAX_AGENT_STEPS; step++) {
        let raw = '';
        let reasoningAcc = ''; // delta.reasoning_content del gateway
        const liveThinking = (inline) =>
          [reasoningAcc, inline].filter(Boolean).join('\n').trim();
        await streamChatCompletion({
          serverUrl,
          apiKey,
          model: currentModel,
          messages: modelMessages,
          conversationId: convId,
          signal,
          onDelta: (delta) => {
            raw += delta;
            const { thinking, visible } = splitThinking(raw);
            patchLast({
              content: agentActive ? displayableText(visible) : visible,
              thinking: liveThinking(thinking),
            });
          },
          onReasoning: (delta) => {
            reasoningAcc += delta;
            patchLast({ thinking: liveThinking(splitThinking(raw).thinking) });
          },
          onSources: (sources) => patchLast({ sources }),
        });

        const { thinking, visible } = splitThinking(raw);
        const fullThinking = liveThinking(thinking);

        if (!agentActive) {
          patchLast({ content: visible.trim(), thinking: fullThinking });
          break;
        }

        const spoken = truncateFabricated(visible);
        const calls = extractToolCalls(spoken);
        const prose = cleanProse(spoken);

        if (!calls.length && nudged && (/^ok\.?$/i.test(prose.trim()) || !prose.trim())) {
          // Tras el recordatorio confirmó que no había nada que aplicar
          set({ messages: get().messages.slice(0, -1) });
          break;
        }
        patchLast({ content: prose, thinking: fullThinking });
        if (!calls.length) {
          if (!nudged && /```/.test(spoken)) {
            // Mostró código en vez de aplicarlo: una oportunidad de corregirse
            nudged = true;
            modelMessages.push({ role: 'assistant', content: spoken });
            modelMessages.push({
              role: 'user',
              content: 'Si ese código debía aplicarse a un archivo del workspace, hazlo AHORA con '
                + '{"tool":"write_file","args":{"path":"...","content":"CONTENIDO COMPLETO"}} (JSON puro, sin ```). '
                + 'Si no había nada que aplicar, responde solo "OK".',
            });
            pushMsg({ role: 'assistant', content: '', sources: null });
            continue;
          }
          break;
        }
        if (!prose && !fullThinking) {
          // La burbuja solo pedía herramientas: fuera, quedan las filas
          set({ messages: get().messages.slice(0, -1) });
        }

        modelMessages.push({ role: 'assistant', content: spoken });
        const results = [];
        for (const call of calls) {
          if (signal.aborted) break;
          const result = await get()._runTool(workspaceRoot, call);
          pushMsg({
            role: 'tool', tool: call.tool, args: call.args, ok: result.ok,
            content: result.display, change: result.change, snapshot: result.snapshot,
          });
          results.push(`TOOL_RESULT ${call.tool}: ${result.output}`);
        }
        if (signal.aborted) break;
        modelMessages.push({ role: 'user', content: results.join('\n') });
        pushMsg({ role: 'assistant', content: '', sources: null });
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        // detenido por el usuario: se conserva lo recibido
      } else {
        const msgs = get().messages;
        const last = msgs[msgs.length - 1];
        const keep = last.role === 'assistant' && !last.content ? msgs.slice(0, -1) : msgs; // sin tokens: fuera la burbuja vacía
        set({ messages: [...keep, { role: 'error', content: err.message }] });
      }
    } finally {
      abortController = null;
      set({ streaming: false, pendingApproval: null });
      // Burbuja vacía sobrante (cancelación entre pasos, tope de pasos…)
      const msgs = get().messages;
      const last = msgs[msgs.length - 1];
      if (last?.role === 'assistant' && !(last.content || '').trim() && !last.sources && !last.thinking) {
        set({ messages: msgs.slice(0, -1) });
      }
    }
  },

  /** Ejecuta una herramienta del agente con aprobación previa (interno). */
  _runTool: async (root, call) => {
    const tool = call.tool;
    const args = call.args || {};
    let change = null;
    let snapshot = null;
    if (!READ_ONLY_TOOLS.has(tool)) {
      try {
        change = await computeChangePreview(root, tool, args);
      } catch {
        change = null; // ruta inválida: el error real saldrá al ejecutar
      }
      if (!get().autoApprove) {
        const decision = await new Promise((resolve) => {
          set({ pendingApproval: { tool, args, change, resolve } });
        });
        if (decision === 'always') set({ autoApprove: true });
        else if (decision !== 'yes') {
          return { ok: false, display: 'rechazado por el usuario', output: 'Ejecución cancelada por el usuario', change };
        }
      }
      snapshot = await captureSnapshot(root, tool, args);
    }
    try {
      const output = await executeToolCall(root, tool, args);
      return { ok: true, display: output.split('\n')[0].slice(0, 160), output, change, snapshot };
    } catch (err) {
      const message = String(err?.message || err);
      return { ok: false, display: message.slice(0, 160), output: `[ERROR] ${message}`, change };
    }
  },

  /** Deshace el cambio de una fila de herramienta (checkpoint estilo Cursor). */
  revertTool: async (index) => {
    const msgs = get().messages;
    const msg = msgs[index];
    if (!msg || msg.role !== 'tool' || !msg.snapshot || msg.reverted) return;
    const root = useAppStore.getState().workspaceRoot;
    try {
      await revertSnapshot(root, msg.snapshot);
      set({ messages: msgs.map((m, i) => (i === index ? { ...m, reverted: true } : m)) });
    } catch (err) {
      set({ messages: [...get().messages, { role: 'error', content: `No se pudo revertir: ${err?.message || err}` }] });
    }
  },
}));
