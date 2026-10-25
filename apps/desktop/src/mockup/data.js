// data.js — datos FICTICIOS de la maqueta unificada. Nada aquí lee ni escribe el Core real.
// Una sola fuente de datos para ADE, IDE, Mobile y CLI: por eso las cuatro superficies "se ven" como el mismo sistema.

export const CURRENT_HOST = 'desktop';

export const HOSTS = [
  { id: 'desktop', name: 'Desktop-PC', short: 'PC', os: 'Windows 11', transport: 'local', status: 'online', note: 'This machine' },
  { id: 'macbook', name: 'MacBook', short: 'Mac', os: 'macOS 15', transport: 'paired', status: 'online', note: 'Paired · LAN' },
  { id: 'vps', name: 'VPS-01', short: 'VPS', os: 'Ubuntu 24.04', transport: 'ssh', status: 'online', note: 'SSH · fra1' },
  { id: 'laptop', name: 'Laptop', short: 'Laptop', os: 'Linux', transport: 'paired', status: 'offline', note: 'Last seen 2 d ago' },
];

export const PROVIDERS = {
  claude: { id: 'claude', name: 'Claude', mark: 'C', models: ['Sonnet', 'Opus'], steer: true },
  codex: { id: 'codex', name: 'Codex', mark: 'X', models: ['Sol', 'Sol-mini'], steer: true },
  gpt: { id: 'gpt', name: 'GPT', mark: 'G', models: ['GPT-5'], steer: true },
  local: { id: 'local', name: 'Local Model', mark: 'L', models: ['qwen-coder-32b'], steer: false },
};

export const PROJECTS = [
  { id: 'lixbon', name: 'Lixbon', branch: 'main' },
  { id: 'zajuna', name: 'Zajuna', branch: 'main' },
  { id: 'sgi', name: 'SGI', branch: 'develop' },
  { id: 'tourism', name: 'Tourism App', branch: 'main' },
];

export const TASKS = [
  {
    id: 't_runtime', projectId: 'lixbon', title: 'Agent Runtime',
    objective: 'Run agents as Attempts behind one Core: lifecycle, sessions, events, and per-Attempt worktrees.',
    criteria: ['Attempt lifecycle emits durable events', 'Integration tests green on Windows + Linux', 'No provider-specific state in the Core'],
    constraints: ['Keep SQLite (no Redis)', 'Do not change the public CLI contract'],
    decisions: ['ProviderSession is a cache, not identity', 'Worktrees live outside the repo'],
    run: 'Runtime multicliente', branchBase: 'feat/agent-runtime',
  },
  {
    id: 't_oauth', projectId: 'lixbon', title: 'OAuth Refresh',
    objective: 'Implement authentication refresh with token rotation and a compatibility layer for existing sessions.',
    criteria: ['Refresh rotates tokens and invalidates the old one', 'Existing sessions keep working', 'Unit + integration tests added'],
    constraints: ['No new global state', 'Tokens never logged'],
    decisions: ['Compare two approaches before choosing (Race)'],
    branchBase: 'feature/auth-refresh',
  },
  { id: 't_mobile', projectId: 'lixbon', title: 'Mobile Remote', objective: 'Pairing + remote control surface for Attempts that keep running on the host.', criteria: ['Pairing flow', 'Attention push', 'Approve/deny with scope'], constraints: [], decisions: [], run: 'Runtime multicliente', branchBase: 'feat/mobile-remote' },
  { id: 't_cli', projectId: 'lixbon', title: 'CLI Integration', objective: 'lxo as a first-class client of the Core.', criteria: ['lxo status/tasks/agents/attention', 'lxo review'], constraints: [], decisions: [], run: 'Runtime multicliente', branchBase: 'feat/cli-integration' },
  { id: 't_sidebar', projectId: 'lixbon', title: 'Sidebar Redesign', objective: 'Project → Task → Attempt navigation with stable ordering.', criteria: [], constraints: [], decisions: [], branchBase: 'feat/sidebar-redesign' },
  { id: 't_telemetry', projectId: 'lixbon', title: 'Telemetry Cleanup', objective: 'Remove dead counters and unify event names.', criteria: [], constraints: [], decisions: [], branchBase: 'chore/telemetry-cleanup' },
  { id: 't_pack', projectId: 'zajuna', title: 'Linux Packaging', objective: 'Ship Linux builds: .deb and AppImage with auto-update.', criteria: ['Installs on Ubuntu 22.04/24.04', 'Updater works'], constraints: [], decisions: [], branchBase: 'feat/linux-packaging' },
  { id: 't_chromium', projectId: 'zajuna', title: 'Chromium Worker', objective: 'Pin and sandbox the headless Chromium used by the renderer worker.', criteria: [], constraints: ['No unverified binaries'], decisions: [], branchBase: 'fix/chromium-worker' },
  { id: 't_inventory', projectId: 'sgi', title: 'Inventory Refactor', objective: 'Split the inventory service and remove duplicated stock queries.', criteria: ['Same API', 'No query regressions'], constraints: [], decisions: [], branchBase: 'refactor/inventory' },
  { id: 't_migration', projectId: 'sgi', title: 'Migration Script', objective: 'Idempotent migration for legacy stock tables.', criteria: [], constraints: [], decisions: [], branchBase: 'feat/migration-script' },
  { id: 't_schema', projectId: 'sgi', title: 'Schema Review', objective: 'Read-only analysis of the schema and migration risks.', criteria: [], constraints: ['Read-only'], decisions: [], branchBase: 'plan/schema-review' },
  { id: 't_map', projectId: 'tourism', title: 'Map Clustering', objective: 'Cluster POIs on the map for >5k markers.', criteria: [], constraints: [], decisions: [], branchBase: 'feat/map-clustering' },
  { id: 't_sync', projectId: 'tourism', title: 'Offline Sync', objective: 'Offline-first sync for saved itineraries.', criteria: [], constraints: [], decisions: [], branchBase: 'feat/offline-sync' },
];

