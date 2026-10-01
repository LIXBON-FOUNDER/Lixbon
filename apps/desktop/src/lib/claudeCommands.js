import { parseUsageText } from './claudeUsage';

// Sin sentido fuera de su terminal (color de la barra, vista foco, fast en el
// Agent SDK), retirados por el propio Claude Code o internos de su nube.
const HIDDEN = new Set(['fast', 'focus', 'color', 'heapdump', 'agents', 'extra-usage', 'workflow-launch-exec', 'clear', 'btw']);

// Con el argumento opcional vacío solo informan y ofrecen sus opciones: se
// lanzan al elegirlos. El resto se deja escrito para completarlo.
const RUN_BARE = new Set(['advisor', 'autocompact', 'output-style', 'mcp', 'goal']);

const ES = {
  advisor: 'Consultar a un modelo más potente en los momentos clave',
  'auto-mode-setup': 'Enseñar al modo Auto cómo es tu entorno',
  autocompact: 'Tamaño de la ventana de compactación automática',
  batch: 'Cambio grande en paralelo con varios agentes',
  'claude-api': 'Referencia de la API de Claude y sus SDK',
  'code-review': 'Revisar el diff actual en busca de errores',
  compact: 'Resumir la conversación para liberar contexto',
  config: 'Cambiar un ajuste de Claude Code (clave=valor)',
  context: 'Qué está ocupando el contexto ahora mismo',
  debug: 'Activar el registro de depuración y diagnosticar un problema',
  doctor: 'Revisar la instalación y la configuración de Claude Code',
  effort: 'Nivel de esfuerzo del modelo',
  'fewer-permission-prompts': 'Menos avisos de permiso para comandos de solo lectura',
  goal: 'Fijar un objetivo y seguir hasta cumplirlo',
  import: 'Importar la configuración de otro agente',
  init: 'Crear CLAUDE.md con la documentación del proyecto',
  insights: 'Informe sobre tus sesiones de Claude Code (tarda: las analiza todas)',
  'list-agents': 'Subagentes y otras sesiones de Claude abiertas',
  loop: 'Repetir un prompt o comando cada cierto tiempo',
  mcp: 'Estado de los servidores MCP',
  model: 'Modelo de esta sesión',
  'output-style': 'Estilo de las respuestas',
  recap: 'Resumen de la sesión en una línea',
  'reload-plugins': 'Activar los cambios pendientes de plugins',
  'reload-skills': 'Recargar las skills cambiadas en disco',
  rename: 'Renombrar la conversación',
  run: 'Arrancar la app para ver un cambio funcionando',
  schedule: 'Agentes programados en la nube',
  'security-review': 'Revisión de seguridad de los cambios pendientes',
  simplify: 'Simplificar el código cambiado',
  'skill-doctor': 'Skills cargadas que no usas y lo que cuestan',
  'team-onboarding': 'Guía para que tu equipo empiece con Claude Code',
  ultrareview: 'Revisión profunda de tu rama en la nube (de pago)',
  'update-config': 'Configurar Claude Code en settings.json',
  usage: 'Consumo del plan y qué lo está gastando',
  'usage-credits': 'Créditos de uso (se abre el navegador)',
  verify: 'Comprobar de punta a punta que un cambio funciona',
};

/** Catálogo del `initialize` → entradas del menú "/", separadas en comandos
    de Claude Code y skills. */
export function claudeMenuEntries(commands = []) {
  return commands
    .filter((c) => c?.name && !HIDDEN.has(c.name) && !c.name.startsWith('__'))
    .map((c) => ({
      cmd: c.name,
      desc: ES[c.name] || String(c.description || 'Comando de Claude Code').replace(/\s*\((user|project|claude\.ai sync|plugin)\)\s*$/i, ''),
      hint: c.hint,
      group: c.builtin ? 'claude' : 'skill',
      direct: !c.hint || RUN_BARE.has(c.name),
    }));
}

export function parseSlash(text) {
  const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  return m ? { name: m[1].toLowerCase(), args: (m[2] || '').trim() } : null;
}

const WORD = /^[\w.[\]-]+$/;

/** Valores que el comando acepta, para ofrecerlos como botones cuando se
    lanza sin argumentos. */
