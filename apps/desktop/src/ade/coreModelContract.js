/**
 * Contrato cliente de las lecturas vNext del modelo Task/Attempt (LXO-119, docs/core/QUERIES.md
 * «Modelo Task/Attempt»; respuestas de referencia en docs/core/fixtures/api/).
 *
 * Mismo patrón que `coreInventoryContract.js`: el DTO del Core llega tal cual; aquí solo se
 * COMPRUEBA su forma, su vocabulario y que corresponde al target pedido. Nada se completa ni se
 * deriva: una Task F2 nunca se convierte en un Attempt. Sin dependencias de Tauri ni de React.
 */

export const CORE_MODELS = Object.freeze(['legacy', 'task_attempt_v1']);
export const ATTEMPT_STATUSES = Object.freeze([
  'pending_approval', 'starting', 'running', 'waiting', 'awaiting_terminal_approval',
  'done', 'failed', 'stopped', 'exited',
]);
export const ATTEMPT_FINAL_STATUSES = Object.freeze(['done', 'failed', 'stopped', 'exited']);
export const TASK_DERIVED_STATES = Object.freeze(['open', 'in_progress', 'in_review', 'integrated', 'discarded']);
export const TASK_INTENTS = Object.freeze(['open', 'discarded']);
export const WORKTREE_STATES = Object.freeze(['active', 'missing', 'removed']);
export const WORKTREE_PROVENANCES = Object.freeze(['created', 'adopted', 'external']);
export const PROVIDER_SESSION_STATUSES = Object.freeze(['open', 'idle', 'closed']);
export const PROVIDER_SESSION_BINDINGS = Object.freeze(['stream_json', 'session_id']);
export const ARTIFACT_KINDS = Object.freeze(['report', 'pull_request', 'last_message', 'commit', 'file']);
export const REVIEW_VERDICTS = Object.freeze(['accepted', 'rejected']);
export const REVIEW_STATUSES = Object.freeze(['active', 'stale', 'superseded']);

/** Página de `task_list_v2` (1–100 en el contrato). `include_discarded` no se envía: vale el defecto del Core. */
export const TASK_LIST_V2_LIMIT = 100;

const set = (values) => new Set(values);
const MODEL_SET = set(CORE_MODELS);
const INTENT_SET = set(TASK_INTENTS);
const WT_STATE_SET = set(WORKTREE_STATES);
const WT_PROV_SET = set(WORKTREE_PROVENANCES);
const PS_STATUS_SET = set(PROVIDER_SESSION_STATUSES);
const PS_BINDING_SET = set(PROVIDER_SESSION_BINDINGS);
const ARTIFACT_SET = set(ARTIFACT_KINDS);
const VERDICT_SET = set(REVIEW_VERDICTS);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v) => typeof v === 'string' && Boolean(v.trim());
const optText = (v) => v === null || (typeof v === 'string' && Boolean(v.trim()));
const text = (v) => typeof v === 'string';
const ms = (v) => Number.isSafeInteger(v) && v >= 0;
const optMs = (v) => v === null || ms(v);
const bool = (v) => typeof v === 'boolean';
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const oneOf = (values) => (v) => values.has(v);
const optOneOf = (values) => (v) => v === null || values.has(v);
// El estado del Attempt y el derivado de la Task se aceptan como texto: un valor nuevo del Core no
// rompe la lectura; la UI lo presenta como «Estado no reconocido» (adeLabels.js).
const statusText = id;

function matches(value, schema) {
  return isRecord(value) && Object.entries(schema).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
}

