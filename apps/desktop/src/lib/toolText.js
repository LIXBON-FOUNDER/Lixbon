// toolText.js — la actividad del agente contada en palabras: qué está
// haciendo ahora («Revisando el diff») y qué hizo en un tramo («Ejecutó 3
// comandos y leyó 2 archivos»). Nunca el comando crudo: ese queda en el
// detalle desplegable.

const base = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || p || '';
const short = (s, n = 48) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');
const mcpParts = (tool) => {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool || '');
  return m ? { server: m[1], tool: m[2].replace(/_/g, ' ') } : null;
};

/** Quita los `cd … &&` del principio y se queda con el primer comando. */
function mainCommand(cmd) {
  let c = String(cmd || '').trim();
  for (let i = 0; i < 4; i++) {
    const m = /^(?:cd|pushd|Set-Location)\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i.exec(c);
    if (!m) break;
    c = c.slice(m[0].length);
  }
  return c.split(/\s*(?:&&|\|\||;|\|)\s*/)[0].trim();
}

const COMMANDS = [
  [/^git\s+(?:diff|show)\b/, 'Revisando el diff'],
  [/^git\s+(?:log|blame|shortlog)\b/, 'Leyendo el historial de git'],
  [/^git\s+(?:status)\b/, 'Mirando el estado del repositorio'],
  [/^git\s+(?:fetch|pull)\b/, 'Trayendo cambios del remoto'],
  [/^git\s+push\b/, 'Subiendo los cambios'],
  [/^git\s+commit\b/, 'Guardando un commit'],
  [/^git\s+(?:add|restore|reset|stash)\b/, 'Preparando cambios en git'],
  [/^git\s+(?:checkout|switch|branch|merge|rebase|cherry-pick)\b/, 'Trabajando con las ramas'],
  [/^git\s+grep\b/, 'Buscando en el código'],
  [/^git\b/, 'Consultando git'],
  [/^gh\s+pr\b/, 'Consultando el pull request'],
  [/^gh\s+(?:run|workflow)\b/, 'Revisando GitHub Actions'],
  [/^gh\s+issue\b/, 'Consultando la issue'],
  [/^gh\b/, 'Consultando GitHub'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:ci|i|install|add)\b/, 'Instalando dependencias'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|^(?:npx\s+)?(?:vitest|jest|playwright\s+test)\b|^(?:python3?\s+-m\s+)?pytest\b|^cargo\s+test\b|^go\s+test\b/, 'Ejecutando los tests'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|format)\b|^(?:npx\s+)?(?:eslint|oxlint|prettier|ruff|black|biome)\b|^cargo\s+(?:clippy|fmt)\b/, 'Revisando el estilo del código'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|^(?:npx\s+)?(?:vite|tsc|webpack)\b|^cargo\s+(?:build|check)\b|^go\s+build\b|^make\b/, 'Compilando el proyecto'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b/, 'Arrancando el servidor'],
  [/^(?:npm|pnpm|yarn|bun|npx)\b/, 'Ejecutando un script del proyecto'],
  [/^(?:pip3?|uv|poetry)\s+(?:install|add|sync)\b/, 'Instalando dependencias'],
  [/^(?:python3?|node|deno|ruby|php)\b/, 'Ejecutando un script'],
  [/^(?:grep|rg|ag|findstr|Select-String)\b/, 'Buscando en el código'],
  [/^(?:ls|dir|tree|find|fd|Get-ChildItem)\b/, 'Explorando los archivos'],
  [/^(?:cat|head|tail|less|more|type|sed\s+-n|Get-Content|wc)\b/, 'Leyendo archivos'],
  [/^(?:sed|awk|perl)\b/, 'Editando texto'],
  [/^(?:mkdir|cp|mv|rm|touch|ln|New-Item|Remove-Item|Copy-Item|Move-Item)\b/, 'Ordenando archivos'],
  [/^(?:curl|wget|Invoke-WebRequest)\b/, 'Haciendo una petición web'],
  [/^(?:docker|docker-compose|podman)\b/, 'Trabajando con contenedores'],
  [/^(?:cargo|go|dotnet|mvn|gradle)\b/, 'Ejecutando la herramienta del proyecto'],
];