const wt = (project, id) => `%LOCALAPPDATA%\\Lixbon\\worktrees\\${project}\\${id}`;

// state: queued | starting | working | waiting | review_ready | failed | completed | paused | offline
// phase (solo working): thinking | tool | writing        cause (solo waiting): approval | answer | dependency | host | rate_limit
const A = (o) => ({ control: 'agent', origin: 'ADE', unread: false, policy: 'Workspace Safe', files: 0, add: 0, del: 0, tests: null, cost: 0, tokens: 0, minutes: 0, latest: '', ...o });

export const ATTEMPTS = [
  A({ id: 'att_rt_a', taskId: 't_runtime', label: 'A', provider: 'claude', model: 'Sonnet', effort: 'high', branch: 'feat/agent-runtime', worktree: wt('lixbon', 'att_rt_a'), host: 'desktop', state: 'working', phase: 'tool', minutes: 18, files: 9, add: 521, del: 90, tests: { pass: 141, total: 141 }, cost: 1.42, tokens: 880000, latest: 'Running integration tests', toolLabel: 'npm run test:integration', unread: true, ctx: 'v3' }),
  A({ id: 'att_rt_b', taskId: 't_runtime', label: 'B', provider: 'codex', model: 'Sol', effort: 'medium', branch: 'feat/agent-runtime-codex', worktree: wt('lixbon', 'att_rt_b'), host: 'desktop', state: 'review_ready', minutes: 26, files: 12, add: 640, del: 120, tests: { pass: 138, total: 141 }, cost: 0.96, tokens: 620000, latest: 'Done · 3 tests still failing on Windows paths', ctx: 'v3' }),
  A({ id: 'att_oa_a', taskId: 't_oauth', label: 'A', provider: 'claude', model: 'Sonnet', effort: 'high', branch: 'feature/auth-refresh-claude', worktree: wt('lixbon', 'att_oa_a'), host: 'desktop', state: 'working', phase: 'thinking', minutes: 9, files: 9, add: 521, del: 90, tests: { pass: 141, total: 141 }, cost: 0.74, tokens: 410000, latest: 'Weighing rotation vs. sliding expiry', ctx: 'v2' }),
  A({ id: 'att_oa_b', taskId: 't_oauth', label: 'B', provider: 'codex', model: 'Sol', effort: 'medium', branch: 'feature/auth-refresh-codex', worktree: wt('lixbon', 'att_oa_b'), host: 'desktop', state: 'review_ready', minutes: 6, files: 12, add: 843, del: 215, tests: { pass: 141, total: 141 }, cost: 0.51, tokens: 380000, latest: 'Done · Proof Pack ready', unread: true, ctx: 'v2' }),
  A({ id: 'att_mr_a', taskId: 't_mobile', label: 'A', provider: 'gpt', model: 'GPT-5', effort: 'medium', branch: 'feat/mobile-remote', worktree: wt('lixbon', 'att_mr_a'), host: 'macbook', state: 'waiting', cause: 'approval', minutes: 31, files: 6, add: 230, del: 12, tests: { pass: 42, total: 42 }, cost: 0.62, tokens: 300000, latest: 'Wants to run npm run lint', ctx: 'v1' }),
  A({ id: 'att_cli_a', taskId: 't_cli', label: 'A', provider: 'codex', model: 'Sol', effort: 'medium', branch: 'feat/cli-integration', worktree: wt('lixbon', 'att_cli_a'), host: 'desktop', state: 'completed', minutes: 44, files: 7, add: 310, del: 48, tests: { pass: 64, total: 64 }, cost: 0.88, tokens: 520000, latest: 'Integration blocked by merge conflicts', origin: 'CLI', ctx: 'v2' }),
  A({ id: 'att_sb_a', taskId: 't_sidebar', label: 'A', provider: 'local', model: 'qwen-coder-32b', effort: 'n/a', branch: 'feat/sidebar-redesign', worktree: wt('lixbon', 'att_sb_a'), host: 'desktop', state: 'paused', minutes: 52, files: 4, add: 118, del: 30, tests: null, cost: 0, tokens: 190000, latest: 'Paused by you at a safe boundary', ctx: 'v1' }),
  A({ id: 'att_tc_a', taskId: 't_telemetry', label: 'A', provider: 'local', model: 'qwen-coder-32b', effort: 'n/a', branch: 'chore/telemetry-cleanup', worktree: wt('lixbon', 'att_tc_a'), host: 'desktop', state: 'queued', minutes: 0, latest: 'Waiting for a free local slot', ctx: 'v1' }),
  A({ id: 'att_pk_a', taskId: 't_pack', label: 'A', provider: 'gpt', model: 'GPT-5', effort: 'high', branch: 'feat/linux-packaging', worktree: wt('zajuna', 'att_pk_a'), host: 'vps', state: 'waiting', cause: 'answer', minutes: 22, files: 5, add: 180, del: 4, tests: { pass: 12, total: 12 }, cost: 0.41, tokens: 260000, latest: 'Asked a blocking question', origin: 'Mobile', ctx: 'v1' }),
  A({ id: 'att_ch_a', taskId: 't_chromium', label: 'A', provider: 'claude', model: 'Sonnet', effort: 'medium', branch: 'fix/chromium-worker', worktree: wt('zajuna', 'att_ch_a'), host: 'vps', state: 'waiting', cause: 'approval', minutes: 14, files: 2, add: 40, del: 9, tests: null, cost: 0.33, tokens: 210000, latest: 'Needs network access to fetch a binary', ctx: 'v1' }),
  A({ id: 'att_inv_a', taskId: 't_inventory', label: 'A', provider: 'codex', model: 'Sol', effort: 'high', branch: 'refactor/inventory', worktree: wt('sgi', 'att_inv_a'), host: 'macbook', state: 'review_ready', minutes: 38, files: 14, add: 702, del: 540, tests: { pass: 88, total: 88 }, cost: 1.12, tokens: 700000, latest: 'Done · 14 files, queries deduplicated', unread: true, ctx: 'v2' }),
  A({ id: 'att_mig_a', taskId: 't_migration', label: 'A', provider: 'claude', model: 'Sonnet', effort: 'high', branch: 'feat/migration-script', worktree: wt('sgi', 'att_mig_a'), host: 'macbook', state: 'failed', minutes: 27, files: 3, add: 96, del: 11, tests: { pass: 20, total: 24 }, cost: 0.58, tokens: 340000, latest: '4 tests failing after 2 retries', ctx: 'v1' }),
  A({ id: 'att_sch_a', taskId: 't_schema', label: 'A', provider: 'codex', model: 'Sol', effort: 'medium', branch: null, worktree: null, readonly: true, host: 'desktop', state: 'waiting', cause: 'approval', minutes: 5, latest: 'Wants to read ../legacy-docs/schema.md', policy: 'Read-only', ctx: 'v1' }),
  A({ id: 'att_map_a', taskId: 't_map', label: 'A', provider: 'local', model: 'qwen-coder-32b', effort: 'n/a', branch: 'feat/map-clustering', worktree: wt('tourism', 'att_map_a'), host: 'laptop', state: 'offline', minutes: 63, files: 5, add: 150, del: 20, cost: 0, tokens: 120000, latest: 'Host disconnected 2 d ago', ctx: 'v1' }),
  A({ id: 'att_sync_a', taskId: 't_sync', label: 'A', provider: 'claude', model: 'Sonnet', effort: 'medium', branch: 'feat/offline-sync', worktree: wt('tourism', 'att_sync_a'), host: 'desktop', state: 'working', phase: 'writing', minutes: 12, files: 4, add: 133, del: 8, tests: { pass: 30, total: 30 }, cost: 0.29, tokens: 150000, latest: 'Editing sync/queue.ts', ctx: 'v1' }),
];

