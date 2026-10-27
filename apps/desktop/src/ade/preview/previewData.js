// previewData.js — datos SIMULADOS de la vista previa del ADE. Nada aquí lee ni escribe el Core real.
// Vocabulario del producto (docs/VOCABULARIO.md): Project, Task y Attention en inglés; «Intento» para
// Attempt en la interfaz; perfiles de autonomía de orch/policy. Los ids internos siguen en inglés.

export const CURRENT_HOST = 'desktop';

export const HOSTS = [
  { id: 'desktop', name: 'Desktop-PC', short: 'PC', os: 'Windows 11', transport: 'local', status: 'online', note: 'Este equipo' },
  { id: 'macbook', name: 'MacBook', short: 'Mac', os: 'macOS 15', transport: 'emparejado', status: 'online', note: 'Emparejado · LAN' },
  { id: 'vps', name: 'VPS-01', short: 'VPS', os: 'Ubuntu 24.04', transport: 'ssh', status: 'online', note: 'SSH · fra1' },
  { id: 'laptop', name: 'Portátil', short: 'Portátil', os: 'Linux', transport: 'emparejado', status: 'offline', note: 'Visto por última vez hace 2 d' },
];

// Proveedores del registro del producto (AGENT_LABELS). `steer`: si puede corregir un turno en marcha.
export const PROVIDERS = {
  claude: { id: 'claude', models: ['sonnet', 'opus'], steer: true },
  codex: { id: 'codex', models: ['gpt-6.1-sol', 'gpt-6.1-mini'], steer: true },
  gemini: { id: 'gemini', models: ['gemini-3-pro'], steer: true },
  opencode: { id: 'opencode', models: ['qwen-coder-32b'], steer: false },
};

// Perfiles de autonomía del producto (orch/policy/resolvePolicy.js).
export const POLICIES = {
  explorar: 'Explorar',
  proponer: 'Proponer',
  delegar_con_revision: 'Delegar con revisión',
};

export const PROJECTS = [
  { id: 'lixbon', name: 'Lixbon', branch: 'main' },
  { id: 'zajuna', name: 'Zajuna', branch: 'main' },
  { id: 'sgi', name: 'SGI', branch: 'develop' },
  { id: 'tourism', name: 'Turismo', branch: 'main' },
];

export const TASKS = [
  {
    id: 't_runtime', projectId: 'lixbon', title: 'Runtime de agentes',
    objective: 'Ejecutar agentes como Intentos detrás de un solo Core: ciclo de vida, sesiones, eventos y un worktree por Intento.',
    criteria: ['El ciclo de vida del Intento emite eventos durables', 'Pruebas de integración en verde en Windows y Linux', 'Ningún estado propio del proveedor en el Core'],
    constraints: ['Mantener SQLite (sin Redis)', 'No cambiar el contrato público del CLI'],
    decisions: ['ProviderSession es una caché, no la identidad', 'Los worktrees viven fuera del repo'],
    run: 'Runtime multicliente', branchBase: 'feat/agent-runtime',
  },
  {
    id: 't_oauth', projectId: 'lixbon', title: 'Renovación OAuth',
    objective: 'Renovar la autenticación con rotación de tokens y una capa de compatibilidad para las sesiones existentes.',
    criteria: ['Renovar rota el token e invalida el anterior', 'Las sesiones existentes siguen funcionando', 'Pruebas unitarias y de integración'],
    constraints: ['Sin estado global nuevo', 'Los tokens nunca se registran en logs'],
    decisions: ['Comparar dos enfoques antes de elegir'],
    branchBase: 'feature/auth-refresh',
  },
  { id: 't_mobile', projectId: 'lixbon', title: 'Control remoto móvil', objective: 'Emparejar el móvil y controlar Intentos que siguen corriendo en el host.', criteria: ['Emparejamiento', 'Avisos de Attention', 'Aprobar o denegar con alcance'], constraints: [], decisions: [], run: 'Runtime multicliente', branchBase: 'feat/mobile-remote' },
  { id: 't_cli', projectId: 'lixbon', title: 'Integración del CLI', objective: 'lxo como cliente de primera clase del Core.', criteria: ['lxo status, tasks, agents y attention', 'lxo review'], constraints: [], decisions: [], run: 'Runtime multicliente', branchBase: 'feat/cli-integration' },
  { id: 't_sidebar', projectId: 'lixbon', title: 'Rediseño del navegador', objective: 'Navegación Project → Task → Intento con orden estable.', criteria: [], constraints: [], decisions: [], branchBase: 'feat/sidebar-redesign' },
  { id: 't_telemetry', projectId: 'lixbon', title: 'Limpieza de telemetría', objective: 'Quitar contadores muertos y unificar nombres de eventos.', criteria: [], constraints: [], decisions: [], branchBase: 'chore/telemetry-cleanup' },
  { id: 't_pack', projectId: 'zajuna', title: 'Paquetes para Linux', objective: 'Publicar builds de Linux: .deb y AppImage con actualización automática.', criteria: ['Se instala en Ubuntu 22.04 y 24.04', 'El actualizador funciona'], constraints: [], decisions: [], branchBase: 'feat/linux-packaging' },
  { id: 't_chromium', projectId: 'zajuna', title: 'Worker de Chromium', objective: 'Fijar y aislar el Chromium sin interfaz que usa el worker de render.', criteria: [], constraints: ['Ningún binario sin verificar'], decisions: [], branchBase: 'fix/chromium-worker' },
  { id: 't_inventory', projectId: 'sgi', title: 'Refactor de inventario', objective: 'Separar el servicio de inventario y quitar consultas de stock duplicadas.', criteria: ['Misma API', 'Sin regresiones en consultas'], constraints: [], decisions: [], branchBase: 'refactor/inventory' },
  { id: 't_migration', projectId: 'sgi', title: 'Script de migración', objective: 'Migración idempotente de las tablas de stock heredadas.', criteria: [], constraints: [], decisions: [], branchBase: 'feat/migration-script' },
  { id: 't_schema', projectId: 'sgi', title: 'Revisión del esquema', objective: 'Análisis de solo lectura del esquema y de los riesgos de migración.', criteria: [], constraints: ['Solo lectura'], decisions: [], branchBase: 'plan/schema-review' },
  { id: 't_map', projectId: 'tourism', title: 'Agrupación en el mapa', objective: 'Agrupar puntos de interés en el mapa con más de 5.000 marcadores.', criteria: [], constraints: [], decisions: [], branchBase: 'feat/map-clustering' },
  { id: 't_sync', projectId: 'tourism', title: 'Sincronización sin conexión', objective: 'Sincronizar sin conexión los itinerarios guardados.', criteria: [], constraints: [], decisions: [], branchBase: 'feat/offline-sync' },
];

