// claudeSession.js — una sesión de Claude Code con la misma forma que una del
// agente de Lixbon (messages, streaming, pendingApproval…): así el chat, los
// paneles de Cambios/Contexto/Terminal, el historial y el control remoto la
// tratan como a cualquier otra.
import { create } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useAppStore } from './appStore';
import { useFileViewStore } from './fileViewStore';
import { useOutputStore } from './outputStore';
import { toolCategory, initialMode, initialPolicy, CHAT_MODES, useSessionsStore, agentSettings } from './chatStore';
import { computeChangePreview, isAllowedCommand, isNeverAutoCommand, revertSnapshot, DEFAULT_CMD_ALLOWLIST } from '../lib/agent';
import {
  startClaude, userMessage, permissionModeOf, mapTool, changeOf, resultText,
  claudeTranscript, transcriptToMessages, claudeVersion, HIDDEN_TOOLS,
} from '../lib/claudeCode';

const MODEL_KEY = 'lixbon_claude_model';
const USAGE_KEY = 'lixbon_claude_usage';

/** Cupo del plan de Claude (ventana de 5 h y semanal), tal como lo cuenta el
    propio Claude Code en cada turno. Compartido por todas las sesiones. */
export const useClaudeUsage = create((set) => ({
  ...(() => { try { return JSON.parse(localStorage.getItem(USAGE_KEY) || '{}'); } catch { return {}; } })(),
  update: (info) => {
    const w = info?.unifiedWindows || {};
    const next = {
      status: info?.status || '',
      session: w.five_hour ? { percent: Math.round((w.five_hour.utilization || 0) * 100), resetAt: w.five_hour.resetsAt } : null,
      week: w.seven_day ? { percent: Math.round((w.seven_day.utilization || 0) * 100), resetAt: w.seven_day.resetsAt } : null,
      at: Date.now(),
    };
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(next)); } catch { /* sin almacenamiento */ }
    set(next);
  },
}));

let nextProc = 1;

function normalizeQuestions(input = {}) {
  return (Array.isArray(input.questions) ? input.questions : []).map((q) => ({
    question: String(q.question || ''),
    header: String(q.header || '').slice(0, 24),
    multiSelect: !!q.multiSelect,
    options: (q.options || []).map((o) => ({ label: String(o.label || o), description: o.description || '' })),
  })).filter((q) => q.question);
}

const refreshEditor = () => {
  window.dispatchEvent(new CustomEvent('lixbon:fs-changed'));
  useFileViewStore.getState().syncFromDisk(true).catch?.(() => {});
};