export function describeCommand(cmd) {
  const c = mainCommand(cmd);
  for (const [re, text] of COMMANDS) if (re.test(c)) return text;
  return 'Ejecutando un comando';
}

/** Frase en curso para una tool call (gerundio, con su objeto). */
export function describeTool(m) {
  const a = m.args || {};
  const mcp = mcpParts(m.tool);
  if (mcp) return `Usando ${mcp.server} · ${mcp.tool}`;
  switch (m.tool) {
    case 'run_command': {
      const d = String(a.description || '').trim();
      return d ? d.charAt(0).toUpperCase() + d.slice(1) : describeCommand(a.command);
    }
    case 'read_file': return `Leyendo ${base(a.path)}`;
    case 'write_file': return `Escribiendo ${base(a.path)}`;
    case 'edit_file': case 'multi_edit': case 'insert_at_line': return `Editando ${base(a.path)}`;
    case 'append_file': return `Añadiendo a ${base(a.path)}`;
    case 'delete_file': return `Eliminando ${base(a.path)}`;
    case 'rename_file': return `Moviendo ${base(a.src)}`;
    case 'mkdir': return `Creando la carpeta ${base(a.path)}`;
    case 'search': return a.query || a.pattern ? `Buscando «${short(a.query || a.pattern, 36)}»` : 'Buscando en el código';
    case 'find_files': return a.pattern ? `Buscando archivos ${short(a.pattern, 36)}` : 'Buscando archivos';
    case 'list_files': return a.path ? `Explorando ${base(a.path)}` : 'Explorando los archivos';
    case 'fetch_url': {
      let host = '';
      try { host = new URL(a.url).hostname.replace(/^www\./, ''); } catch { /* url rara */ }
      return host ? `Leyendo ${host}` : 'Leyendo una página web';
    }
    case 'web_search': return a.query ? `Buscando en la web «${short(a.query, 36)}»` : 'Buscando en la web';
    case 'ask_user': return 'Esperando tu respuesta';
    case 'Task': case 'Agent': return a.description ? `Delegando: ${short(a.description, 48)}` : 'Delegando en un subagente';
    case 'TodoWrite': return 'Actualizando la lista de tareas';
    default: return `Usando ${m.tool}`;
  }
}

const KINDS = [
  { key: 'cmd', tools: ['run_command'], one: 'ejecutó un comando', many: (n) => `ejecutó ${n} comandos` },
  { key: 'edit', tools: ['write_file', 'edit_file', 'multi_edit', 'append_file', 'insert_at_line'], unique: true, one: 'editó un archivo', many: (n) => `editó ${n} archivos` },
  { key: 'read', tools: ['read_file'], unique: true, one: 'leyó un archivo', many: (n) => `leyó ${n} archivos` },
  { key: 'search', tools: ['search', 'find_files', 'list_files'], one: 'hizo una búsqueda', many: (n) => `hizo ${n} búsquedas` },
  { key: 'web', tools: ['fetch_url', 'web_search'], one: 'consultó la web', many: (n) => `consultó la web ${n} veces` },
  { key: 'files', tools: ['delete_file', 'rename_file', 'mkdir'], one: 'ordenó un archivo', many: (n) => `ordenó ${n} archivos` },
  { key: 'ask', tools: ['ask_user'], one: 'te hizo una pregunta', many: (n) => `te hizo ${n} preguntas` },
];

/** «Ejecutó 3 comandos, leyó 2 archivos y editó uno». */
export function summarizeTools(messages) {
  const parts = [];
  const used = new Set();
  for (const k of KINDS) {
    const list = messages.filter((m) => k.tools.includes(m.tool));
    list.forEach((m) => used.add(m));
    const n = k.unique ? new Set(list.map((m) => m.args?.path || m)).size : list.length;
    if (n) parts.push(n === 1 ? k.one : k.many(n));
  }
  const servers = [...new Set(messages.filter((m) => mcpParts(m.tool)).map((m) => mcpParts(m.tool).server))];
  messages.filter((m) => mcpParts(m.tool)).forEach((m) => used.add(m));
  if (servers.length) parts.push(`usó ${servers.join(', ')}`);
  const rest = messages.filter((m) => !used.has(m)).length;
  if (rest) parts.push(rest === 1 ? 'usó una herramienta' : `usó ${rest} herramientas`);
  if (!parts.length) return '';
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
