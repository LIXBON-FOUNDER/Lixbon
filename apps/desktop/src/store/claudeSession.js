// claudeSession.js — una sesión de Claude Code con la misma forma que una del
// agente de Lixbon (messages, streaming, pendingApproval…): así el chat, los
// paneles de Cambios/Contexto/Terminal, el historial y el control remoto la
// tratan como a cualquier otra.
import { create } from 'zustand';
import { createStore } from 'zustand/vanilla';
import { useAppStore } from './appStore';
import { useFileViewStore } from './fileViewStore';
import { useOutputStore } from './outputStore';
import { initialMode, initialPolicy, useSessionsStore, agentSettings } from './chatStore';
import { computeChangePreview, revertSnapshot, DEFAULT_CMD_ALLOWLIST } from '../lib/agent';
import {
  startClaude, userMessage, mapTool, changeOf, resultText, compactSummaryOf,
  claudeTranscript, transcriptToMessages, claudeVersion, HIDDEN_TOOLS, CLAUDE_MODES,
} from '../lib/claudeCode';

const MODEL_KEY = 'lixbon_claude_model';
const USAGE_KEY = 'lixbon_claude_usage';
const MODE_KEY = 'lixbon_claude_mode';
const EFFORT_KEY = 'lixbon_claude_effort';
const CATALOG_KEY = 'lixbon_claude_catalog';