// `attempt_brief`: lo único que dan `attempts_by_task`, `task_list_v2.current_attempt` y
// `task_detail_v2.attempts`. No trae worktree, rama ni resumen.
const BRIEF_SCHEMA = {
  id, n: (v) => Number.isSafeInteger(v) && v >= 1, status: statusText,
  provider: id, model: optText, role: optText, external: bool,
  created_at: ms, started_at: optMs, ended_at: optMs,
};
const WORKTREE_SCHEMA = {
  id, provenance: oneOf(WT_PROV_SET), machine: optText, path: optText, branch: optText,
  base_branch: optText, branch_kept: bool, state: oneOf(WT_STATE_SET), registered_by_attempt_id: optText,
};
// La referencia externa del proveedor NO viaja (es opaca y privada): solo `bound`.
const SESSION_SCHEMA = {
  id, opened_by_attempt_id: id, binding: optOneOf(PS_BINDING_SET), bound: bool, resumable: bool,
  status: oneOf(PS_STATUS_SET),
};
const ARTIFACT_SCHEMA = { id, kind: oneOf(ARTIFACT_SET), uri: id, sha256: optText, bytes: (v) => v === null || count(v) };
const REVIEW_SCHEMA = {
  decision_id: count, head_commit: id, base_commit: optText, verdict: oneOf(VERDICT_SET),
  // Como los estados de Attempt: un valor nuevo se acepta y la UI lo muestra «desconocido», no rompe el detalle.
  status: (value) => typeof value === 'string' && value.trim() !== '',
};
const TASK_V2_SCHEMA = {
  id, project_id: id, run_id: optText, parent_task_id: optText, title: text, intent: oneOf(INTENT_SET),
  state: statusText, origin: id, depth: count, attempt_count: count, created_at: ms, updated_at: ms,
};

/** Un `attempt_brief` válido; con `taskId`, además pertenece a esa Task (`<task>-a<n>`, migración 008). */
export function validAttemptBrief(attempt, taskId) {
  if (!matches(attempt, BRIEF_SCHEMA)) return false;
  return taskId === undefined || attempt.id === `${taskId}-a${attempt.n}`;
}

export function validTaskV2(task) {
  if (!matches(task, TASK_V2_SCHEMA)) return false;
  const current = task.current_attempt ?? null;
  if (task.attempt_count === 0) return current === null;
  return validAttemptBrief(current, task.id);
}

export function validAttemptDetail(attempt) {
  if (!validAttemptBrief(attempt) || !id(attempt.task_id) || attempt.id !== `${attempt.task_id}-a${attempt.n}`) return false;
  return optText(attempt.effort) && optText(attempt.profile) && optText(attempt.failure_reason)
    && text(attempt.summary) && bool(attempt.integrated)
    && (attempt.provider_session === null || matches(attempt.provider_session, SESSION_SCHEMA))
    && (attempt.worktree === null || matches(attempt.worktree, WORKTREE_SCHEMA))
    && Array.isArray(attempt.artifacts) && attempt.artifacts.every((a) => matches(a, ARTIFACT_SCHEMA))
    && (attempt.review === null || matches(attempt.review, REVIEW_SCHEMA));
}

const invalid = (query, detail) => new Error(`ade_query_invalid_response: ${query}: ${detail}`);

function durable(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) {
    throw new Error(`ade_query_invalid_request: ${name} debe ser un ID durable`);
  }
  return value.trim();
}

function envelope(query, response, version) {
  if (!isRecord(response)) throw invalid(query, 'respuesta no es un objeto');
  if (version !== null && response.v !== version) throw invalid(query, 'versión de respuesta no compatible');
  if (response.core_model !== 'task_attempt_v1') throw invalid(query, 'la respuesta no es del modelo Task/Attempt');
}

