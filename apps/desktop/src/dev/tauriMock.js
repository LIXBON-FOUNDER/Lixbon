// tauriMock.js — solo en `npm run dev` fuera de Tauri: simula la API nativa
// con un proyecto de ejemplo en memoria para poder diseñar y revisar la
// interfaz en un navegador sin compilar el backend de Rust.
const ROOT = '/demo/orbita-web';

const FILES = {
  'package.json': '{\n  "name": "orbita-web",\n  "private": true,\n  "scripts": { "dev": "vite", "test": "vitest" }\n}\n',
  'tsconfig.json': '{\n  "compilerOptions": { "strict": true, "jsx": "react-jsx" }\n}\n',
  'README.md':'# Órbita\n\nApp de finanzas personales.\n',
  'src/app/page.tsx': 'export default function Inicio() {\n  return <main>Inicio</main>;\n}\n',
  'src/app/movimientos/page.tsx': 'export default function Movimientos() {\n  return <main>Movimientos</main>;\n}\n',
  'src/app/(cuenta)/perfil/page.tsx': 'export default function Perfil() {\n  return <main>Perfil</main>;\n}\n',
  'src/app/movimientos/[id]/page.tsx': 'export default function Movimiento() {\n  return <main>Detalle</main>;\n}\n',
  'src/App.tsx':'import { AgentPanel } from "./components/agent/AgentPanel";\n\nexport default function App() {\n  return <AgentPanel activeId="main" onSend={() => {}} />;\n}\n',
  'src/components/agent/AgentPanel.tsx': [
    'import { useEffect } from "react";',
    'import { useAgent } from "@/hooks/useAgent";',
    'import { Thread } from "./Thread";',
    '',
    'interface AgentPanelProps {',
    '  activeId: string;',
    '  onSend: (text: string) => void;',
    '}',
    '',
    'export function AgentPanel({ activeId, onSend }: AgentPanelProps) {',
    '  const { messages, status, stream } = useAgent(activeId);',
    '  const isStreaming = status === "running";',
    '',
    '  // Se suscribe al stream del agente mientras el panel está montado.',
    '  useEffect(() => stream.subscribe(), [stream]);',
    '',
    '  return (',
    '    <Thread',
    '      messages={messages}',
    '      streaming={isStreaming}',
    '      onSend={onSend}',
    '    />',
    '  );',
    '}',
    '',
  ].join('\n'),
  'src/components/agent/Thread.tsx': 'export function Thread(props: any) {\n  return <div className="thread">{props.messages.length}</div>;\n}\n',
  'src/hooks/useAgent.ts': 'export function useAgent(id: string) {\n  return { messages: [], status: "idle", stream: { subscribe: () => () => {} } };\n}\n',
  'src/hooks/useSession.ts': 'import { session } from "@/lib/session";\n\nexport function useSession() {\n  return session.current();\n}\n',
  'src/lib/auth.ts': 'import { session } from "./session";\n\nexport async function signIn(creds: { email: string }) {\n  const token = await session.create(creds);\n  session.persist(token);\n  return token.user;\n}\n',
  'src/lib/session.ts': 'export const session = {\n  current: () => null,\n  create: async (c: unknown) => ({ user: c }),\n  persist: (_t: unknown) => {},\n};\n',
  'src/styles/app.css': ':root {\n  --bg: #0b0b0b;\n}\n\nbody {\n  margin: 0;\n  background: var(--bg);\n}\n',
};

const files = new Map(Object.entries(FILES).map(([rel, content]) => [`${ROOT}/${rel}`, { content, mtime: Date.now() }]));
const callbacks = new Map();
let nextId = 1;
const store = new Map([
  ['apiKey', 'lixbon_sk_demo'],
  ['serverUrl', 'https://lixbon.com'],
  ['user', { id: 1, first_name: 'Johnny', last_name: 'Morales', username: 'jmorales', email: 'jm@orbita.dev', plan_name: 'Pro' }],
]);
// ?auth abre la pantalla de entrada; ?onboarding, el recorrido inicial.
if (location.search.includes('auth')) store.delete('apiKey');
if (location.search.includes('onboarding')) localStorage.removeItem('lixbon_onboarded');