// risk: low | medium | high | none ; kind: permission | question | review | failed | conflict | host | security
export const ATTENTION = [
  { id: 'at_net_ch', kind: 'permission', attemptId: 'att_ch_a', risk: 'high', ago: '3 m', title: 'Network access + unverified binary', command: 'curl -sL https://dl.example-cdn.io/chromium-114.tar.gz | tar xz', riskLabel: 'Network · executes a downloaded binary', reason: 'Fetch a Chromium build to pin the renderer worker', scope: 'This command once' },
  { id: 'at_q_pk', kind: 'question', attemptId: 'att_pk_a', risk: 'none', ago: '9 m', title: 'Which formats should the Linux build ship?', question: 'Package as .deb + AppImage, or AppImage only? .deb needs a postinst script and signing.', options: ['.deb + AppImage', 'AppImage only'] },
  { id: 'at_rev_oa', kind: 'review', attemptId: 'att_oa_b', risk: 'medium', ago: '6 m', title: 'Review ready · OAuth Refresh · Attempt B', summary: '12 files · +843 / −215 · tests 141/141 · 1 warning' },
  { id: 'at_rev_inv', kind: 'review', attemptId: 'att_inv_a', risk: 'low', ago: '21 m', title: 'Review ready · Inventory Refactor', summary: '14 files · +702 / −540 · tests 88/88' },
  { id: 'at_fail_mig', kind: 'failed', attemptId: 'att_mig_a', risk: 'none', ago: '12 m', title: 'Attempt stopped after test failure', summary: '4 of 24 tests failing after 2 retries · last checkpoint available' },
  { id: 'at_conf_cli', kind: 'conflict', attemptId: 'att_cli_a', risk: 'none', ago: '40 m', title: 'Integration blocked', summary: '3 merge conflicts into main (src/cli/mod.rs, src/cli/args.rs, Cargo.lock)' },
  { id: 'at_host_map', kind: 'host', attemptId: 'att_map_a', risk: 'none', ago: '2 d', title: 'Laptop is offline', summary: 'Map Clustering paused. It resumes when the host reconnects.' },
  { id: 'at_low_mr', kind: 'permission', attemptId: 'att_mr_a', risk: 'low', ago: '2 m', title: 'Run lint', command: 'npm run lint', riskLabel: 'Not in this Task’s allowlist', reason: 'Validate before committing', scope: 'This command once' },
  { id: 'at_low_sch', kind: 'permission', attemptId: 'att_sch_a', risk: 'low', ago: '1 m', title: 'Read outside the Task scope', command: 'read ../legacy-docs/schema.md', riskLabel: 'Read-only · outside project scope', reason: 'Needs the legacy schema notes', scope: 'This file once' },
];