export function makeClaudeStore() {
  const procId = `cc${nextProc++}`;
  let proc = null;
  let starting = null;
  let appliedMode = null;
  let appliedModel = null;
  let streamedMsgs = new Set();
  let rows = new Map();
  let stderr = '';
  let gotInit = false;

  return createStore((set, get) => {
    const msgs = () => get().messages;
    const push = (m) => set({ messages: [...msgs(), m] });
    const patchAt = (i, p) => set({ messages: msgs().map((m, k) => (k === i ? { ...m, ...p } : m)) });
    const bubbleIndex = () => {
      const list = msgs();
      if (list[list.length - 1]?.role === 'assistant') return list.length - 1;
      push({ role: 'assistant', content: '', engine: 'claude' });
      return msgs().length - 1;
    };
    const appendText = (field, text) => {
      const i = bubbleIndex();
      patchAt(i, { [field]: (msgs()[i][field] || '') + text });
    };
    const dropEmptyTail = () => {
      const list = msgs();
      const last = list[list.length - 1];
      if (last?.role === 'assistant' && !(last.content || '').trim() && !last.thinking && !last.plan) set({ messages: list.slice(0, -1) });
    };
    const finishTurn = () => {
      dropEmptyTail();
      set({ streaming: false, pendingApproval: null, pendingQuestion: null });
    };

    async function decide(req) {
      const root = useAppStore.getState().workspaceRoot;
      const name = req.tool_name;
      const input = req.input || {};

      if (name === 'AskUserQuestion') {
        const questions = normalizeQuestions(input);
        const answers = await new Promise((resolve) => set({ pendingQuestion: { questions, resolve } }));
        if (!answers) return { behavior: 'deny', message: 'El usuario no respondió.' };
        const map = {};
        questions.forEach((q, i) => { map[q.question] = (answers[i] || []).join(', '); });
        return { behavior: 'allow', updatedInput: { ...input, answers: map } };
      }
      if (name === 'ExitPlanMode') {
        push({ role: 'assistant', content: String(input.plan || ''), engine: 'claude', plan: true });
        return { behavior: 'deny', message: 'El usuario va a revisar el plan en el IDE. Termina el turno y espera su respuesta.' };
      }

      const { tool, args } = mapTool(name, input, root);
      const cat = toolCategory(tool);
      const policy = get().toolPolicy[cat] || 'ask';
      if (policy === 'never') return { behavior: 'deny', message: 'El usuario no permite esta herramienta en Ajustes → Agente y permisos.' };
      const cmd = args.command || '';
      const needs = cat === 'command'
        ? (policy === 'allow' ? isNeverAutoCommand(cmd) : !isAllowedCommand(cmd, get().commandAllowlist))
        : policy !== 'allow';
      if (!needs) return { behavior: 'allow', updatedInput: input };

      let change = null;
      if (tool === 'write_file' || tool === 'edit_file') {
        try { change = await computeChangePreview(root, tool, args); } catch { /* sin vista previa */ }
      } else if (cat === 'command') {
        change = { kind: 'command', path: cmd };
      }
      const decision = await new Promise((resolve) => set({ pendingApproval: { tool, args, change, resolve } }));
      if (decision === 'always') get().setToolPolicy(cat, 'allow');
      else if (decision !== 'yes') return { behavior: 'deny', message: 'El usuario lo rechazó desde el IDE.' };
      return { behavior: 'allow', updatedInput: input };
    }

    function onEvent(ev) {
      if (ev.parent_tool_use_id) return;
      const root = useAppStore.getState().workspaceRoot;
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init') {
            gotInit = true;
            set({
              conversationId: ev.session_id,
              ccInfo: { model: ev.model, version: ev.claude_code_version, mcp: ev.mcp_servers || [], tools: (ev.tools || []).length, cwd: ev.cwd },
            });
          }
          break;
        case 'stream_event': {
          const e = ev.event || {};
          if (e.type === 'message_start') set({ ccMsgId: e.message?.id });
          if (e.type === 'content_block_delta') {
            const id = get().ccMsgId;
            if (e.delta?.type === 'text_delta') { streamedMsgs.add(`${id}:text`); appendText('content', e.delta.text); }
            if (e.delta?.type === 'thinking_delta') { streamedMsgs.add(`${id}:thinking`); appendText('thinking', e.delta.thinking); }
          }
          break;
        }
        case 'assistant': {
          const m = ev.message || {};
          const u = m.usage;
          if (u) set({ ccContext: { ...get().ccContext, used: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) } });
          for (const b of m.content || []) {
            if (b.type === 'text' && !streamedMsgs.has(`${m.id}:text`)) appendText('content', b.text || '');
            else if (b.type === 'thinking' && !streamedMsgs.has(`${m.id}:thinking`)) appendText('thinking', b.thinking || '');
            else if (b.type === 'tool_use' && !HIDDEN_TOOLS.has(b.name)) {
              dropEmptyTail();
              const mapped = mapTool(b.name, b.input, root);
              push({ role: 'tool', ...mapped, ccName: b.name, ccInput: b.input, pending: true, startedAt: Date.now() });
              rows.set(b.id, msgs().length - 1);
            }
          }
          break;
        }
        case 'user': {
          for (const b of ev.message?.content || []) {
            if (b.type !== 'tool_result' || !rows.has(b.tool_use_id)) continue;
            const i = rows.get(b.tool_use_id);
            const row = msgs()[i];
            const txt = resultText(b);
            const { change, snapshot } = changeOf(row.ccName, row.ccInput, ev.tool_use_result, root);
            patchAt(i, {
              pending: false, ok: !b.is_error, ms: Date.now() - (row.startedAt || Date.now()),
              content: txt.split('\n')[0].slice(0, 160), full: txt.slice(0, 4000), change, snapshot,
            });
            if (row.tool === 'run_command') useOutputStore.getState().append('Claude Code', `$ ${row.args?.command}\n${txt}`);
            if (change) refreshEditor();
          }
          bubbleIndex();
          break;
        }
        case 'rate_limit_event':
          useClaudeUsage.getState().update(ev.rate_limit_info);
          break;
        case 'result': {
          const mu = Object.values(ev.modelUsage || {})[0];
          set({
            ccContext: { ...get().ccContext, window: mu?.contextWindow || get().ccContext.window },
            ccCost: (get().ccCost || 0) + (ev.total_cost_usd || 0),
          });
          if (ev.is_error || (ev.subtype && ev.subtype !== 'success')) {
            if (!get().interrupted) {
              const text = String(ev.result || ev.subtype || 'Claude Code terminó con un error.');
              const hint = /login|api key|auth/i.test(text) ? ' Abre una terminal, ejecuta `claude` e inicia sesión.' : '';
              dropEmptyTail();
              push({ role: 'error', content: `Claude Code: ${text}${hint}` });
            }
          }
          finishTurn();
          set({ interrupted: false });
          break;
        }
        case 'control_request':
          if (ev.request?.subtype === 'can_use_tool') {
            decide(ev.request).then((res) => proc?.respond(ev.request_id, res)).catch(() => {});
          }
          break;
        default:
          break;
      }
    }

    function onExit() {
      const was = proc;
      proc = null;
      starting = null;
      if (!was) return;
      if (get().streaming) {
        dropEmptyTail();
        const why = gotInit ? 'Claude Code se cerró a mitad del turno.' : `No se pudo arrancar Claude Code.${stderr ? `\n\n${stderr.trim().slice(0, 600)}` : ''}`;
        push({ role: 'error', content: why });
        finishTurn();
      }
      was.close();
    }

    async function ensureProc() {
      if (proc) return proc;
      if (starting) return starting;
      const root = useAppStore.getState().workspaceRoot;
      if (!root) throw new Error('Abre una carpeta de trabajo para usar Claude Code.');
      starting = (async () => {
        try { await claudeVersion(); } catch (e) { throw new Error(`${e?.message || e} Instálalo desde claude.com/code y ejecuta \`claude\` una vez en una terminal para iniciar sesión.`); }
        stderr = '';
        gotInit = false;
        appliedMode = permissionModeOf(get().chatMode);
        appliedModel = get().ccModel;
        const p = await startClaude({
          procId, cwd: root, resume: get().conversationId, model: appliedModel, permissionMode: appliedMode,
          onEvent, onStderr: (t) => { stderr += t; }, onExit,
        });
        proc = p;
        return p;
      })();
      try { return await starting; } finally { starting = null; }
    }

    const shared = {
      toolPolicy: initialPolicy(),
      chatMode: initialMode(),
      autoApprove: (localStorage.getItem('lixbon_agent_auto') ?? 'true') === 'true',
      autoRunCommands: (localStorage.getItem('lixbon_agent_autorun') ?? 'false') === 'true',
      commandAllowlist: (() => {
        try { const s = JSON.parse(localStorage.getItem('lixbon_agent_cmd_allowlist') || 'null'); return Array.isArray(s) ? s : DEFAULT_CMD_ALLOWLIST; } catch { return DEFAULT_CMD_ALLOWLIST; }
      })(),
    };

    return {
      engine: 'claude',
      messages: [],
      conversationId: null,
      conversationTitle: '',
      streaming: false,
      interrupted: false,
      pendingApproval: null,
      pendingQuestion: null,
      ccModel: localStorage.getItem(MODEL_KEY) || '',
      ccInfo: null,
      ccContext: { used: 0, window: 200000 },
      ccCost: 0,
      ccMsgId: null,
      nativeTools: false,
      ...shared,

      setToolPolicy: (cat, value) => agentSettings.setToolPolicy(get().toolPolicy, cat, value),
      setChatMode: (mode) => agentSettings.setChatMode(mode),
      cycleChatMode: () => {
        const i = CHAT_MODES.findIndex((m) => m.id === get().chatMode);
        get().setChatMode(CHAT_MODES[(i + 1) % CHAT_MODES.length].id);
      },
      setAutoApprove: (v) => get().setToolPolicy('edit', v ? 'allow' : 'ask'),
      setAutoRunCommands: (v) => get().setToolPolicy('command', v ? 'allow' : 'ask'),
      setCommandAllowlist: (list) => agentSettings.setCommandAllowlist(list),
      setNativeTools: () => {},

      setCcModel: (ccModel) => {
        localStorage.setItem(MODEL_KEY, ccModel);
        set({ ccModel });
      },

      resolveApproval: (decision) => {
        const p = get().pendingApproval;
        if (!p) return;
        set({ pendingApproval: null });
        p.resolve(decision);
      },
      answerQuestion: (answers) => {
        const p = get().pendingQuestion;
        if (!p) return;
        set({ pendingQuestion: null });
        p.resolve(answers);
      },

      newConversation: async () => {
        if (get().streaming || get().pendingApproval || get().pendingQuestion) {
          const { spawnSessionOf } = await import('./chatStore');
          spawnSessionOf('claude');
          return;
        }
        const p = proc;
        proc = null;
        await p?.close();
        streamedMsgs = new Set();
        rows = new Map();
        set({ messages: [], conversationId: null, conversationTitle: '', ccInfo: null, ccContext: { used: 0, window: 200000 }, ccCost: 0 });
      },

      loadConversation: async (id) => {
        const reg = useSessionsStore.getState();
        const open = Object.entries(reg.sessions).find(([, st]) => st.getState().conversationId === id);
        if (open) { reg.activate(open[0]); return; }
        if (get().streaming || get().pendingApproval) {
          const { spawnSessionOf } = await import('./chatStore');
          await spawnSessionOf('claude').getState().loadConversation(id);
          return;
        }
        const root = useAppStore.getState().workspaceRoot;
        const p = proc;
        proc = null;
        await p?.close();
        streamedMsgs = new Set();
        rows = new Map();
        const text = await claudeTranscript(root, id);
        const { messages, title } = transcriptToMessages(text, root);
        set({ messages, conversationId: id, conversationTitle: title });
      },

      stop: () => {
        const a = get().pendingApproval;
        if (a) { set({ pendingApproval: null }); a.resolve('no'); }
        const q = get().pendingQuestion;
        if (q) { set({ pendingQuestion: null }); q.resolve(null); }
        if (proc && get().streaming) {
          set({ interrupted: true });
          proc.control({ subtype: 'interrupt' }).catch(() => {});
        }
        finishTurn();
      },

      send: async (text, context = null, images = [], mentions = []) => {
        const hasImages = images?.length > 0;
        if (get().streaming || (!text.trim() && !hasImages)) return;
        const shown = { role: 'user', content: text.trim(), images: hasImages ? images.map((im) => im.dataUrl) : null, context: context ? { name: context.name, selection: context.isSelection } : null };
        if (mentions?.length) shown.mentions = mentions.map((m) => m.name);
        let prompt = text.trim() || '(mira la imagen adjunta)';
        if (context?.path) prompt = `(Tengo abierto \`${context.path}\` en el editor${context.isSelection ? ', con una selección' : ''}.)\n\n${prompt}`;
        if (mentions?.length) prompt = `(Archivos mencionados: ${mentions.map((m) => `\`${m.rel || m.path}\``).join(', ')})\n\n${prompt}`;

        set({
          messages: [...msgs(), shown, { role: 'assistant', content: '', engine: 'claude' }],
          streaming: true,
          conversationTitle: get().conversationTitle || shown.content.slice(0, 60),
        });
        try {
          const p = await ensureProc();
          const mode = permissionModeOf(get().chatMode);
          if (mode !== appliedMode) { await p.control({ subtype: 'set_permission_mode', mode }); appliedMode = mode; }
          if (get().ccModel !== appliedModel) { await p.control({ subtype: 'set_model', model: get().ccModel || 'default' }); appliedModel = get().ccModel; }
          await p.send(userMessage(prompt, hasImages ? images : []));
        } catch (err) {
          dropEmptyTail();
          push({ role: 'error', content: String(err?.message || err) });
          finishTurn();
        }
      },

      runPlan: () => {
        get().setChatMode('agent');
        set({ messages: msgs().map((m) => (m.plan ? { ...m, plan: false, planRun: true } : m)) });
        get().send('Adelante: ejecuta el plan que propusiste, paso a paso.');
      },

      revertTool: async (index) => {
        const msg = msgs()[index];
        if (!msg || msg.role !== 'tool' || !msg.snapshot || msg.reverted) return;
        try {
          await revertSnapshot(useAppStore.getState().workspaceRoot, msg.snapshot);
          patchAt(index, { reverted: true });
        } catch (err) {
          push({ role: 'error', content: `No se pudo revertir: ${err?.message || err}` });
        }
      },
      retryTool: () => {
        push({ role: 'note', content: 'Para repetir un paso de Claude Code, pídeselo en el chat.' });
      },
      acceptChanges: (rel = null) => {
        set({
          messages: msgs().map((m) => (
            m.role === 'tool' && m.change?.path && !m.reverted && !m.accepted && (rel === null || m.change.path === rel) ? { ...m, accepted: true } : m
          )),
        });
      },
    };
  });
}
