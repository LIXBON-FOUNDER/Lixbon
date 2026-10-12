// fixtures.js — datos simulados del ADE. No son la verdad de nadie: sirven para diseñar y probar la interfaz.
//
// Cubren a propósito todos los estados de Attempt y todos los kinds de Attention, tareas con varios
// intentos, una pregunta pendiente, una revisión desactualizada, un fallo, una aprobación en la terminal,
// un lanzamiento elevado y un proyecto archivado con la ruta ausente.
// Los tiempos son relativos a `now` para que la interfaz se vea viva en cualquier momento.

const MIN = 60 * 1000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;

const sha = (n) => `${String(n).padStart(2, '0')}${'a1b2c3d4e5f60718293a4b5c6d7e8f90'.repeat(2)}`.slice(0, 40);
const WT_RAIZ = '%LOCALAPPDATA%/Lixbon/worktrees';

/** @param {number} now marca de tiempo base (ms). */
export function createFixtures(now = Date.now()) {
  const hace = (ms) => now - ms;
  const en = (ms) => now + ms;

  const claude = (model, effort, role) => ({ provider: 'claude', model, effort, role });
  const codex = (model, effort, role) => ({ provider: 'codex', model, effort, role });
  const politicaOk = (cmd) => ({ status: 'ok', command: cmd, warnings: [], elevated: false });

  const projects = [
    { id: 'prj_orbita', name: 'orbita-web', state: 'active', defaultBranch: 'main',
      locations: [{ machine: 'escritorio', path: 'C:/proyectos/orbita-web', primary: true, state: 'ok', lastSeen: hace(2 * MIN) }] },
    { id: 'prj_api', name: 'lixbon-api', state: 'active', defaultBranch: 'master',
      locations: [
        { machine: 'escritorio', path: 'C:/proyectos/lixbon-api', primary: true, state: 'ok', lastSeen: hace(5 * MIN) },
        { machine: 'portátil', path: '/home/dev/lixbon-api', primary: false, state: 'missing', lastSeen: hace(40 * DIA) },
      ] },
    { id: 'prj_docs', name: 'sitio-docs', state: 'active', defaultBranch: 'main',
      locations: [{ machine: 'escritorio', path: 'C:/proyectos/sitio-docs', primary: true, state: 'ok', lastSeen: hace(1 * HORA) }] },
    { id: 'prj_movil', name: 'prototipo-movil', state: 'archived', defaultBranch: 'main',
      locations: [{ machine: 'escritorio', path: 'D:/archivo/prototipo-movil', primary: true, state: 'missing', lastSeen: hace(120 * DIA) }] },
  ];

  // Intentos: [id, task, proyecto, ordinal, estado, agente, extra]
  const A = (id, taskId, projectId, ordinal, state, agent, extra = {}) => ({
    id, taskId, projectId, ordinal, state, agent,
    startedAt: hace(extra.dur ?? 30 * MIN), updatedAt: hace(extra.upd ?? 2 * MIN), endedAt: null,
    phase: null, note: null, summary: null, failureReason: null, approvalDeadline: null,
    policy: politicaOk([agent.provider, '--permission-mode', 'plan']),
    pendingQuestion: null, worktreeId: `wt_${id.slice(4)}`, contextPackageId: null,
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => !['dur', 'upd'].includes(k))),
  });
  const cerrado = (a, minutosAtras) => ({ ...a, endedAt: hace(minutosAtras * MIN), updatedAt: hace(minutosAtras * MIN) });

  const attempts = [
    // Rediseñar el checkout: un primer intento detenido y uno de Codex en marcha (varios intentos).
    cerrado(A('att_checkout_1', 'tsk_checkout', 'prj_orbita', 1, 'stopped', claude('sonnet-5.5', 'medium', 'implementador'), { dur: 3 * HORA, summary: 'Detenido por la persona: el enfoque con formularios anidados se complicaba.' }), 140),
    A('att_checkout_2', 'tsk_checkout', 'prj_orbita', 2, 'running', codex('gpt-6-sol', 'high', 'implementador'), { dur: 48 * MIN, upd: 1 * MIN, phase: 'Implementando', note: 'Migrando los campos de tarjeta al nuevo componente de formulario' }),

    // Pago con tarjeta 3-D Secure: terminada y revisada sobre el commit actual -> Integrar.
    cerrado(A('att_pago_1', 'tsk_pago', 'prj_orbita', 1, 'done', claude('opus-5', 'high', 'implementador'), { dur: 95 * MIN, summary: 'Flujo 3-D Secure con retorno al comercio y pruebas del reintento.' }), 18),

    // Internacionalizar errores: terminada sin revisión -> Revisar.
    cerrado(A('att_i18n_1', 'tsk_i18n', 'prj_orbita', 1, 'done', codex('gpt-6-sol', 'medium', 'implementador'), { dur: 40 * MIN, summary: 'Extraje 62 mensajes a catálogos es/en.' }), 9),

    // Modo oscuro en gráficas: ya integrada (historial).
    cerrado(A('att_dark_1', 'tsk_dark', 'prj_orbita', 1, 'done', claude('sonnet-5.5', 'low', 'implementador'), { dur: 25 * MIN, summary: 'Paleta con tokens y contraste AA.' }), 26 * 60),

    // Límite de tasa: pregunta pendiente (waiting) -> unanswered_question.
    A('att_rate_1', 'tsk_rate', 'prj_api', 1, 'waiting', claude('opus-5', 'xhigh', 'implementador'), {
      dur: 70 * MIN, upd: 6 * MIN, phase: 'Diseñando', note: 'Esperando una decisión sobre la clave de agrupación',
      pendingQuestion: { id: 'msg_rate_q1', text: '¿El límite se cuenta por clave de API o por organización? Cambia el índice de Redis.', askedAt: hace(6 * MIN) },
    }),

    // Migración de índices: esperando aprobación en la terminal -> approve_in_terminal.
    A('att_migr_1', 'tsk_migr', 'prj_api', 1, 'awaiting_terminal_approval', claude('sonnet-5.5', 'high', 'implementador'), {
      dur: 22 * MIN, upd: 4 * MIN, phase: 'Aplicando migración', note: 'La CLI pide confirmar un comando de base de datos', approvalDeadline: en(6 * MIN),
    }),

    // Reintentos de webhooks: un intento cerrado y uno fallido por tiempo -> failed.
    cerrado(A('att_webhook_1', 'tsk_webhook', 'prj_api', 1, 'exited', codex('gpt-6-mini', 'low', 'explorador'), { dur: 15 * MIN, summary: 'Se cerró la terminal del agente antes de entregar.' }), 5 * 60),
    cerrado(A('att_webhook_2', 'tsk_webhook', 'prj_api', 2, 'failed', claude('opus-5', 'high', 'implementador'), { dur: 35 * MIN, failureReason: 'terminal_approval_timeout', summary: null }), 25),

    // Rotación de registros: terminada, revisión desactualizada -> Revisar.
    cerrado(A('att_logs_1', 'tsk_logs', 'prj_api', 1, 'done', claude('sonnet-5.5', 'medium', 'implementador'), { dur: 30 * MIN, summary: 'Rotación diaria con compresión y retención de 14 días.' }), 3 * 60),

    // Guía de instalación: lanzamiento pendiente (no elevado) -> pending_spawn.
    A('att_guia_1', 'tsk_guia', 'prj_docs', 1, 'pending_approval', claude('sonnet-5.5', 'medium', 'explorador'), {
      dur: 3 * MIN, upd: 3 * MIN, worktreeId: null, approvalDeadline: en(8 * MIN), policy: politicaOk(['claude', '--permission-mode', 'plan']),
    }),
    // Despliegue a staging: lanzamiento pendiente con política ELEVADA (el móvil no puede aprobarlo).
    A('att_deploy_1', 'tsk_deploy', 'prj_docs', 1, 'pending_approval', codex('gpt-6-sol', 'high', 'implementador'), {
      dur: 2 * MIN, upd: 2 * MIN, worktreeId: null, approvalDeadline: en(7 * MIN),
      policy: { status: 'unverified', command: ['codex', '--sandbox', 'danger-full-access'], warnings: ['Sandbox sin restricciones: el agente puede escribir fuera del worktree.'], elevated: true },
    }),

    // Referencia de la API: terminada y rechazada sobre el commit actual (el coordinador debe corregir; sin Attention).
    cerrado(A('att_ref_1', 'tsk_ref', 'prj_docs', 1, 'done', codex('gpt-6-sol', 'medium', 'implementador'), { dur: 50 * MIN, summary: 'Generé la referencia desde el esquema OpenAPI.' }), 70),
    // Búsqueda del sitio: recién lanzada.
    A('att_busq_1', 'tsk_busq', 'prj_docs', 1, 'starting', claude('haiku-5', 'low', 'explorador'), { dur: 40 * 1000, upd: 20 * 1000 }),
    // Enlaces rotos: descartada.
    cerrado(A('att_old_1', 'tsk_old', 'prj_docs', 1, 'exited', codex('gpt-6-mini', 'low', 'explorador'), { dur: 10 * MIN }), 6 * DIA / MIN),
  ];

  // Tareas: el estado derivado lo calcula el «núcleo simulado» al iniciar (mockCore.recalcularTareas).
  const T = (id, projectId, title, objective, attemptIds, threadIds, creado, extra = {}) => ({
    id, projectId, title, objective, derivedState: 'open', attemptIds, threadIds, createdAt: hace(creado), updatedAt: hace(extra.upd ?? 5 * MIN),
  });
  const tasks = [
    T('tsk_checkout', 'prj_orbita', 'Rediseñar el checkout', 'Unificar el formulario de pago en un componente accesible, con validación en línea y sin recargar la página.', ['att_checkout_1', 'att_checkout_2'], ['th_checkout'], 3 * HORA),
    T('tsk_pago', 'prj_orbita', 'Pago con tarjeta 3-D Secure', 'Soportar el desafío 3-D Secure y volver al comercio con el resultado.', ['att_pago_1'], ['th_pago'], 2 * HORA),
    T('tsk_i18n', 'prj_orbita', 'Internacionalizar mensajes de error', 'Mover los mensajes de error a catálogos es/en.', ['att_i18n_1'], ['th_i18n'], 1 * HORA),
    T('tsk_dark', 'prj_orbita', 'Modo oscuro en las gráficas', 'Gráficas legibles en tema oscuro con contraste AA.', ['att_dark_1'], ['th_dark'], 28 * HORA),
    T('tsk_rate', 'prj_api', 'Límite de tasa por clave de API', 'Limitar peticiones por clave con ventana deslizante en Redis.', ['att_rate_1'], ['th_rate'], 75 * MIN),
    T('tsk_migr', 'prj_api', 'Migración de índices de facturación', 'Reconstruir los índices de facturación sin bloquear escrituras.', ['att_migr_1'], ['th_migr'], 25 * MIN),
    T('tsk_webhook', 'prj_api', 'Reintentos de webhooks de Stripe', 'Reintentar entregas fallidas con retroceso exponencial.', ['att_webhook_1', 'att_webhook_2'], ['th_webhook'], 5 * HORA),
    T('tsk_logs', 'prj_api', 'Rotación de registros', 'Rotar y comprimir los registros de la API cada día.', ['att_logs_1'], ['th_logs'], 3.5 * HORA),
    T('tsk_guia', 'prj_docs', 'Guía de instalación en Windows', 'Escribir la guía de instalación y verificarla paso a paso.', ['att_guia_1'], ['th_guia'], 4 * MIN),
    T('tsk_deploy', 'prj_docs', 'Despliegue de la documentación a staging', 'Publicar el sitio en staging tras cada fusión.', ['att_deploy_1'], ['th_deploy'], 3 * MIN),
    T('tsk_ref', 'prj_docs', 'Referencia de la API generada', 'Generar la referencia de la API desde OpenAPI.', ['att_ref_1'], ['th_ref'], 90 * MIN),
    T('tsk_busq', 'prj_docs', 'Búsqueda en el sitio', 'Añadir búsqueda local sin servicios externos.', ['att_busq_1'], ['th_busq'], 1 * MIN),
    T('tsk_idea', 'prj_docs', 'Auditar la accesibilidad de la documentación', 'Revisar contraste, foco y etiquetas del sitio antes de la versión 2.', [], [], 20 * MIN),
    T('tsk_old', 'prj_docs', 'Limpiar enlaces rotos', 'Detectar y arreglar enlaces rotos.', ['att_old_1'], ['th_old'], 6 * DIA),
  ];

  // Mensajes del buzón (Kind vigente). Texto solo en el Desktop local.
  const M = (id, kind, mins, attemptId, who, text, extra = {}) => ({
    id, kind, at: hace(mins * MIN), attemptId, replyTo: extra.replyTo ?? null,
    author: { kind: extra.authorKind ?? 'agent', label: who }, text,
  });
  const threads = [
    { id: 'th_checkout', taskId: 'tsk_checkout', title: 'Checkout: hilo principal', syncPolicy: 'metadata-only', attemptIds: ['att_checkout_1', 'att_checkout_2'], messages: [
      M('m1', 'phase', 175, 'att_checkout_1', 'Claude Code', 'Fase: explorando el formulario actual'),
      M('m2', 'note', 150, 'att_checkout_1', 'Claude Code', 'Los formularios anidados duplican la validación; propongo un solo componente.'),
      M('m3', 'exited', 140, 'att_checkout_1', 'Sistema', 'Intento detenido por la persona.', { authorKind: 'system' }),
      M('m4', 'phase', 47, 'att_checkout_2', 'Codex', 'Fase: implementando el componente de tarjeta'),
      M('m5', 'note', 12, 'att_checkout_2', 'Codex', 'Validación en línea lista; faltan los estados de error.'),
    ] },
    { id: 'th_pago', taskId: 'tsk_pago', title: '3-D Secure', syncPolicy: 'metadata-only', attemptIds: ['att_pago_1'], messages: [
      M('m1', 'phase', 90, 'att_pago_1', 'Claude Code', 'Fase: integrando el desafío 3-D Secure'),
      M('m2', 'done', 18, 'att_pago_1', 'Claude Code', 'Entregué el flujo con reintento y 14 pruebas nuevas.'),
    ] },
    { id: 'th_i18n', taskId: 'tsk_i18n', title: 'Catálogos de mensajes', syncPolicy: 'metadata-only', attemptIds: ['att_i18n_1'], messages: [
      M('m1', 'done', 9, 'att_i18n_1', 'Codex', 'Extraje 62 mensajes; quedan 3 con variables que conviene revisar.'),
    ] },
    { id: 'th_dark', taskId: 'tsk_dark', title: 'Gráficas oscuras', syncPolicy: 'metadata-only', attemptIds: ['att_dark_1'], messages: [
      M('m1', 'done', 26 * 60, 'att_dark_1', 'Claude Code', 'Paleta con tokens y contraste AA.'),
    ] },
    { id: 'th_rate', taskId: 'tsk_rate', title: 'Límite de tasa', syncPolicy: 'metadata-only', attemptIds: ['att_rate_1'], messages: [
      M('m0', 'phase', 68, 'att_rate_1', 'Claude Code', 'Fase: diseñando la ventana deslizante'),
      M('msg_rate_q1', 'question', 6, 'att_rate_1', 'Claude Code', '¿El límite se cuenta por clave de API o por organización? Cambia el índice de Redis.'),
    ] },
    { id: 'th_migr', taskId: 'tsk_migr', title: 'Índices de facturación', syncPolicy: 'metadata-only', attemptIds: ['att_migr_1'], messages: [
      M('m1', 'phase', 20, 'att_migr_1', 'Claude Code', 'Fase: preparando la migración concurrente'),
      M('m2', 'note', 4, 'att_migr_1', 'Claude Code', 'Pidió confirmar CREATE INDEX CONCURRENTLY en la terminal.'),
    ] },
    { id: 'th_webhook', taskId: 'tsk_webhook', title: 'Reintentos de webhooks', syncPolicy: 'metadata-only', attemptIds: ['att_webhook_1', 'att_webhook_2'], messages: [
      M('m1', 'exited', 5 * 60, 'att_webhook_1', 'Sistema', 'Se cerró la terminal del agente.', { authorKind: 'system' }),
      M('m2', 'phase', 33, 'att_webhook_2', 'Claude Code', 'Fase: implementando el retroceso exponencial'),
      M('m3', 'note', 25, 'att_webhook_2', 'Sistema', 'Nadie aprobó en la terminal a tiempo.', { authorKind: 'system' }),
    ] },
    { id: 'th_logs', taskId: 'tsk_logs', title: 'Rotación diaria', syncPolicy: 'metadata-only', attemptIds: ['att_logs_1'], messages: [
      M('m1', 'done', 3 * 60, 'att_logs_1', 'Claude Code', 'Rotación diaria con compresión y retención de 14 días.'),
    ] },
    { id: 'th_guia', taskId: 'tsk_guia', title: 'Guía de instalación', syncPolicy: 'metadata-only', attemptIds: ['att_guia_1'], messages: [] },
    { id: 'th_deploy', taskId: 'tsk_deploy', title: 'Despliegue a staging', syncPolicy: 'metadata-only', attemptIds: ['att_deploy_1'], messages: [] },
    { id: 'th_ref', taskId: 'tsk_ref', title: 'Referencia generada', syncPolicy: 'metadata-only', attemptIds: ['att_ref_1'], messages: [
      M('m1', 'done', 70, 'att_ref_1', 'Codex', 'Generé la referencia desde el esquema OpenAPI.'),
    ] },
    { id: 'th_busq', taskId: 'tsk_busq', title: 'Búsqueda', syncPolicy: 'metadata-only', attemptIds: ['att_busq_1'], messages: [] },
    { id: 'th_old', taskId: 'tsk_old', title: 'Enlaces rotos', syncPolicy: 'local-only', attemptIds: ['att_old_1'], messages: [] },
  ];

  const conWorktree = attempts.filter((a) => a.worktreeId);
  const heads = {
    att_checkout_1: 11, att_checkout_2: 12, att_pago_1: 21, att_i18n_1: 31, att_dark_1: 41, att_rate_1: 51, att_migr_1: 61,
    att_webhook_1: 71, att_webhook_2: 72, att_logs_1: 81, att_ref_1: 91, att_busq_1: 95, att_old_1: 99,
  };
  const proyectoDe = Object.fromEntries(tasks.map((t) => [t.id, t.projectId]));
  const worktrees = conWorktree.map((a) => ({
    id: a.worktreeId, attemptId: a.id, path: `${WT_RAIZ}/${proyectoDe[a.taskId]}/${a.id}`, branch: `lxo/${a.id}`,
    baseCommit: sha(1), headCommit: sha(heads[a.id] ?? 2), dirty: a.state === 'running' || a.state === 'starting' || a.state === 'waiting', exists: true,
  }));

  const art = (id, attemptId, kind, title, mins) => ({ id, attemptId, kind, title, createdAt: hace(mins * MIN) });
  const artifacts = [
    art('ar_pago_1', 'att_pago_1', 'report', 'Informe del intento', 18),
    art('ar_pago_2', 'att_pago_1', 'diff', 'Diff contra main (14 archivos)', 18),
    art('ar_pago_3', 'att_pago_1', 'test_report', 'Resultado de pruebas (214 correctas)', 19),
    art('ar_i18n_1', 'att_i18n_1', 'report', 'Informe del intento', 9),
    art('ar_i18n_2', 'att_i18n_1', 'diff', 'Diff contra main (31 archivos)', 9),
    art('ar_logs_1', 'att_logs_1', 'report', 'Informe del intento', 180),
    art('ar_logs_2', 'att_logs_1', 'diff', 'Diff contra master (6 archivos)', 180),
    art('ar_ref_1', 'att_ref_1', 'report', 'Informe del intento', 70),
    art('ar_wh_1', 'att_webhook_2', 'log', 'Registro de la terminal (truncado)', 25),
    art('ar_ck_1', 'att_checkout_2', 'log', 'Registro de la terminal', 1),
  ];

  // Revisión e integración en bruto (el «núcleo simulado» deriva el estado).
  const reviews = {
    att_pago_1: { decision: 'accepted', headCommit: sha(21), at: hace(10 * MIN), by: { kind: 'human', client: 'desktop' }, diffStat: { files: 14, additions: 612, deletions: 88 } },
    att_logs_1: { decision: 'accepted', headCommit: sha(80), at: hace(2 * HORA), by: { kind: 'human', client: 'desktop' }, diffStat: { files: 6, additions: 140, deletions: 22 } },
    att_ref_1: { decision: 'rejected', headCommit: sha(91), at: hace(30 * MIN), by: { kind: 'human', client: 'mobile' }, diffStat: { files: 22, additions: 1900, deletions: 4 } },
    att_dark_1: { decision: 'accepted', headCommit: sha(41), at: hace(25 * HORA), by: { kind: 'human', client: 'desktop' }, diffStat: { files: 5, additions: 90, deletions: 31 } },
  };
  const diffStats = { att_i18n_1: { files: 31, additions: 804, deletions: 266 } };
  const integrations = {
    att_dark_1: { outcome: 'merged', into: 'main', resultCommit: sha(42), at: hace(24 * HORA) },
  };

  const ev = (seq, mins, type, entity, ids, actor, data = {}) => ({
    seq, id: `ev_${seq}`, ts: hace(mins * MIN), type, entity, projectId: ids.p, taskId: ids.t ?? null, attemptId: ids.a ?? null, actor, data,
  });
  const persona = { kind: 'human', id: 'usuario', label: 'Tú', client: 'desktop' };
  const sistema = { kind: 'system', id: 'core', label: 'Lixbon', client: null };
  const agente = (label, id) => ({ kind: 'agent', id, label, client: null });
  const activity = [
    ev(1, 0.3, 'attempt.started', { kind: 'attempt', id: 'att_busq_1' }, { p: 'prj_docs', t: 'tsk_busq', a: 'att_busq_1' }, agente('Claude Code', 'claude')),
    ev(3, 2, 'attempt.requested', { kind: 'attempt', id: 'att_deploy_1' }, { p: 'prj_docs', t: 'tsk_deploy', a: 'att_deploy_1' }, persona),
    ev(4, 3, 'attempt.requested', { kind: 'attempt', id: 'att_guia_1' }, { p: 'prj_docs', t: 'tsk_guia', a: 'att_guia_1' }, persona),
    ev(5, 4, 'attempt.waiting', { kind: 'attempt', id: 'att_migr_1' }, { p: 'prj_api', t: 'tsk_migr', a: 'att_migr_1' }, agente('Claude Code', 'claude'), { motivo: 'terminal' }),
    ev(6, 6, 'agent.question', { kind: 'attempt', id: 'att_rate_1' }, { p: 'prj_api', t: 'tsk_rate', a: 'att_rate_1' }, agente('Claude Code', 'claude')),
    ev(7, 9, 'attempt.completed', { kind: 'attempt', id: 'att_i18n_1' }, { p: 'prj_orbita', t: 'tsk_i18n', a: 'att_i18n_1' }, agente('Codex', 'codex')),
    ev(8, 10, 'review.completed', { kind: 'review', id: 'att_pago_1' }, { p: 'prj_orbita', t: 'tsk_pago', a: 'att_pago_1' }, persona, { decision: 'accepted' }),
    ev(9, 18, 'attempt.completed', { kind: 'attempt', id: 'att_pago_1' }, { p: 'prj_orbita', t: 'tsk_pago', a: 'att_pago_1' }, agente('Claude Code', 'claude')),
    ev(10, 25, 'attempt.failed', { kind: 'attempt', id: 'att_webhook_2' }, { p: 'prj_api', t: 'tsk_webhook', a: 'att_webhook_2' }, sistema, { failure_reason: 'terminal_approval_timeout' }),
    ev(11, 30, 'review.completed', { kind: 'review', id: 'att_ref_1' }, { p: 'prj_docs', t: 'tsk_ref', a: 'att_ref_1' }, { ...persona, client: 'mobile' }, { decision: 'rejected' }),
    ev(12, 48, 'attempt.started', { kind: 'attempt', id: 'att_checkout_2' }, { p: 'prj_orbita', t: 'tsk_checkout', a: 'att_checkout_2' }, agente('Codex', 'codex')),
    ev(13, 120, 'review.completed', { kind: 'review', id: 'att_logs_1' }, { p: 'prj_api', t: 'tsk_logs', a: 'att_logs_1' }, persona, { decision: 'accepted' }),
    ev(14, 140, 'attempt.stopped', { kind: 'attempt', id: 'att_checkout_1' }, { p: 'prj_orbita', t: 'tsk_checkout', a: 'att_checkout_1' }, persona),
    ev(15, 24 * 60, 'integration.completed', { kind: 'integration', id: 'att_dark_1' }, { p: 'prj_orbita', t: 'tsk_dark', a: 'att_dark_1' }, persona, { outcome: 'merged' }),
  ];
  // seq descendente (lo más reciente primero) y renumerado sin huecos.
  const actividad = activity.map((e, i) => ({ ...e, seq: activity.length - i, id: `ev_${activity.length - i}` }));

  const agents = [
    { id: 'claude', label: 'Claude Code', available: true, policyStatus: 'ok',
      models: [{ id: 'sonnet-5.5', label: 'Sonnet 5.5' }, { id: 'opus-5', label: 'Opus 5' }, { id: 'haiku-5', label: 'Haiku 5' }],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'], roles: ['explorador', 'implementador', 'revisor', 'escalado'] },
    { id: 'codex', label: 'Codex', available: true, policyStatus: 'unverified',
      models: [{ id: 'gpt-6-sol', label: 'GPT-6 Sol' }, { id: 'gpt-6-mini', label: 'GPT-6 Mini' }],
      efforts: ['low', 'medium', 'high'], roles: ['explorador', 'implementador'] },
    { id: 'lixbon-cli', label: 'Lixbon CLI', available: true, policyStatus: 'ok',
      models: [{ id: 'local', label: 'Modelo local' }], efforts: [], roles: ['explorador'] },
    { id: 'opencode', label: 'OpenCode', available: false, policyStatus: 'blocked', models: [], efforts: [], roles: [] },
  ];

  // Tareas que la persona descartó (el estado derivado `discarded` es del Core, no se calcula en la interfaz).
  const discardedTaskIds = ['tsk_old'];

  return { now, discardedTaskIds, projects, tasks, attempts, threads, worktrees, artifacts, reviews, diffStats, integrations, activity: actividad, agents };
}
