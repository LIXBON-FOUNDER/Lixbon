// mcpStore.js — servidores MCP del workspace: config, estado de cada proceso
// y sus tools, que el agente recibe como `mcp__<servidor>__<tool>`.
import { create } from 'zustand';
import { loadMcpConfig, McpClient, toolName } from '../lib/mcp';
import { useOutputStore } from './outputStore';

const OFF_KEY = 'lixbon_mcp_off';
const readOff = () => { try { return new Set(JSON.parse(localStorage.getItem(OFF_KEY) || '[]')); } catch { return new Set(); } };
const writeOff = (set) => localStorage.setItem(OFF_KEY, JSON.stringify([...set]));

const clients = new Map(); // nombre → McpClient

export const useMcpStore = create((set, get) => ({
  servers: {}, // nombre → { name, spec, source, status: 'stopped'|'starting'|'ready'|'error', tools, error, enabled }
  errors: [],
  root: '',
  loaded: false,

  _patch: (name, patch) => {
    const cur = get().servers[name];
    if (!cur) return;
    set({ servers: { ...get().servers, [name]: { ...cur, ...patch } } });
  },

  /** Relee la config y arranca los servidores habilitados. */
  load: async (root) => {
    const { servers: specs, errors } = await loadMcpConfig(root);
    const off = readOff();
    for (const [name, client] of clients) {
      const next = specs[name];
      if (!next || JSON.stringify(next) !== JSON.stringify(client.spec) || root !== get().root) {
        await client.stop();
        clients.delete(name);
      }
    }
    const servers = {};
    for (const [name, spec] of Object.entries(specs)) {
      const running = clients.get(name);
      const prev = get().servers[name];
      servers[name] = {
        name, spec, source: spec.source,
        enabled: !spec.disabled && !off.has(name),
        status: running?.alive ? 'ready' : 'stopped',
        tools: running?.alive ? running.tools : [],
        error: running?.alive ? '' : prev?.error || '',
      };
    }
    set({ servers, errors, root, loaded: true });
    await Promise.all(Object.values(servers).filter((s) => s.enabled && s.status !== 'ready').map((s) => get().start(s.name)));
  },

  start: async (name) => {
    const entry = get().servers[name];
    if (!entry) return;
    await clients.get(name)?.stop();
    const client = new McpClient(name, entry.spec, get().root);
    clients.set(name, client);
    get()._patch(name, { status: 'starting', error: '' });
    const log = (t) => useOutputStore.getState().append('MCP', `[${name}] ${t}`);
    log(`iniciando: ${[entry.spec.command, ...(entry.spec.args || [])].join(' ')}`);
    try {
      const tools = await client.start();
      client.onExit = () => {
        if (clients.get(name) !== client) return;
        log('el proceso terminó');
        get()._patch(name, { status: 'error', error: 'El proceso terminó', tools: [] });
      };
      log(`listo · ${tools.length} herramientas`);
      get()._patch(name, { status: 'ready', tools });
    } catch (e) {
      await client.stop();
      clients.delete(name);
      log(`error: ${e?.message || e}`);
      get()._patch(name, { status: 'error', error: String(e?.message || e), tools: [] });
    }
  },

  stop: async (name) => {
    await clients.get(name)?.stop();
    clients.delete(name);
    get()._patch(name, { status: 'stopped', tools: [] });
  },

  setEnabled: async (name, enabled) => {
    const off = readOff();
    if (enabled) off.delete(name); else off.add(name);
    writeOff(off);
    get()._patch(name, { enabled });
    if (enabled) await get().start(name);
    else await get().stop(name);
  },

  stopAll: async () => {
    for (const client of clients.values()) await client.stop();
    clients.clear();
  },

  /** Tools disponibles para el agente, con su nombre prefijado. */
  agentTools: () => {
    const out = [];
    for (const s of Object.values(get().servers)) {
      if (s.status !== 'ready') continue;
      for (const t of s.tools) {
        out.push({ name: toolName(s.name, t.name), server: s.name, tool: t.name, description: t.description || '', schema: t.inputSchema || { type: 'object', properties: {} } });
      }
    }
    return out;
  },

  call: async (fullName, args) => {
    const hit = get().agentTools().find((t) => t.name === fullName);
    if (!hit) throw new Error(`La herramienta ${fullName} no está disponible (¿servidor MCP detenido?)`);
    const client = clients.get(hit.server);
    if (!client?.alive) throw new Error(`El servidor MCP «${hit.server}» no está en marcha`);
    return client.call(hit.tool, args);
  },
}));

/** Schemas en formato OpenAI para tool-calling nativo. */
export function mcpToolSchemas() {
  return useMcpStore.getState().agentTools().map((t) => ({
    type: 'function',
    function: { name: t.name, description: `[MCP ${t.server}] ${t.description}`.slice(0, 1000), parameters: t.schema },
  }));
}

/** Sección del system prompt (protocolo de texto) con las tools MCP. */
export function mcpPromptSection() {
  const tools = useMcpStore.getState().agentTools();
  if (!tools.length) return '';
  const lines = tools.map((t) => {
    const props = Object.keys(t.schema?.properties || {});
    const example = Object.fromEntries(props.slice(0, 4).map((p) => [p, '…']));
    return `{"tool":"${t.name}","args":${JSON.stringify(example)}}  (${t.description.replace(/\s+/g, ' ').slice(0, 160)})`;
  });
  return `\n\n=== HERRAMIENTAS MCP (servidores externos del usuario) ===\n${lines.join('\n')}`;
}