function listDir(dir) {
  const prefix = `${dir}/`;
  const seen = new Map();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const [head, ...rest] = path.slice(prefix.length).split('/');
    const full = prefix + head;
    if (!seen.has(full)) seen.set(full, { name: head, path: full, is_dir: rest.length > 0, size: 0 });
  }
  return [...seen.values()].sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name));
}

const GIT = {
  status: 'M  src/lib/auth.ts\n M src/hooks/useSession.ts\n M src/components/agent/AgentPanel.tsx\n?? src/lib/session.ts\n',
  branch: 'feat/session-api\n',
  log: ['a3f9c21', 'refactor(auth): extrae session.ts'].join('\u001f'),
};

function git(args) {
  const [cmd] = args;
  const out = (stdout) => ({ stdout, stderr: '', code: 0 });
  if (cmd === 'status') return out(GIT.status);
  if (cmd === 'branch' && args[1] === '--show-current') return out(GIT.branch);
  if (cmd === 'branch') return out('feat/session-api\t*\nmain\t \n');
  if (cmd === 'remote' && args[1] === 'get-url') return out('https://github.com/orbita/orbita-web.git\n');
  if (cmd === 'remote') return out('origin\n');
  if (cmd === 'rev-list') return out('0\t2\n');
  if (cmd === 'log') {
    const US = '\u001f';
    return out([
      ['a3f9c21aa', 'agente', '2026-09-25', 'refactor(auth): extrae session.ts'],
      ['7be0d14bb', 'Johnny', '2026-09-25', 'test(auth): cubre el refresco de token'],
      ['e21aa0ccc', 'Johnny', '2026-09-24', 'chore: actualiza dependencias'],
    ].map((r) => r.join(US)).join('\n'));
  }
  if (cmd === 'diff' && args.includes('--numstat')) {
    return out(args.includes('--cached') ? '28\t15\tsrc/lib/auth.ts\n' : '12\t5\tsrc/hooks/useSession.ts\n7\t3\tsrc/components/agent/AgentPanel.tsx\n');
  }
  if (cmd === 'diff' || cmd === 'show') {
    return out('diff --git a/src/lib/auth.ts b/src/lib/auth.ts\n--- a/src/lib/auth.ts\n+++ b/src/lib/auth.ts\n@@ -1,6 +1,7 @@\n-import { legacy } from "./legacy-session";\n+import { session } from "./session";\n export async function signIn(creds) {\n-  const s = await legacy.open(creds);\n+  const token = await session.create(creds);\n+  session.persist(token);\n');
  }
  return out('');
}