const wt = (project, id) => `%LOCALAPPDATA%\\Lixbon\\worktrees\\${project}\\${id}`;

// state: queued | starting | working | waiting | review_ready | failed | completed | paused | offline
// phase (solo working): thinking | tool | writing        cause (solo waiting): approval | answer | dependency | host | rate_limit
const A = (o) => ({ control: 'agent', origin: 'ADE', unread: false, policy: 'delegar_con_revision', files: 0, add: 0, del: 0, tests: null, cost: 0, tokens: 0, minutes: 0, latest: '', ...o });

export const ATTEMPTS = [
  A({ id: 'att_rt_a', taskId: 't_runtime', label: 'A', provider: 'claude', model: 'sonnet', effort: 'high', branch: 'feat/agent-runtime', worktree: wt('lixbon', 'att_rt_a'), host: 'desktop', state: 'working', phase: 'tool', minutes: 18, files: 9, add: 521, del: 90, tests: { pass: 141, total: 141 }, cost: 1.42, tokens: 880000, latest: 'Ejecutando las pruebas de integración', toolLabel: 'npm run test:integration', unread: true, ctx: 'v3' }),
  A({ id: 'att_rt_b', taskId: 't_runtime', label: 'B', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', branch: 'feat/agent-runtime-codex', worktree: wt('lixbon', 'att_rt_b'), host: 'desktop', state: 'review_ready', minutes: 26, files: 12, add: 640, del: 120, tests: { pass: 138, total: 141 }, cost: 0.96, tokens: 620000, latest: 'Terminado · 3 pruebas fallan con rutas de Windows', ctx: 'v3' }),
  A({ id: 'att_oa_a', taskId: 't_oauth', label: 'A', provider: 'claude', model: 'sonnet', effort: 'high', branch: 'feature/auth-refresh-claude', worktree: wt('lixbon', 'att_oa_a'), host: 'desktop', state: 'working', phase: 'thinking', minutes: 9, files: 9, add: 521, del: 90, tests: { pass: 141, total: 141 }, cost: 0.74, tokens: 410000, latest: 'Comparando rotación con caducidad deslizante', ctx: 'v2' }),
  A({ id: 'att_oa_b', taskId: 't_oauth', label: 'B', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', branch: 'feature/auth-refresh-codex', worktree: wt('lixbon', 'att_oa_b'), host: 'desktop', state: 'review_ready', minutes: 6, files: 12, add: 843, del: 215, tests: { pass: 141, total: 141 }, cost: 0.51, tokens: 380000, latest: 'Terminado · Proof Pack listo', unread: true, ctx: 'v2' }),
  A({ id: 'att_mr_a', taskId: 't_mobile', label: 'A', provider: 'gemini', model: 'gemini-3-pro', effort: 'medium', branch: 'feat/mobile-remote', worktree: wt('lixbon', 'att_mr_a'), host: 'macbook', state: 'waiting', cause: 'approval', minutes: 31, files: 6, add: 230, del: 12, tests: { pass: 42, total: 42 }, cost: 0.62, tokens: 300000, latest: 'Quiere ejecutar npm run lint', ctx: 'v1' }),
  A({ id: 'att_cli_a', taskId: 't_cli', label: 'A', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', branch: 'feat/cli-integration', worktree: wt('lixbon', 'att_cli_a'), host: 'desktop', state: 'completed', minutes: 44, files: 7, add: 310, del: 48, tests: { pass: 64, total: 64 }, cost: 0.88, tokens: 520000, latest: 'Integración bloqueada por conflictos', origin: 'CLI', ctx: 'v2' }),
  A({ id: 'att_sb_a', taskId: 't_sidebar', label: 'A', provider: 'opencode', model: 'qwen-coder-32b', effort: null, branch: 'feat/sidebar-redesign', worktree: wt('lixbon', 'att_sb_a'), host: 'desktop', state: 'paused', minutes: 52, files: 4, add: 118, del: 30, tests: null, cost: 0, tokens: 190000, latest: 'Pausado por ti en un punto seguro', ctx: 'v1' }),
  A({ id: 'att_tc_a', taskId: 't_telemetry', label: 'A', provider: 'opencode', model: 'qwen-coder-32b', effort: null, branch: 'chore/telemetry-cleanup', worktree: wt('lixbon', 'att_tc_a'), host: 'desktop', state: 'queued', minutes: 0, latest: 'Esperando un hueco local libre', ctx: 'v1' }),
  A({ id: 'att_pk_a', taskId: 't_pack', label: 'A', provider: 'gemini', model: 'gemini-3-pro', effort: 'high', branch: 'feat/linux-packaging', worktree: wt('zajuna', 'att_pk_a'), host: 'vps', state: 'waiting', cause: 'answer', minutes: 22, files: 5, add: 180, del: 4, tests: { pass: 12, total: 12 }, cost: 0.41, tokens: 260000, latest: 'Hizo una pregunta que lo bloquea', origin: 'Móvil', ctx: 'v1' }),
  A({ id: 'att_ch_a', taskId: 't_chromium', label: 'A', provider: 'claude', model: 'sonnet', effort: 'medium', branch: 'fix/chromium-worker', worktree: wt('zajuna', 'att_ch_a'), host: 'vps', state: 'waiting', cause: 'approval', minutes: 14, files: 2, add: 40, del: 9, tests: null, cost: 0.33, tokens: 210000, latest: 'Necesita red para descargar un binario', ctx: 'v1' }),
  A({ id: 'att_inv_a', taskId: 't_inventory', label: 'A', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', branch: 'refactor/inventory', worktree: wt('sgi', 'att_inv_a'), host: 'macbook', state: 'review_ready', minutes: 38, files: 14, add: 702, del: 540, tests: { pass: 88, total: 88 }, cost: 1.12, tokens: 700000, latest: 'Terminado · 14 archivos, consultas sin duplicar', unread: true, ctx: 'v2' }),
  A({ id: 'att_mig_a', taskId: 't_migration', label: 'A', provider: 'claude', model: 'sonnet', effort: 'high', branch: 'feat/migration-script', worktree: wt('sgi', 'att_mig_a'), host: 'macbook', state: 'failed', minutes: 27, files: 3, add: 96, del: 11, tests: { pass: 20, total: 24 }, cost: 0.58, tokens: 340000, latest: '4 pruebas fallan tras 2 reintentos', ctx: 'v1' }),
  A({ id: 'att_sch_a', taskId: 't_schema', label: 'A', provider: 'codex', model: 'gpt-6.1-sol', effort: 'medium', branch: null, worktree: null, readonly: true, host: 'desktop', state: 'waiting', cause: 'approval', minutes: 5, latest: 'Quiere leer ../legacy-docs/schema.md', policy: 'explorar', ctx: 'v1' }),
  A({ id: 'att_map_a', taskId: 't_map', label: 'A', provider: 'opencode', model: 'qwen-coder-32b', effort: null, branch: 'feat/map-clustering', worktree: wt('tourism', 'att_map_a'), host: 'laptop', state: 'offline', minutes: 63, files: 5, add: 150, del: 20, cost: 0, tokens: 120000, latest: 'Host desconectado hace 2 d', ctx: 'v1' }),
  A({ id: 'att_sync_a', taskId: 't_sync', label: 'A', provider: 'claude', model: 'sonnet', effort: 'medium', branch: 'feat/offline-sync', worktree: wt('tourism', 'att_sync_a'), host: 'desktop', state: 'working', phase: 'writing', minutes: 12, files: 4, add: 133, del: 8, tests: { pass: 30, total: 30 }, cost: 0.29, tokens: 150000, latest: 'Editando sync/queue.ts', ctx: 'v1' }),
];

// risk: low | medium | high | none ; kind: permission | question | review | failed | conflict | host
// `before`: lo que hizo el agente justo antes de pedirlo. `similar`: decisiones tuyas parecidas en este Project.
// `touches`: qué alcanza la orden si se permite. Así se decide sin saltar a otra pantalla.
export const ATTENTION = [
  {
    id: 'at_net_ch', kind: 'permission', attemptId: 'att_ch_a', risk: 'high', ago: 'hace 3 min', title: 'Red y un binario sin verificar',
    command: 'curl -sL https://dl.example-cdn.io/chromium-114.tar.gz | tar xz', riskLabel: 'Red · ejecuta un binario descargado',
    reason: 'Descargar una build de Chromium para fijar el worker de render', scope: 'Solo esta orden, una vez',
    touches: ['Red: dl.example-cdn.io (dominio no visto antes)', 'Escribe en el worktree: vendor/chromium/', 'Ejecuta código descargado'],
    before: ['Leyó docs/render-worker.md', 'Buscó «chromium» en package.json sin resultados', 'Propuso fijar la versión 114'],
    similar: [{ text: 'Denegaste una descarga con curl | tar en este Project', ago: 'hace 6 d', verdict: 'deny' }],
  },
  {
    id: 'at_q_pk', kind: 'question', attemptId: 'att_pk_a', risk: 'none', ago: 'hace 9 min', title: '¿Qué formatos debe publicar la build de Linux?',
    question: '¿Empaquetar como .deb y AppImage, o solo AppImage? El .deb necesita un script postinst y una clave de firma.', options: ['.deb + AppImage', 'Solo AppImage'],
    before: ['Generó los scripts de build', 'Probó AppImage en Ubuntu 24.04 (ok)', 'No encontró clave de firma en el VPS'],
  },
  { id: 'at_rev_oa', kind: 'review', attemptId: 'att_oa_b', risk: 'medium', ago: 'hace 6 min', title: 'Listo para revisar · Renovación OAuth · Intento B', summary: '12 archivos · +843 / −215 · pruebas 141/141 · 1 aviso' },
  { id: 'at_rev_inv', kind: 'review', attemptId: 'att_inv_a', risk: 'low', ago: 'hace 21 min', title: 'Listo para revisar · Refactor de inventario', summary: '14 archivos · +702 / −540 · pruebas 88/88' },
  { id: 'at_fail_mig', kind: 'failed', attemptId: 'att_mig_a', risk: 'none', ago: 'hace 12 min', title: 'El Intento se detuvo tras fallar pruebas', summary: '4 de 24 pruebas fallan tras 2 reintentos · hay un checkpoint disponible' },
  { id: 'at_conf_cli', kind: 'conflict', attemptId: 'att_cli_a', risk: 'none', ago: 'hace 40 min', title: 'Integración bloqueada', summary: '3 conflictos al integrar en main (src/cli/mod.rs, src/cli/args.rs, Cargo.lock)' },
  { id: 'at_host_map', kind: 'host', attemptId: 'att_map_a', risk: 'none', ago: 'hace 2 d', title: 'El portátil está desconectado', summary: 'Agrupación en el mapa está en pausa. Sigue cuando el host vuelva.' },
  {
    id: 'at_low_mr', kind: 'permission', attemptId: 'att_mr_a', risk: 'low', ago: 'hace 2 min', title: 'Ejecutar lint',
    command: 'npm run lint', riskLabel: 'No está en la lista permitida de esta Task', reason: 'Validar antes de hacer commit', scope: 'Solo esta orden, una vez',
    touches: ['Solo lectura del worktree', 'Sin red'],
    before: ['Editó 3 archivos de src/remote/', 'Pruebas unitarias 42/42'],
    similar: [{ text: 'Permitiste npm run lint 3 veces en Lixbon', ago: 'esta semana', verdict: 'allow' }],
  },
  {
    id: 'at_low_sch', kind: 'permission', attemptId: 'att_sch_a', risk: 'low', ago: 'hace 1 min', title: 'Leer fuera del alcance de la Task',
    command: 'read ../legacy-docs/schema.md', riskLabel: 'Solo lectura · fuera del Project', reason: 'Necesita las notas del esquema heredado', scope: 'Solo este archivo, una vez',
    touches: ['Lee 1 archivo fuera del Project', 'Sin escritura ni red'],
    before: ['Listó las migraciones existentes', 'Encontró una referencia a legacy-docs/schema.md'],
  },
];

// Línea de tiempo: kind user|agent|tools|edits|check|system|checkpoint
export const TIMELINES = {
  att_rt_a: [
    { id: 'e1', kind: 'user', time: '14:12', from: 'ADE', text: 'Implementa el ciclo de vida del Intento en el Core. Mantén SQLite, sin Redis. Emite eventos durables en cada transición.' },
    { id: 'e2', kind: 'agent', time: '14:13', text: 'Plan: (1) máquina de estados del Intento, (2) sobre de eventos, (3) frontera del adaptador ProviderSession, (4) gestor de worktrees. Empiezo por la máquina de estados.' },
    { id: 'e3', kind: 'edits', time: '14:17', files: [{ path: 'src/runtime/attempt.ts', add: 188, del: 0 }, { path: 'src/runtime/events.ts', add: 96, del: 0 }, { path: 'src/runtime/session.ts', add: 142, del: 31 }] },
    { id: 'e4', kind: 'tools', time: '14:19', title: 'Ejecutó 4 órdenes', items: [{ cmd: 'npm run typecheck', ok: true, ms: 4200 }, { cmd: 'npm run lint', ok: true, ms: 2100 }, { cmd: 'npm test -- runtime', ok: true, ms: 8800 }, { cmd: 'git commit -m "attempt: state machine"', ok: true, ms: 180 }] },
    { id: 'e5', kind: 'checkpoint', time: '14:19', text: 'Checkpoint · attempt: state machine · 4 archivos' },
    { id: 'e6', kind: 'agent', time: '14:24', text: 'La máquina de estados y los eventos están. Ahora conecto el gestor de worktrees; las rutas se resuelven por ProjectLocation, nunca por una identidad absoluta.' },
    { id: 'e7', kind: 'edits', time: '14:27', files: [{ path: 'src/runtime/worktree.ts', add: 134, del: 12 }, { path: 'src/runtime/location.ts', add: 61, del: 4 }] },
    { id: 'e8', kind: 'check', time: '14:29', name: 'Pruebas unitarias', status: 'pass', detail: '141 / 141' },
    { id: 'e9', kind: 'tools', time: '14:30', title: 'Ejecutando', items: [{ cmd: 'npm run test:integration', ok: null, ms: 0 }] },
  ],
  att_oa_a: [
    { id: 'e1', kind: 'user', time: '14:21', from: 'ADE', text: 'Implementa la renovación de la autenticación. Compara con el Intento B antes de elegir.' },
    { id: 'e2', kind: 'agent', time: '14:24', text: 'Leyendo src/auth/*. Dos opciones: rotar el token en cada uso o caducidad deslizante. Rotar es más seguro; estoy valorando la compatibilidad con sesiones vivas.' },
    { id: 'e3', kind: 'edits', time: '14:27', files: [{ path: 'src/auth/token.ts', add: 120, del: 40 }, { path: 'src/auth/refresh.ts', add: 164, del: 0 }] },
  ],
  att_oa_b: [
    { id: 'e1', kind: 'user', time: '14:21', from: 'ADE', text: 'Implementa la renovación de la autenticación. Mismo ContextPackage que el Intento A.' },
    { id: 'e2', kind: 'agent', time: '14:26', text: 'Rotación del token más una capa de compatibilidad para las sesiones creadas antes de rotar. Una dependencia nueva (jose).' },
    { id: 'e3', kind: 'tools', time: '14:31', title: 'Ejecutó 6 órdenes', items: [{ cmd: 'npm run typecheck', ok: true, ms: 4100 }, { cmd: 'npm run lint', ok: true, ms: 2000 }, { cmd: 'npm test', ok: true, ms: 9100 }, { cmd: 'npm run test:integration', ok: true, ms: 21000 }, { cmd: 'npm run build', ok: true, ms: 45000 }, { cmd: 'git commit', ok: true, ms: 120 }] },
    { id: 'e4', kind: 'agent', time: '14:32', text: 'Terminado. Proof Pack adjunto. No se ejecutó el e2e de login contra un proveedor real.' },
  ],
  att_mr_a: [
    { id: 'e1', kind: 'user', time: '14:02', from: 'ADE', text: 'Emparejamiento y aprobar o denegar con alcance desde el móvil. El host sigue siendo el dueño de la ejecución.' },
    { id: 'e2', kind: 'agent', time: '14:09', text: 'Plan: (1) saludo de emparejamiento por la LAN, (2) aviso de Attention, (3) aprobar o denegar con alcance. Empiezo por el emparejamiento.' },
    { id: 'e3', kind: 'edits', time: '14:16', files: [{ path: 'src/remote/pairing.ts', add: 118, del: 0 }, { path: 'src/remote/attention-push.ts', add: 74, del: 6 }, { path: 'src/remote/scope.ts', add: 38, del: 6 }] },
    { id: 'e4', kind: 'check', time: '14:24', name: 'Pruebas unitarias', status: 'pass', detail: '42 / 42' },
    { id: 'e5', kind: 'agent', time: '14:31', text: 'Listo para validar antes del commit. Quiero ejecutar npm run lint, que no está en la lista permitida de esta Task, así que espero tu decisión.' },
  ],
  att_pk_a: [
    { id: 'e1', kind: 'user', time: '14:00', from: 'Móvil', text: 'Empaqueta la build de Linux. Que funcionen las actualizaciones.' },
    { id: 'e2', kind: 'agent', time: '14:21', text: 'Scripts de build listos. Bloqueado por una decisión de producto: el .deb necesita postinst y una clave de firma.' },
  ],
};

export const PROOF_PACKS = {
  att_oa_b: {
    revision: 'a91f3c2', objective: 'Implementar la renovación OAuth', approach: 'Rotación del token más una capa de compatibilidad para las sesiones creadas antes de rotar.',
    files: 12, add: 843, del: 215,
    validation: [
      { name: 'Pruebas unitarias', result: '141 / 141', status: 'pass', src: 'auto', ms: '9,1 s' },
      { name: 'Pruebas de integración', result: '23 / 23', status: 'pass', src: 'auto', ms: '21 s' },
      { name: 'Lint', result: 'limpio', status: 'pass', src: 'auto', ms: '2,0 s' },
      { name: 'Typecheck', result: 'limpio', status: 'pass', src: 'auto', ms: '4,1 s' },
      { name: 'Build', result: 'ok', status: 'pass', src: 'auto', ms: '45 s' },
      { name: 'e2e de login (proveedor real)', result: 'sin ejecutar', status: 'skipped', src: 'agent', ms: '—' },
    ],
    failed: ['El typecheck falló en la primera pasada (tipo de retorno de token.ts); se corrigió en el turno 7.'],
    unverified: ['El e2e contra un proveedor OAuth real necesita credenciales que el Intento no tiene.', 'No se probó el comportamiento con desfase de reloj > 30 s.'],
    risks: [{ level: 'high', text: 'Toca el almacén de tokens y la ruta de autenticación (sensible).' }, { level: 'medium', text: 'Nueva llamada de red al renovar.' }, { level: 'low', text: 'Cambió la firma pública de refreshToken().' }],
    deps: [{ name: 'jose', change: '+5.2.0', kind: 'added' }],
    security: [{ name: 'Escaneo de secretos', status: 'pass', detail: 'no se añadieron secretos' }, { name: 'Dependencia de red nueva', status: 'warn', detail: 'POST /oauth/token' }, { name: 'Ruta de autenticación modificada', status: 'warn', detail: 'src/auth/*' }],
    screenshots: ['Login · aviso de renovación', 'Banner de sesión caducada', 'Ajustes · Sesiones'],
    questions: ['¿Guardar los tokens en el llavero del sistema o en SQLite? (El Intento eligió el llavero.)'],
    review: ['src/auth/token.ts', 'src/auth/store.ts', 'src/api/session.ts'],
  },
  att_rt_a: {
    revision: 'e5a02f7', objective: 'Runtime de agentes: ciclo de vida del Intento en el Core', approach: 'Máquina de estados con eventos, gestor de worktrees por ProjectLocation y almacén local de eventos con better-sqlite3.',
    files: 11, add: 612, del: 96,
    validation: [
      { name: 'Pruebas unitarias', result: '150 / 150', status: 'pass', src: 'auto', ms: '9,8 s' },
      { name: 'Pruebas de integración', result: '34 / 34', status: 'pass', src: 'auto', ms: '27 s' },
      { name: 'Lint', result: 'limpio', status: 'pass', src: 'auto', ms: '2,1 s' },
      { name: 'Typecheck', result: 'limpio', status: 'pass', src: 'auto', ms: '4,3 s' },
      { name: 'Build', result: 'ok', status: 'pass', src: 'auto', ms: '43 s' },
      { name: 'Rutas de Linux', result: 'sin ejecutar', status: 'skipped', src: 'agent', ms: '—' },
    ],
    failed: [], unverified: ['Comportamiento con rutas de Linux (el host es Windows).'],
    risks: [{ level: 'medium', text: 'Dependencia nativa nueva (better-sqlite3), instalada con tu permiso.' }],
    deps: [{ name: 'better-sqlite3', change: '+11.3.0', kind: 'added' }],
    security: [{ name: 'Escaneo de secretos', status: 'pass', detail: 'no se añadieron secretos' }, { name: 'Dependencia aprobada', status: 'pass', detail: 'permitida una vez desde el móvil' }],
    screenshots: [], questions: [], review: ['src/runtime/session.ts', 'src/runtime/worktree.ts'],
  },
  att_rt_b: {
    revision: 'c77d0be', objective: 'Ciclo de vida del agente en el Core', approach: 'Intento con eventos y un adaptador de proveedor delgado.',
    files: 12, add: 640, del: 120,
    validation: [
      { name: 'Pruebas unitarias', result: '138 / 141', status: 'fail', src: 'auto', ms: '9,4 s' },
      { name: 'Lint', result: 'limpio', status: 'pass', src: 'auto', ms: '2,2 s' },
      { name: 'Typecheck', result: 'limpio', status: 'pass', src: 'auto', ms: '4,0 s' },
      { name: 'Build', result: 'ok', status: 'pass', src: 'auto', ms: '41 s' },
    ],
    failed: ['3 pruebas fallan con el separador de rutas de Windows (worktree.test.ts).'],
    unverified: ['No se probaron rutas de Linux en este host.'],
    risks: [{ level: 'medium', text: 'Separador de rutas escrito a mano en el gestor de worktrees.' }],
    deps: [], security: [{ name: 'Escaneo de secretos', status: 'pass', detail: 'no se añadieron secretos' }], screenshots: [],
    questions: [], review: ['src/runtime/worktree.ts'],
  },
  att_inv_a: {
    revision: '5be21d9', objective: 'Separar el servicio de inventario', approach: 'Extraer StockRepository y quitar 6 consultas duplicadas.',
    files: 14, add: 702, del: 540,
    validation: [
      { name: 'Pruebas unitarias', result: '88 / 88', status: 'pass', src: 'auto', ms: '7,2 s' },
      { name: 'Lint', result: 'limpio', status: 'pass', src: 'auto', ms: '1,9 s' },
      { name: 'Typecheck', result: 'limpio', status: 'pass', src: 'auto', ms: '3,8 s' },
      { name: 'Diff de planes de consulta', result: '0 regresiones', status: 'pass', src: 'agent', ms: '—' },
    ],
    failed: [], unverified: ['Comportamiento con un volumen de datos como el de producción.'],
    risks: [{ level: 'low', text: 'Movimiento mecánico grande; el comportamiento debería ser idéntico.' }],
    deps: [], security: [{ name: 'Escaneo de secretos', status: 'pass', detail: 'no se añadieron secretos' }], screenshots: [],
    questions: [], review: ['src/inventory/stock.repo.ts'],
  },
};

// Archivos de la revisión de OAuth (Intento B). risk: high|medium|low ; since: cambió desde la revisión anterior.
export const REVIEW_FILES = {
  att_oa_b: [
    { path: 'src/auth/token.ts', add: 164, del: 58, risk: 'high', since: true },
    { path: 'src/auth/store.ts', add: 92, del: 31, risk: 'high', since: true },
    { path: 'src/api/session.ts', add: 71, del: 22, risk: 'high', since: false },
    { path: 'src/auth/refresh.ts', add: 210, del: 0, risk: 'medium', since: true },
    { path: 'src/auth/compat.ts', add: 88, del: 0, risk: 'medium', since: false },
    { path: 'src/net/client.ts', add: 34, del: 9, risk: 'medium', since: false },
    { path: 'src/config/auth.ts', add: 18, del: 6, risk: 'low', since: false },
    { path: 'tests/auth/refresh.test.ts', add: 96, del: 0, risk: 'low', since: true },
    { path: 'tests/auth/compat.test.ts', add: 41, del: 0, risk: 'low', since: false },
    { path: 'tests/api/session.test.ts', add: 22, del: 8, risk: 'low', since: false },
    { path: 'package.json', add: 2, del: 0, risk: 'medium', since: false },
    { path: 'package-lock.json', add: 5, del: 81, risk: 'low', since: false, generated: true },
  ],
};

// Parches unificados: se pintan con el DiffView del producto.
export const PATCHES = {
  'src/auth/token.ts': [
    'diff --git a/src/auth/token.ts b/src/auth/token.ts',
    '--- a/src/auth/token.ts',
    '+++ b/src/auth/token.ts',
    '@@ -38,13 +38,17 @@ export async function refreshToken(',
    ' export async function refreshToken(',
    '-  session: Session,',
    '+  session: Session,',
    '+  opts: { rotate?: boolean } = { rotate: true },',
    ' ): Promise<TokenPair> {',
    '-  const res = await fetch(`${AUTH}/token`, { method: "POST", body: session.refresh });',
    '+  const res = await net.post(`${AUTH}/oauth/token`, {',
    '+    grant_type: "refresh_token",',
    '+    refresh_token: session.refresh,',
    '+  });',
    '   if (!res.ok) throw new AuthError(res.status);',
    '+  const next = await parsePair(res);',
    '+  if (opts.rotate) await store.invalidate(session.refresh);',
    '+  await store.save(next);',
    '   return next;',
    '',
  ].join('\n'),
  'src/auth/store.ts': [
    'diff --git a/src/auth/store.ts b/src/auth/store.ts',
    '--- a/src/auth/store.ts',
    '+++ b/src/auth/store.ts',
    '@@ -12,6 +12,9 @@ export class TokenStore {',
    ' export class TokenStore {',
    '-  async save(p: TokenPair) { await db.put("tokens", p); }',
    '+  async save(p: TokenPair) { await keychain.set("lixbon.tokens", encrypt(p)); }',
    '+  async invalidate(old: string) {',
    '+    await db.run("INSERT INTO revoked(token) VALUES (?)", hash(old));',
    '+  }',
    ' }',
    '',
  ].join('\n'),
  'src/api/session.ts': [
    'diff --git a/src/api/session.ts b/src/api/session.ts',
    '--- a/src/api/session.ts',
    '+++ b/src/api/session.ts',
    '@@ -80,3 +80,6 @@ export function attachSession(req, res) {',
    '   const s = await sessions.get(req.cookies.sid);',
    '+  if (s && s.expiresIn < REFRESH_WINDOW_MS) {',
    '+    s = await refreshToken(s).catch(() => s);',
    '+  }',
    '   req.session = s;',
    '',
  ].join('\n'),
};

export const USAGE = [
  { provider: 'claude', today: 3.24, tokens: '2,1 M', windowLabel: 'ventana de 5 h', pct: 72, reset: '1 h 14 min', hint: 'Cerca del límite: los Intentos nuevos te preguntarán antes de usarlo' },
  { provider: 'codex', today: 1.88, tokens: '1,4 M', windowLabel: 'semanal', pct: 42, reset: '3 d', hint: 'Margen cómodo' },
  { provider: 'gemini', today: 1.03, tokens: '0,56 M', windowLabel: 'semanal', pct: 18, reset: '4 d', hint: 'Apenas usado' },
  { provider: 'opencode', today: 0, tokens: '0,31 M', windowLabel: 'huecos locales', pct: 50, reset: '—', hint: 'Gratis · sin corrección en marcha' },
];

export const EDGES = [
  { from: 't_runtime', to: 't_mobile', kind: 'child' },
  { from: 't_runtime', to: 't_cli', kind: 'child' },
  { from: 't_oauth', to: 't_mobile', kind: 'blocks', label: 'necesita los tokens' },
  { from: 't_oauth', to: 't_runtime', kind: 'overlaps', files: ['src/auth/token.ts', 'src/runtime/session.ts'] },
  { from: 't_telemetry', to: 't_runtime', kind: 'overlaps', files: ['src/telemetry/events.ts'] },
  { from: 't_cli', to: 't_runtime', kind: 'conflict', files: ['src/cli/mod.rs', 'Cargo.lock'] },
];

export const RESOURCES = [
  { name: 'Experimento OAuth antiguo', host: 'Desktop-PC', size: '4,2 GB', last: '18 d', git: 'clean' },
  { name: 'Reintento 04 de Codex', host: 'Desktop-PC', size: '2,8 GB', last: '9 d', git: 'unmerged' },
  { name: 'Docs antiguas', host: 'MacBook', size: '1,1 GB', last: '31 d', git: 'merged' },
  { name: 'Externo · feature/foo', host: 'Desktop-PC', size: '8,4 GB', last: '2 d', git: 'dirty' },
];

export const ACTIVITY = [
  { id: 'a1', time: '14:31', text: 'Codex terminó Renovación OAuth · Intento B', attemptId: 'att_oa_b', tone: 'merged' },
  { id: 'a2', time: '14:29', text: 'Claude Code: 141/141 pruebas unitarias · Runtime de agentes', attemptId: 'att_rt_a', tone: 'good' },
  { id: 'a3', time: '14:21', text: 'Gemini hizo una pregunta · Paquetes para Linux', attemptId: 'att_pk_a', tone: 'warn' },
  { id: 'a4', time: '14:20', text: 'Claude Code: 4 pruebas fallan · Script de migración', attemptId: 'att_mig_a', tone: 'danger' },
  { id: 'a5', time: '14:05', text: 'Codex completó Integración del CLI (integración bloqueada)', attemptId: 'att_cli_a', tone: 'good' },
];

export const PENDING = {
  att_rt_a: [
    { id: 'p1', mode: 'queue', text: 'Cuando pasen las pruebas, añade casos límite para Intentos cancelados.', from: 'ADE' },
    { id: 'p2', mode: 'queue', text: 'Actualiza docs/runtime.md con el nuevo diagrama del ciclo de vida.', from: 'CLI' },
  ],
};

export const CLOCK_START = 14 * 60 + 32;