// Timeline: kind user|agent|tools|edits|check|system|checkpoint
export const TIMELINES = {
  att_rt_a: [
    { id: 'e1', kind: 'user', time: '14:12', from: 'ADE', text: 'Implement the Attempt lifecycle in the Core. Keep SQLite, no Redis. Emit durable events for every transition.' },
    { id: 'e2', kind: 'agent', time: '14:13', text: 'Plan: (1) Attempt state machine, (2) event envelope, (3) ProviderSession adapter boundary, (4) worktree manager. Starting with the state machine.' },
    { id: 'e3', kind: 'edits', time: '14:17', files: [{ path: 'src/runtime/attempt.ts', add: 188, del: 0 }, { path: 'src/runtime/events.ts', add: 96, del: 0 }, { path: 'src/runtime/session.ts', add: 142, del: 31 }] },
    { id: 'e4', kind: 'tools', time: '14:19', title: 'Ran 4 commands', items: [{ cmd: 'npm run typecheck', ok: true, ms: 4200 }, { cmd: 'npm run lint', ok: true, ms: 2100 }, { cmd: 'npm test -- runtime', ok: true, ms: 8800 }, { cmd: 'git add -A && git commit -m "attempt: state machine"', ok: true, ms: 180 }] },
    { id: 'e5', kind: 'checkpoint', time: '14:19', text: 'Checkpoint · attempt: state machine · 4 files' },
    { id: 'e6', kind: 'agent', time: '14:24', text: 'State machine and events are in. Now wiring the worktree manager; paths resolve through ProjectLocation, never absolute identity.' },
    { id: 'e7', kind: 'edits', time: '14:27', files: [{ path: 'src/runtime/worktree.ts', add: 134, del: 12 }, { path: 'src/runtime/location.ts', add: 61, del: 4 }] },
    { id: 'e8', kind: 'check', time: '14:29', name: 'Unit tests', status: 'pass', detail: '141 / 141' },
    { id: 'e9', kind: 'tools', time: '14:30', title: 'Running tool', items: [{ cmd: 'npm run test:integration', ok: null, ms: 0 }] },
  ],
  att_oa_a: [
    { id: 'e1', kind: 'user', time: '14:21', from: 'ADE', text: 'Implement authentication refresh. Compare with Attempt B before we pick.' },
    { id: 'e2', kind: 'agent', time: '14:24', text: 'Reading src/auth/*. Two options: rotate refresh tokens on every use, or sliding expiry. Rotation is safer; weighing compatibility with live sessions.' },
    { id: 'e3', kind: 'edits', time: '14:27', files: [{ path: 'src/auth/token.ts', add: 120, del: 40 }, { path: 'src/auth/refresh.ts', add: 164, del: 0 }] },
  ],
  att_oa_b: [
    { id: 'e1', kind: 'user', time: '14:21', from: 'ADE', text: 'Implement authentication refresh. Same ContextPackage as Attempt A.' },
    { id: 'e2', kind: 'agent', time: '14:26', text: 'Refresh rotation plus a compatibility layer for sessions created before rotation. One new dependency (jose).' },
    { id: 'e3', kind: 'tools', time: '14:31', title: 'Ran 6 commands', items: [{ cmd: 'npm run typecheck', ok: true, ms: 4100 }, { cmd: 'npm run lint', ok: true, ms: 2000 }, { cmd: 'npm test', ok: true, ms: 9100 }, { cmd: 'npm run test:integration', ok: true, ms: 21000 }, { cmd: 'npm run build', ok: true, ms: 45000 }, { cmd: 'git commit', ok: true, ms: 120 }] },
    { id: 'e4', kind: 'agent', time: '14:32', text: 'Done. Proof Pack attached. e2e login against a real provider was not run.' },
  ],
  att_mr_a: [
    { id: 'e1', kind: 'user', time: '14:02', from: 'ADE', text: 'Pairing flow and approve/deny with scope for the phone. Keep the host as the owner of execution.' },
    { id: 'e2', kind: 'agent', time: '14:09', text: 'Plan: (1) pairing handshake over the LAN host, (2) push for Attention, (3) approve/deny with scope. Starting with the handshake.' },
    { id: 'e3', kind: 'edits', time: '14:16', files: [{ path: 'src/remote/pairing.ts', add: 118, del: 0 }, { path: 'src/remote/attention-push.ts', add: 74, del: 6 }, { path: 'src/remote/scope.ts', add: 38, del: 6 }] },
    { id: 'e4', kind: 'check', time: '14:24', name: 'Unit tests', status: 'pass', detail: '42 / 42' },
    { id: 'e5', kind: 'agent', time: '14:31', text: 'Ready to validate before committing. I want to run npm run lint, which is not in this Task’s allowlist, so I am waiting for your decision.' },
  ],
  att_pk_a: [
    { id: 'e1', kind: 'user', time: '14:00', from: 'Mobile', text: 'Package the Linux build. Make updates work.' },
    { id: 'e2', kind: 'agent', time: '14:21', text: 'Build scripts ready. Blocked on a product decision: .deb needs a postinst and signing key.' },
  ],
};

