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
  insights: 'Informe sobre tus sesiones de Claude Code',
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
  return card;
}
