// fieldSources.js — tabla «campo → slice que lo hace real».
//
// Para cada campo de cada entidad que el ADE consume: de dónde sale HOY en el producto y qué slice lo
// convierte en dato real del Core. `slice: null` significa que ya es real (vigente) y solo necesita el
// mapeo del adaptador. Una prueba exige que todo campo de las fixtures esté aquí: no se puede añadir un
// campo al mock sin decir quién lo hará real.
import { SLICES } from './intents';

const { D, E, F, G, TASK_ATTEMPT, CONTEXT_PACKAGE, DAEMON } = SLICES;
const f = (slice, hoy) => Object.freeze({ slice, hoy });
const real = (hoy) => f(null, hoy);

export const FIELD_SOURCES = Object.freeze({
  Project: {
    id: f(D, 'no existe; el frontend usa la ruta del repo'),
    name: f(D, 'nombre de la carpeta'),
    state: f(D, 'no existe (activo/archivado)'),
    defaultBranch: f(D, 'huella del proyecto'),
    locations: f(D, '`repo`/`cwd` de la Task (ProjectLocation: ruta, machine, primary, state, lastSeen)'),
  },
  Task: {
    id: real('Task.id en state.json'),
    projectId: f(D, 'derivable del `repo` normalizado'),
    title: real('Task.title'),
    objective: real('Task.spec / título'),
    derivedState: f(TASK_ATTEMPT, 'no existe; hoy la Task es el intento y su estado es `status`'),
    attemptIds: f(TASK_ATTEMPT, 'no existe (1 intento = 1 Task)'),
    threadIds: f(TASK_ATTEMPT, 'no existe (buzón de mensajes por run)'),
    createdAt: real('Task.created'),
    updatedAt: real('Task.updated'),
  },
  Attempt: {
    id: f(TASK_ATTEMPT, 'coincide con el id de la Task'),
    taskId: f(TASK_ATTEMPT, 'no existe'),
    projectId: f(D, 'derivable del `repo`'),
    ordinal: f(TASK_ATTEMPT, 'no existe (historial de intentos)'),
    state: real('Task.status (8 ids vigentes); `pending_approval` vive hoy fuera: lanzamiento pendiente'),
    agent: real('Task.agent/model/effort/role'),
    startedAt: real('Task.created'),
    updatedAt: real('Task.updated'),
    endedAt: real('Task.updated cuando es final'),
    phase: real('última fase en Task.phases'),
    note: real('nota de la última fase'),
    summary: real('Task.report / summary'),
    failureReason: real('Task.failure_reason'),
    approvalDeadline: real('Task.approval_deadline'),
    policy: real('policy.status/warnings/argv; `elevated` sin confirmar en el código (a definir con F)'),
    pendingQuestion: f(TASK_ATTEMPT, 'hoy `unansweredQuestions()` en el frontend sobre los mensajes'),
    worktreeId: f(TASK_ATTEMPT, 'no existe (worktree propio del intento)'),
    contextPackageId: f(CONTEXT_PACKAGE, 'no existe'),
  },
  Thread: {
    id: f(TASK_ATTEMPT, 'no existe'),
    taskId: f(TASK_ATTEMPT, 'no existe'),
    title: f(TASK_ATTEMPT, 'no existe'),
    syncPolicy: f(TASK_ATTEMPT, 'no existe (política de sincronización del Thread)'),
    attemptIds: f(TASK_ATTEMPT, 'no existe'),
    messageCount: f(TASK_ATTEMPT, 'conteo de mensajes del buzón'),
    lastMessageAt: f(TASK_ATTEMPT, 'no existe'),
    messages: f(TASK_ATTEMPT, 'buzón de mensajes (Kind vigente) por run'),
  },
  Worktree: {
    id: f(TASK_ATTEMPT, 'no existe'),
    attemptId: f(TASK_ATTEMPT, 'no existe'),
    path: f(TASK_ATTEMPT, 'cwd de la Task'),
    branch: real('Task.branch'),
    baseCommit: f(TASK_ATTEMPT, 'no se guarda por separado'),
    headCommit: real('Task.head_commit'),
    dirty: f(TASK_ATTEMPT, 'no expuesto'),
    exists: f(TASK_ATTEMPT, 'no expuesto'),
  },
  Artifact: {
    id: f(TASK_ATTEMPT, 'no existe'),
    attemptId: f(TASK_ATTEMPT, 'no existe'),
    kind: f(TASK_ATTEMPT, 'sin vocabulario definido (H no define Artifact)'),
    title: f(TASK_ATTEMPT, 'no existe'),
    createdAt: f(TASK_ATTEMPT, 'no existe'),
  },
  Review: {
    attemptId: f(TASK_ATTEMPT, 'coincide con la Task'),
    state: real('derivado en frontend por reviewStatus (pasa al Core con G)'),
    decision: real('last_review.decision'),
    headCommit: real('last_review.head_commit'),
    currentHeadCommit: real('Task.head_commit'),
    at: real('last_review.at'),
    by: f(F, 'no existe (quién y desde qué cliente)'),
    diffStat: real('orch_diff (resumen)'),
  },
  Integration: {
    attemptId: f(TASK_ATTEMPT, 'coincide con la Task'),
    outcome: real('last_integration.outcome'),
    into: real('snap.integrate_into'),
    resultCommit: real('last_integration.result_commit'),
    at: real('last_integration.at'),
    eligibility: f(G, 'hoy `canIntegrate.js` en el frontend (regla que pasa al Core)'),
  },
  AttentionItem: {
    id: f(G, 'no existe (clave regla+entidad)'),
    kind: f(G, 'calculado en el frontend (attention.js, 4 kinds)'),
    entity: f(G, 'la Task'),
    projectId: f(D, 'no existe'),
    taskId: f(TASK_ATTEMPT, 'id de la Task'),
    attemptId: f(TASK_ATTEMPT, 'id de la Task'),
    reason: f(G, 'hoy implícito en attention.js (reviewStatus, failure_reason)'),
    subject: f(G, 'título de la Task'),
    createdAt: f(G, 'no existe'),
    dueAt: f(G, '`expires_at` del lanzamiento pendiente'),
    severity: f(G, 'no existe y no está definida (decisión pendiente de G)'),
    person: f(G, 'no existe (visto/pospuesto por persona y dispositivo; requiere F)'),
  },
  ActivityEntry: {
    seq: f(E, 'no existe (orch:changed no tiene historia)'),
    id: f(E, 'no existe'),
    ts: f(E, 'no existe'),
    type: f(E, 'no existe (eventos `entidad.verbo`)'),
    entity: f(E, 'no existe'),
    projectId: f(D, 'no existe'),
    taskId: f(E, 'scope del evento'),
    attemptId: f(E, 'scope del evento'),
    actor: f(E, 'no existe; `actor.client` requiere además F'),
    data: f(E, 'no existe'),
  },
  ClientConnection: {
    clientKind: f(F, 'no existe (identidad del cliente)'),
    scopes: f(F, 'no existe (alcances)'),
    label: f(F, 'no existe'),
    source: real('lo fija el cliente: mock o core'),
    coreMode: f(DAEMON, 'solo en proceso con el Desktop'),
  },
  Capability: {
    intent: real('catálogo de intents del ADE'),
    availability: f(F, 'gateway móvil limitado a 8 acciones; el Core dirá qué permite cada alcance'),
    slice: real('catálogo de intents del ADE'),
    reason: real('texto de interfaz'),
    requiresConfirmation: real('catálogo de intents del ADE'),
  },
  AgentProvider: {
    id: real('orch_agents'),
    label: real('AGENT_LABELS'),
    available: real('orch_agents'),
    policyStatus: real('policy.status'),
    models: real('ajustes de roles'),
    efforts: real('ajustes de roles'),
    roles: real('ajustes de roles'),
  },
  Location: {
    projectId: f(D, 'no existe'),
    taskId: f(TASK_ATTEMPT, 'no existe'),
    attemptId: f(TASK_ATTEMPT, 'no existe'),
    worktreeId: f(TASK_ATTEMPT, 'no existe'),
  },
});

/** Campos de una entidad sin slice declarado: la prueba espera que siempre sea []. */
export function undeclaredFields(entity, obj) {
  const decl = FIELD_SOURCES[entity];
  if (!decl) return [`(entidad sin declarar: ${entity})`];
  return Object.keys(obj || {}).filter((k) => !(k in decl));
}