export const PROOF_PACKS = {
  att_oa_b: {
    revision: 'a91f3c2', objective: 'Implement OAuth refresh', approach: 'Refresh-token rotation + a compatibility layer for sessions created before rotation.',
    files: 12, add: 843, del: 215,
    validation: [
      { name: 'Unit tests', result: '141 / 141', status: 'pass', src: 'auto', ms: '9.1 s' },
      { name: 'Integration tests', result: '23 / 23', status: 'pass', src: 'auto', ms: '21 s' },
      { name: 'Lint', result: 'clean', status: 'pass', src: 'auto', ms: '2.0 s' },
      { name: 'Typecheck', result: 'clean', status: 'pass', src: 'auto', ms: '4.1 s' },
      { name: 'Build', result: 'ok', status: 'pass', src: 'auto', ms: '45 s' },
      { name: 'e2e login (real provider)', result: 'not run', status: 'skipped', src: 'agent', ms: '—' },
    ],
    failed: ['Typecheck failed on the first run (token.ts return type) — fixed in turn 7.'],
    unverified: ['e2e against a real OAuth provider needs credentials the Attempt does not have.', 'Behavior under clock skew > 30 s was not exercised.'],
    risks: [{ level: 'high', text: 'Touches token storage and the auth path (security-sensitive).' }, { level: 'medium', text: 'New outbound network call on refresh.' }, { level: 'low', text: 'Public signature of refreshToken() changed.' }],
    deps: [{ name: 'jose', change: '+5.2.0', kind: 'added' }],
    security: [{ name: 'Secret scan', status: 'pass', detail: 'no secrets added' }, { name: 'New network dependency', status: 'warn', detail: 'POST /oauth/token' }, { name: 'Auth path modified', status: 'warn', detail: 'src/auth/*' }],
    screenshots: ['Login · refresh toast', 'Session expiry banner', 'Settings · Sessions'],
    questions: ['Keep refresh tokens in the OS keychain or in SQLite? (Attempt chose keychain.)'],
    review: ['src/auth/token.ts', 'src/auth/store.ts', 'src/api/session.ts'],
  },
  att_rt_a: {
    revision: 'e5a02f7', objective: 'Agent Runtime: Attempt lifecycle in the Core', approach: 'Event-sourced Attempt state machine, worktree manager through ProjectLocation, local event store on better-sqlite3.',
    files: 11, add: 612, del: 96,
    validation: [
      { name: 'Unit tests', result: '150 / 150', status: 'pass', src: 'auto', ms: '9.8 s' },
      { name: 'Integration tests', result: '34 / 34', status: 'pass', src: 'auto', ms: '27 s' },
      { name: 'Lint', result: 'clean', status: 'pass', src: 'auto', ms: '2.1 s' },
      { name: 'Typecheck', result: 'clean', status: 'pass', src: 'auto', ms: '4.3 s' },
      { name: 'Build', result: 'ok', status: 'pass', src: 'auto', ms: '43 s' },
      { name: 'Linux path handling', result: 'not run', status: 'skipped', src: 'agent', ms: '—' },
    ],
    failed: [], unverified: ['Behavior on Linux paths (host is Windows).'],
    risks: [{ level: 'medium', text: 'New native dependency (better-sqlite3) installed with your approval.' }],
    deps: [{ name: 'better-sqlite3', change: '+11.3.0', kind: 'added' }],
    security: [{ name: 'Secret scan', status: 'pass', detail: 'no secrets added' }, { name: 'Dependency approved', status: 'pass', detail: 'allowed once from Mobile' }],
    screenshots: [], questions: [], review: ['src/runtime/session.ts', 'src/runtime/worktree.ts'],
  },
  att_rt_b: {
    revision: 'c77d0be', objective: 'Agent lifecycle in the Core', approach: 'Event-sourced Attempt with a thin provider adapter.',
    files: 12, add: 640, del: 120,
    validation: [
      { name: 'Unit tests', result: '138 / 141', status: 'fail', src: 'auto', ms: '9.4 s' },
      { name: 'Lint', result: 'clean', status: 'pass', src: 'auto', ms: '2.2 s' },
      { name: 'Typecheck', result: 'clean', status: 'pass', src: 'auto', ms: '4.0 s' },
      { name: 'Build', result: 'ok', status: 'pass', src: 'auto', ms: '41 s' },
    ],
    failed: ['3 tests fail on Windows path separators (worktree.test.ts).'],
    unverified: ['Linux path handling not exercised on this host.'],
    risks: [{ level: 'medium', text: 'Hard-coded path separator in worktree manager.' }],
    deps: [], security: [{ name: 'Secret scan', status: 'pass', detail: 'no secrets added' }], screenshots: [],
    questions: [], review: ['src/runtime/worktree.ts'],
  },
  att_inv_a: {
    revision: '5be21d9', objective: 'Split inventory service', approach: 'Extract StockRepository, remove 6 duplicated queries.',
    files: 14, add: 702, del: 540,
    validation: [
      { name: 'Unit tests', result: '88 / 88', status: 'pass', src: 'auto', ms: '7.2 s' },
      { name: 'Lint', result: 'clean', status: 'pass', src: 'auto', ms: '1.9 s' },
      { name: 'Typecheck', result: 'clean', status: 'pass', src: 'auto', ms: '3.8 s' },
      { name: 'Query plan diff', result: '0 regressions', status: 'pass', src: 'agent', ms: '—' },
    ],
    failed: [], unverified: ['Load behaviour on the production-sized dataset.'],
    risks: [{ level: 'low', text: 'Large mechanical move; behaviour should be identical.' }],
    deps: [], security: [{ name: 'Secret scan', status: 'pass', detail: 'no secrets added' }], screenshots: [],
    questions: [], review: ['src/inventory/stock.repo.ts'],
  },
};

