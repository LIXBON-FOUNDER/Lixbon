// chatStore.js — estado del chat del IDE.
// Los mensajes viven en memoria; el historial persistente está en el backend
// (tabla conversations), así que no se duplica en localStorage.

import { create } from 'zustand';
import { useAppStore } from './appStore';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';

let abortController = null;

export const useChatStore = create((set, get) => ({
  messages: [], // { role: 'user'|'assistant'|'error', content, sources? }
  conversationId: null,
  streaming: false,
  view: 'chat', // 'chat' | 'history'

  setView: (view) => set({ view }),

  newConversation: () => {
    get().stop();
    set({ messages: [], conversationId: null, view: 'chat' });
  },

  loadConversation: async (id) => {
    get().stop();
    const res = await api.get(`/api/conversations/${id}/messages`);
    const messages = (res.messages || []).map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
    set({ conversationId: id, messages, view: 'chat' });
  },

  stop: () => {
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
    const { messages, conversationId, streaming } = get();
    if (streaming || !text.trim()) return;

    const { serverUrl, apiKey, currentModel } = useAppStore.getState();
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

    const userMsg = { role: 'user', content: text.trim(), context: context ? { name: context.name, selection: context.isSelection } : null };
    const assistantMsg = { role: 'assistant', content: '', sources: null };
    const history = [...messages, userMsg];
    set({ messages: [...history, assistantMsg], streaming: true, conversationId: convId });

    // Historial que ve el modelo: sin burbujas de error y con el contexto
    // de código incorporado al último mensaje
    const modelMessages = [
      ...history.slice(0, -1)
        .filter((m) => m.role !== 'error' && m.content)
        .map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: modelText },
    ];

    abortController = new AbortController();

    const patchLast = (patch) => {
      const msgs = get().messages;
      const last = msgs[msgs.length - 1];
      set({ messages: [...msgs.slice(0, -1), { ...last, ...patch }] });
    };

    try {
      await streamChatCompletion({
        serverUrl,
        apiKey,
        model: currentModel,
        messages: modelMessages,
        conversationId: convId,
        signal: abortController.signal,
        onDelta: (delta) => patchLast({ content: get().messages.at(-1).content + delta }),
        onSources: (sources) => patchLast({ sources }),
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        // detenido por el usuario: se conserva lo recibido
      } else {
        const msgs = get().messages;
        const last = msgs[msgs.length - 1];
        const keep = last.content ? msgs : msgs.slice(0, -1); // sin tokens: fuera la burbuja vacía
        set({ messages: [...keep, { role: 'error', content: err.message }] });
      }
    } finally {
      abortController = null;
      set({ streaming: false });
    }
  },
}));