function choicesOf(name, output) {
  const text = String(output || '');
  if (name === 'output-style') {
    return [...text.matchAll(/^- ([^:\n(]+?)(?: \((current)\))?(?::\s*(.+))?$/gm)]
      .map((m) => ({ value: m[1].trim(), current: !!m[2], desc: m[3] || '' }));
  }
  if (name === 'model') {
    const cur = /Current model: `([^`]+)`/.exec(text)?.[1]?.toLowerCase().split(' ')[0];
    const list = /Available: (.+?)(?:, or a full model ID)?\.?$/m.exec(text)?.[1];
    if (!list) return [];
    return list.split(/,\s*/).filter((v) => WORD.test(v)).map((v) => ({ value: v, current: v === cur }));
  }
  const usage = new RegExp(`^Usage: /${name} [<[]([^>\\]]+)[>\\]]`, 'm').exec(text)?.[1];
  const opts = usage?.split('|').map((v) => v.trim()) || [];
  const cur = /^[\w -]+:\s*(\S+)\s*$/m.exec(text)?.[1]?.toLowerCase();
  return opts.length > 1 && opts.every((v) => WORD.test(v)) ? opts.map((v) => ({ value: v, current: v === cur })) : [];
}

const UNITS = { k: 1e3, m: 1e6 };
export const tokensOf = (s) => {
  const m = /^([\d.,]+)\s*([km])?$/i.exec(String(s || '').trim());
  return m ? Math.round(parseFloat(m[1].replace(/,/g, '')) * (UNITS[m[2]?.toLowerCase()] || 1)) : null;
};

const CATEGORY_ES = {
  'system prompt': 'Prompt del sistema',
  'system tools': 'Herramientas',
  'system tools (deferred)': 'Herramientas diferidas',
  'mcp tools': 'Herramientas MCP',
  'mcp tools (deferred)': 'Herramientas MCP diferidas',
  'mcp server instructions': 'Instrucciones MCP',
  'custom agents': 'Subagentes',
  'memory files': 'Memoria (CLAUDE.md)',
  skills: 'Skills',
  messages: 'Mensajes',
  'free space': 'Libre',
  'autocompact buffer': 'Reserva de autocompactación',
};

/** Salida de `/context` → tokens usados, reparto por categoría y el resto de
    tablas (skills, MCP…) como markdown aparte. */
export function parseContextText(text) {
  const src = String(text || '');
  const head = /\*\*Tokens:\*\*\s*([\d.,]+[km]?)\s*\/\s*([\d.,]+[km]?)\s*\((\d+)%\)/i.exec(src);
  if (!head) return null;
  const model = /\*\*Model:\*\*\s*(\S+)/.exec(src)?.[1] || '';
  const catStart = src.search(/^### Estimated usage by category/m);
  const rest = catStart >= 0 ? src.slice(catStart).split('\n').slice(1) : [];
  const categories = [];
  let i = 0;
  for (; i < rest.length; i++) {
    const row = /^\|\s*([^|]+?)\s*\|\s*([\d.,]+[km]?)\s*\|\s*([\d.]+)%\s*\|/i.exec(rest[i]);
    if (row) {
      const key = row[1].toLowerCase();
      categories.push({ key, label: CATEGORY_ES[key] || row[1], tokens: tokensOf(row[2]), text: row[2], pct: Number(row[3]) });
    } else if (categories.length && !rest[i].startsWith('|')) break;
  }
  return {
    model,
    used: tokensOf(head[1]),
    total: tokensOf(head[2]),
    usedText: head[1],
    totalText: head[2],
    pct: Number(head[3]),
    categories,
    details: rest.slice(i).join('\n').trim(),
  };
}

/** Mensaje del chat con la salida de un comando local de Claude Code. */
export function commandCard(name, args, output) {
  const out = String(output || '').trim();
  const card = { role: 'cmd', engine: 'claude', name, args, output: out };
  if (name === 'usage') { const usage = parseUsageText(out); if (usage) card.usage = usage; }
  if (name === 'context') { const context = parseContextText(out); if (context) card.context = context; }
  if (!args) { const choices = choicesOf(name, out); if (choices.length) card.choices = choices; }
  if (name === 'list-agents') { const agents = parseAgentsText(out); if (agents) card.agents = agents; }
  if (name === 'skill-doctor') { const table = parseColumns(out); if (table) card.table = table; }
  if (name === 'config' && !args) { const options = parseConfigOptions(out); if (options.length) card.options = options; }
  if (!args && !card.usage && !card.context && !card.agents && !card.table && !card.options) { const setting = parseSetting(out); if (setting) card.setting = setting; }
  return card;
}

// Solo leen y no dependen del turno: mientras Claude trabaja se resuelven
// aparte, como en su terminal, en vez de esperar al final del turno.
const INSTANT = new Set(['usage', 'context', 'mcp', 'list-agents', 'skill-doctor']);
const INSTANT_BARE = new Set(['model', 'effort', 'output-style', 'advisor', 'autocompact', 'config']);
export const isInstant = (slash) => !!slash && (INSTANT.has(slash.name) || (!slash.args && INSTANT_BARE.has(slash.name)));

const MCP_STATUS = {
  connected: ['Conectado', 'ok'],
  pending: ['Conectando', 'wait'],
  'needs-auth': ['Falta autorizar', 'warn'],
  failed: ['Falló', 'bad'],
  disabled: ['Desactivado', 'off'],
};

/** Respuesta del control `mcp_status` → tarjeta de /mcp. */
export function mcpCard(servers = []) {
  const list = servers.map((s) => {
    const [label, tone] = MCP_STATUS[s.status] || [s.status, 'off'];
    const name = String(s.name || '').replace(/^claude\.ai /, '');
    return { name, status: label, tone, scope: s.scope === 'claudeai' ? 'claude.ai' : s.scope || '', kind: s.config?.type === 'claudeai-proxy' ? 'conector' : s.config?.type || '' };
  });
  return { role: 'cmd', engine: 'claude', name: 'mcp', args: '', output: '', mcp: list };
}

const AGENT_STATUS = { busy: ['Trabajando', 'wait'], idle: ['En espera', 'off'] };

function parseAgentsText(text) {
  const self = /^This session:\s*(\S+)\s*\[([^\]]+)\]/m.exec(text);
  if (!self) return null;
  const others = [...text.matchAll(/^\s*\[(\w+)\]\s*·\s*(.+?)\s*·\s*(.+?)\s*·\s*started (.+)$/gm)].map((m) => {
    const [label, tone] = AGENT_STATUS[m[1]] || [m[1], 'off'];
    return { name: m[2], cwd: m[3], started: m[4].replace(/^(\d+)([hmd]) ago$/, 'hace $1 $2'), status: label, tone };
  });
  return { self: self[1], others };
}

/** Tabla en columnas alineadas con espacios (la de /skill-doctor) → filas. */
function parseColumns(text) {
  const lines = String(text).split('\n');
  const h = lines.findIndex((l) => /^\s{2}\S.*\s{2,}\S/.test(l) && !/^\s{2}\S+\s+\S+\s+[<~\d-]/.test(l));
  if (h < 0) return null;
  const header = lines[h].trim().split(/\s{2,}/);
  const rows = [];
  let i = h + 1;
  for (; i < lines.length && lines[i].trim(); i++) rows.push(lines[i].trim().split(/\s{2,}/));
  if (!rows.length) return null;
  const title = lines.slice(0, h).join('\n').trim();
  const notes = lines.slice(i).join('\n').trim();
  return { title, header, rows, notes };
}

const SETTING_ES = {
  advisor: 'Asesor',
  'auto-compact window': 'Ventana de autocompactación',
  'output style': 'Estilo de las respuestas',
  'current model': 'Modelo actual',
};

// "Clave: valor" en la primera línea de los comandos de ajuste (/advisor, /output-style…).
function parseSetting(text) {
  const m = /^([A-Z][\w -]{1,30}):\s*(\S.*)$/m.exec(text);
  if (!m || /^Usage$/i.test(m[1])) return null;
  const body = text.replace(m[0], '').replace(/^Usage: .*$/m, '').replace(/^Available styles:\s*$/m, '').replace(/^- .*$/gm, '').trim();
  return { key: SETTING_ES[m[1].toLowerCase()] || m[1], value: m[2].replace(/`/g, ''), body };
}