// Archivos del Review de OAuth (Attempt B). risk: high|medium|low ; since: cambió desde la revisión previa
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

export const DIFFS = {
  'src/auth/token.ts': [
    { t: 'hunk', text: '@@ -38,14 +38,31 @@ export async function refreshToken(' },
    { t: 'ctx', n: 38, text: 'export async function refreshToken(' },
    { t: 'del', n: 39, text: '  session: Session,' },
    { t: 'add', n: 39, text: '  session: Session,' },
    { t: 'add', n: 40, text: '  opts: { rotate?: boolean } = { rotate: true },' },
    { t: 'ctx', n: 41, text: '): Promise<TokenPair> {' },
    { t: 'del', n: 42, text: '  const res = await fetch(`${AUTH}/token`, { method: "POST", body: session.refresh });' },
    { t: 'add', n: 42, text: '  const res = await net.post(`${AUTH}/oauth/token`, {' },
    { t: 'add', n: 43, text: '    grant_type: "refresh_token",' },
    { t: 'add', n: 44, text: '    refresh_token: session.refresh,' },
    { t: 'add', n: 45, text: '  });' },
    { t: 'ctx', n: 46, text: '  if (!res.ok) throw new AuthError(res.status);' },
    { t: 'add', n: 47, text: '  const next = await parsePair(res);' },
    { t: 'add', n: 48, text: '  if (opts.rotate) await store.invalidate(session.refresh);' },
    { t: 'add', n: 49, text: '  await store.save(next);' },
    { t: 'ctx', n: 50, text: '  return next;' },
  ],
  'src/auth/store.ts': [
    { t: 'hunk', text: '@@ -12,9 +12,22 @@ export class TokenStore {' },
    { t: 'ctx', n: 12, text: 'export class TokenStore {' },
    { t: 'del', n: 13, text: '  async save(p: TokenPair) { await db.put("tokens", p); }' },
    { t: 'add', n: 13, text: '  async save(p: TokenPair) { await keychain.set("lixbon.tokens", encrypt(p)); }' },
    { t: 'add', n: 14, text: '  async invalidate(old: string) {' },
    { t: 'add', n: 15, text: '    await db.run("INSERT INTO revoked(token) VALUES (?)", hash(old));' },
    { t: 'add', n: 16, text: '  }' },
    { t: 'ctx', n: 17, text: '}' },
  ],
  'src/api/session.ts': [
    { t: 'hunk', text: '@@ -80,6 +80,14 @@ export function attachSession(req, res) {' },
    { t: 'ctx', n: 80, text: '  const s = await sessions.get(req.cookies.sid);' },
    { t: 'add', n: 81, text: '  if (s && s.expiresIn < REFRESH_WINDOW_MS) {' },
    { t: 'add', n: 82, text: '    s = await refreshToken(s).catch(() => s);' },
    { t: 'add', n: 83, text: '  }' },
    { t: 'ctx', n: 84, text: '  req.session = s;' },
  ],
  'src/auth/refresh.ts': [
    { t: 'hunk', text: '@@ -0,0 +1,18 @@' },
    { t: 'add', n: 1, text: 'import { jwtVerify } from "jose";' },
    { t: 'add', n: 2, text: 'export async function verifyRefresh(token: string) {' },
    { t: 'add', n: 3, text: '  const { payload } = await jwtVerify(token, key, { clockTolerance: 30 });' },
    { t: 'add', n: 4, text: '  return payload;' },
    { t: 'add', n: 5, text: '}' },
  ],
};

