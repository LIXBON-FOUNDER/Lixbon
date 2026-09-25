// chatStore.js — estado del chat del IDE.
// Los mensajes viven en memoria; el historial persistente está en el backend
// (tabla conversations), así que no se duplica en localStorage.
//
// Modo agente: el modelo puede crear/editar/eliminar archivos del workspace
// pidiendo herramientas con JSON embebido (protocolo compartido con el CLI,
// ver lib/agent.js). Cada cambio pide aprobación salvo "Aplicar todo".

import { create, useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useEffect, useState } from 'react';
import { useAppStore } from './appStore';
import { useOutputStore } from './outputStore';
import { api } from '../lib/api';
import { streamChatCompletion } from '../lib/stream';
import { readFileContent } from '../lib/tauri';
import { searchIndex } from '../lib/codebaseIndex';
import {
  MAX_AGENT_STEPS,
  MAX_REPEATED_CALLS,
  READ_ONLY_TOOLS,
  buildAgentSystemPrompt,
  DEFAULT_CMD_ALLOWLIST,
  isAllowedCommand,
  isNeverAutoCommand,
  buildModelHistory,
  captureSnapshot,
  cleanProse,
  computeChangePreview,
  displayableText,
  executeToolCall,
  extractToolCalls,
  hasInvalidCall,
  hasUnclosedCall,
  revertSnapshot,
  splitThinking,
  truncateFabricated,
} from '../lib/agent';
import { TOOL_SCHEMAS, nativeCallToInternal } from '../lib/agentSchemas';
import { useMcpStore, mcpToolSchemas, mcpPromptSection } from './mcpStore';
import { clipToolOutput, estimateTokens, fitHistory, promptBudget } from '../lib/agentContext';
import { describeImages } from '../lib/vision';
import { roleWarning } from '../lib/modelRoles';

/** Categoría de permisos de una herramienta (Ajustes → Agente y permisos). */
export function toolCategory(tool) {
  if (tool.startsWith('mcp__')) return 'mcp';
  if (tool === 'run_command') return 'command';
  if (tool === 'delete_file') return 'delete';
  if (tool === 'fetch_url' || tool === 'web_search') return 'web';
  return READ_ONLY_TOOLS.has(tool) ? 'read' : 'edit';
}

const POLICY_KEY = 'lixbon_tool_policy';
function initialPolicy() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(POLICY_KEY) || '{}') || {}; } catch { /* corrupto: por defecto */ }
  const auto = (localStorage.getItem('lixbon_agent_auto') ?? 'true') === 'true';
  const run = (localStorage.getItem('lixbon_agent_autorun') ?? 'false') === 'true';
  // edit y command se derivan de los ajustes de siempre para no cambiar lo que
  // el usuario ya tenía; solo 'never' (que antes no existía) se respeta aparte.
  return {
    read: 'allow', web: 'allow', mcp: 'ask', delete: 'ask',
    ...saved,
    edit: saved.edit === 'never' ? 'never' : auto ? 'allow' : 'ask',
    command: saved.command === 'never' ? 'never' : run ? 'allow' : 'ask',
  };
}

// Varios agentes a la vez: cada conversación abierta es un store propio (su
// stream, sus aprobaciones, sus cambios). `useChatStore` sigue siendo la API de
// siempre y apunta a la sesión activa; las demás siguen trabajando detrás.
let nextKey = 1;

export const useSessionsStore = create((set, get) => ({
  sessions: {},
  order: [],
  activeKey: null,
  seen: {}, // clave → true cuando el usuario ya vio cómo terminó
  add: (store, activate = true) => {
    const key = `s${nextKey++}`;
    set({ sessions: { ...get().sessions, [key]: store }, order: [...get().order, key], ...(activate ? { activeKey: key } : {}) });
    // Terminar detrás deja la sesión "por ver" hasta que el usuario la abra.
    store.subscribe((a, b) => {
      if (b.streaming && !a.streaming && get().activeKey !== key) set({ seen: { ...get().seen, [key]: false } });
    });
    return key;
  },
  activate: (key) => {
    if (!get().sessions[key] || key === get().activeKey) return;
    // La que se deja también cuenta como vista: el usuario la estaba mirando.
    set({ activeKey: key, seen: { ...get().seen, [key]: true, [get().activeKey]: true } });
  },
  remove: (key) => {
    const { [key]: _drop, ...rest } = get().sessions;
    set({ sessions: rest, order: get().order.filter((k) => k !== key) });
  },
}));

