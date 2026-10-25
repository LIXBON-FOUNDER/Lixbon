// orchData.js — datos ficticios del Orquestador. Todo en memoria: ningún dato sale del Core.
// El vocabulario (run, coordinador, rol, hija, encargo, informe, política efectiva, lanzamiento pendiente, integrar)
// es el del modo Orquestador real (apps/desktop/src/orch + lxo/guide/coordinator.md). Lo que aún no existe en el
// producto va marcado con `plan` y la fase de docs/PLAN_ORQUESTADOR.md que lo introduce.

export const NOW_LABEL = '14:32';

export const PROJECT = {
  name: 'Lixbon Core',
  root: 'C:\\Users\\USUARIO\\lixbon',
  coordBranch: 'activacion-corte-al-arrancar',
  host: 'Desktop-PC',
};

/* ── Registro de agentes (Plan · Fase 0.2: hoy son 5 en un `match`, mañana filas de agents.json) ───────── */
export const PROVIDERS = {
  claude:  { id: 'claude',  label: 'Claude Code', mark: 'C', hue: 24,  state: 'ready',  version: '2.1.296', mode: 'terminal', readOnly: 'verificado', models: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] },
  codex:   { id: 'codex',   label: 'Codex',       mark: 'X', hue: 160, state: 'ready',  version: '0.162.1', mode: 'terminal', readOnly: 'verificado', models: ['gpt-5-codex', 'gpt-5.2'], efforts: ['low', 'medium', 'high'] },
  gemini:  { id: 'gemini',  label: 'Gemini',      mark: 'G', hue: 215, state: 'ready',  version: '0.9.2',   mode: 'terminal', readOnly: 'verificado', models: ['gemini-2.5-pro', 'gemini-2.5-flash'], efforts: [] },
  copilot: { id: 'copilot', label: 'Copilot CLI', mark: 'P', hue: 280, state: 'ready',  version: '1.4.0',   mode: 'piped',    readOnly: 'sin verificar', models: ['gpt-5'], efforts: [], plan: 'Fase 1' },
  cursor:  { id: 'cursor',  label: 'Cursor',      mark: 'U', hue: 330, state: 'paused', version: '2025.10', mode: 'terminal', readOnly: 'sin verificar', models: ['auto'], efforts: [], reason: 'No recibe teclado en ConPTY (Windows). Se mantiene pausado hasta decidir PTY o modo piped.' },
  opencode:{ id: 'opencode',label: 'OpenCode',    mark: 'O', hue: 60,  state: 'paused', version: '0.14.1',  mode: 'terminal', readOnly: 'sin verificar', models: ['(según proveedor)'], efforts: [], reason: 'No recibe teclado en ConPTY (Windows).' },
  qwen:    { id: 'qwen',    label: 'Qwen Code',   mark: 'Q', hue: 190, state: 'missing',version: null,      mode: 'terminal', readOnly: 'sin verificar', models: [], efforts: [], plan: 'Fase 1' },
};

/* ── Roles (Ajustes → Orquestador). El coordinador NO elige el modelo: lo fija el rol (principio 7 del plan). ── */
export const ROLES = {
  explorador:    { agent: 'gemini', model: 'gemini-2.5-pro', effort: null,     readOnly: true,  worktree: false, uso: 'Buscar y leer código. Solo lectura, sin rama.' },
  implementador: { agent: 'claude', model: 'sonnet',          effort: 'high',   readOnly: false, worktree: true,  uso: 'Programar un encargo en su rama y worktree, con tests.' },
  revisor:       { agent: 'codex',  model: 'gpt-5-codex',     effort: 'medium', readOnly: true,  worktree: false, uso: 'Revisar el diff de otra hija. Solo lectura.' },
  escalado:      { agent: 'claude', model: 'opus',            effort: 'high',   readOnly: false, worktree: true,  uso: 'Solo si un implementador falló dos veces en lo mismo.' },
  adversario:    { agent: 'codex',  model: 'gpt-5-codex',     effort: 'high',   readOnly: true,  worktree: false, uso: 'Atacar lo que hizo otra hija: busca cómo se rompe.' },
};
export const COORDINATOR_CFG = { agent: 'claude', model: 'opus', effort: 'high' };