function parseConfigOptions(text) {
  return [...String(text).matchAll(/^\s{2}([\w.-]+)=(.+)$/gm)].map((m) => ({
    key: m[1],
    values: m[2].trim() === '<value>' ? null : m[2].trim().split('|'),
  }));
}

// Lo que el menú "/" de la terminal trae y el modo -p no: Lixbon lo resuelve con
// lo que ya sabe de la sesión y los archivos de configuración de Claude Code.
export const IDE_CARDS = new Set(['status', 'cost', 'help', 'skills', 'permissions', 'memory', 'hooks', 'doctor']);

export const SCOPE_ES = { user: 'Global', project: 'Proyecto', local: 'Local, solo tú' };

function settingsOf(files) {
  return files.filter((f) => f.kind === 'settings' && f.exists).map((f) => {
    try { return { ...f, json: JSON.parse(f.content || '{}') || {} }; } catch (e) { return { ...f, json: {}, error: String(e.message || e) }; }
  });
}

export function permissionsOf(files) {
  const rules = [];
  const dirs = [];
  let defaultMode = null;
  const settings = settingsOf(files);
  for (const f of settings) {
    const p = f.json.permissions || {};
    for (const kind of ['allow', 'ask', 'deny']) {
      for (const rule of Array.isArray(p[kind]) ? p[kind] : []) rules.push({ kind, rule: String(rule), scope: f.scope, path: f.path });
    }
    for (const d of Array.isArray(p.additionalDirectories) ? p.additionalDirectories : []) dirs.push({ dir: String(d), scope: f.scope });
    if (p.defaultMode) defaultMode = { mode: p.defaultMode, scope: f.scope };
  }
  return {
    rules, dirs, defaultMode,
    errors: settings.filter((f) => f.error).map((f) => ({ path: f.path, error: f.error })),
    files: files.filter((f) => f.kind === 'settings'),
  };
}