const activeStore = () => {
  const { sessions, activeKey } = useSessionsStore.getState();
  return sessions[activeKey];
};
const allStores = () => Object.values(useSessionsStore.getState().sessions);

/** Ajustes del agente: iguales en todas las sesiones abiertas. */
const share = (patch) => { for (const st of allStores()) st.setState(patch); };

/** Abre una sesión nueva y la activa. Las sesiones sin nada (ni mensajes ni
    stream) que queden detrás se descartan para no acumular vacías. */
function spawnSession() {
  for (const [key, st] of Object.entries(useSessionsStore.getState().sessions)) {
    const s = st.getState();
    if (!s.streaming && !s.pendingApproval && s.messages.length === 0) useSessionsStore.getState().remove(key);
  }
  const store = makeChatStore();
  useSessionsStore.getState().add(store);
  return store;
}

function makeChatStore() {
  let abortController = null;
  return createStore((set, get) => ({
    messages: [], // { role: 'user'|'assistant'|'error'|'tool', content, sources?, tool?, args?, ok?, change? }
    conversationId: null,
    conversationTitle: '', // lo pone el auto-título; se ve en la cabecera del panel
    streaming: false,
    agentMode: (localStorage.getItem('lixbon_agent_mode') ?? 'true') === 'true',
    // Por defecto el agente escribe directo (petición del diseño); en Ajustes
    // se puede exigir aprobación por cambio.
    autoApprove: (localStorage.getItem('lixbon_agent_auto') ?? 'true') === 'true',
    // Tool-calling nativo (opt-in): requiere un modelo que soporte tools en
    // Ollama. Off = protocolo de texto (JSON embebido), fiable y por defecto.
    nativeTools: (localStorage.getItem('lixbon_agent_native') ?? 'false') === 'true',
    // Ejecutar comandos del agente sin aprobación (B4). OFF por defecto: correr
    // shell es irreversible (a diferencia de editar archivos, que tiene revert),
    // así que los comandos SIEMPRE piden confirmación salvo que estén en la
    // allowlist o que el usuario active esto explícitamente.
    autoRunCommands: (localStorage.getItem('lixbon_agent_autorun') ?? 'false') === 'true',
    commandAllowlist: (() => {
      try {
        const saved = JSON.parse(localStorage.getItem('lixbon_agent_cmd_allowlist') || 'null');
        return Array.isArray(saved) ? saved : DEFAULT_CMD_ALLOWLIST;
      } catch { return DEFAULT_CMD_ALLOWLIST; }
    })(),
    pendingApproval: null, // { tool, args, change, resolve }
    toolPolicy: initialPolicy(), // categoría → 'allow' | 'ask' | 'never'

    setToolPolicy: (cat, value) => {
      const toolPolicy = { ...get().toolPolicy, [cat]: value };
      localStorage.setItem(POLICY_KEY, JSON.stringify(toolPolicy));
      share({ toolPolicy });
      if (cat === 'edit') {
        localStorage.setItem('lixbon_agent_auto', value === 'allow' ? 'true' : 'false');
        share({ autoApprove: value === 'allow' });
      }
      if (cat === 'command') {
        localStorage.setItem('lixbon_agent_autorun', value === 'allow' ? 'true' : 'false');
        share({ autoRunCommands: value === 'allow' });
      }
    },

    setAgentMode: (agentMode) => {
      localStorage.setItem('lixbon_agent_mode', agentMode ? 'true' : 'false');
      share({ agentMode });
    },

    setAutoApprove: (autoApprove) => get().setToolPolicy('edit', autoApprove ? 'allow' : 'ask'),

    setNativeTools: (nativeTools) => {
      localStorage.setItem('lixbon_agent_native', nativeTools ? 'true' : 'false');
      share({ nativeTools });
    },

    setAutoRunCommands: (autoRunCommands) => get().setToolPolicy('command', autoRunCommands ? 'allow' : 'ask'),

    setCommandAllowlist: (list) => {
      const arr = Array.isArray(list) ? list.map((s) => String(s).trim()).filter(Boolean) : [];
      localStorage.setItem('lixbon_agent_cmd_allowlist', JSON.stringify(arr));
      share({ commandAllowlist: arr });
    },

    resolveApproval: (decision) => {
      const pending = get().pendingApproval;
      if (!pending) return;
      set({ pendingApproval: null });
      pending.resolve(decision);
    },

    /** Con un agente trabajando, la conversación nueva se abre al lado y la
        otra sigue; si no, se reutiliza esta. */
    newConversation: () => {
      if (get().streaming || get().pendingApproval) { spawnSession(); return; }
      set({ messages: [], conversationId: null, conversationTitle: '' });
    },

    loadConversation: async (id) => {
      const reg = useSessionsStore.getState();
      const open = Object.entries(reg.sessions).find(([, st]) => st.getState().conversationId === id);
      if (open) { reg.activate(open[0]); return; }
      if (get().streaming || get().pendingApproval) { await spawnSession().getState().loadConversation(id); return; }
      get().stop();
      let res;
      try {
        res = await api.get(`/api/conversations/${id}/messages`);
      } catch (err) {
        set({
          messages: [...get().messages, {
            role: 'error',
            content: `No se pudo cargar la conversación: ${err?.message || err}`,
          }],
        });
        return;
      }
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
          // Nunca caer de vuelta a `m.content`: si cleanProse lo deja vacío es
          // porque el turno entero era un tool-call (ya persistido como fila
          // TOOL_RESULT aparte); mostrar el crudo filtraba el JSON al chat.
          return { role: 'assistant', content: cleanProse(visible), thinking };
        }
        return { role: 'user', content: m.content };
      }).filter((m) => m.role !== 'assistant' || m.content || m.thinking);
      set({
        conversationId: id,
        conversationTitle: res.conversation?.title || '',
        messages,
      });
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
    send: async (text, context = null, images = [], mentions = []) => {
      const { messages, conversationId, streaming, agentMode } = get();
      const hasImages = Array.isArray(images) && images.length > 0;
      if (streaming || (!text.trim() && !hasImages)) return;

      const appState = useAppStore.getState();
      const { serverUrl, apiKey, currentModel, workspaceRoot } = appState;
      if (!currentModel) {
        set({ messages: [...messages, { role: 'error', content: 'No hay ningún modelo disponible. Comprueba la conexión con el servidor.' }] });
        return;
      }

      // El backend acepta ids de conversación generados por el cliente
      const convId = conversationId || crypto.randomUUID();
      // Solo el primer intercambio pide título: después ya lo tiene.
      const isFirstExchange = !conversationId;
      const agentActive = agentMode && !!workspaceRoot;

      // ── Sub-agente de visión: si hay imágenes, un modelo multimodal las
      //    describe en texto para que el modelo de texto (qwen…) las entienda. ──
      const userMsg = {
        role: 'user',
        content: text.trim(),
        context: context ? { name: context.name, selection: context.isSelection } : null,
        images: hasImages ? images.map((im) => im.dataUrl) : null,
      };
      let visionText = '';
      if (hasImages) {
        const visionModel = appState.effectiveVisionModel();
        if (!visionModel) {
          // El aviso lo redacta el gateway (sabe qué falta); el texto local es el
          // respaldo para un gateway antiguo sin roles.
          const aviso = roleWarning(appState.modelRoles, 'vision')
            || 'Instala uno en Ollama (p. ej. `ollama pull llava`).';
          set({ messages: [...messages, userMsg, {
            role: 'error',
            content: `Adjuntaste una imagen pero no hay un modelo de visión disponible. ${aviso} `
              + 'También puedes elegirlo en Ajustes → Modelos.',
          }] });
          return;
        }
        abortController = new AbortController();
        set({ messages: [...messages, userMsg, { role: 'assistant', content: '', vision: true }], streaming: true, conversationId: convId });
        try {
          const desc = await describeImages({
            serverUrl, apiKey, model: visionModel,
            images: images.map((im) => im.base64),
            signal: abortController.signal,
          });
          visionText = `[El usuario adjuntó ${images.length} imagen(es). Un modelo de visión (${visionModel}) las describió así:\n${desc}\n]\n\n`;
        } catch (err) {
          abortController = null;
          if (err.name === 'AbortError') { set({ messages: get().messages.slice(0, -1), streaming: false }); return; }
          set({ messages: [...get().messages.slice(0, -1), { role: 'error', content: `Visión: ${err.message}` }], streaming: false });
          return;
        }
        // Quita la burbuja de estado "viendo imagen"; sigue el flujo normal
        set({ messages: get().messages.slice(0, -1), streaming: false });
      }

      let modelText = text.trim() || '(ver la imagen adjunta)';
      if (context?.code) {
        if (agentActive) {
          // En modo agente NO se inyecta el archivo como bloque cercado (```): eso
          // le enseña al modelo a "responder con un bloque de código" en vez de
          // editar. Se le da la referencia y el agente lee con read_file.
          modelText =
            `(El usuario tiene abierto \`${context.path}\`${context.isSelection ? ' con una selección activa' : ''}. ` +
            'Usa read_file para ver su contenido actual y edit_file/write_file para modificarlo.)\n\n' +
            modelText;
        } else {
          modelText =
            `Contexto — archivo \`${context.path}\`:\n\n` +
            '```' + (context.language || '') + '\n' + context.code + '\n```\n\n' +
            modelText;
        }
      }
      // Archivos mencionados con @ en el chat. En modo agente se pasan como
      // REFERENCIA (el agente los lee con read_file); en chat normal se inyecta
      // su contenido para que el modelo razone sobre ellos.
      if (Array.isArray(mentions) && mentions.length) {
        if (agentActive) {
          const list = mentions.map((m) => `- ${m.rel || m.path}`).join('\n');
          modelText = `(El usuario mencionó estos archivos; léelos con read_file si los necesitas:\n${list}\n)\n\n` + modelText;
        } else {
          const MAX_MENTION_CHARS = 16000;
          const blocks = [];
          for (const m of mentions) {
            try {
              let code = await readFileContent(m.path);
              if (code.length > MAX_MENTION_CHARS) code = code.slice(0, MAX_MENTION_CHARS) + '\n… (recortado)';
              blocks.push(`Archivo \`${m.rel || m.name}\`:\n\n\`\`\`\n${code}\n\`\`\``);
            } catch { /* ilegible/binario: se omite */ }
          }
          if (blocks.length) modelText = blocks.join('\n\n') + '\n\n' + modelText;
        }
        userMsg.mentions = mentions.map((m) => m.name);
      }

      // RAG: en chat normal, inyecta fragmentos relevantes del índice del codebase
      // (en modo agente no: el agente llama a search_codebase cuando lo necesita).
      if (appState.useCodebaseContext && !agentActive && text.trim()) {
        try {
          const hits = await searchIndex(text.trim(), 5);
          if (hits.length) {
            const block = hits.map((h) => `# ${h.rel}:${h.start}-${h.end}\n${h.text}`).join('\n\n');
            modelText = `Contexto relevante del proyecto (búsqueda semántica):\n\n${block}\n\n---\n\n` + modelText;
          }
        } catch { /* sin índice/modelo de embeddings: se ignora */ }
      }

      // La descripción de la imagen (del sub-agente de visión) va primero
      if (visionText) modelText = visionText + modelText;

      const history = [...messages, userMsg];
      set({ messages: [...history, { role: 'assistant', content: '', sources: null }], streaming: true, conversationId: convId });

      // Historial que ve el modelo (reconstrucción turno a turno en agentProtocol).
      // `let` y no `const`: si el contexto se desborda hay que poder sustituirlo
      // por una versión podada a mitad de turno.
      let modelMessages = [
        ...buildModelHistory(history.slice(0, -1), agentActive),
        { role: 'user', content: modelText },
      ];
      if (agentActive) {
        modelMessages.unshift({ role: 'system', content: (await buildAgentSystemPrompt(workspaceRoot)) + mcpPromptSection() });
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
      // Tool-calling nativo (opt-in): solo se envían los schemas en modo agente.
      const useNative = agentActive && get().nativeTools;
      // Bucles y desbordamientos: el turno no puede acabar en silencio por
      // ninguno de los dos (era exactamente lo que parecía "el agente se cuelga").
      let lastSignature = '';
      let repeated = 0;
      let emptyRetries = 0;
      let prunedWarned = false;
      const signatureOf = (calls) =>
        calls.map((c) => JSON.stringify({ t: c.tool, a: c.args || {} }).slice(0, 400)).join('|');
      const stopWith = (text) => {
        patchLast({ content: text, thinking: null, generating: null });
      };

      try {
        for (let step = 0; step < MAX_AGENT_STEPS; step++) {
          let raw = '';
          let reasoningAcc = ''; // delta.reasoning_content del gateway
          let nativeCalls = [];  // tool_calls nativos de esta respuesta
          const liveThinking = (inline) =>
            [reasoningAcc, inline].filter(Boolean).join('\n').trim();
          // "Pensó 8 s": desde el primer razonamiento hasta el primer texto visible.
          let thinkStart = null;
          let thinkMs = null;
          const clock = (thinking, shown) => {
            if (thinking && thinkStart === null) thinkStart = Date.now();
            if (thinkStart !== null && thinkMs === null && shown) thinkMs = Date.now() - thinkStart;
            return thinkMs;
          };

          // El prompt tiene que caber en la ventana CON el system prompt y las
          // definiciones de herramientas dentro. Si se pasa, Ollama descarta el
          // principio (justo esos dos), el modelo se queda sin instrucciones y
          // responde vacío: es la causa de que el agente se congelara a los
          // pocos minutos de trabajo. Se poda el historial, nunca el system.
          const policy = get().toolPolicy;
          const tools = useNative
            ? [...TOOL_SCHEMAS, ...mcpToolSchemas()].filter((t) => policy[toolCategory(t.function?.name || '')] !== 'never')
            : null;
          const systemMsg = modelMessages[0]?.role === 'system' ? [modelMessages[0]] : [];
          const body = modelMessages.slice(systemMsg.length);
          const budget = promptBudget(appState.contextWindow, tools, estimateTokens(systemMsg));
          const fitted = fitHistory(body, budget);
          if (fitted.pruned && !prunedWarned) {
            prunedWarned = true;
            // La burbuja vacía en curso se sustituye por la nota y se abre otra:
            // así el aviso queda ANTES de lo que el modelo vaya a responder.
            set({
              messages: [...get().messages.slice(0, -1), {
                role: 'note',
                content: 'La conversación llenaba la ventana de contexto: se han recortado '
                  + 'los pasos más antiguos para poder seguir.',
              }],
            });
            pushMsg({ role: 'assistant', content: '', sources: null });
          }

          await streamChatCompletion({
            serverUrl,
            apiKey,
            model: currentModel,
            messages: [...systemMsg, ...fitted.messages],
            conversationId: convId,
            signal,
            tools,
            numCtx: appState.contextWindow,
            onDelta: (delta) => {
              raw += delta;
              const { thinking, visible } = splitThinking(raw);
              const shown = agentActive ? displayableText(visible) : visible;
              // Si está generando un tool-call largo (write_file grande), el
              // contenido va oculto: mostrar progreso para que no parezca colgado.
              const generating = agentActive && !shown.trim() && hasUnclosedCall(visible)
                ? visible.length
                : null;
              const live = liveThinking(thinking);
              patchLast({ content: shown, thinking: live, generating, thinkMs: clock(live, shown.trim() || generating) });
            },
            onReasoning: (delta) => {
              reasoningAcc += delta;
              clock(true, false);
              patchLast({ thinking: liveThinking(splitThinking(raw).thinking) });
            },
            onToolCalls: (tc) => { nativeCalls = tc.map(nativeCallToInternal); },
            onSources: (sources) => patchLast({ sources }),
          });

          const { thinking, visible } = splitThinking(raw);
          const fullThinking = liveThinking(thinking);
          if (fullThinking) patchLast({ thinkMs: clock(true, true) });

          if (!agentActive) {
            patchLast({ content: visible.trim(), thinking: fullThinking });
            break;
          }

          const spoken = truncateFabricated(visible);
          // Preferir los tool_calls NATIVOS; si no hay, caer al JSON en texto.
          let calls = nativeCalls.length ? nativeCalls : extractToolCalls(spoken);
          // Último recurso: el RAZONAMIENTO. Los modelos thinking (qwen3.5…)
          // deciden la herramienta dentro del bloque de pensamiento y la escriben
          // ahí, así que Ollama la manda por el canal `thinking` y nunca llega
          // como content ni como tool_call. Ignorarlo era ver al agente pensar
          // 12 s y no hacer nada, con el contexto casi vacío.
          let rescued = false;
          if (!calls.length && !spoken.trim() && fullThinking) {
            const fromThinking = extractToolCalls(fullThinking);
            if (fromThinking.length) {
              calls = fromThinking;
              rescued = true;
            }
          }
          const prose = cleanProse(spoken);

          if (!calls.length && nudged && (/^ok\.?$/i.test(prose.trim()) || !prose.trim())) {
            // Tras el recordatorio confirmó que no había nada que aplicar
            set({ messages: get().messages.slice(0, -1) });
            break;
          }

          // Ni texto ni llamadas (tampoco rescatadas del razonamiento). Rendirse
          // aquí en silencio es lo que dejaba al agente "colgado".
          if (!calls.length && !spoken.trim()) {
            if (emptyRetries < 2) {
              emptyRetries += 1;
              if (fullThinking) {
                // Razonó pero no llegó a responder: no es contexto, se quedó
                // pensando. Se le pide el paso concreto.
                modelMessages.push({
                  role: 'user',
                  content: 'Has razonado pero no has emitido ninguna respuesta ni ninguna '
                    + 'llamada a herramienta. NO vuelvas a razonar: ejecuta AHORA el siguiente '
                    + 'paso llamando a la herramienta que toque, o responde con el resumen '
                    + 'final si ya no queda nada por hacer.',
                });
              } else {
                // Nada en absoluto: ahí sí huele a ventana desbordada.
                const relief = fitHistory(modelMessages.slice(systemMsg.length),
                                          Math.floor(budget / 2));
                modelMessages = [...systemMsg, ...relief.messages];
              }
              continue;
            }
            stopWith('Me quedé sin respuesta del modelo: razona pero no llega a responder. '
              + 'Prueba con un modelo sin «thinking», o empieza un chat nuevo.');
            break;
          }
          emptyRetries = 0;

          if (calls.length) {
            const signature = signatureOf(calls);
            repeated = signature === lastSignature ? repeated + 1 : 0;
            lastSignature = signature;
            if (repeated >= MAX_REPEATED_CALLS) {
              stopWith('Me estaba repitiendo con la misma acción sin avanzar, así que he parado. '
                + 'Dime cómo seguir.');
              break;
            }
          }

          patchLast({ content: prose, thinking: fullThinking, generating: null });
          if (!calls.length) {
            // JSON de tool-call cerrado pero ilegible (comillas sin escapar
            // dentro de un valor largo, típico al generar CSS/HTML): pedir que
            // lo repita en vez de dar el turno por terminado en silencio.
            if (!nudged && hasInvalidCall(spoken)) {
              nudged = true;
              modelMessages.push({ role: 'assistant', content: cleanProse(spoken) || '(llamada a herramienta inválida)' });
              modelMessages.push({
                role: 'user',
                content: 'La llamada a herramienta anterior traía JSON inválido (probablemente una comilla '
                  + 'doble o un salto de línea sin escapar dentro de un valor largo, como el "content" de '
                  + 'write_file). Repite ÚNICAMENTE esa llamada con el JSON bien formado: escapa con \\ '
                  + 'cualquier comilla doble o salto de línea que vaya DENTRO de un string.',
              });
              pushMsg({ role: 'assistant', content: '', sources: null });
              continue;
            }
            // Salida truncada a mitad de un tool-call (archivo demasiado grande):
            // empujar a edit_file, que emite fragmentos pequeños.
            if (!nudged && hasUnclosedCall(spoken)) {
              nudged = true;
              modelMessages.push({ role: 'assistant', content: cleanProse(spoken) || '(salida truncada)' });
              modelMessages.push({
                role: 'user',
                content: 'Tu respuesta anterior se CORTÓ a mitad porque el contenido era demasiado largo. '
                  + 'NO reescribas el archivo entero con write_file. Usa edit_file para cambiar solo las '
                  + 'secciones necesarias (old_text/new_text), en varios pasos pequeños si hace falta.',
              });
              pushMsg({ role: 'assistant', content: '', sources: null });
              continue;
            }
            if (!nudged && /```/.test(spoken)) {
              // Mostró código en vez de aplicarlo: una oportunidad de corregirse
              nudged = true;
              modelMessages.push({ role: 'assistant', content: spoken });
              modelMessages.push({
                role: 'user',
                content: 'NO repitas el código. Responde ÚNICAMENTE con el/los JSON de herramienta '
                  + 'necesarios para aplicar ese cambio al archivo (edit_file o write_file), sin prosa ni ```. '
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

          // Con la llamada rescatada del razonamiento, `spoken` está vacío: el
          // historial guarda la llamada para que el modelo lea bien el resultado.
          modelMessages.push({
            role: 'assistant',
            content: rescued
              ? calls.map((c) => JSON.stringify({ tool: c.tool, args: c.args || {} })).join('\n')
              : spoken,
          });
          const results = [];
          for (const call of calls) {
            if (signal.aborted) break;
            // Fila "en curso" (spinner) que se resuelve in-place al terminar:
            // es la animación de "el agente está ejecutando una acción".
            const pendingIndex = get().messages.length;
            pushMsg({ role: 'tool', tool: call.tool, args: call.args, pending: true });
            const startedAt = Date.now();
            const result = await get()._runTool(workspaceRoot, call);
            set({
              messages: get().messages.map((m, i) => (i === pendingIndex ? {
                ...m, pending: false, ok: result.ok, ms: Date.now() - startedAt,
                content: result.display, change: result.change, snapshot: result.snapshot,
                full: (result.output || '').slice(0, 4000), // para replay del historial
              } : m)),
            });
            // Al modelo le va una versión acotada; el usuario ve la salida
            // completa en su fila. Un read_file de 100 000 caracteres desbordaba
            // la ventana de contexto él solo.
            results.push(`TOOL_RESULT ${call.tool}: ${clipToolOutput(result.output)}`);
          }
          if (signal.aborted) break;
          modelMessages.push({ role: 'user', content: results.join('\n') });
          pushMsg({ role: 'assistant', content: '', sources: null });

          if (step === MAX_AGENT_STEPS - 1) {
            // El tope se alcanzaba borrando la burbuja vacía: el agente se paraba
            // a media tarea sin una sola pista de por qué.
            stopWith(`He llegado al tope de ${MAX_AGENT_STEPS} pasos en un mismo turno y paro `
              + 'aquí para no seguir a ciegas. Dime «continúa» si quieres que siga desde donde iba.');
          }
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
        if (isFirstExchange) get()._autoTitle(convId);
      }
    },

    /** Auto-título tras el primer intercambio (igual que la web y la app).
        Sin esto toda conversación del IDE se quedaba como "Sin título". */
    _autoTitle: async (convId) => {
      try {
        const res = await api.post(`/api/conversations/${convId}/generate-title`);
        if (typeof res?.title === 'string' && get().conversationId === convId) {
          set({ conversationTitle: res.title });
        }
      } catch {
        // sin título automático: no es crítico
      }
    },

    /** ¿La herramienta requiere aprobación explícita antes de ejecutarse?
        Los comandos (run_command) son irreversibles → SIEMPRE piden confirmación
        salvo que estén en la allowlist o que el usuario active auto-run; el
        auto-aplicado de archivos (autoApprove) NO los cubre. */
    _needsApproval: (tool, args) => {
      const cat = toolCategory(tool);
      const policy = get().toolPolicy[cat] || 'ask';
      if (policy === 'never') return 'never';
      if (cat === 'command') {
        const cmd = args?.command || '';
        // Ni con auto-run: los comandos que ejecutan código externo (npx, curl,
        // flags -e/-c), instalan paquetes o encadenan piden aprobación SIEMPRE.
        if (policy === 'allow') return isNeverAutoCommand(cmd);
        return !isAllowedCommand(cmd, get().commandAllowlist);
      }
      return policy !== 'allow';
    },

    /** Ejecuta una herramienta del agente con aprobación previa (interno). */
    _runTool: async (root, call) => {
      const tool = call.tool;
      const args = call.args || {};
      const isCommand = tool === 'run_command';
      let change = null;
      let snapshot = null;
      const need = get()._needsApproval(tool, args);
      if (need === 'never') {
        return {
          ok: false, display: 'bloqueado por tus permisos', change: null,
          output: 'El usuario no permite esta herramienta (Ajustes → Agente y permisos). No la vuelvas a intentar; sigue sin ella o explica qué haría falta.',
        };
      }
      if (!READ_ONLY_TOOLS.has(tool)) {
        try {
          change = await computeChangePreview(root, tool, args);
        } catch {
          change = null; // ruta inválida: el error real saldrá al ejecutar
        }
      }
      if (need) {
        const decision = await new Promise((resolve) => {
          set({ pendingApproval: { tool, args, change, resolve } });
        });
        // "Permitir siempre" solo abre la categoría de esta herramienta.
        if (decision === 'always') get().setToolPolicy(toolCategory(tool), 'allow');
        else if (decision !== 'yes') {
          return { ok: false, display: 'rechazado por el usuario', output: 'Ejecución cancelada por el usuario', change };
        }
      }
      if (!isCommand && !READ_ONLY_TOOLS.has(tool)) snapshot = await captureSnapshot(root, tool, args);
      try {
        const output = tool.startsWith('mcp__')
          ? await useMcpStore.getState().call(tool, args)
          : await executeToolCall(root, tool, args);
        if (isCommand) useOutputStore.getState().append('Agente', `$ ${args.command}\n${output}`);
        else if (tool.startsWith('mcp__')) useOutputStore.getState().append('MCP', `${tool}\n${output.slice(0, 2000)}`);
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

    /** Vuelve a ejecutar un paso que falló (con su aprobación si la necesita).
        El resultado nuevo sustituye al de la fila, que es lo que el modelo lee
        del historial en el siguiente mensaje. */
    retryTool: async (index) => {
      const msg = get().messages[index];
      if (!msg || msg.role !== 'tool' || msg.ok !== false || get().streaming) return;
      const root = useAppStore.getState().workspaceRoot;
      const patch = (p) => set({ messages: get().messages.map((m, i) => (i === index ? { ...m, ...p } : m)) });
      patch({ pending: true, ok: undefined });
      const startedAt = Date.now();
      const result = await get()._runTool(root, { tool: msg.tool, args: msg.args });
      patch({
        pending: false, ok: result.ok, ms: Date.now() - startedAt, retried: true,
        content: result.display, change: result.change, snapshot: result.snapshot,
        full: (result.output || '').slice(0, 4000),
      });
    },

    /** Da por revisados los cambios del agente en `rel` (o en todos si es null):
        dejan de marcarse en el editor y ya no se pueden revertir desde el panel. */
    acceptChanges: (rel = null) => {
      set({
        messages: get().messages.map((m) => (
          m.role === 'tool' && m.change?.path && !m.reverted && !m.accepted && (rel === null || m.change.path === rel)
            ? { ...m, accepted: true } : m
        )),
      });
    },
  }));
}

useSessionsStore.getState().add(makeChatStore());

export function useChatStore(selector = (s) => s) {
  const store = useSessionsStore((s) => s.sessions[s.activeKey]);
  return useStore(store, selector);
}
useChatStore.getState = () => activeStore().getState();
useChatStore.setState = (patch) => activeStore().setState(patch);
/** Sigue a la sesión activa aunque cambie: quien se suscribe (control remoto)
    recibe siempre los cambios de la que el usuario está viendo. */
useChatStore.subscribe = (fn) => {
  let unsub = activeStore().subscribe(fn);
  const unsubReg = useSessionsStore.subscribe((s, prev) => {
    if (s.activeKey === prev.activeKey) return;
    unsub();
    const st = activeStore();
    unsub = st.subscribe(fn);
    fn(st.getState(), {});
  });
  return () => { unsub(); unsubReg(); };
};

/** Sesiones abiertas con su estado resumido, para la lista de agentes. */
export function useOpenSessions() {
  const { sessions, order, activeKey, seen } = useSessionsStore();
  const [, force] = useState(0);
  useEffect(() => {
    const unsubs = order.map((k) => sessions[k].subscribe((a, b) => {
      if (a.streaming !== b.streaming || a.pendingApproval !== b.pendingApproval || a.conversationTitle !== b.conversationTitle || a.conversationId !== b.conversationId) force((n) => n + 1);
    }));
    return () => unsubs.forEach((u) => u());
  }, [sessions, order]);
  return order.map((key) => {
    const s = sessions[key].getState();
    return {
      key, active: key === activeKey, streaming: s.streaming, waiting: !!s.pendingApproval,
      title: s.conversationTitle || (s.messages.find((m) => m.role === 'user')?.content || '').slice(0, 60), conversationId: s.conversationId, hasMessages: s.messages.length > 0, seen: !!seen[key],
    };
  });
}