/* Perfiles de autonomía (PROPUESTA_CLIENTE_IDE_ADE_CLI, «El usuario decide la autonomía») */
export const PROFILES = {
  explorar:             { label: 'Explorar',             note: 'Leer y explicar dentro del alcance. Sin aplicar cambios.' },
  proponer:             { label: 'Proponer',             note: 'Preparar cambios para tu aprobación antes de aplicarlos.' },
  delegar_con_revision: { label: 'Delegar con revisión', note: 'Modificar y ejecutar en una copia aislada; entrega para revisión humana.' },
};
export const ROLE_PROFILE = { explorador: 'explorar', revisor: 'explorar', adversario: 'explorar', implementador: 'delegar_con_revision', escalado: 'delegar_con_revision' };

/* ── Políticas efectivas ───────────────────────────────────────────────────────────────────────────────── */
const LXO_TOOLS = ['Bash(lxo report:*)', 'Bash(lxo guide)', 'Bash(lxo phase:*)', 'Bash(lxo ask:*)', 'Bash(lxo check)'];
export const POLICY_NOTES = {
  claude: ['Claude no tiene sandbox del sistema operativo: los límites los aplica la propia CLI.', 'Claude no corta la red.'],
  codex: ['El aislamiento entre tareas lo da el worktree de git, no la CLI.'],
  gemini: ['El aislamiento entre tareas lo da el worktree de git, no la CLI.'],
};
export function policyFor(role, agent) {
  const profile = ROLE_PROFILE[role];
  const ro = ROLES[role]?.readOnly;
  const base = {
    claude: ro
      ? ['-p', '--output-format', 'stream-json', '--disallowedTools=Edit,Write,NotebookEdit', `--allowedTools=${LXO_TOOLS.join(',')}`, '--permission-mode', 'plan']
      : [`--allowedTools=${LXO_TOOLS.join(',')}`, '--permission-mode', 'acceptEdits'],
    codex: ['--sandbox', ro ? 'read-only' : 'workspace-write'],
    gemini: ['--approval-mode', ro ? 'plan' : 'auto_edit'],
  }[agent] || [];
  return { profile, argv: [agent, ...base], status: 'ok', warnings: POLICY_NOTES[agent] || [] };
}

/* ── Tareas del run activo. status: starting | running | done | failed | exited | stopped | blocked (plan F2) ─ */
// min = minutos desde el arranque; las fases traen `ago` en minutos.
const T = (o) => ({ phases: [], files: [], deps: [], attempt: 1, cost: 0, tokens: 0, ...o });

