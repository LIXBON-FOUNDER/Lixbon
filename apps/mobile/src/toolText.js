// toolText.js — la actividad del agente remoto contada en palabras (copia de
// apps/web/src/lib/toolText.js, en español e inglés): qué hace ahora («Revisando el diff») y qué hizo
// en un tramo («Ejecutó 3 comandos y leyó 2 archivos»). El host del IDE ya
// manda la frase hecha (`label`); con un host que no la manda (el CLI, una
// versión vieja) se deduce aquí del nombre de la herramienta y su resumen.

const base = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || p || '';
const short = (s, n = 40) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s || '');

const T = {
  es: {
    diff: 'Revisando el diff', log: 'Leyendo el historial de git', status: 'Mirando el estado del repositorio',
    fetch: 'Trayendo cambios del remoto', push: 'Subiendo los cambios', commit: 'Guardando un commit',
    stage: 'Preparando cambios en git', branches: 'Trabajando con las ramas', grep: 'Buscando en el código',
    git: 'Consultando git', pr: 'Consultando el pull request', actions: 'Revisando GitHub Actions', gh: 'Consultando GitHub',
    install: 'Instalando dependencias', test: 'Ejecutando los tests', lint: 'Revisando el estilo del código',
    build: 'Compilando el proyecto', dev: 'Arrancando el servidor', script: 'Ejecutando un script',
    ls: 'Explorando los archivos', read: 'Leyendo archivos', sed: 'Editando texto', files: 'Ordenando archivos',
    curl: 'Haciendo una petición web', docker: 'Trabajando con contenedores', cmd: 'Ejecutando un comando',
    reading: (f) => `Leyendo ${f}`, writing: (f) => `Escribiendo ${f}`, editing: (f) => `Editando ${f}`,
    deleting: (f) => `Eliminando ${f}`, moving: (f) => `Moviendo ${f}`, searching: (q) => `Buscando «${q}»`,
    searchingCode: 'Buscando en el código', exploring: (f) => `Explorando ${f}`, web: 'Consultando la web',
    asking: 'Esperando tu respuesta', using: (n) => `Usando ${n}`,
    kinds: {
      cmd: ['ejecutó un comando', (n) => `ejecutó ${n} comandos`],
      edit: ['editó un archivo', (n) => `editó ${n} archivos`],
      read: ['leyó un archivo', (n) => `leyó ${n} archivos`],
      search: ['hizo una búsqueda', (n) => `hizo ${n} búsquedas`],
      web: ['consultó la web', (n) => `consultó la web ${n} veces`],
      other: ['usó una herramienta', (n) => `usó ${n} herramientas`],
    },
    and: 'y',
  },
  en: {
    diff: 'Reviewing the diff', log: 'Reading the git history', status: 'Checking the repository status',
    fetch: 'Fetching from the remote', push: 'Pushing the changes', commit: 'Creating a commit',
    stage: 'Staging changes', branches: 'Working with branches', grep: 'Searching the code',
    git: 'Running git', pr: 'Checking the pull request', actions: 'Checking GitHub Actions', gh: 'Querying GitHub',
    install: 'Installing dependencies', test: 'Running the tests', lint: 'Checking code style',
    build: 'Building the project', dev: 'Starting the server', script: 'Running a script',
    ls: 'Exploring the files', read: 'Reading files', sed: 'Editing text', files: 'Organizing files',
    curl: 'Making a web request', docker: 'Working with containers', cmd: 'Running a command',
    reading: (f) => `Reading ${f}`, writing: (f) => `Writing ${f}`, editing: (f) => `Editing ${f}`,
    deleting: (f) => `Deleting ${f}`, moving: (f) => `Moving ${f}`, searching: (q) => `Searching for “${q}”`,
    searchingCode: 'Searching the code', exploring: (f) => `Exploring ${f}`, web: 'Browsing the web',
    asking: 'Waiting for your answer', using: (n) => `Using ${n}`,
    kinds: {
      cmd: ['ran a command', (n) => `ran ${n} commands`],
      edit: ['edited a file', (n) => `edited ${n} files`],
      read: ['read a file', (n) => `read ${n} files`],
      search: ['ran a search', (n) => `ran ${n} searches`],
      web: ['browsed the web', (n) => `browsed the web ${n} times`],
      other: ['used a tool', (n) => `used ${n} tools`],
    },
    and: 'and',
  },
};