export function hooksOf(files) {
  const rows = [];
  const settings = settingsOf(files);
  for (const f of settings) {
    for (const [event, groups] of Object.entries(f.json.hooks || {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
          rows.push({ event, matcher: g.matcher || '', command: h.command || h.prompt || h.url || h.type || '', type: h.type || 'command', scope: f.scope, path: f.path });
        }
      }
    }
  }
  return { rows, disabled: settings.some((f) => f.json.disableAllHooks === true), files: files.filter((f) => f.kind === 'settings') };
}

export function memoryOf(files) {
  return files.filter((f) => f.kind === 'memory').map((f) => ({
    scope: f.scope, path: f.path, exists: f.exists,
    lines: f.exists ? String(f.content || '').split('\n').length : 0,
    tokens: f.exists ? Math.round(String(f.content || '').length / 4) : 0,
  }));
}

const SKILL_SOURCES = { user: 'Tuyas', project: 'Del proyecto', plugin: 'De plugins', 'claude.ai sync': 'De claude.ai' };

export function skillsOf(commands = []) {
  return commands.filter((c) => c?.name && !c.builtin && !c.name.startsWith('__')).map((c) => {
    const raw = String(c.description || '');
    const src = /\((user|project|plugin|claude\.ai sync)\)\s*$/i.exec(raw)?.[1]?.toLowerCase();
    return {
      name: c.name,
      desc: raw.replace(/\s*\((user|project|plugin|claude\.ai sync)\)\s*$/i, ''),
      source: SKILL_SOURCES[src] || (c.name.includes(':') ? 'De plugins' : 'Otras'),
    };
  });
}

/** Revisión sin modelo: lo que suele romper Claude Code en una máquina. */
export function doctorChecks({ version, account, files, mcp, context }) {
  const checks = [];
  checks.push(version
    ? { tone: 'ok', label: 'Claude Code instalado', detail: version }
    : { tone: 'bad', label: 'Claude Code no responde', detail: 'Instálalo desde claude.com/code y ejecuta claude en una terminal.' });
  checks.push(account?.email
    ? { tone: 'ok', label: 'Sesión iniciada', detail: [account.email, account.subscriptionType].filter(Boolean).join(' · ') }
    : { tone: 'warn', label: 'Sin datos de la cuenta', detail: 'Si Claude no responde, ejecuta claude en una terminal e inicia sesión.' });
  const settings = settingsOf(files);
  const broken = settings.filter((f) => f.error);
  checks.push(broken.length
    ? { tone: 'bad', label: 'Ajustes con JSON inválido', detail: broken.map((f) => `${f.path}: ${f.error}`).join('\n'), paths: broken.map((f) => f.path) }
    : { tone: 'ok', label: 'Ajustes válidos', detail: settings.length ? `${settings.length} archivo${settings.length === 1 ? '' : 's'} de settings` : 'Sin settings.json propios' });
  if (mcp) {
    const failed = mcp.filter((s) => s.tone === 'bad');
    const auth = mcp.filter((s) => s.tone === 'warn');
    if (failed.length) checks.push({ tone: 'bad', label: 'Servidores MCP caídos', detail: failed.map((s) => s.name).join(', ') });
    if (auth.length) checks.push({ tone: 'warn', label: 'MCP sin autorizar', detail: `${auth.map((s) => s.name).join(', ')}. Autorízalos en los conectores de claude.ai o con /mcp en la terminal.` });
    if (!failed.length && !auth.length) checks.push({ tone: 'ok', label: 'Servidores MCP', detail: mcp.length ? `${mcp.length} configurados, ninguno con errores` : 'Ninguno configurado' });
  }
  const memTokens = memoryOf(files).reduce((n, m) => n + m.tokens, 0);
  checks.push(memTokens > 10000
    ? { tone: 'warn', label: 'CLAUDE.md muy largo', detail: `~${Math.round(memTokens / 1000)}k tokens en cada turno. Recórtalo con /memory.` }
    : { tone: 'ok', label: 'Memoria (CLAUDE.md)', detail: memTokens ? `~${memTokens.toLocaleString('es')} tokens por turno` : 'Sin CLAUDE.md' });
  if (context?.window && context.used / context.window > 0.8) {
    checks.push({ tone: 'warn', label: 'Contexto casi lleno', detail: `${Math.round((context.used / context.window) * 100)}% usado. Usa /compact o empieza otra conversación.` });
  }
  return checks;
}