export const TASKS = [
  T({
    id: 'c1', parent: null, title: 'Coordinador', role: null, agent: 'claude', model: 'opus', effort: 'high', status: 'running', min: 41,
    spec: 'Cerrar los pendientes del corte Task/Attempt en el ADE (LXB-48) sin romper la selección.',
    phases: [
      { name: 'Planificar', done: true, ago: 38, note: 'Dividido en 5 tareas independientes' },
      { name: 'Esperar informes', done: false, ago: 12, note: '3 hijas en marcha · 1 pregunta abierta' },
    ],
    cost: 1.84, tokens: 212000, live: { verdict: 'live', hb: 9 },
  }),
  T({
    id: 't1', parent: 'c1', title: 'Mapa de la navegación F2', role: 'explorador', agent: 'gemini', model: 'gemini-2.5-pro', effort: null, status: 'done', min: 34,
    spec: '¿Dónde se resuelve la selección de Task en la navegación F2 y qué pruebas la cubren? Devuelve rutas con línea y conclusiones, no código.',
    summary: 'La selección vive en `useF2Nav` y se persiste por Task, no por Attempt. Tres pruebas la cubren; ninguna cambia de Attempt con el corte activo.',
    report: '.lixbon/informes/t1.md', files: ['apps/desktop/src/f2/useF2Nav.js:41', 'apps/desktop/src/f2/f2Nav.test.js:88'], cost: 0.21, tokens: 61000,
    phases: [{ name: 'Localizar', done: true, ago: 33 }, { name: 'Informe', done: true, ago: 27, note: 'Informe entregado' }],
    live: { verdict: 'exited', hb: null }, log: [
      ['cmd', '$ rg -n "selectedTask" apps/desktop/src/f2'],
      ['out', 'apps/desktop/src/f2/useF2Nav.js:41:  const [selectedTask, setSelectedTask] = useState(null);'],
      ['out', 'apps/desktop/src/f2/f2Nav.test.js:88:  it("conserva la selección al refrescar", () => {'],
      ['ok', 'OK Informe escrito en .lixbon/informes/t1.md'],
    ],
  }),
  T({
    id: 't2', parent: 'c1', title: 'Navegación F2 por Attempt', role: 'implementador', agent: 'claude', model: 'sonnet', effort: 'high', status: 'running', min: 24,
    branch: 'lx/nav-f2-attempt', worktree: 'C:\\Users\\USUARIO\\lixbon-wt\\lx-nav-f2-attempt', head: 'a3f09c1',
    spec: 'Migrar `useF2Nav` al modelo Task/Attempt: la selección guarda attempt_id y recupera la Task desde él. No tocar `src/ade/`. Aceptación: `npm test -- f2Nav` en verde y sin cambiar la API pública del hook.',
    phases: [
      { name: 'Entender', done: true, ago: 22, note: 'Leído el informe t1' },
      { name: 'Implementar', done: true, ago: 14, note: '2 archivos' },
      { name: 'Verificar', done: false, ago: 3, note: 'Ejecutando las pruebas de f2Nav' },
    ],
    files: ['apps/desktop/src/f2/useF2Nav.js', 'apps/desktop/src/f2/f2Nav.test.js'], tests: { pass: 9, total: 11 }, cost: 0.72, tokens: 148000,
    env: { shared: ['node_modules'], copy: ['.env.local'], skipped: [{ path: 'target/', reason: 'se regenera' }] },
    live: { verdict: 'live', hb: 4 },
    log: [
      ['cmd', '$ git status -sb'], ['out', '## lx/nav-f2-attempt...origin/activacion-corte-al-arrancar [ahead 1]'],
      ['out', ' M apps/desktop/src/f2/useF2Nav.js'], ['out', ' M apps/desktop/src/f2/f2Nav.test.js'],
      ['cmd', '$ npm test -- f2Nav'], ['out', ' RUN  v3.2.4  lx-nav-f2-attempt'],
      ['ok', ' PASS f2Nav.test.js (9 pruebas pasadas)'], ['warn', ' × f2Nav.test.js > conserva la selección al cambiar de Attempt'],
    ],
    liveFeed: [
      ['out', '   AssertionError: expected "att_oa_b" to equal "att_oa_a"'],
      ['cmd', '$ git diff apps/desktop/src/f2/useF2Nav.js'],
      ['out', '   el fallo viene de reutilizar el id de Task como clave de la selección'],
      ['ok', ' PASS f2Nav.test.js (11 pruebas pasadas)'],
    ],
    diff: [
      { path: 'apps/desktop/src/f2/useF2Nav.js', add: 44, del: 12, hunk: [
        [' ', 'export function useF2Nav() {'],
        ['-', '  const [selectedTask, setSelectedTask] = useState(null);'],
        ['+', '  const [selectedAttempt, setSelectedAttempt] = useState(null);'],
        ['+', '  const task = useTaskOfAttempt(selectedAttempt);'],
        [' ', '  const select = useCallback((id) => {'],
        ['-', '    setSelectedTask(id);'],
        ['+', '    setSelectedAttempt(resolveAttempt(id));'],
        [' ', '  }, []);'],
      ] },
      { path: 'apps/desktop/src/f2/f2Nav.test.js', add: 27, del: 4, hunk: [
        [' ', 'it("conserva la selección al refrescar", () => {'],
        ['+', '  const { result } = renderHook(() => useF2Nav());'],
        ['+', '  act(() => result.current.select("att_oa_a"));'],
        ['+', '  expect(result.current.task.id).toBe("t_oauth");'],
        [' ', '});'],
      ] },
    ],
  }),
  T({
    id: 't3', parent: 'c1', title: 'Aviso de corte en el ADE', role: 'implementador', agent: 'claude', model: 'sonnet', effort: 'high', status: 'awaiting_terminal_approval', min: 19,
    branch: 'lx/aviso-corte-ade', worktree: 'C:\\Users\\USUARIO\\lixbon-wt\\lx-aviso-corte-ade', head: '5be21d0',
    spec: 'Mostrar en el ADE un aviso cuando el arranque activa el corte Task/Attempt. Reutiliza el banner del Core degradado. Aceptación: prueba de render con y sin corte.',
    phases: [
      { name: 'Entender', done: true, ago: 17 },
      { name: 'Implementar', done: false, ago: 6, note: 'Necesita ejecutar `cargo test -p lixbon-core` para validar el texto del estado' },
    ],
    files: ['apps/desktop/src/ade/CutNotice.jsx'], cost: 0.48, tokens: 97000,
    approval: { command: 'cargo test -p lixbon-core --test agentic_cut', why: 'Comando fuera del catálogo permitido (compila Rust).', since: 6, deadlineMin: 4 },
    live: { verdict: 'live', hb: 15 },
    env: { shared: ['node_modules'], copy: ['.env.local'] },
    log: [
      ['cmd', '$ rg -n "Core degradado" apps/desktop/src'], ['out', 'apps/desktop/src/orch/OrchestratorMode.jsx:377'],
      ['cmd', '$ cargo test -p lixbon-core --test agentic_cut'],
      ['warn', '[POLÍTICA] Este comando espera aprobación en la terminal.'], ['warn', 'Esperando confirmación de la persona…'],
    ],
  }),
  T({
    id: 't4', parent: 'c1', title: 'Revisión del aviso de corte', role: 'revisor', agent: 'codex', model: 'gpt-5-codex', effort: 'medium', status: 'blocked', min: 0,
    deps: ['t3'], spec: 'Revisa git diff activacion-corte-al-arrancar...lx/aviso-corte-ade. Busca regresiones de selección y texto en español sin acentos.',
    phases: [], cost: 0, tokens: 0, live: { verdict: 'unverifiable', hb: null },
  }),
  T({
    id: 't5', parent: 'c1', title: 'Rechazo en solo lectura', role: 'implementador', agent: 'claude', model: 'sonnet', effort: 'high', status: 'done', min: 25,
    branch: 'lx/rechazo-solo-lectura', worktree: 'C:\\Users\\USUARIO\\lixbon-wt\\lx-rechazo-solo-lectura', head: '9c0d417', attempt: 2,
    spec: 'Con el Core en solo lectura, rechazar la escritura de Tasks con `core_cut_read_only` y mostrar el motivo en el ADE. Aceptación: `cargo test -p lixbon-core read_only`.',
    summary: 'Añadido el rechazo `core_cut_read_only` en `task_ops` y el motivo consultable en `core_model.storage`. 38 pruebas en verde; sin cambios fuera de `task_ops` y su prueba.',
    report: '.lixbon/informes/t5.md', files: ['apps/desktop/src-tauri/src/orch/task_ops.rs', 'apps/desktop/src-tauri/src/orch/task_ops_tests.rs', 'apps/desktop/src/ade/CutNotice.jsx'],
    tests: { pass: 38, total: 38 }, cost: 0.93, tokens: 171000,
    phases: [{ name: 'Implementar', done: true, ago: 21 }, { name: 'Verificar', done: true, ago: 11, note: '38/38' }, { name: 'Corregir hallazgos', done: true, ago: 5, note: 'Respondió 3 hallazgos del adversario' }],
    review: { decision: 'accepted', head: '9c0d417', at: 'hace 4 min' },
    live: { verdict: 'exited', hb: null },
    env: { shared: ['node_modules'], copy: ['.env.local'] },
    log: [['cmd', '$ cargo test -p lixbon-core read_only'], ['ok', 'test result: ok. 38 passed; 0 failed'], ['ok', 'OK lxo done --outcome succeeded']],
    diff: [
      { path: 'apps/desktop/src-tauri/src/orch/task_ops.rs', add: 61, del: 7, hunk: [
        [' ', 'pub fn create_task(core: &Core, input: TaskInput) -> Result<Task, OpError> {'],
        ['+', '    if core.storage().read_only() {'],
        ['+', '        return Err(OpError::rejected("core_cut_read_only"));'],
        ['+', '    }'],
        [' ', '    let tx = core.begin()?;'],
      ] },
      { path: 'apps/desktop/src-tauri/src/orch/task_ops_tests.rs', add: 38, del: 0, hunk: [
        ['+', '#[test]'], ['+', 'fn rechaza_escritura_en_solo_lectura() {'], ['+', '    let core = Core::read_only_fixture();'],
        ['+', '    assert_eq!(create(&core).unwrap_err().code(), "core_cut_read_only");'], ['+', '}'],
      ] },
      { path: 'apps/desktop/src/ade/CutNotice.jsx', add: 18, del: 2, hunk: [
        [' ', 'export function CutNotice({ storage }) {'],
        ['+', '  if (storage.readOnly) return <p>El Core está en solo lectura: no se pueden crear Tasks.</p>;'],
      ] },
    ],
  }),
  T({
    id: 't6', parent: 'c1', title: 'Ataque al rechazo en solo lectura', role: 'adversario', agent: 'codex', model: 'gpt-5-codex', effort: 'high', status: 'done', min: 16,
    spec: 'Ataca git diff activacion-corte-al-arrancar...lx/rechazo-solo-lectura. Lista hallazgos numerados por gravedad con escenario, evidencia y una pregunta para el creador.',
    summary: '3 hallazgos: (1 alto) la carpeta compartida no pasa por `read_only()`; (2 medio) el motivo no se limpia al reabrir; (3 bajo) texto sin acento. Ronda 1 de 2 contestada por t5.',
    report: '.lixbon/informes/t6.md', files: ['.lixbon/informes/t6.md'], cost: 0.36, tokens: 88000,
    phases: [{ name: 'Atacar', done: true, ago: 12 }, { name: 'Informe', done: true, ago: 9, note: '3 hallazgos' }], live: { verdict: 'exited', hb: null },
    log: [['cmd', '$ git diff activacion-corte-al-arrancar...lx/rechazo-solo-lectura'], ['warn', 'hallazgo 1 (alto): carpeta compartida sin pasar por read_only()'], ['ok', 'OK Informe entregado']],
  }),
  T({
    id: 't7', parent: 'c1', title: 'Inventario de pruebas del corte', role: 'explorador', agent: 'gemini', model: 'gemini-2.5-pro', effort: null, status: 'exited', min: 28, attempt: 2,
    spec: 'Lista las pruebas que cubren `agentic_cut` y dónde faltan casos de numeración reservada.',
    summary: null, failure: 'La CLI se cerró sin entregar informe (intento 2).', cost: 0.12, tokens: 33000,
    phases: [{ name: 'Localizar', done: false, ago: 20, note: 'Sin cerrar' }], live: { verdict: 'exited', hb: null },
    log: [['cmd', '$ rg -n "agentic_cut" apps/desktop/src-tauri'], ['warn', 'La sesión de Gemini terminó con código 1.']],
  }),
];