/** Peticiones y validación de las cinco lecturas vNext. Se fusionan en la tabla de `coreQueries.js`. */
export const CORE_MODEL_QUERY_SPECS = Object.freeze({
  core_model: {
    request: () => ({}),
    validate: (response) => {
      if (!isRecord(response) || !MODEL_SET.has(response.core_model) || !Array.isArray(response.compat)
        || !Array.isArray(response.queries) || !response.queries.every(id) || !response.compat.every(id)) {
        throw invalid('core_model', 'la respuesta no declara un modelo del contrato');
      }
      return response;
    },
  },
  task_list_v2: {
    request: (args) => {
      const request = { project_id: durable(args?.projectId, 'project_id'), limit: TASK_LIST_V2_LIMIT };
      if (args?.cursor !== null && args?.cursor !== undefined) request.cursor = durable(args.cursor, 'cursor');
      return request;
    },
    validate: (response, args) => {
      envelope('task_list_v2', response, 2);
      if (response.project_id !== args.project_id || !Array.isArray(response.items)
        || !(response.next_cursor === null || id(response.next_cursor))) {
        throw invalid('task_list_v2', 'la página no corresponde al Project solicitado');
      }
      if (!response.items.every((task) => validTaskV2(task) && task.project_id === args.project_id)) {
        throw invalid('task_list_v2', 'la lista contiene una Task fuera del contrato o de otro Project');
      }
      return response;
    },
  },
  task_detail_v2: {
    request: (args) => ({ task_id: durable(args?.taskId, 'task_id') }),
    validate: (response, args) => {
      envelope('task_detail_v2', response, 2);
      const task = response.task;
      if (!validTaskV2(task) || task.id !== args.task_id || !text(task.spec ?? '')
        || !Array.isArray(task.attempts) || !task.attempts.every((a) => validAttemptBrief(a, task.id))
        || !Array.isArray(task.children)) {
        throw invalid('task_detail_v2', 'el detalle no corresponde a la Task solicitada');
      }
      return response;
    },
  },
  attempts_by_task: {
    request: (args) => ({ task_id: durable(args?.taskId, 'task_id') }),
    validate: (response, args) => {
      envelope('attempts_by_task', response, 1);
      if (response.task_id !== args.task_id || !Array.isArray(response.items)) {
        throw invalid('attempts_by_task', 'la lista no corresponde a la Task solicitada');
      }
      // Todo Attempt pertenece a la Task pedida: nunca se mezclan ejecuciones de otra Task.
      if (!response.items.every((attempt) => validAttemptBrief(attempt, args.task_id))) {
        throw invalid('attempts_by_task', 'la lista contiene un Attempt fuera del contrato o de otra Task');
      }
      return response;
    },
  },
  attempt_detail: {
    request: (args) => ({ attempt_id: durable(args?.attemptId, 'attempt_id') }),
    validate: (response, args) => {
      envelope('attempt_detail', response, 1);
      if (!validAttemptDetail(response.attempt)) throw invalid('attempt_detail', 'el detalle del Attempt está fuera del contrato');
      if (response.attempt.id !== args.attempt_id) throw invalid('attempt_detail', 'el detalle no corresponde al Attempt solicitado');
      return response;
    },
  },
});

export const CORE_MODEL_QUERY_NAMES = Object.freeze(Object.keys(CORE_MODEL_QUERY_SPECS));

/**
 * Código estructurado de un error de lectura. El Core responde `codigo: mensaje` (model_read.rs);
 * se toma el código del prefijo, no se busca texto suelto. Un Core anterior a LXO-119 no conoce la
 * query: o no la clasifica y la deniega (`ForbiddenAction`) o no la despacha («Comando
 * desconocido»); ambos casos, y el rechazo de la allowlist del shell, son `query_unsupported`.
 */
export function coreErrorCode(error) {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (message.startsWith('Comando desconocido: ')
    || message === 'Acción no permitida para esta identidad: ForbiddenAction'
    || message.startsWith('orch_query_forbidden:')
    || message.startsWith('ade_query_forbidden:')) return 'query_unsupported';
  const match = /^([a-z][a-z0-9_]*):/.exec(message);
  return match ? match[1] : 'unknown_error';
}

/** Códigos que significan «este Core sirve el modelo legacy»: no son errores, se sigue con F2. */
export const LEGACY_MODEL_CODES = Object.freeze(['core_model_inactive', 'query_unsupported']);
export const isLegacyModelCode = (code) => LEGACY_MODEL_CODES.includes(code);