const PRS = [
  { number: 128, title: 'feat(auth): sesión por tokens', author: { login: 'jmorales' }, headRefName: 'feat/session-api', baseRefName: 'main', state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', url: 'https://github.com/orbita/orbita-web/pull/128' },
  { number: 127, title: 'fix: paginación de /orders', author: { login: 'ana' }, headRefName: 'fix/orders', baseRefName: 'main', state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', url: '' },
  { number: 125, title: 'chore: migrar a Vite 6', author: { login: 'lixbon-agent' }, headRefName: 'chore/vite6', baseRefName: 'main', state: 'OPEN', isDraft: true, reviewDecision: 'CHANGES_REQUESTED', url: '' },
];
function ghMock(command) {
  const ok = (v) => ({ stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '', code: 0, timed_out: false });
  if (command.includes('--version') || command.includes('auth status')) return ok('gh version 2.60.0');
  if (command.includes('pr list')) return ok(command.includes('closed') ? [] : PRS);
  if (command.includes('/comments')) {
    return ok([{ id: 1, path: 'src/lib/auth.ts', line: 21, body: '¿Qué pasa si el refresco falla sin red? Deberíamos reintentar con backoff.', user: { login: 'ana' }, diff_hunk: '@@ -18,9 +18,12 @@\n   const token = await session.create(creds)\n+  session.scheduleRefresh(token)', html_url: 'https://github.com' }]);
  }
  if (command.includes('pr view')) {
    const n = Number(command.match(/pr view (\d+)/)[1]);
    const base = PRS.find((p) => p.number === n) || PRS[0];
    return ok({
      ...base, body: 'Sustituye la sesión legacy por tokens con refresco automático.\ngetActiveSession desaparece; los consumidores usan useSession. Sin cambios de UI.',
      mergeable: 'MERGEABLE', additions: 47, deletions: 23, commits: [{}, {}, {}], files: [{}, {}, {}, {}, {}, {}],
      reviews: [{ author: { login: 'ana' }, state: 'COMMENTED' }], reviewRequests: [{ login: 'luis' }],
      labels: [{ name: 'auth' }, { name: 'refactor' }], closingIssuesReferences: [{ number: 231, url: '' }],
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-09-25T10:00:00Z', completedAt: '2026-09-25T10:00:48Z' },
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-09-25T10:00:00Z', completedAt: '2026-09-25T10:00:12Z' },
        { __typename: 'CheckRun', name: 'tests', status: 'IN_PROGRESS', conclusion: null },
      ],
    });
  }
  return ok('');
}

const handlers = {
  'plugin:store|load': () => 1,
  'plugin:store|get': ({ key }) => [store.get(key) ?? null, store.has(key)],
  'plugin:store|set': ({ key, value }) => { store.set(key, value); },
  'plugin:store|delete': ({ key }) => store.delete(key),
  'plugin:store|save': () => null,
  'plugin:store|has': ({ key }) => store.has(key),
  'plugin:event|listen': ({ handler }) => handler,
  'plugin:event|unlisten': () => null,
  'plugin:window|is_maximized': () => false,
  'plugin:dialog|open': () => ROOT,
  secret_get: () => store.get('apiKey'),
  secret_set: ({ value }) => { store.set('apiKey', value); },
  secret_delete: () => { store.delete('apiKey'); },
  get_app_version: () => '2.0.0-dev',
  get_workspace_root: () => ROOT,
  set_workspace_root: ({ path }) => path,
  read_dir: ({ path }) => listDir(path),
  read_file_content: ({ path }) => {
    const f = files.get(path);
    if (!f) throw new Error(`No existe: ${path}`);
    return f.content;
  },
  stat_file: ({ path }) => files.get(path)?.mtime ?? 0,
  write_file_content: ({ path, content, expectedMtime }) => {
    const f = files.get(path);
    if (f && expectedMtime && f.mtime !== expectedMtime) throw new Error(`CONFLICT:${f.mtime}`);
    const mtime = Date.now();
    files.set(path, { content, mtime });
    return mtime;
  },
  list_files: () => [...files.keys()].map((path) => ({ name: path.split('/').pop(), path, rel: path.slice(ROOT.length + 1) })),
  search_in_files: ({ query, caseSensitive }) => {
    const hits = [];
    const q = caseSensitive ? query : query.toLowerCase();
    for (const [path, f] of files) {
      f.content.split('\n').forEach((text, i) => {
        if ((caseSensitive ? text : text.toLowerCase()).includes(q)) hits.push({ path, name: path.split('/').pop(), line: i + 1, text });
      });
    }
    return hits;
  },
  replace_in_files: () => ({ files: 0, replacements: 0 }),
  git_run: ({ args }) => git(args),
  term_open: () => `t${nextId++}`,
  term_write: () => null,
  term_resize: () => null,
  term_close: () => null,
  run_command: ({ command }) => (command.startsWith('gh ') ? ghMock(command) : command.includes('tsc')
    ? {
      stdout: "src/components/agent/AgentPanel.tsx(21,11): error TS2339: Property 'stream' does not exist on type 'AgentState'.\nsrc/lib/session.ts(3,11): warning TS6133: 'c' is declared but its value is never read.\n",
      stderr: '', code: 2, timed_out: false,
    }
    : { stdout: '', stderr: '', code: 0, timed_out: false }),
};

window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
  transformCallback(cb, once) {
    const id = nextId++;
    callbacks.set(id, (payload) => { if (once) callbacks.delete(id); cb?.(payload); });
    return id;
  },
  unregisterCallback: (id) => callbacks.delete(id),
  convertFileSrc: (p) => p,
  async invoke(cmd, args = {}) {
    const h = handlers[cmd];
    if (h) return h(args);
    if (cmd.startsWith('plugin:window|') || cmd.startsWith('plugin:webview|')) return null;
    console.info('[tauriMock] sin simular:', cmd, args);
    return null;
  },
};
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
if (location.search.includes('onboarding')) localStorage.removeItem('lixbon_workspace_root');
else localStorage.setItem('lixbon_workspace_root', ROOT);

