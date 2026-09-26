// claudeCode.js — Claude Code como agente del IDE (`claude -p` en stream-json).
// El proceso lo lanza src-tauri/src/claude_code.rs; aquí se habla el protocolo
// y se traducen sus herramientas a las filas del agente de Lixbon, para que
// Cambios, Contexto y Terminal funcionen igual con los dos agentes.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const CLAUDE_MODELS = [
  { value: '', label: 'Predeterminado' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
];

export const claudeVersion = () => invoke('cc_version');
export const claudeSessions = (cwd) => invoke('cc_sessions', { cwd });
export const claudeTranscript = (cwd, id) => invoke('cc_session_read', { cwd, id });

/** Plan y Preguntar son solo lectura: los dos van al modo plan de Claude Code. */
export const permissionModeOf = (chatMode) => (chatMode === 'agent' ? 'default' : 'plan');

export async function startClaude({ procId, cwd, resume, model, permissionMode, onEvent, onStderr, onExit }) {
  const unlisten = await Promise.all([
    listen(`cc:line:${procId}`, (e) => {
      let ev;
      try { ev = JSON.parse(e.payload); } catch { return; }
      onEvent(ev);
    }),
    listen(`cc:stderr:${procId}`, (e) => onStderr(String(e.payload || ''))),
    listen(`cc:exit:${procId}`, () => onExit()),
  ]);
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio',
    '--permission-mode', permissionMode,
    ...(model ? ['--model', model] : []),
    ...(resume ? ['--resume', resume] : []),
  ];
  try {
    await invoke('cc_start', { id: procId, args, cwd });
  } catch (err) {
    unlisten.forEach((u) => u());
    throw err;
  }
  let reqN = 0;
  const send = (obj) => invoke('cc_send', { id: procId, line: JSON.stringify(obj) });
  return {
    send,
    control: (request) => send({ type: 'control_request', request_id: `ide-${Date.now()}-${reqN++}`, request }),
    respond: (requestId, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }),
    close: async () => {
      unlisten.forEach((u) => u());
      await invoke('cc_stop', { id: procId }).catch(() => {});
    },
  };
}

export function userMessage(text, images = []) {
  const content = [];
  for (const im of images) {
    const media = /^data:([^;]+);/.exec(im.dataUrl || '')?.[1] || 'image/png';
    content.push({ type: 'image', source: { type: 'base64', media_type: media, data: im.base64 } });
  }
  content.push({ type: 'text', text });
  return { type: 'user', message: { role: 'user', content } };
}

// ── Herramientas de Claude Code → filas del agente ──────────────────────

export function relTo(root, abs) {
  if (!abs) return '';
  const norm = (p) => String(p).replace(/\\/g, '/');
  const r = norm(root || '').replace(/\/+$/, '');
  const a = norm(abs);
  if (r && a.toLowerCase().startsWith(`${r.toLowerCase()}/`)) return a.slice(r.length + 1);
  return a;
}
const inside = (root, abs) => relTo(root, abs) !== String(abs || '').replace(/\\/g, '/');

export function mapTool(name, input = {}, root = '') {
  const path = (p) => relTo(root, p);
  switch (name) {
    case 'Read': return { tool: 'read_file', args: { path: path(input.file_path) } };
    case 'Write': return { tool: 'write_file', args: { path: path(input.file_path), content: input.content } };
    case 'Edit': return { tool: 'edit_file', args: { path: path(input.file_path), old_text: input.old_string, new_text: input.new_string, all: !!input.replace_all } };
    case 'MultiEdit': return { tool: 'multi_edit', args: { path: path(input.file_path), edits: input.edits } };
    case 'NotebookEdit': return { tool: 'edit_file', args: { path: path(input.notebook_path) } };
    case 'Bash':
    case 'PowerShell': return { tool: 'run_command', args: { command: input.command, description: input.description } };
    case 'Grep': return { tool: 'search', args: { query: input.pattern, path: input.path ? path(input.path) : undefined } };
    case 'Glob': return { tool: 'find_files', args: { pattern: input.pattern } };
    case 'LS': return { tool: 'list_files', args: { path: path(input.path) } };
    case 'WebFetch': return { tool: 'fetch_url', args: { url: input.url } };
    case 'WebSearch': return { tool: 'web_search', args: { query: input.query } };
    default: return { tool: name, args: input };
  }
}