// Modelos y comandos salen del `initialize` de Claude Code; se guardan para
// que el selector y el menú "/" estén completos antes de que arranque.
const cachedCatalog = () => {
  try { const v = JSON.parse(localStorage.getItem(CATALOG_KEY) || 'null'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};
const initialCcMode = () => {
  const v = localStorage.getItem(MODE_KEY);
  return CLAUDE_MODES.some((m) => m.id === v) ? v : 'default';
};

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
const FLUSH_MS = 50;

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
  let appliedEffort = null;
  // Turnos que el IDE manda por su cuenta (`/effort`): su salida no se muestra.
  let hiddenTurns = 0;
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
    // Los fragmentos llegan cada ~25 ms: se juntan y se pintan cada FLUSH_MS
    // para no re-renderizar el chat entero por cada uno.
    let buffered = { content: '', thinking: '' };
    let flushTimer = null;
    const flush = () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (!buffered.content && !buffered.thinking) return;
      const add = buffered;
      buffered = { content: '', thinking: '' };
      const i = bubbleIndex();
      const cur = msgs()[i];
      patchAt(i, {
        ...(add.content ? { content: (cur.content || '') + add.content } : {}),
        ...(add.thinking ? { thinking: (cur.thinking || '') + add.thinking } : {}),
      });
    };
    const appendText = (field, text) => {
      buffered[field] += text;
      if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    };
    const dropEmptyTail = () => {
      const list = msgs();
      const last = list[list.length - 1];
      if (last?.role === 'assistant' && !(last.content || '').trim() && !last.thinking && !last.plan) set({ messages: list.slice(0, -1) });
    };
    const finishTurn = () => {
      flush();
      dropEmptyTail();
      set({ streaming: false, pendingApproval: null, pendingQuestion: null, ccCompacting: null });
    };
    // Mientras compacta, Claude Code no habla con el usuario: lo que llegue es
    // la propia compactación y no debe pintarse como respuesta.
    const startCompact = () => {
      if (get().ccCompacting) return;
      flush();
      dropEmptyTail();
      set({ ccCompacting: Date.now() });
    };
    const endCompact = (meta = {}) => {
      const started = get().ccCompacting;
      set({ ccCompacting: null });
      dropEmptyTail();
      push({ role: 'compact', ms: started ? Date.now() - started : null, ...meta });
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

      // Claude Code solo pregunta lo que su modo y sus reglas no cubren: aquí
      // no se aplica la política del agente de Lixbon, se le pregunta al usuario.
      const { tool, args } = mapTool(name, input, root);
      let change = null;
      if (tool === 'write_file' || tool === 'edit_file') {
        try { change = await computeChangePreview(root, tool, args); } catch { /* sin vista previa */ }
      } else if (tool === 'run_command') {
        change = { kind: 'command', path: args.command || '' };
      }
      const decision = await new Promise((resolve) => set({ pendingApproval: { tool, args, change, resolve } }));
      if (decision === 'always') {
        const rules = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
        return { behavior: 'allow', updatedInput: input, ...(rules.length ? { updatedPermissions: rules } : {}) };
      }
      if (decision !== 'yes') return { behavior: 'deny', message: 'El usuario lo rechazó desde el IDE.' };
      return { behavior: 'allow', updatedInput: input };
    }

    function onEvent(ev) {
      if (ev.parent_tool_use_id) return;
      if (hiddenTurns > 0 && ev.type !== 'system' && ev.type !== 'control_request' && ev.type !== 'rate_limit_event') {
        if (ev.type === 'result') hiddenTurns -= 1;
        return;
      }
      if (ev.type !== 'stream_event') flush();
      const root = useAppStore.getState().workspaceRoot;
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'status') {
            if (ev.status === 'compacting') startCompact();
            break;
          }
          if (ev.subtype === 'compact_boundary') {
            const m = ev.compact_metadata || {};
            endCompact({ trigger: m.trigger, preTokens: m.pre_tokens });
            set({ ccContext: { ...get().ccContext, used: 0 } });
            break;
          }
          if (ev.subtype === 'init') {
            gotInit = true;
            set({
              conversationId: ev.session_id,
              ccInfo: { model: ev.model, version: ev.claude_code_version, mcp: ev.mcp_servers || [], tools: (ev.tools || []).length, cwd: ev.cwd },
            });
          }
          break;
        case 'stream_event': {
          if (get().ccCompacting) break;
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
          if (get().ccCompacting) break;
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
          const summary = compactSummaryOf(ev);
          if (summary != null) {
            const i = msgs().findLastIndex((m) => m.role === 'compact');
            if (i >= 0) patchAt(i, { summary });
            else push({ role: 'compact', summary });
            break;
          }
          for (const b of ev.message?.content || []) {
            if (b.type !== 'tool_result' || !rows.has(b.tool_use_id)) continue;
            const i = rows.get(b.tool_use_id);
            const row = msgs()[i];
            const txt = resultText(b);
            const { change, snapshot } = changeOf(row.ccName, row.ccInput, ev.tool_use_result, root);
            patchAt(i, {
              pending: false, ok: !b.is_error, ms: Date.now() - (row.startedAt || Date.now()),
              content: txt.split('\n')[0].slice(0, 160), full: txt.slice(0, 4000), change, snapshot,
              // Claude Code ya lo escribió en disco (por su modo o por el permiso
              // dado): no queda nada que revisar, solo se puede revertir.
              ...(change ? { accepted: true } : {}),
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
          if (get().ccCompacting) endCompact();
          // Los comandos "/" locales de Claude Code solo dejan su salida aquí.
          if (!ev.is_error && ev.result) {
            const last = msgs()[msgs().length - 1];
            if (last?.role === 'assistant' && !(last.content || '').trim()) patchAt(msgs().length - 1, { content: String(ev.result) });
          }
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
        appliedMode = get().ccMode;
        appliedModel = get().ccModel;
        appliedEffort = get().ccEffort;
        hiddenTurns = 0;
        const p = await startClaude({
          procId, cwd: root, resume: get().conversationId, model: appliedModel, effort: appliedEffort, permissionMode: appliedMode,
          onEvent, onStderr: (t) => { stderr += t; }, onExit,
        });
        proc = p;
        const info = await p.control({ subtype: 'initialize' }).catch(() => null);
        if (info) {
          const catalog = {
            models: Array.isArray(info.models) ? info.models : get().ccModels,
            commands: Array.isArray(info.commands)
              ? info.commands.map((c) => ({ name: c.name, description: c.description || '', hint: c.argumentHint || '' }))
              : get().ccCommands,
          };
          try { localStorage.setItem(CATALOG_KEY, JSON.stringify(catalog)); } catch { /* sin almacenamiento */ }
          set({ ccModels: catalog.models, ccCommands: catalog.commands });
        }
        return p;
      })();
      try { return await starting; } finally { starting = null; }
    }

    async function applyEffort(p) {
      const level = get().ccEffort;
      if (level === appliedEffort) return;
      appliedEffort = level;
      hiddenTurns += 1;
      await p.send(userMessage(`/effort ${level}`));
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
      ccCompacting: null,
      ccMode: initialCcMode(),
      ccEffort: localStorage.getItem(EFFORT_KEY) || 'auto',
      ccPrevMode: 'default',
      ccModels: cachedCatalog().models || [],
      ccCommands: cachedCatalog().commands || [],
      nativeTools: false,
      ...shared,

      setToolPolicy: (cat, value) => agentSettings.setToolPolicy(get().toolPolicy, cat, value),
      // Los comandos del IDE hablan en modos de Lixbon: se traducen a los de Claude.
      setChatMode: (mode) => get().setCcMode(mode === 'agent' ? (get().ccPrevMode || 'default') : 'plan'),
      cycleChatMode: () => {
        const cycle = CLAUDE_MODES.filter((m) => m.cycle);
        const i = cycle.findIndex((m) => m.id === get().ccMode);
        get().setCcMode(cycle[(i + 1) % cycle.length].id);
      },
      setCcMode: (ccMode) => {
        if (!CLAUDE_MODES.some((m) => m.id === ccMode) || ccMode === get().ccMode) return;
        localStorage.setItem(MODE_KEY, ccMode);
        set({ ccMode, ...(get().ccMode !== 'plan' ? { ccPrevMode: get().ccMode } : {}) });
        if (proc && ccMode !== appliedMode) {
          const p = proc;
          p.control({ subtype: 'set_permission_mode', mode: ccMode })
            .then(() => { if (proc === p) appliedMode = ccMode; })
            .catch((err) => push({ role: 'error', content: `Claude Code no aceptó el modo: ${err?.message || err}` }));
        }
      },
      warmup: () => { ensureProc().catch(() => {}); },

      // `/effort` es un comando local de Claude Code (no gasta tokens) y es la
      // forma fiable de cambiarlo con la sesión abierta; al arrancar va en --effort.
      setCcEffort: (ccEffort) => {
        localStorage.setItem(EFFORT_KEY, ccEffort);
        set({ ccEffort });
        if (proc && !get().streaming) applyEffort(proc).catch(() => {});
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

        const compacting = /^\/compact(\s|$)/i.test(text.trim());
        set({
          messages: [...msgs(), shown, ...(compacting ? [] : [{ role: 'assistant', content: '', engine: 'claude' }])],
          streaming: true,
          ccCompacting: compacting ? Date.now() : null,
          conversationTitle: get().conversationTitle || shown.content.slice(0, 60),
        });
        try {
          const p = await ensureProc();
          const mode = get().ccMode;
          if (mode !== appliedMode) { await p.control({ subtype: 'set_permission_mode', mode }); appliedMode = mode; }
          if (get().ccEffort !== appliedEffort) await applyEffort(p);
          if (get().ccModel !== appliedModel) { await p.control({ subtype: 'set_model', model: get().ccModel || 'default' }); appliedModel = get().ccModel; }
          await p.send(userMessage(prompt, hasImages ? images : []));
        } catch (err) {
          dropEmptyTail();
          push({ role: 'error', content: String(err?.message || err) });
          finishTurn();
        }
      },

      runPlan: () => {
        get().setCcMode(get().ccPrevMode && get().ccPrevMode !== 'plan' ? get().ccPrevMode : 'default');
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