const day = (i) => new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
const keys = [
  { id: 1, name: 'lixbon desktop', masked_key: 'lixbon_sk_…a91f', created_at: day(40), last_accessed: new Date(Date.now() - 600000).toISOString(), is_active: true },
  { id: 2, name: 'CI', masked_key: 'lixbon_sk_…07bc', created_at: day(12), last_accessed: null, is_active: true },
];
const GATEWAY = {
  'GET /api/account/usage': () => ({
    plan: { name: 'Pro' },
    buckets: {
      session: { percent: 42, messages: 38, reset_at: new Date(Date.now() + 2.4 * 3600000).toISOString() },
      week: { percent: 67, messages: 412, reset_at: new Date(Date.now() + 3 * 86400000).toISOString() },
    },
    daily: Array.from({ length: 30 }, (_, i) => [
      { usage_date: day(i), model: 'lixbon-coder', total_tokens: Math.round(40000 + Math.abs(Math.sin(i)) * 180000) },
      { usage_date: day(i), model: 'lixbon-fast', total_tokens: Math.round(Math.abs(Math.cos(i)) * 60000) },
    ]).flat(),
  }),
  'GET /api/keys': () => ({ keys }),
  'GET /api/conversations': () => ({
    conversations: [
      { id: 11, title: 'Refactor auth', updated_at: new Date(Date.now() - 20 * 60000).toISOString() },
      { id: 12, title: 'Tests E2E del checkout', updated_at: new Date(Date.now() - 3 * 3600000).toISOString() },
      { id: 13, title: 'Paginación en /orders', updated_at: new Date(Date.now() - 26 * 3600000).toISOString() },
      { id: 14, title: 'Generar LIXBON.md', updated_at: new Date(Date.now() - 30 * 3600000).toISOString() },
      { id: 15, title: 'Migrar a Vite 6', updated_at: new Date(Date.now() - 4 * 86400000).toISOString() },
    ],
  }),
  'GET /api/model-roles': () => ({
    roles: { chat: { model: 'lixbon-coder' }, fim: { model: 'lixbon-fast' }, vision: { model: 'lixbon-vision' }, embed: { model: 'nomic-embed' } },
    models: [
      { id: 'lixbon-coder', capabilities: ['completion', 'tools'] },
      { id: 'lixbon-fast', capabilities: ['completion'] },
      { id: 'lixbon-vision', capabilities: ['completion', 'vision'] },
      { id: 'nomic-embed', capabilities: ['embedding'] },
    ],
  }),
  'POST /api/keys': (body) => {
    keys.unshift({ id: nextId++, name: body.name, masked_key: 'lixbon_sk_…new0', created_at: new Date().toISOString(), last_accessed: null, is_active: true });
    return { api_key: `lixbon_sk_${Math.random().toString(36).slice(2)}` };
  },
  'PATCH /api/account/profile': (body) => ({ user: { ...store.get('user'), ...body } }),
};
const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  const method = (init.method || 'GET').toUpperCase();
  const del = method === 'DELETE' && url.pathname.match(/^\/api\/keys\/(\d+)$/);
  if (del) {
    const k = keys.findIndex((x) => x.id === Number(del[1]));
    if (k >= 0) keys.splice(k, 1);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }
  if (method === 'POST' && url.pathname === '/v1/chat/completions') return mockCompletion(JSON.parse(init.body));
  const h = GATEWAY[`${method} ${url.pathname}`];
  if (!h) return realFetch(input, init);
  const body = init.body ? JSON.parse(init.body) : {};
  return new Response(JSON.stringify(h(body)), { headers: { 'content-type': 'application/json' } });
};

// Respuesta simulada del modelo: para la edición en línea devuelve el
// fragmento con un comentario encima; para el chat, un saludo.
function mockCompletion(body) {
  const last = body.messages.at(-1)?.content || '';
  const frag = last.match(/<<<[^\n]*\n([\s\S]*?)\nFRAGMENTO>>>/);
  const fence = '```';
  const text = frag ? `${fence}\n// editado por el mock\n${frag[1]}\n${fence}` : 'Hola, soy el modelo simulado del modo dev.';
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      for (const part of text.match(/[\s\S]{1,12}/g)) {
        ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`));
        await new Promise((r) => setTimeout(r, last.includes('lento') ? 700 : 30));
      }
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