/* ── Mensajes del buzón (lxo) ─────────────────────────────────────────────────────────────────────────── */
export const MESSAGES = [
  { id: 'm1', kind: 'phase', from: 't2', to: 'c1', body: 'Verificar · ejecutando las pruebas de f2Nav', at: 3 },
  { id: 'm2', kind: 'question', from: 't3', to: 'c1', body: '¿El aviso debe bloquear el arranque o solo informar? El texto del corte lo permite en ambos casos.', at: 7 },
  { id: 'm3', kind: 'done', from: 't5', to: 'c1', body: 'Entregado. 38/38 pruebas. Informe en .lixbon/informes/t5.md', at: 5 },
  { id: 'm4', kind: 'done', from: 't6', to: 'c1', body: 'Informe del adversario: 3 hallazgos (1 alto, 1 medio, 1 bajo).', at: 9 },
  { id: 'm5', kind: 'note', from: 'c1', to: 't5', body: 'Responde a cada hallazgo: corrige con un test o justifica. Ronda 1 de 2.', at: 8 },
  { id: 'm6', kind: 'exited', from: 't7', to: 'c1', body: 'La CLI se cerró sin entregar. Relanzado una vez (intento 2); sigue cerrada.', at: 14 },
  { id: 'm7', kind: 'done', from: 't1', to: 'c1', body: 'Informe del mapa de navegación en .lixbon/informes/t1.md', at: 27 },
];