// Mecánica interna de Claude Code: el IDE ya la muestra a su manera (el plan,
// las preguntas) o no aporta nada al usuario.
export const HIDDEN_TOOLS = new Set(['ExitPlanMode', 'EnterPlanMode', 'AskUserQuestion', 'ToolSearch']);

const SAMPLE = 8;

function fromPatch(patch = []) {
  const old = [];
  const neu = [];
  for (const h of patch) {
    for (const l of h.lines || []) {
      if (l.startsWith('-')) old.push(l.slice(1));
      else if (l.startsWith('+')) neu.push(l.slice(1));
    }
  }
  return { added: neu.length, removed: old.length, sampleOld: old.slice(0, SAMPLE), sampleNew: neu.slice(0, SAMPLE) };
}

/** Cambio (para Cambios y el editor) y snapshot (para revertir) a partir del
    resultado estructurado de Edit/Write, que trae el archivo original. */
export function changeOf(name, input, result, root) {
  if (!['Write', 'Edit', 'MultiEdit'].includes(name) || !result) return {};
  const abs = result.filePath || input?.file_path;
  if (!abs || !inside(root, abs)) return {};
  const rel = relTo(root, abs);
  const created = result.type === 'create';
  const counts = created
    ? (() => { const lines = String(result.content ?? input?.content ?? '').split('\n'); return { added: lines.length, removed: 0, sampleOld: [], sampleNew: lines.slice(0, SAMPLE) }; })()
    : fromPatch(result.structuredPatch);
  const original = created ? null : result.originalFile;
  return {
    change: { kind: created ? 'create' : 'update', path: rel, ...counts },
    snapshot: created || typeof original === 'string' ? { kind: 'file', path: rel, oldContent: original } : null,
  };
}

export function resultText(block) {
  const c = block?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return '';
}

const HIDDEN_USER = /^(<command-|<local-command|<system-reminder|Caveat:)/;

/** Transcripción guardada de Claude Code → mensajes del chat. Los cambios del
    historial ya están hechos: se marcan aceptados para no pedir revisión. */
export function transcriptToMessages(text, root) {
  const out = [];
  const rows = new Map();
  const bubble = () => {
    const last = out[out.length - 1];
    if (last?.role === 'assistant') return last;
    const b = { role: 'assistant', content: '', engine: 'claude' };
    out.push(b);
    return b;
  };
  let title = '';
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'custom-title' && ev.customTitle) title = ev.customTitle;
    if (ev.type === 'summary' && ev.summary && !title) title = ev.summary;
    if ((ev.type !== 'user' && ev.type !== 'assistant') || ev.isSidechain || ev.isMeta) continue;
    const content = ev.message?.content;
    if (ev.type === 'assistant') {
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type === 'text' && b.text) { const m = bubble(); m.content = m.content ? `${m.content}\n\n${b.text}` : b.text; }
        else if (b.type === 'thinking' && b.thinking) bubble().thinking = b.thinking;
        else if (b.type === 'tool_use' && !HIDDEN_TOOLS.has(b.name)) {
          const row = { role: 'tool', ...mapTool(b.name, b.input, root), ccName: b.name, ccInput: b.input, ok: true };
          rows.set(b.id, row);
          out.push(row);
        }
      }
      continue;
    }
    if (typeof content === 'string') {
      if (!HIDDEN_USER.test(content.trim())) out.push({ role: 'user', content });
      continue;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === 'tool_result') {
        const row = rows.get(b.tool_use_id);
        if (!row) continue;
        const txt = resultText(b);
        const { change, snapshot } = changeOf(row.ccName, row.ccInput, ev.toolUseResult, root);
        Object.assign(row, {
          ok: !b.is_error, content: txt.split('\n')[0].slice(0, 160), full: txt.slice(0, 4000),
          ...(change ? { change, snapshot, accepted: true } : {}),
        });
      } else if (b.type === 'text' && b.text && !HIDDEN_USER.test(b.text.trim())) {
        out.push({ role: 'user', content: b.text });
      }
    }
  }
  if (!title) title = (out.find((m) => m.role === 'user')?.content || '').slice(0, 60);
  return { messages: out.filter((m) => m.role !== 'assistant' || m.content || m.thinking), title };
}