export const USAGE = [
  { provider: 'claude', today: 3.24, tokens: '2.1M', windowLabel: '5 h window', pct: 72, reset: '1 h 14 m', attempts: 5, hint: 'Near the limit — route new Attempts to Codex' },
  { provider: 'codex', today: 1.88, tokens: '1.4M', windowLabel: 'Weekly', pct: 42, reset: '3 d', attempts: 4, hint: 'Comfortable headroom' },
  { provider: 'gpt', today: 1.03, tokens: '0.56M', windowLabel: 'Weekly', pct: 18, reset: '4 d', attempts: 2, hint: 'Barely used' },
  { provider: 'local', today: 0, tokens: '0.31M', windowLabel: 'Slots', pct: 50, reset: '—', attempts: 3, hint: 'Free · no native Steer' },
];

export const EDGES = [
  { from: 't_runtime', to: 't_mobile', kind: 'child' },
  { from: 't_runtime', to: 't_cli', kind: 'child' },
  { from: 't_oauth', to: 't_mobile', kind: 'blocks', label: 'needs refresh tokens' },
  { from: 't_oauth', to: 't_runtime', kind: 'overlaps', files: ['src/auth/token.ts', 'src/runtime/session.ts'] },
  { from: 't_telemetry', to: 't_runtime', kind: 'overlaps', files: ['src/telemetry/events.ts'] },
  { from: 't_cli', to: 't_runtime', kind: 'conflict', files: ['src/cli/mod.rs', 'Cargo.lock'] },
];