/* ── Lanzamientos pendientes: cada `lxo spawn` lo aprueba una persona (vence a los 10 min) ─────────────── */
export const PENDING = [
  { id: 'p1', role: 'revisor', name: 'Revisión del rechazo en solo lectura', agent: 'codex', model: 'gpt-5-codex', effort: 'medium', shared: true,
    spec: 'Revisa git diff activacion-corte-al-arrancar...lx/rechazo-solo-lectura tras las correcciones de la ronda 1.', expiresIn: 8.5 },
  { id: 'p2', role: 'implementador', name: 'Pruebas de migración 900', agent: 'claude', model: 'sonnet', effort: 'high', shared: false,
    spec: 'Cubrir con pruebas la migración con versión reservada 900 y la numeración legada. Rama propia, sin tocar src/ade.', expiresIn: 3 },
];

/* Pestaña «Actividad» del coordinador: lo que el usuario le pidió y lo que ha ido haciendo (resumido) */
export const COORD_LOG = [
  ['user', 'Hace 41 min', '/orquestar Cerrar los pendientes del corte Task/Attempt en el ADE (LXB-48) sin romper la selección.'],
  ['cmd', 'Hace 40 min', 'lxo run create --objective "Cerrar los pendientes del corte…" --agent claude'],
  ['cmd', 'Hace 40 min', 'lxo issue ver LXB-48'],
  ['cmd', 'Hace 40 min', 'lxo issue mover LXB-48 "En curso"'],
  ['cmd', 'Hace 38 min', 'lxo spawn --role explorador --name "Mapa de la navegación F2"'],
  ['say', 'Hace 28 min', 'El informe de t1 confirma que la selección vive en `useF2Nav`. Reparto en tres implementaciones independientes y una revisión.'],
  ['cmd', 'Hace 26 min', 'lxo spawn --role implementador --name "Navegación F2 por Attempt"'],
  ['cmd', 'Hace 25 min', 'lxo spawn --role implementador --name "Rechazo en solo lectura"'],
  ['cmd', 'Hace 20 min', 'lxo spawn --role implementador --name "Aviso de corte en el ADE"'],
  ['cmd', 'Hace 14 min', 'lxo spawn --role adversario --name "Ataque al rechazo en solo lectura"'],
  ['cmd', 'Hace 12 min', 'lxo wait --timeout-ms 540000'],
];