const COMMANDS = [
  [/^git\s+(?:diff|show)\b/, 'diff'], [/^git\s+(?:log|blame|shortlog)\b/, 'log'], [/^git\s+status\b/, 'status'],
  [/^git\s+(?:fetch|pull)\b/, 'fetch'], [/^git\s+push\b/, 'push'], [/^git\s+commit\b/, 'commit'],
  [/^git\s+(?:add|restore|reset|stash)\b/, 'stage'], [/^git\s+(?:checkout|switch|branch|merge|rebase|cherry-pick)\b/, 'branches'],
  [/^git\s+grep\b/, 'grep'], [/^git\b/, 'git'], [/^gh\s+pr\b/, 'pr'], [/^gh\s+(?:run|workflow)\b/, 'actions'], [/^gh\b/, 'gh'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:ci|i|install|add)\b|^(?:pip3?|uv|poetry)\s+(?:install|add|sync)\b/, 'install'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|^(?:npx\s+)?(?:vitest|jest|playwright\s+test)\b|^(?:python3?\s+-m\s+)?pytest\b|^(?:cargo|go)\s+test\b/, 'test'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|format)\b|^(?:npx\s+)?(?:eslint|oxlint|prettier|ruff|black|biome)\b/, 'lint'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|^(?:npx\s+)?(?:vite|tsc|webpack)\b|^cargo\s+(?:build|check)\b|^go\s+build\b|^make\b/, 'build'],
  [/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b/, 'dev'],
  [/^(?:npm|pnpm|yarn|bun|npx|python3?|node|deno|ruby|php)\b/, 'script'],
  [/^(?:grep|rg|ag|findstr|Select-String)\b/, 'grep'], [/^(?:ls|dir|tree|find|fd|Get-ChildItem)\b/, 'ls'],
  [/^(?:cat|head|tail|less|more|type|sed\s+-n|Get-Content|wc)\b/, 'read'], [/^(?:sed|awk|perl)\b/, 'sed'],
  [/^(?:mkdir|cp|mv|rm|touch|ln|New-Item|Remove-Item|Copy-Item|Move-Item)\b/, 'files'],
  [/^(?:curl|wget|Invoke-WebRequest)\b/, 'curl'], [/^(?:docker|docker-compose|podman)\b/, 'docker'],
];

function mainCommand(cmd) {
  let c = String(cmd || '').trim();
  for (let i = 0; i < 4; i++) {
    const m = /^(?:cd|pushd|Set-Location)\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i.exec(c);
    if (!m) break;
    c = c.slice(m[0].length);
  }
  return c.split(/\s*(?:&&|\|\||;|\|)\s*/)[0].trim();
}

const KIND_OF = {
  run_command: 'cmd', Bash: 'cmd', bash: 'cmd', shell: 'cmd',
  write_file: 'edit', edit_file: 'edit', multi_edit: 'edit', append_file: 'edit', insert_at_line: 'edit', Write: 'edit', Edit: 'edit',
  read_file: 'read', Read: 'read',
  search: 'search', search_codebase: 'search', find_files: 'search', list_files: 'search', Grep: 'search', Glob: 'search',
  fetch_url: 'web', web_search: 'web', WebFetch: 'web', WebSearch: 'web',
};

/** Frase en curso para una herramienta del transcript remoto. */
export function describeRemoteTool(item, locale = 'es') {
  if (item.label) return item.label;
  const t = T[locale] || T.es;
  const s = String(item.summary || '');
  const kind = KIND_OF[item.tool];
  if (kind === 'cmd') {
    const c = mainCommand(s);
    const hit = COMMANDS.find(([re]) => re.test(c));
    return t[hit ? hit[1] : 'cmd'];
  }
  if (kind === 'read') return t.reading(base(s));
  if (kind === 'edit') return /^write|^Write/.test(item.tool) ? t.writing(base(s)) : t.editing(base(s));
  if (item.tool === 'delete_file') return t.deleting(base(s));
  if (item.tool === 'rename_file') return t.moving(base(s.split(' → ')[0]));
  if (kind === 'search') {
    const q = /«(.+?)»/.exec(s)?.[1];
    if (q) return t.searching(short(q));
    return item.tool === 'list_files' ? t.exploring(base(s) || '.') : t.searchingCode;
  }
  if (kind === 'web') return t.web;
  if (item.tool === 'ask_user') return t.asking;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(item.tool || '');
  return t.using(mcp ? `${mcp[1]} · ${mcp[2].replace(/_/g, ' ')}` : item.tool);
}

/** «Ejecutó 3 comandos, leyó 2 archivos y editó uno». */
export function summarizeRemoteTools(items, locale = 'es') {
  const t = T[locale] || T.es;
  const counts = {};
  const files = { edit: new Set(), read: new Set() };
  for (const it of items) {
    const k = KIND_OF[it.tool] || 'other';
    if (files[k]) files[k].add(it.summary || it.key);
    else counts[k] = (counts[k] || 0) + 1;
  }
  counts.edit = files.edit.size;
  counts.read = files.read.size;
  const parts = ['cmd', 'edit', 'read', 'search', 'web', 'other']
    .filter((k) => counts[k])
    .map((k) => (counts[k] === 1 ? t.kinds[k][0] : t.kinds[k][1](counts[k])));
  if (!parts.length) return '';
  const text = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} ${t.and} ${parts.at(-1)}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