export const REPO_TREE = [
  { name: 'src', dir: true, open: true, children: [
    { name: 'auth', dir: true, open: true, children: [
      { name: 'token.ts', path: 'src/auth/token.ts' }, { name: 'refresh.ts', path: 'src/auth/refresh.ts' }, { name: 'store.ts', path: 'src/auth/store.ts' }, { name: 'compat.ts', path: 'src/auth/compat.ts' } ] },
    { name: 'runtime', dir: true, open: true, children: [
      { name: 'attempt.ts', path: 'src/runtime/attempt.ts' }, { name: 'events.ts', path: 'src/runtime/events.ts' }, { name: 'session.ts', path: 'src/runtime/session.ts' }, { name: 'worktree.ts', path: 'src/runtime/worktree.ts' }, { name: 'location.ts', path: 'src/runtime/location.ts' } ] },
    { name: 'api', dir: true, children: [{ name: 'session.ts', path: 'src/api/session.ts' }] },
    { name: 'net', dir: true, children: [{ name: 'client.ts', path: 'src/net/client.ts' }] },
  ] },
  { name: 'tests', dir: true, children: [{ name: 'auth', dir: true, children: [{ name: 'refresh.test.ts', path: 'tests/auth/refresh.test.ts' }] }] },
  { name: 'package.json', path: 'package.json' },
  { name: 'tsconfig.json', path: 'tsconfig.json' },
];

export const CODE = {
  'src/runtime/attempt.ts': `import { emit } from "./events";

// An Attempt is one concrete execution of a Task. State transitions are durable events.
export type AttemptState =
  | "queued" | "starting" | "working" | "waiting"
  | "review_ready" | "failed" | "completed" | "paused" | "offline";

export class Attempt {
  state: AttemptState = "queued";

  transition(next: AttemptState, cause?: string) {
    const prev = this.state;
    this.state = next;
    // Every transition is an event: Activity and Attention are derived from them, never invented by a client.
    emit({ type: "attempt.state", attemptId: this.id, from: prev, to: next, cause });
  }
}`,
  'src/runtime/events.ts': `export interface CoreEvent {
  type: string;          // "attempt.state", "attention.raised", ...
  attemptId?: string;
  at?: number;
}

const subscribers = new Set<(e: CoreEvent) => void>();

export function emit(e: CoreEvent) {
  const evt = { ...e, at: Date.now() };
  for (const s of subscribers) s(evt);   // ADE, IDE, CLI and Mobile all subscribe here
}`,
  'src/runtime/session.ts': `import { Attempt } from "./attempt";
import { emit } from "./events";
import { resolveLocation } from "./location";

// ProviderSession is a cache owned by the provider — never the identity of the work.
export interface ProviderSession {
  id: string;
  provider: "claude" | "codex" | "gpt" | "local";
  resumable: boolean;
}

export async function startSession(attempt: Attempt): Promise<ProviderSession> {
  const loc = await resolveLocation(attempt.projectId, attempt.host);
  emit({ type: "attempt.session.starting", attemptId: attempt.id, cwd: loc.cwd });
  const session = await attempt.adapter.open({ cwd: loc.cwd, policy: attempt.policy });
  emit({ type: "attempt.session.started", attemptId: attempt.id, sessionId: session.id });
  return session;
}

export async function resumeOrRebuild(attempt: Attempt): Promise<ProviderSession> {
  if (attempt.session?.resumable) return attempt.session;
  // Provider session is gone: rebuild from the neutral ContextPackage.
  const pkg = await attempt.contextPackage();
  return attempt.adapter.open({ cwd: attempt.cwd, context: pkg });
}`,
  'src/auth/token.ts': `import { net } from "../net/client";
import { store } from "./store";
import { AuthError, parsePair, type Session, type TokenPair } from "./types";

const AUTH = process.env.AUTH_URL!;

export async function refreshToken(
  session: Session,
  opts: { rotate?: boolean } = { rotate: true },
): Promise<TokenPair> {
  const res = await net.post(\`\${AUTH}/oauth/token\`, {
    grant_type: "refresh_token",
    refresh_token: session.refresh,
  });
  if (!res.ok) throw new AuthError(res.status);
  const next = await parsePair(res);
  if (opts.rotate) await store.invalidate(session.refresh);
  await store.save(next);
  return next;
}`,
  'src/runtime/worktree.ts': `import path from "node:path";
import { git } from "../vcs/git";

export async function createWorktree(projectId: string, attemptId: string, base: string) {
  const root = managedRoot(projectId);
  const dir = path.join(root, attemptId);
  await git(["worktree", "add", "-b", \`attempt/\${attemptId}\`, dir, base]);
  return { dir, branch: \`attempt/\${attemptId}\` };
}`,
};

export const DIAGNOSTICS = [
  { sev: 'warn', file: 'src/auth/token.ts', line: 47, msg: "'next' is assigned but may be stale after invalidate()", src: 'ts' },
  { sev: 'info', file: 'src/net/client.ts', line: 12, msg: 'Consider a timeout for net.post', src: 'eslint' },
];

export const FLEET_SIM = {
  start: 14 * 60 + 32,
};