/* Run anterior, ya cerrado: el árbol conserva el historial plegado */
export const CLOSED_RUNS = [
  { id: 'r0', title: 'Cursor t2: aceptado en la ventana de compatibilidad', issue: 'LXB-44', tasks: 4, merged: 3, ago: 'ayer', cost: 3.12 },
  { id: 'r00', title: 'Prueba de Activity por Attempt con conteos', issue: 'LXB-41', tasks: 3, merged: 3, ago: 'hace 2 días', cost: 2.07 },
];

export const RUN = { id: 'r1', title: 'Cerrar los pendientes del corte Task/Attempt', issue: 'LXB-48', budget: { cost: 12, parallel: 4 }, startedMin: 41 };

/* Otras carpetas con agentes (vista Flota) */
export const OTHER_AGENTS = [
  { id: 'x1', title: 'Migrar alembic a la versión 0013', repo: 'lixbon-api', role: 'implementador', agent: 'claude', model: 'sonnet', status: 'running', min: 12, cost: 0.41, live: { verdict: 'live', hb: 6 }, run: 'Run de lixbon-api' },
  { id: 'x2', title: 'Handoff: limpiar avisos de clippy', repo: 'lixbon-cli', role: null, agent: 'codex', model: 'gpt-5-codex', status: 'running', min: 55, cost: 0.88, live: { verdict: 'unverifiable', hb: 190 }, run: 'Sin supervisión (handoff)', handoff: true },
];

/* Línea de tiempo del run (minutos desde ahora hacia atrás). `after` = dependencia declarada con `lxo spawn --after` (Plan · Fase 2). */
export const LANES = {
  c1: { start: 41, end: null }, t1: { start: 38, end: 27 }, t2: { start: 26, end: null }, t5: { start: 25, end: 5 },
  t7: { start: 26, end: 14 }, t3: { start: 20, end: null }, t6: { start: 14, end: 9 }, t4: { start: null, end: null, after: 't3' },
};
