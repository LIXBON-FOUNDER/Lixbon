// mcp.js — cliente MCP (JSON-RPC 2.0 por stdio). Mismo formato de
// configuración y de nombres que el CLI (apps/cli/lixbon_cli/mcp.py):
//   <workspace>/.lixbon/mcp.json  y  ~/.lixbon/mcp.json
//   {"servers": {"github": {"command": "npx", "args": [...], "env": {...}}}}
// Cada tool se expone al agente como `mcp__<servidor>__<tool>`.
import { listen } from '@tauri-apps/api/event';
import {
  mcpStart, mcpSend, mcpStop, mcpUserConfig, mcpSaveUserConfig, readFileContent, writeFileContent, createNewEntry,
} from './tauri';

export const MCP_PROTOCOL = '2024-11-05';
const START_TIMEOUT = 30000;
const CALL_TIMEOUT = 120000;
const MAX_RESULT_CHARS = 20000;

export const slug = (text) => String(text).replace(/[^A-Za-z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'x';
export const toolName = (server, tool) => `mcp__${slug(server)}__${slug(tool)}`;

function parseServers(text, source) {
  if (!text) return {};
  const data = JSON.parse(text);
  const out = {};
  for (const [name, spec] of Object.entries(data.servers || data.mcpServers || {})) {
    if (!spec || typeof spec.command !== 'string') continue;
    out[name] = {
      command: spec.command,
      args: Array.isArray(spec.args) ? spec.args.map(String) : [],
      env: Object.fromEntries(Object.entries(spec.env || {}).map(([k, v]) => [k, String(v)])),
      disabled: !!spec.disabled,
      source,
    };
  }
  return out;
}

/** Servidores declarados; los del proyecto pisan a los del usuario. */
export async function loadMcpConfig(root) {
  const errors = [];
  let user = {};
  let project = {};
  try { user = parseServers(await mcpUserConfig(), 'usuario'); } catch (e) { errors.push(`~/.lixbon/mcp.json: ${e.message || e}`); }
  if (root) {
    const sep = root.includes('\\') ? '\\' : '/';
    try {
      project = parseServers(await readFileContent(`${root}${sep}.lixbon${sep}mcp.json`), 'proyecto');
    } catch (e) {
      if (!/no existe|no encontrad|not found|No such file|cannot find|no se encuentra/i.test(String(e))) errors.push(`.lixbon/mcp.json: ${e.message || e}`);
    }
  }
  return { servers: { ...user, ...project }, errors };
}

export class McpClient {
  constructor(name, spec, cwd) {
    this.name = name;
    this.spec = spec;
    this.cwd = cwd;
    this.id = `${slug(name)}-${Date.now().toString(36)}`;
    this.seq = 0;
    this.pending = new Map();
    this.tools = [];
    this.alive = false;
    this.unlisten = [];
    this.onExit = null;
  }

  async start() {
    this.unlisten.push(await listen(`mcp:line:${this.id}`, (e) => this._onLine(e.payload)));
    this.unlisten.push(await listen(`mcp:exit:${this.id}`, () => this._onExit()));
    await mcpStart(this.id, this.spec.command, this.spec.args, this.spec.env, this.cwd || null);
    this.alive = true;
    await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'lixbon-desktop', version: '2' },
    }, START_TIMEOUT);
    await this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const res = await this.request('tools/list', {}, START_TIMEOUT);
    this.tools = Array.isArray(res.tools) ? res.tools : [];
    return this.tools;
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // hay servidores que loguean por stdout
    const slot = msg && msg.id != null ? this.pending.get(msg.id) : null;
    if (!slot) return;
    this.pending.delete(msg.id);
    clearTimeout(slot.timer);
    if (msg.error) slot.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else slot.resolve(msg.result || {});
  }

  _onExit() {
    this.alive = false;
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(new Error(`el servidor «${this.name}» se cerró`));
    }
    this.pending.clear();
    this.onExit?.();
  }

  _send(message) {
    if (!this.alive) return Promise.reject(new Error(`el servidor «${this.name}» no está en marcha`));
    return mcpSend(this.id, JSON.stringify(message));
  }

  request(method, params, timeout = CALL_TIMEOUT) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`«${this.name}» no respondió a ${method} en ${Math.round(timeout / 1000)} s`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params }).catch((e) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      });
    });
  }

  async call(tool, args) {
    const result = await this.request('tools/call', { name: tool, arguments: args || {} });
    const parts = (result.content || []).map((item) => {
      if (item.type === 'text') return String(item.text ?? '');
      if (item.type === 'image') return `[imagen ${item.mimeType || ''}: no se puede mostrar aquí]`;
      if (item.type === 'resource') return String(item.resource?.text || `[recurso ${item.resource?.uri || ''}]`);
      return '';
    });
    let text = parts.filter(Boolean).join('\n').trim() || '(sin contenido)';
    if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n…[recortado]`;
    return result.isError ? `[ERROR] ${text}` : text;
  }

  async stop() {
    this.alive = false;
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
    await mcpStop(this.id).catch(() => {});
  }
}

// ── Edición de la configuración ────────────────────────────────────────

async function readConfigText(scope, root) {
  if (scope === 'usuario') return (await mcpUserConfig()) || '';
  const sep = root.includes('\\') ? '\\' : '/';
  try { return await readFileContent(`${root}${sep}.lixbon${sep}mcp.json`); } catch { return ''; }
}

async function writeConfigText(scope, root, text) {
  if (scope === 'usuario') return mcpSaveUserConfig(text);
  const sep = root.includes('\\') ? '\\' : '/';
  await createNewEntry(root, '.lixbon', true).catch(() => {}); // ya existe: no pasa nada
  const path = `${root}${sep}.lixbon${sep}mcp.json`;
  await writeFileContent(path, text, null);
  return path;
}

/** Añade o reemplaza un servidor en ~/.lixbon/mcp.json o en el del proyecto. */
export async function saveMcpServer(scope, root, name, spec) {
  const text = await readConfigText(scope, root);
  const data = text.trim() ? JSON.parse(text) : {};
  const key = data.mcpServers && !data.servers ? 'mcpServers' : 'servers';
  data[key] = { ...(data[key] || {}), [name]: spec };
  return writeConfigText(scope, root, `${JSON.stringify(data, null, 2)}\n`);
}

export async function removeMcpServer(scope, root, name) {
  const text = await readConfigText(scope, root);
  if (!text.trim()) return null;
  const data = JSON.parse(text);
  for (const key of ['servers', 'mcpServers']) if (data[key]) delete data[key][name];
  return writeConfigText(scope, root, `${JSON.stringify(data, null, 2)}\n`);
}

/** Servidores conocidos para instalar con un clic. `{campo}` en args/env se
    pide al usuario antes de guardar. */
export const MCP_CATALOG = [
  {
    id: 'github', name: 'GitHub', desc: 'Issues, pull requests, ramas y archivos del repositorio.',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '{token de GitHub}' },
  },
  {
    id: 'postgres', name: 'Postgres', desc: 'Consultas de solo lectura y esquema de tu base de datos.',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '{URL de la base de datos}'], env: {},
  },
  {
    id: 'playwright', name: 'Playwright', desc: 'Controla un navegador: navegar, hacer clic, capturar la página.',
    command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: {},
  },
  {
    id: 'fetch', name: 'Fetch', desc: 'Descarga páginas web y las convierte a Markdown.',
    command: 'uvx', args: ['mcp-server-fetch'], env: {},
  },
  {
    id: 'memory', name: 'Memoria', desc: 'Grafo de conocimiento persistente entre conversaciones.',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], env: {},
  },
  {
    id: 'sequential-thinking', name: 'Razonamiento secuencial', desc: 'Divide problemas complejos en pasos revisables.',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], env: {},
  },
  {
    id: 'brave-search', name: 'Brave Search', desc: 'Búsqueda web y local con la API de Brave.',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '{clave de la API de Brave}' },
  },
];

/** Campos `{…}` que hay que rellenar en una plantilla del catálogo. */
export function templateFields(entry) {
  const fields = [];
  entry.args.forEach((a, i) => { const m = /^\{(.+)\}$/.exec(a); if (m) fields.push({ key: `arg:${i}`, label: m[1] }); });
  Object.entries(entry.env).forEach(([k, v]) => { const m = /^\{(.+)\}$/.exec(v); if (m) fields.push({ key: `env:${k}`, label: m[1], secret: true }); });
  return fields;
}

export function fillTemplate(entry, values) {
  return {
    command: entry.command,
    args: entry.args.map((a, i) => (/^\{.+\}$/.test(a) ? values[`arg:${i}`] || '' : a)),
    env: Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, /^\{.+\}$/.test(v) ? values[`env:${k}`] || '' : v])),
  };
}
